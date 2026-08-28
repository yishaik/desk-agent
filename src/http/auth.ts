import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { config } from '../core/config.ts';
import { createChildLogger } from '../core/logger.ts';

const log = createChildLogger('auth');

export type ProviderId = 'anthropic' | 'openai-codex';

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  description: string;
  connected: boolean;
  authType?: 'oauth' | 'api_key';
  subscription?: string;
}

export interface LoginStatus {
  provider: ProviderId;
  status: 'pending' | 'connected' | 'error';
  error?: string;
}

interface PendingLogin {
  provider: ProviderId;
  authorizeUrl: string;
  manualCodeResolver?: (codeOrUrl: string) => void;
  loginPromise: Promise<void>;
  startedAt: number;
}

const pendingLogins = new Map<ProviderId, PendingLogin>();
let sharedModelRuntime: ModelRuntime | null = null;

export async function getModelRuntime(): Promise<ModelRuntime> {
  if (sharedModelRuntime) {
    return sharedModelRuntime;
  }

  const piAgentDir = join(config.dataDir, 'pi-agent');
  if (!existsSync(piAgentDir)) {
    mkdirSync(piAgentDir, { recursive: true });
  }

  const authPath = join(piAgentDir, 'auth.json');
  const modelsPath = join(piAgentDir, 'models.json');

  log.info({ piAgentDir, authPath }, 'Creating ModelRuntime for auth');

  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath,
    allowModelNetwork: true,
  });

  if (config.modelApiKey) {
    try {
      await runtime.setRuntimeApiKey('anthropic', config.modelApiKey);
      log.info('Set Anthropic API key from MODEL_API_KEY env var (override)');
    } catch (err) {
      log.warn({ err }, 'Failed to set runtime API key');
    }
  }

  sharedModelRuntime = runtime;
  return runtime;
}

export function getSharedModelRuntime(): ModelRuntime | null {
  return sharedModelRuntime;
}

export function setSharedModelRuntime(runtime: ModelRuntime): void {
  sharedModelRuntime = runtime;
}

export async function listProviders(): Promise<ProviderInfo[]> {
  const runtime = await getModelRuntime();
  const providers: ProviderInfo[] = [];

  const providerConfigs: Array<{ id: ProviderId; name: string; description: string }> = [
    {
      id: 'anthropic',
      name: 'Claude Pro/Max',
      description: 'השתמש במנוי Claude Pro או Max שלך',
    },
    {
      id: 'openai-codex',
      name: 'ChatGPT Plus/Pro',
      description: 'השתמש במנוי ChatGPT Plus או Pro שלך',
    },
  ];

  for (const pc of providerConfigs) {
    let connected = false;
    let authType: 'oauth' | 'api_key' | undefined;
    let subscription: string | undefined;

    try {
      const credentialsPromise = runtime.listCredentials?.();
      const credentials = credentialsPromise ? await credentialsPromise : undefined;
      if (credentials) {
        const cred = credentials.find((c) => c.providerId === pc.id);
        if (cred) {
          connected = true;
          authType = cred.type === 'oauth' ? 'oauth' : 'api_key';
        }
      }

      if (!connected) {
        const checkAuthPromise = runtime.checkAuth?.(pc.id);
        const checkAuth = checkAuthPromise ? await checkAuthPromise : undefined;
        if (checkAuth) {
          connected = true;
        }
      }

      if (connected && authType === 'oauth') {
        const isSubscription = runtime.isUsingSubscription?.(pc.id);
        if (isSubscription) {
          subscription = pc.id === 'anthropic' ? 'Claude Pro/Max' : 'ChatGPT Plus/Pro';
        }
      }
    } catch (err) {
      log.debug({ err, provider: pc.id }, 'Error checking provider status');
    }

    providers.push({
      id: pc.id,
      name: pc.name,
      description: pc.description,
      connected,
      authType,
      subscription,
    });
  }

  return providers;
}

export async function startLogin(provider: ProviderId): Promise<{
  authorizeUrl: string;
  instructions: string;
}> {
  const existing = pendingLogins.get(provider);
  if (existing && Date.now() - existing.startedAt < 300000) {
    return {
      authorizeUrl: existing.authorizeUrl,
      instructions: getLoginInstructions(provider),
    };
  }

  const runtime = await getModelRuntime();

  let authorizeUrl = '';
  let manualCodeResolver: ((codeOrUrl: string) => void) | undefined;

  const loginPromise = new Promise<void>((resolveLogin, rejectLogin) => {
    runtime.login(provider, 'oauth', {
      notify: (event: { type: string; url?: string; instructions?: string }) => {
        if (event.type === 'auth_url' && event.url) {
          authorizeUrl = event.url;
          log.info({ provider, url: event.url }, 'Got authorize URL');
        }
      },
      prompt: async (prompt: { type: string; message?: string }) => {
        if (prompt.type === 'manual_code') {
          return new Promise<string>((resolve) => {
            manualCodeResolver = resolve;
            log.info({ provider }, 'Manual code input available');
          });
        }
        return '';
      },
    }).then(() => {
      resolveLogin();
    }).catch((err: Error) => {
      log.error({ err, provider }, 'Login failed');
      pendingLogins.delete(provider);
      rejectLogin(err);
    });
  });

  await new Promise<void>((resolve) => {
    const checkUrl = setInterval(() => {
      if (authorizeUrl) {
        clearInterval(checkUrl);
        resolve();
      }
    }, 100);

    setTimeout(() => {
      clearInterval(checkUrl);
      resolve();
    }, 5000);
  });

  if (!authorizeUrl) {
    throw new Error('Failed to get authorize URL');
  }

  pendingLogins.set(provider, {
    provider,
    authorizeUrl,
    manualCodeResolver,
    loginPromise,
    startedAt: Date.now(),
  });

  loginPromise.then(() => {
    log.info({ provider }, 'Login completed successfully');
  }).catch(() => {
  });

  return {
    authorizeUrl,
    instructions: getLoginInstructions(provider),
  };
}

function getLoginInstructions(provider: ProviderId): string {
  if (provider === 'anthropic') {
    return `1. לחץ על "התחבר" לפתיחת claude.ai
2. היכנס לחשבון Claude שלך
3. אשר את הגישה
4. אם הדפדפן לא באותו מחשב, העתק את כתובת ה-callback והדבק כאן`;
  }
  return `1. לחץ על "התחבר" לפתיחת OpenAI
2. היכנס לחשבון ChatGPT שלך
3. אשר את הגישה
4. אם הדפדפן לא באותו מחשב, העתק את כתובת ה-callback או הקוד והדבק כאן`;
}

export async function completeLogin(
  provider: ProviderId,
  codeOrRedirectUrl: string
): Promise<{ success: boolean; error?: string }> {
  const pending = pendingLogins.get(provider);

  if (!pending) {
    return { success: false, error: 'No pending login for this provider. Start login first.' };
  }

  if (!pending.manualCodeResolver) {
    return { success: false, error: 'Login flow does not support manual code input.' };
  }

  try {
    pending.manualCodeResolver(codeOrRedirectUrl);

    await Promise.race([
      pending.loginPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Login completion timeout')), 30000)
      ),
    ]);

    pendingLogins.delete(provider);
    return { success: true };
  } catch (err) {
    pendingLogins.delete(provider);
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.error({ err, provider }, 'Login completion failed');
    return { success: false, error: message };
  }
}

export async function getLoginStatusAsync(provider: ProviderId): Promise<LoginStatus> {
  const pending = pendingLogins.get(provider);

  if (pending) {
    return { provider, status: 'pending' };
  }

  const runtime = sharedModelRuntime;
  if (!runtime) {
    return { provider, status: 'error', error: 'Runtime not initialized' };
  }

  try {
    const credentialsPromise = runtime.listCredentials?.();
    const credentials = credentialsPromise ? await credentialsPromise : undefined;
    if (credentials) {
      const cred = credentials.find((c) => c.providerId === provider);
      if (cred) {
        return { provider, status: 'connected' };
      }
    }
  } catch (err) {
    log.debug({ err, provider }, 'Error checking login status');
  }

  return { provider, status: 'error', error: 'Not connected' };
}

export function getLoginStatus(provider: ProviderId): LoginStatus {
  const pending = pendingLogins.get(provider);

  if (pending) {
    return { provider, status: 'pending' };
  }

  return { provider, status: 'error', error: 'Not connected' };
}

export async function logout(provider: ProviderId): Promise<{ success: boolean; error?: string }> {
  const runtime = await getModelRuntime();

  try {
    await runtime.logout?.(provider);
    log.info({ provider }, 'Logged out');
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.error({ err, provider }, 'Logout failed');
    return { success: false, error: message };
  }
}

export function clearPendingLogin(provider: ProviderId): void {
  pendingLogins.delete(provider);
}

export async function hasAnyAuthConfigured(): Promise<boolean> {
  if (config.modelApiKey) {
    return true;
  }

  try {
    const runtime = await getModelRuntime();
    const credentialsPromise = runtime.listCredentials?.();
    const credentials = credentialsPromise ? await credentialsPromise : undefined;
    if (credentials && credentials.length > 0) {
      return true;
    }
  } catch {
  }

  return false;
}

export function getModelAliases(): Record<string, { provider: ProviderId; model: string }> {
  return {
    claude: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    'claude-sonnet': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    'claude-opus': { provider: 'anthropic', model: 'claude-opus-4-8' },
    gpt: { provider: 'openai-codex', model: 'gpt-5.5' },
    chatgpt: { provider: 'openai-codex', model: 'gpt-5.5' },
    'gpt-4': { provider: 'openai-codex', model: 'gpt-4o' },
  };
}

export function resolveModelAlias(alias: string): { provider: ProviderId; model: string } | null {
  const aliases = getModelAliases();
  const normalized = alias.toLowerCase().trim();

  if (aliases[normalized]) {
    return aliases[normalized];
  }

  if (alias.includes('/')) {
    const [provider, ...modelParts] = alias.split('/');
    if (provider === 'anthropic' || provider === 'openai-codex') {
      return { provider: provider as ProviderId, model: modelParts.join('/') };
    }
  }

  return null;
}
