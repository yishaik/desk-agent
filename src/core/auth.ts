import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { config } from './config.ts';
import { createChildLogger } from './logger.ts';

const log = createChildLogger('auth');

let cachedRuntime: ModelRuntime | null = null;

const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o',
  'openai-codex': 'gpt-4o',
  google: 'gemini-2.0-flash',
  github: 'gpt-4o',
};

interface CredentialInfo {
  providerId: string;
  type: string;
  label?: string;
}

export interface CredentialStatus {
  providerId: string;
  authType: 'oauth' | 'api_key' | 'subscription' | 'unknown';
  isConfigured: boolean;
  label?: string;
}

export interface AuthCheckResult {
  hasAnyCredential: boolean;
  credentials: CredentialStatus[];
  configuredProviders: string[];
}

async function getModelRuntime(): Promise<ModelRuntime> {
  if (cachedRuntime) {
    return cachedRuntime;
  }

  const piAgentDir = join(config.dataDir, 'pi-agent');
  if (!existsSync(piAgentDir)) {
    mkdirSync(piAgentDir, { recursive: true });
  }

  const authPath = join(piAgentDir, 'auth.json');
  const modelsPath = join(piAgentDir, 'models.json');

  log.debug({ piAgentDir, authPath }, 'Creating ModelRuntime for auth check');

  cachedRuntime = await ModelRuntime.create({
    authPath,
    modelsPath,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  return cachedRuntime;
}

export function clearRuntimeCache(): void {
  cachedRuntime = null;
}

export async function listCredentials(): Promise<readonly CredentialInfo[]> {
  try {
    const runtime = await getModelRuntime();
    return await runtime.listCredentials();
  } catch (err) {
    log.error({ err }, 'Failed to list credentials');
    return [];
  }
}

export async function checkAuthStatus(): Promise<AuthCheckResult> {
  const runtime = await getModelRuntime();
  const credentials = await listCredentials();
  
  const result: AuthCheckResult = {
    hasAnyCredential: credentials.length > 0,
    credentials: [],
    configuredProviders: [],
  };

  for (const cred of credentials) {
    const isOAuth = runtime.isUsingOAuth(cred.providerId);
    const isSubscription = runtime.isUsingSubscription(cred.providerId);
    const hasConfigured = runtime.hasConfiguredAuth(cred.providerId);
    
    let authType: CredentialStatus['authType'] = 'unknown';
    if (isOAuth) authType = 'oauth';
    else if (isSubscription) authType = 'subscription';
    else if (cred.type === 'api_key') authType = 'api_key';
    
    result.credentials.push({
      providerId: cred.providerId,
      authType,
      isConfigured: hasConfigured,
      label: cred.label,
    });
    
    if (hasConfigured) {
      result.configuredProviders.push(cred.providerId);
    }
  }

  return result;
}

export async function hasCredentialForProvider(providerId: string): Promise<boolean> {
  try {
    const runtime = await getModelRuntime();
    return runtime.hasConfiguredAuth(providerId);
  } catch (err) {
    log.warn({ err, providerId }, 'Failed to check auth for provider');
    return false;
  }
}

export function getProviderFromModel(model: string): string | null {
  if (model.startsWith('claude') || model.includes('anthropic')) {
    return 'anthropic';
  }
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) {
    return 'openai';
  }
  if (model.startsWith('gemini')) {
    return 'google';
  }
  if (model.includes('/')) {
    const [provider] = model.split('/');
    return provider ?? null;
  }
  return null;
}

export function getDefaultModelForProvider(providerId: string): string {
  return PROVIDER_DEFAULT_MODELS[providerId] ?? 'gpt-4o';
}

export async function resolveValidModel(requestedModel: string): Promise<{
  model: string;
  providerId: string;
  isValid: boolean;
  fallbackReason?: string;
}> {
  const authStatus = await checkAuthStatus();
  
  if (!authStatus.hasAnyCredential) {
    return {
      model: requestedModel,
      providerId: 'none',
      isValid: false,
      fallbackReason: 'no_credentials',
    };
  }

  const requestedProvider = getProviderFromModel(requestedModel);
  
  if (requestedProvider && authStatus.configuredProviders.includes(requestedProvider)) {
    return {
      model: requestedModel,
      providerId: requestedProvider,
      isValid: true,
    };
  }

  const firstConfigured = authStatus.configuredProviders[0];
  if (firstConfigured) {
    const fallbackModel = getDefaultModelForProvider(firstConfigured);
    log.info(
      { requestedModel, requestedProvider, fallbackModel, fallbackProvider: firstConfigured },
      'Model fallback: requested provider not authenticated'
    );
    return {
      model: fallbackModel,
      providerId: firstConfigured,
      isValid: true,
      fallbackReason: requestedProvider 
        ? `provider_not_authenticated:${requestedProvider}` 
        : 'unknown_provider',
    };
  }

  return {
    model: requestedModel,
    providerId: requestedProvider ?? 'unknown',
    isValid: false,
    fallbackReason: 'no_configured_providers',
  };
}

export async function getAuthStatusText(): Promise<string> {
  const status = await checkAuthStatus();
  
  if (!status.hasAnyCredential) {
    return '❌ לא מחובר לשום ספק AI. התחבר דרך ההגדרות.';
  }

  const lines: string[] = [];
  for (const cred of status.credentials) {
    const icon = cred.isConfigured ? '✅' : '⚠️';
    const typeLabel = cred.authType === 'oauth' ? 'OAuth' : 
                     cred.authType === 'subscription' ? 'מנוי' :
                     cred.authType === 'api_key' ? 'API Key' : '';
    const labelPart = cred.label ? ` (${cred.label})` : '';
    lines.push(`${icon} ${cred.providerId}${labelPart} - ${typeLabel}`);
  }

  return lines.join('\n');
}
