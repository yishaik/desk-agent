import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { config } from '../core/config.ts';
import { createChildLogger } from '../core/logger.ts';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import {
  isClaudeCodeConnected,
  disconnectClaudeCode,
  startClaudeCodeLogin,
  completeClaudeCodeLogin,
} from '../agent/claude-code.ts';

const log = createChildLogger('auth');

let sharedRuntime: ModelRuntime | null = null;

export interface CredentialInfo {
  providerId: string;
  type: 'api_key' | 'oauth';
}

export interface ModelResolution {
  valid: boolean;
  model: ReturnType<ModelRuntime['getModel']>;
  modelId: string;
  providerId: string;
  error?: string;
}

const pendingLogins = new Map<string, {
  loginPromise: Promise<unknown>;
  manualCodeResolver: ((code: string) => void) | null;
  authorizeUrl: string | null;
  failedError?: string;
}>();

async function getRuntime(): Promise<ModelRuntime> {
  if (sharedRuntime) {
    return sharedRuntime;
  }

  const piAgentDir = join(config.dataDir, 'pi-agent');
  if (!existsSync(piAgentDir)) {
    mkdirSync(piAgentDir, { recursive: true });
  }

  const authPath = join(piAgentDir, 'auth.json');
  const modelsPath = join(piAgentDir, 'models.json');

  log.debug({ piAgentDir, authPath }, 'Creating ModelRuntime for auth');

  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath,
    allowModelNetwork: true,
  });

  sharedRuntime = runtime;
  return runtime;
}

export async function getSharedRuntime(): Promise<ModelRuntime> {
  return getRuntime();
}

export function clearRuntimeCache(): void {
  sharedRuntime = null;
  log.info('Runtime cache cleared');
}

export async function listRuntimeCredentials(): Promise<readonly CredentialInfo[]> {
  const runtime = await getRuntime();
  return runtime.listCredentials();
}

export async function providerHasLiveCredential(providerId: string): Promise<boolean> {
  const runtime = await getRuntime();
  try {
    const credentials = await runtime.listCredentials();
    const hasCredential = credentials.some(c => c.providerId === providerId);
    if (!hasCredential) return false;
    
    const authCheck = await runtime.checkAuth(providerId);
    return !!authCheck;
  } catch (err) {
    log.debug({ err, providerId }, 'Error checking provider credential');
    return false;
  }
}

function extractProviderFromModelId(modelId: string): string {
  if (modelId.includes('/')) {
    return modelId.split('/')[0]!;
  }
  if (modelId.startsWith('claude')) return 'anthropic';
  if (modelId.startsWith('gpt') || modelId.startsWith('o1') || modelId.startsWith('o3')) return 'openai-codex';
  return 'anthropic';
}

export async function resolveActiveModel(settingsModel: string): Promise<ModelResolution> {
  const runtime = await getRuntime();
  const credentials = await runtime.listCredentials();
  
  if (credentials.length === 0) {
    return {
      valid: false,
      model: undefined,
      modelId: settingsModel,
      providerId: extractProviderFromModelId(settingsModel),
      error: 'No AI provider connected. Please connect in Settings.',
    };
  }
  
  // split('/') always yields a first element, so a bare model name ("gpt-4o")
  // must go through extractProviderFromModelId, not be treated as a provider.
  const hasProviderPrefix = settingsModel.includes('/');
  const [providerId, ...modelParts] = settingsModel.split('/');
  const modelId = hasProviderPrefix ? modelParts.join('/') : settingsModel;
  const targetProvider = hasProviderPrefix ? providerId! : extractProviderFromModelId(settingsModel);
  
  const hasProviderCredential = await providerHasLiveCredential(targetProvider);

  // Guard against a stored model the provider will reject at request time
  // (spark models are API-key-only; ChatGPT-account Codex logins get a 4xx).
  const storedModelUnusable = targetProvider === 'openai-codex' && modelId.includes('spark');

  if (hasProviderCredential && !storedModelUnusable) {
    const model = runtime.getModel(targetProvider, modelId) ??
                  runtime.getModel(targetProvider, settingsModel);
    
    if (model) {
      log.debug({ providerId: targetProvider, modelId: model.id }, 'Resolved model from settings');
      return {
        valid: true,
        model,
        modelId: `${targetProvider}/${model.id}`,
        providerId: targetProvider,
      };
    }
  }
  
  const availableCredential = credentials[0]!;
  const availableProvider = availableCredential.providerId;

  const models = runtime.getModels(availableProvider);
  const defaultModel = pickDefaultModel(availableProvider, models);
  
  if (!defaultModel) {
    return {
      valid: false,
      model: undefined,
      modelId: settingsModel,
      providerId: targetProvider,
      error: `No models available for ${availableProvider}. Try reconnecting in Settings.`,
    };
  }
  
  log.warn(
    { 
      settingsModel, 
      targetProvider, 
      availableProvider, 
      resolvedModel: `${availableProvider}/${defaultModel.id}` 
    },
    'Model/credential mismatch - using available provider default'
  );
  
  return {
    valid: false,
    model: defaultModel,
    modelId: `${availableProvider}/${defaultModel.id}`,
    providerId: availableProvider,
    error: `Model "${settingsModel}" requires ${targetProvider} credentials. Using ${availableProvider}/${defaultModel.id} instead.`,
  };
}

// First-in-catalog is not always usable: e.g. gpt-5.3-codex-spark is rejected
// for ChatGPT-account Codex logins. Prefer known-good defaults per provider.
const PREFERRED_DEFAULT_MODELS: Record<string, string[]> = {
  'openai-codex': ['gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex', 'gpt-5-codex'],
  'anthropic': ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5'],
};

function pickDefaultModel<T extends { id: string }>(providerId: string, models: readonly T[]): T | undefined {
  for (const preferred of PREFERRED_DEFAULT_MODELS[providerId] ?? []) {
    const match = models.find((m) => m.id === preferred);
    if (match) return match;
  }
  return models.find((m) => !m.id.includes('spark')) ?? models[0];
}

export async function getProviderDefaultModel(providerId: string): Promise<string | undefined> {
  const runtime = await getRuntime();
  const models = runtime.getModels(providerId);
  const defaultModel = pickDefaultModel(providerId, models);
  return defaultModel ? `${providerId}/${defaultModel.id}` : undefined;
}

export interface ProviderInfo {
  id: string;
  name: string;
  isConnected: boolean;
  /** Human label of the connected account, e.g. "yishai@gmail.com · Claude Max" */
  account?: string;
}

// --- connected-account identity ------------------------------------------
// Knowing WHICH account is connected is essential for debugging quota/auth
// problems, so show it next to the ✓. Results are cached briefly because the
// wizard polls listProviders every few seconds.
const identityCache = new Map<string, { label: string | undefined; at: number }>();
const IDENTITY_CACHE_MS = 10 * 60 * 1000;

function readStoredAuth(): Record<string, { access?: string; idToken?: string; id_token?: string }> {
  try {
    const authPath = join(config.dataDir, 'pi-agent', 'auth.json');
    return JSON.parse(readFileSync(authPath, 'utf8'));
  } catch {
    return {};
  }
}

function decodeJwtEmail(jwt: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return payload.email ?? payload.preferred_username;
  } catch {
    return undefined;
  }
}

export async function getProviderIdentity(providerId: string): Promise<string | undefined> {
  const auth = readStoredAuth();
  const entry = auth[providerId];
  if (!entry) return undefined;

  const cacheKey = `${providerId}:${(entry.access ?? '').slice(0, 24)}`;
  const cached = identityCache.get(cacheKey);
  if (cached && Date.now() - cached.at < IDENTITY_CACHE_MS) {
    return cached.label;
  }

  let label: string | undefined;
  try {
    if (providerId === 'anthropic' && entry.access) {
      const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
        headers: { Authorization: `Bearer ${entry.access}`, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const profile = await res.json() as {
          account?: { email?: string; has_claude_max?: boolean; has_claude_pro?: boolean };
        };
        const email = profile.account?.email;
        const plan = profile.account?.has_claude_max ? 'Claude Max'
          : profile.account?.has_claude_pro ? 'Claude Pro' : undefined;
        label = email ? (plan ? `${email} · ${plan}` : email) : undefined;
      }
    } else if (providerId === 'openai-codex') {
      const jwt = entry.idToken ?? entry.id_token ?? (entry.access?.split('.').length === 3 ? entry.access : undefined);
      label = jwt ? decodeJwtEmail(jwt) : undefined;
    }
  } catch (err) {
    log.debug({ err, providerId }, 'Failed to fetch provider identity');
  }

  identityCache.set(cacheKey, { label, at: Date.now() });
  return label;
}

export interface LoginResult {
  authorizeUrl?: string;
  instructions?: string;
  error?: string;
}

export interface LoginStatus {
  status: 'pending' | 'success' | 'failed';
  error?: string;
}

const SUPPORTED_PROVIDERS = [
  { id: 'claude-code', name: 'Claude (מנוי — Claude Code)' },
  { id: 'anthropic', name: 'Anthropic (Claude · extra usage)' },
  { id: 'openai-codex', name: 'OpenAI' },
];

export async function listProviders(): Promise<ProviderInfo[]> {
  const runtime = await getRuntime();

  const result: ProviderInfo[] = [];

  for (const provider of SUPPORTED_PROVIDERS) {
    if (provider.id === 'claude-code') {
      const connected = isClaudeCodeConnected();
      result.push({
        id: provider.id,
        name: provider.name,
        isConnected: connected,
        account: connected ? 'Claude Code · מכסת המנוי' : undefined,
      });
      continue;
    }
    let isConnected = false;
    
    try {
      const credentials = await runtime.listCredentials();
      const hasCredential = credentials.some(c => c.providerId === provider.id);
      
      if (hasCredential) {
        const authCheck = await runtime.checkAuth(provider.id);
        isConnected = !!authCheck;
      }
    } catch (err) {
      log.debug({ err, provider: provider.id }, 'Error checking auth status');
    }
    
    result.push({
      id: provider.id,
      name: provider.name,
      isConnected,
      account: isConnected ? await getProviderIdentity(provider.id) : undefined,
    });
  }

  return result;
}

export async function startLogin(provider: string): Promise<LoginResult> {
  if (provider === 'claude-code') {
    const r = await startClaudeCodeLogin();
    if (r.error) return { error: r.error };
    return {
      authorizeUrl: r.authorizeUrl,
      instructions: 'אשר בחלון שנפתח, העתק את הקוד ש-Claude מציג, והדבק אותו כאן.',
    };
  }

  // A repeat click while a login is already pending must return the same URL —
  // starting a second runtime.login() while one is in flight fails. If the URL
  // hasn't arrived yet (pre-URL window), wait for the in-flight attempt rather
  // than starting a parallel one.
  const existing = pendingLogins.get(provider);
  if (existing && !existing.failedError) {
    const waitStart = Date.now();
    while (!existing.authorizeUrl && !existing.failedError && Date.now() - waitStart < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (existing.authorizeUrl) {
      log.info({ provider }, 'Reusing pending authorize URL');
      return {
        authorizeUrl: existing.authorizeUrl,
        instructions: 'השלם את ההתחברות בחלון שנפתח. אם החלון לא נפתח, הדבק את הקוד שקיבלת.',
      };
    }
    pendingLogins.delete(provider);
    return { error: existing.failedError ?? 'שגיאה בהתחלת ההתחברות' };
  }
  if (existing?.failedError) {
    pendingLogins.delete(provider);
  }

  const runtime = await getRuntime();

  log.info({ provider }, 'Starting OAuth login flow');
  
  let authorizeUrl: string | null = null;
  let manualCodeResolver: ((code: string) => void) | null = null;
  
  const loginPromise = runtime.login(provider, 'oauth', {
    notify: (event) => {
      const e = event as { type: string; url?: string };
      if (e.type === 'auth_url' && e.url) {
        authorizeUrl = e.url;
        log.info({ provider, url: e.url }, 'Received authorize URL');
      }
    },
    prompt: async (prompt) => {
      const p = prompt as { type: string; options?: readonly { id: string }[] };
      if (p.type === 'select') {
        const hasBrowser = (p.options ?? []).some(o => o.id === 'browser');
        return hasBrowser ? 'browser' : (p.options?.[0]?.id ?? 'browser');
      }
      
      if (p.type === 'manual_code') {
        return new Promise<string>((resolve) => {
          manualCodeResolver = resolve;
          const pending = pendingLogins.get(provider);
          if (pending) {
            pending.manualCodeResolver = resolve;
          }
        });
      }
      
      return 'browser';
    },
  });
  
  pendingLogins.set(provider, {
    loginPromise,
    manualCodeResolver,
    authorizeUrl,
  });

  // In the browser flow nothing ever awaits loginPromise — without this catch,
  // a rejected login (denied consent, timeout) is an unhandled rejection that
  // kills the process, and the UI polls forever with no feedback.
  loginPromise.catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ provider, err: message }, 'OAuth login attempt failed');
    const pending = pendingLogins.get(provider);
    if (pending && pending.loginPromise === loginPromise) {
      pending.failedError = message;
    }
  });

  const startTime = Date.now();
  const timeout = 5000;
  
  while (!authorizeUrl && Date.now() - startTime < timeout) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const pending = pendingLogins.get(provider);
    if (pending) {
      pending.authorizeUrl = authorizeUrl;
    }
  }
  
  if (authorizeUrl) {
    const pending = pendingLogins.get(provider);
    if (pending) {
      pending.authorizeUrl = authorizeUrl;
    }
    
    return {
      authorizeUrl,
      instructions: 'השלם את ההתחברות בחלון שנפתח. אם החלון לא נפתח, הדבק את הקוד שקיבלת.',
    };
  }
  
  pendingLogins.delete(provider);
  log.error({ provider }, 'Failed to get authorize URL');
  return { error: 'שגיאה בהתחלת ההתחברות' };
}

export async function completeLogin(provider: string, codeOrRedirectUrl: string): Promise<{ success: boolean; error?: string }> {
  if (provider === 'claude-code') {
    return completeClaudeCodeLogin(codeOrRedirectUrl);
  }

  const pending = pendingLogins.get(provider);
  
  if (!pending) {
    log.warn({ provider }, 'No pending login found');
    return { success: false, error: 'לא נמצאה התחברות פעילה. נסה להתחבר מחדש.' };
  }
  
  const { loginPromise, manualCodeResolver } = pending;
  
  if (manualCodeResolver) {
    log.info({ provider }, 'Resolving manual code');
    manualCodeResolver(codeOrRedirectUrl);
  }
  
  try {
    await loginPromise;
    pendingLogins.delete(provider);
    log.info({ provider }, 'Login completed successfully');
    return { success: true };
  } catch (err) {
    pendingLogins.delete(provider);
    log.error({ err, provider }, 'Login failed');
    return { success: false, error: err instanceof Error ? err.message : 'שגיאה בהשלמת ההתחברות' };
  }
}

export async function getLoginStatusAsync(provider: string): Promise<LoginStatus> {
  if (provider === 'claude-code') {
    return isClaudeCodeConnected() ? { status: 'success' } : { status: 'pending' };
  }

  const runtime = await getRuntime();

  try {
    const credentials = await runtime.listCredentials();
    const hasCredential = credentials.some(c => c.providerId === provider);
    
    if (hasCredential) {
      const authCheck = await runtime.checkAuth(provider);
      if (authCheck) {
        return { status: 'success' };
      }
    }
    
    const pending = pendingLogins.get(provider);
    if (pending?.failedError) {
      pendingLogins.delete(provider);
      return { status: 'failed', error: pending.failedError };
    }

    return { status: 'pending' };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

export async function logout(provider: string): Promise<{ success: boolean; error?: string }> {
  if (provider === 'claude-code') {
    disconnectClaudeCode();
    return { success: true };
  }

  const runtime = await getRuntime();

  try {
    log.info({ provider }, 'Logging out provider');
    if (typeof runtime.logout === 'function') {
      await runtime.logout(provider);
    }
    return { success: true };
  } catch (err) {
    log.error({ err, provider }, 'Logout error');
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
