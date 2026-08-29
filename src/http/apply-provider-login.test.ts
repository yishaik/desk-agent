import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DATA_DIR = './test-data-apply-provider';

beforeEach(() => {
  vi.resetModules();
  process.env['DATA_DIR'] = TEST_DATA_DIR;
  
  if (existsSync(TEST_DATA_DIR)) {
    rmSync(TEST_DATA_DIR, { recursive: true });
  }
  mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DATA_DIR)) {
    rmSync(TEST_DATA_DIR, { recursive: true });
  }
  delete process.env['DATA_DIR'];
});

describe('defaultModelForProvider', () => {
  it('returns anthropic model for anthropic provider', async () => {
    const { defaultModelForProvider } = await import('./apply-provider-login.ts');
    
    expect(defaultModelForProvider('anthropic')).toBe('anthropic/claude-sonnet-4-6');
  });

  it('returns openai model for openai-codex provider', async () => {
    const { defaultModelForProvider } = await import('./apply-provider-login.ts');
    
    expect(defaultModelForProvider('openai-codex')).toBe('openai-codex/gpt-5.5');
  });

  it('returns null for unknown provider', async () => {
    const { defaultModelForProvider } = await import('./apply-provider-login.ts');
    
    expect(defaultModelForProvider('unknown-provider')).toBeNull();
  });
});

describe('rewriteCustomerFacingModelError', () => {
  it('rewrites No API key errors', async () => {
    const { rewriteCustomerFacingModelError } = await import('./apply-provider-login.ts');
    
    const result = rewriteCustomerFacingModelError('No API key provided');
    expect(result).toContain('דף ההגדרות');
    expect(result).not.toContain('No API key');
  });

  it('rewrites Use /login errors', async () => {
    const { rewriteCustomerFacingModelError } = await import('./apply-provider-login.ts');
    
    const result = rewriteCustomerFacingModelError('Use /login to authenticate');
    expect(result).toContain('דף ההגדרות');
    expect(result).not.toContain('/login');
  });

  it('rewrites npx pi /login errors', async () => {
    const { rewriteCustomerFacingModelError } = await import('./apply-provider-login.ts');
    
    const result = rewriteCustomerFacingModelError('Run npx pi /login first');
    expect(result).toContain('דף ההגדרות');
    expect(result).not.toContain('npx pi');
  });

  it('preserves unrelated error messages', async () => {
    const { rewriteCustomerFacingModelError } = await import('./apply-provider-login.ts');
    
    const original = 'Network connection failed';
    const result = rewriteCustomerFacingModelError(original);
    expect(result).toBe(original);
  });

  it('rewrites authentication required errors', async () => {
    const { rewriteCustomerFacingModelError } = await import('./apply-provider-login.ts');
    
    const result = rewriteCustomerFacingModelError('Authentication required');
    expect(result).toContain('דף ההגדרות');
  });
});

describe('formatCaughtError', () => {
  it('formats Error objects', async () => {
    const { formatCaughtError } = await import('./apply-provider-login.ts');
    
    const result = formatCaughtError(new Error('No API key'));
    expect(result).toContain('דף ההגדרות');
  });

  it('formats string errors', async () => {
    const { formatCaughtError } = await import('./apply-provider-login.ts');
    
    const result = formatCaughtError('No API key');
    expect(result).toContain('דף ההגדרות');
  });

  it('formats other types', async () => {
    const { formatCaughtError } = await import('./apply-provider-login.ts');
    
    const result = formatCaughtError({ message: 'test' });
    expect(typeof result).toBe('string');
  });
});

describe('applySuccessfulProviderLogin', () => {
  it('updates settings.model on first call', async () => {
    const { applySuccessfulProviderLogin, resetConnectedProvidersCache } = await import('./apply-provider-login.ts');
    const { loadSettings } = await import('../core/settings.ts');
    
    resetConnectedProvidersCache();
    
    await applySuccessfulProviderLogin('anthropic');
    
    const settings = loadSettings();
    expect(settings.model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('skips duplicate provider applications', async () => {
    const { applySuccessfulProviderLogin, resetConnectedProvidersCache, isProviderApplied } = await import('./apply-provider-login.ts');
    
    resetConnectedProvidersCache();
    
    await applySuccessfulProviderLogin('anthropic');
    expect(isProviderApplied('anthropic')).toBe(true);
    
    await applySuccessfulProviderLogin('anthropic');
    expect(isProviderApplied('anthropic')).toBe(true);
  });

  it('tracks different providers separately', async () => {
    const { applySuccessfulProviderLogin, resetConnectedProvidersCache, isProviderApplied } = await import('./apply-provider-login.ts');
    
    resetConnectedProvidersCache();
    
    await applySuccessfulProviderLogin('anthropic');
    expect(isProviderApplied('anthropic')).toBe(true);
    expect(isProviderApplied('openai-codex')).toBe(false);
    
    await applySuccessfulProviderLogin('openai-codex');
    expect(isProviderApplied('openai-codex')).toBe(true);
  });
});
