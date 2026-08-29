import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { config } from '../core/config.ts';
import { createChildLogger } from '../core/logger.ts';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const log = createChildLogger('auth');

let sharedRuntime: ModelRuntime | null = null;

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
  error?: string;
}

export interface LoginStatus {
  status: 'pending' | 'success' | 'failed';
  error?: string;
}

export async function listProviders(): Promise<ProviderInfo[]> {
  const runtime = await getRuntime();
  
  const providers = [
    { id: 'anthropic', name: 'Anthropic (Claude)' },
    { id: 'openai', name: 'OpenAI' },
  ];

  const result: ProviderInfo[] = [];
  
  for (const provider of providers) {
    try {
      const authStatus = runtime.getProviderAuthStatus(provider.id);
      result.push({
        id: provider.id,
        name: provider.name,
        isConnected: authStatus.configured,
      });
    } catch {
      result.push({
        id: provider.id,
        name: provider.name,
        isConnected: false,
      });
    }
  }

  return result;
}

export async function startLogin(provider: string): Promise<LoginResult> {
  log.info({ provider }, 'Starting login flow');
  return { 
    error: 'Browser OAuth login not supported. Use terminal: npx pi /login' 
  };
}

export async function completeLogin(provider: string, codeOrRedirectUrl: string): Promise<{ success: boolean; error?: string }> {
  log.info({ provider }, 'Complete login not supported via HTTP');
  return { 
    success: false, 
    error: 'Browser OAuth login not supported. Use terminal: npx pi /login' 
  };
}

export async function getLoginStatusAsync(provider: string): Promise<LoginStatus> {
  const runtime = await getRuntime();
  
  try {
    const authStatus = runtime.getProviderAuthStatus(provider);
    
    if (authStatus.configured) {
      return { status: 'success' };
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
    await runtime.logout(provider);
    return { success: true };
  } catch (err) {
    log.error({ err, provider }, 'Logout error');
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
