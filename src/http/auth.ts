import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { config } from '../core/config.ts';
import { createChildLogger } from '../core/logger.ts';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { applySuccessfulProviderLogin } from './apply-provider-login.ts';

const log = createChildLogger('auth');

let sharedRuntime: ModelRuntime | null = null;

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
  
  loginPromise.then(() => {
    applySuccessfulProviderLogin(provider).catch((err) => {
      log.warn({ err, provider }, 'Failed to apply provider login from startLogin');
    });
  }).catch(() => {
    // Error handled elsewhere
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
    
    await applySuccessfulProviderLogin(provider).catch((err) => {
      log.warn({ err, provider }, 'Failed to apply provider login from completeLogin');
    });
    
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

export interface ResolvedModel {
  providerId: string;
  modelId: string;
  label: string;
}

const MODEL_LABELS: Record<string, string> = {
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-sonnet-4-5': 'Claude Sonnet 4.5',
  'claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet',
  'claude-3-opus': 'Claude 3 Opus',
  'gpt-5.5': 'GPT-5.5',
  'gpt-4o': 'GPT-4o',
  'gpt-4-turbo': 'GPT-4 Turbo',
  'o1': 'O1',
};

export async function resolveActiveModel(settingsModel?: string): Promise<ResolvedModel | null> {
  const runtime = await getRuntime();
  
  if (settingsModel) {
    const parts = settingsModel.split('/');
    const providerId = parts.length > 1 ? parts[0] : 'anthropic';
    const modelId = parts.length > 1 ? parts.slice(1).join('/') : settingsModel;
    
    const model = runtime.getModel(providerId ?? 'anthropic', modelId);
    if (model) {
      return {
        providerId: providerId ?? 'anthropic',
        modelId,
        label: MODEL_LABELS[modelId] || modelId,
      };
    }
  }
  
  for (const provider of SUPPORTED_PROVIDERS) {
    try {
      const credentials = await runtime.listCredentials();
      const hasCredential = credentials.some(c => c.providerId === provider.id);
      
      if (hasCredential) {
        const authCheck = await runtime.checkAuth(provider.id);
        if (authCheck) {
          const defaultModels: Record<string, string> = {
            'anthropic': 'claude-sonnet-4-6',
            'openai-codex': 'gpt-5.5',
          };
          const modelId = defaultModels[provider.id] || 'unknown';
          return {
            providerId: provider.id,
            modelId,
            label: MODEL_LABELS[modelId] || `${provider.name} (OAuth)`,
          };
        }
      }
    } catch (err) {
      log.debug({ err, provider: provider.id }, 'Error checking model for provider');
    }
  }
  
  return null;
}

export async function resolveActiveModelLabel(settingsModel?: string): Promise<string> {
  const resolved = await resolveActiveModel(settingsModel);
  if (resolved) {
    return resolved.label;
  }
  
  if (settingsModel) {
    return MODEL_LABELS[settingsModel] || settingsModel;
  }
  
  return 'לא מוגדר';
}
