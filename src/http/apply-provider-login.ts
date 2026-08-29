import { loadSettings, updateSettings } from '../core/settings.ts';
import { createChildLogger } from '../core/logger.ts';

const log = createChildLogger('apply-provider-login');

const connectedProviders = new Set<string>();

const DEFAULT_MODELS: Record<string, string> = {
  'anthropic': 'anthropic/claude-sonnet-4-6',
  'openai-codex': 'openai-codex/gpt-5.5',
};

export function defaultModelForProvider(provider: string): string | null {
  return DEFAULT_MODELS[provider] ?? null;
}

export async function applySuccessfulProviderLogin(provider: string): Promise<void> {
  if (connectedProviders.has(provider)) {
    log.debug({ provider }, 'Provider already applied, skipping');
    return;
  }
  
  connectedProviders.add(provider);
  
  const defaultModel = defaultModelForProvider(provider);
  if (!defaultModel) {
    log.warn({ provider }, 'No default model for provider');
    return;
  }
  
  const settings = loadSettings();
  const oldModel = settings.model;
  
  updateSettings({ model: defaultModel });
  log.info({ provider, oldModel, newModel: defaultModel }, 'Updated settings.model after provider login');
  
  try {
    const { clearSession, getOrCreateSession } = await import('../agent/session.ts');
    clearSession(settings.activeProject);
    await getOrCreateSession(settings.activeProject);
    log.info({ provider, project: settings.activeProject }, 'Session recreated after provider login');
  } catch (err) {
    log.warn({ err, provider }, 'Session recreation failed (swallowed)');
  }
}

export function resetConnectedProvidersCache(): void {
  connectedProviders.clear();
}

export function isProviderApplied(provider: string): boolean {
  return connectedProviders.has(provider);
}

const CUSTOMER_FACING_ERROR_PATTERNS = [
  { pattern: /No API key/i, replacement: 'אנא התחבר לספק AI דרך דף ההגדרות' },
  { pattern: /Use \/login/i, replacement: 'אנא התחבר לספק AI דרך דף ההגדרות' },
  { pattern: /npx pi \/login/i, replacement: 'אנא התחבר לספק AI דרך דף ההגדרות' },
  { pattern: /npx pi/i, replacement: 'דף ההגדרות' },
  { pattern: /\/login/i, replacement: 'דף ההגדרות' },
  { pattern: /API key.*required/i, replacement: 'נדרשת התחברות לספק AI - עבור לדף ההגדרות' },
  { pattern: /authentication.*required/i, replacement: 'נדרשת התחברות לספק AI - עבור לדף ההגדרות' },
  { pattern: /not authenticated/i, replacement: 'אנא התחבר לספק AI דרך דף ההגדרות' },
];

export function rewriteCustomerFacingModelError(message: string): string {
  let result = message;
  
  for (const { pattern, replacement } of CUSTOMER_FACING_ERROR_PATTERNS) {
    if (pattern.test(result)) {
      result = result.replace(pattern, replacement);
    }
  }
  
  return result;
}

export function formatCaughtError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return rewriteCustomerFacingModelError(raw);
}
