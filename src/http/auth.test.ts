import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRuntime: {
    create: vi.fn().mockResolvedValue({
      listCredentials: vi.fn().mockReturnValue([]),
      checkAuth: vi.fn().mockReturnValue(false),
      isUsingSubscription: vi.fn().mockReturnValue(false),
      login: vi.fn(),
      logout: vi.fn(),
      getModel: vi.fn(),
      setRuntimeApiKey: vi.fn(),
    }),
  },
}));

const TEST_DATA_DIR = './test-data-auth-module';

beforeEach(() => {
  vi.resetModules();
  process.env['DATA_DIR'] = TEST_DATA_DIR;
  process.env['PAIR_TOKEN'] = 'test-token';
});

afterEach(() => {
  delete process.env['DATA_DIR'];
  delete process.env['PAIR_TOKEN'];
  delete process.env['MODEL_API_KEY'];
  vi.clearAllMocks();
});

describe('Auth Module - Model Aliases', () => {
  it('provides model aliases', async () => {
    const { getModelAliases } = await import('./auth.ts');
    const aliases = getModelAliases();
    
    expect(aliases).toHaveProperty('claude');
    expect(aliases).toHaveProperty('gpt');
    expect(aliases).toHaveProperty('chatgpt');
    expect(aliases['claude']).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
    expect(aliases['gpt']).toEqual({ provider: 'openai-codex', model: 'gpt-5.5' });
  });
  
  it('resolves model aliases', async () => {
    const { resolveModelAlias } = await import('./auth.ts');
    
    expect(resolveModelAlias('claude')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
    expect(resolveModelAlias('gpt')).toEqual({ provider: 'openai-codex', model: 'gpt-5.5' });
    expect(resolveModelAlias('chatgpt')).toEqual({ provider: 'openai-codex', model: 'gpt-5.5' });
    expect(resolveModelAlias('claude-opus')).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8' });
  });
  
  it('resolves provider/model format', async () => {
    const { resolveModelAlias } = await import('./auth.ts');
    
    expect(resolveModelAlias('anthropic/claude-3-5-sonnet')).toEqual({ 
      provider: 'anthropic', 
      model: 'claude-3-5-sonnet' 
    });
    expect(resolveModelAlias('openai-codex/gpt-4o')).toEqual({ 
      provider: 'openai-codex', 
      model: 'gpt-4o' 
    });
  });
  
  it('returns null for unknown aliases', async () => {
    const { resolveModelAlias } = await import('./auth.ts');
    
    expect(resolveModelAlias('unknown-model')).toBeNull();
    expect(resolveModelAlias('invalid/provider/model')).toBeNull();
  });
});

describe('Auth Module - Provider Listing', () => {
  it('lists supported providers', async () => {
    const { listProviders, getModelRuntime } = await import('./auth.ts');
    
    await getModelRuntime();
    
    const providers = await listProviders();
    
    expect(providers).toHaveLength(2);
    expect(providers[0]).toMatchObject({
      id: 'anthropic',
      name: 'Claude Pro/Max',
      connected: false,
    });
    expect(providers[1]).toMatchObject({
      id: 'openai-codex',
      name: 'ChatGPT Plus/Pro',
      connected: false,
    });
  });
});

describe('Auth Module - Login Status', () => {
  it('returns error status when not connected', async () => {
    const { getLoginStatus } = await import('./auth.ts');
    
    const status = getLoginStatus('anthropic');
    
    expect(status).toMatchObject({
      provider: 'anthropic',
      status: 'error',
    });
  });
});

describe('Auth Module - hasAnyAuthConfigured', () => {
  it('returns true when MODEL_API_KEY is set', async () => {
    process.env['MODEL_API_KEY'] = 'test-api-key';
    
    vi.resetModules();
    const { hasAnyAuthConfigured } = await import('./auth.ts');
    
    const result = await hasAnyAuthConfigured();
    expect(result).toBe(true);
  });
  
  it('returns false when no auth is configured', async () => {
    delete process.env['MODEL_API_KEY'];
    
    vi.resetModules();
    const { hasAnyAuthConfigured, getModelRuntime } = await import('./auth.ts');
    
    await getModelRuntime();
    
    const result = await hasAnyAuthConfigured();
    expect(result).toBe(false);
  });
});

describe('Auth API Endpoint Validation', () => {
  const validProviders = ['anthropic', 'openai-codex'];
  const invalidProviders = ['invalid', 'google', 'github', '', undefined];
  
  it('validates provider IDs correctly', () => {
    const isValidProvider = (provider: string | undefined): boolean => {
      return provider === 'anthropic' || provider === 'openai-codex';
    };
    
    for (const provider of validProviders) {
      expect(isValidProvider(provider)).toBe(true);
    }
    
    for (const provider of invalidProviders) {
      expect(isValidProvider(provider as string)).toBe(false);
    }
  });
});

describe('Auth Security', () => {
  it('never exposes tokens in provider info', async () => {
    const { listProviders, getModelRuntime } = await import('./auth.ts');
    
    await getModelRuntime();
    
    const providers = await listProviders();
    
    for (const provider of providers) {
      const json = JSON.stringify(provider);
      expect(json).not.toContain('token');
      expect(json).not.toContain('apiKey');
      expect(json).not.toContain('secret');
      expect(json).not.toContain('credential');
    }
  });
});
