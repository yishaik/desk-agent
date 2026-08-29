import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { config } from '../core/config.ts';
import { createChildLogger } from '../core/logger.ts';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

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
  
  const [providerId, ...modelParts] = settingsModel.split('/');
  const modelId = modelParts.join('/') || settingsModel;
  const targetProvider = providerId ?? extractProviderFromModelId(settingsModel);
  
  const hasProviderCredential = await providerHasLiveCredential(targetProvider);
  
  if (hasProviderCredential) {
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

function pickDefaultModel<T extends { id: string }>(providerId: string, models: T[]): T | undefined {
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
  { id: 'anthropic', name: 'Anthropic (Claude)' },
  { id: 'openai-codex', name: 'OpenAI' },
];

export async function listProviders(): Promise<ProviderInfo[]> {
  const runtime = await getRuntime();
  
  const result: ProviderInfo[] = [];
  
  for (const provider of SUPPORTED_PROVIDERS) {
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
    });
  }

  return result;
}

export async function startLogin(provider: string): Promise<LoginResult> {
  // A repeat click while a login is already pending must return the same URL —
  // starting a second runtime.login() while one is in flight fails.
  const existing = pendingLogins.get(provider);
  if (existing?.authorizeUrl) {
    log.info({ provider }, 'Reusing pending authorize URL');
    return {
      authorizeUrl: existing.authorizeUrl,
      instructions: 'השלם את ההתחברות בחלון שנפתח. אם החלון לא נפתח, הדבק את הקוד שקיבלת.',
    };
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
    if (pending) {
      return { status: 'pending' };
    }
    
    return { status: 'pending' };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

export async function logout(provider: string): Promise<{ success: boolean; error?: string }> {
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
