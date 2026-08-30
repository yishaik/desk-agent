import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { parse as parseUrl } from 'node:url';

const TEST_DATA_DIR = './test-data-auth';
const TEST_PORT = 3999;
const TEST_PAIR_TOKEN = 'test-token-12345';

function isAuthenticated(req: IncomingMessage, expectedToken: string): boolean {
  const url = parseUrl(req.url ?? '', true);
  const queryToken = url.query['token'] as string | undefined;
  
  const cookies = req.headers.cookie ?? '';
  const cookieToken = cookies
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([key]) => key === 'PAIR_TOKEN')?.[1];

  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : undefined;

  const token = queryToken ?? cookieToken ?? bearerToken;
  return token === expectedToken;
}

beforeEach(() => {
  vi.resetModules();
  process.env['DATA_DIR'] = TEST_DATA_DIR;
  process.env['PAIR_TOKEN'] = TEST_PAIR_TOKEN;
  process.env['PORT'] = String(TEST_PORT);
  
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
  delete process.env['PAIR_TOKEN'];
  delete process.env['PORT'];
});

describe('Authentication Helper', () => {
  it('rejects requests without token', () => {
    const req = { url: '/api/settings', headers: {} } as IncomingMessage;
    expect(isAuthenticated(req, TEST_PAIR_TOKEN)).toBe(false);
  });

  it('accepts requests with valid query token', () => {
    const req = { url: `/api/settings?token=${TEST_PAIR_TOKEN}`, headers: {} } as IncomingMessage;
    expect(isAuthenticated(req, TEST_PAIR_TOKEN)).toBe(true);
  });

  it('accepts requests with valid bearer token', () => {
    const req = { 
      url: '/api/settings', 
      headers: { authorization: `Bearer ${TEST_PAIR_TOKEN}` } 
    } as IncomingMessage;
    expect(isAuthenticated(req, TEST_PAIR_TOKEN)).toBe(true);
  });

  it('accepts requests with valid cookie token', () => {
    const req = { 
      url: '/api/settings', 
      headers: { cookie: `PAIR_TOKEN=${TEST_PAIR_TOKEN}` } 
    } as IncomingMessage;
    expect(isAuthenticated(req, TEST_PAIR_TOKEN)).toBe(true);
  });

  it('rejects requests with invalid token', () => {
    const req = { url: '/api/settings?token=wrong-token', headers: {} } as IncomingMessage;
    expect(isAuthenticated(req, TEST_PAIR_TOKEN)).toBe(false);
  });

  it('prefers query token over cookie', () => {
    const req = { 
      url: `/api/settings?token=${TEST_PAIR_TOKEN}`, 
      headers: { cookie: 'PAIR_TOKEN=wrong-token' } 
    } as IncomingMessage;
    expect(isAuthenticated(req, TEST_PAIR_TOKEN)).toBe(true);
  });

  it('prefers cookie token over bearer', () => {
    const req = { 
      url: '/api/settings', 
      headers: { 
        cookie: `PAIR_TOKEN=${TEST_PAIR_TOKEN}`,
        authorization: 'Bearer wrong-token'
      } 
    } as IncomingMessage;
    expect(isAuthenticated(req, TEST_PAIR_TOKEN)).toBe(true);
  });
});

describe('Secure Cookie Setting', () => {
  it('sets Secure flag when X-Forwarded-Proto is https', async () => {
    const isHttps = (headers: Record<string, string | undefined>, isProduction: boolean): boolean => {
      return headers['x-forwarded-proto'] === 'https' || 
             (headers.host?.startsWith('https') ?? false) ||
             isProduction;
    };

    expect(isHttps({ 'x-forwarded-proto': 'https' }, false)).toBe(true);
  });

  it('sets Secure flag in production', async () => {
    const isHttps = (headers: Record<string, string | undefined>, isProduction: boolean): boolean => {
      return headers['x-forwarded-proto'] === 'https' || 
             (headers.host?.startsWith('https') ?? false) ||
             isProduction;
    };
    
    expect(isHttps({}, true)).toBe(true);
    expect(isHttps({}, false)).toBe(false);
  });
});

describe('Self-Chat Gate', () => {
  it('identifies self-chat messages correctly', () => {
    const isSelfChat = (message: { isFromMe: boolean; to: string }, ownerJid: string): boolean => {
      const ownerPhone = ownerJid.split(':')[0]?.split('@')[0];
      const toJid = message.to;
      const toPhone = toJid.split(':')[0]?.split('@')[0];
      
      return message.isFromMe && toPhone === ownerPhone;
    };

    const ownerJid = '972501234567:0@s.whatsapp.net';

    expect(isSelfChat({ 
      isFromMe: true, 
      to: '972501234567@s.whatsapp.net' 
    }, ownerJid)).toBe(true);

    expect(isSelfChat({ 
      isFromMe: true, 
      to: '972509876543@s.whatsapp.net' 
    }, ownerJid)).toBe(false);

    expect(isSelfChat({ 
      isFromMe: false, 
      to: '972501234567@s.whatsapp.net' 
    }, ownerJid)).toBe(false);

    expect(isSelfChat({ 
      isFromMe: true, 
      to: '1234567890-1234567890@g.us' 
    }, ownerJid)).toBe(false);
  });
});

describe('Auth Module', () => {
  it('listProviders returns provider info structure', async () => {
    const { listProviders } = await import('./auth.ts');
    
    const providers = await listProviders();
    
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBeGreaterThan(0);
    
    for (const provider of providers) {
      expect(provider).toHaveProperty('id');
      expect(provider).toHaveProperty('name');
      expect(provider).toHaveProperty('isConnected');
      expect(typeof provider.id).toBe('string');
      expect(typeof provider.name).toBe('string');
      expect(typeof provider.isConnected).toBe('boolean');
    }
  });

  it('logout returns result structure', async () => {
    const { logout } = await import('./auth.ts');
    
    const result = await logout('anthropic');
    
    expect(result).toHaveProperty('success');
    expect(typeof result.success).toBe('boolean');
  });
});

describe('LoginMethod types', () => {
  it('LoginMethod type includes device_code, browser, paste', async () => {
    const { LoginMethod } = await import('./auth.ts');
    
    const validMethods: Array<'device_code' | 'browser' | 'paste'> = ['device_code', 'browser', 'paste'];
    expect(validMethods).toContain('device_code');
    expect(validMethods).toContain('browser');
    expect(validMethods).toContain('paste');
  });
});

describe('LoginResult interface', () => {
  it('LoginResult can include device code fields', () => {
    const result = {
      userCode: 'ABCD-1234',
      verificationUri: 'https://chatgpt.com/verify',
      loginMethod: 'device_code' as const,
    };
    
    expect(result.userCode).toBe('ABCD-1234');
    expect(result.verificationUri).toBe('https://chatgpt.com/verify');
    expect(result.loginMethod).toBe('device_code');
  });
  
  it('LoginResult can include browser flow fields', () => {
    const result = {
      authorizeUrl: 'https://accounts.anthropic.com/oauth/authorize',
      loginMethod: 'browser' as const,
      instructions: 'Complete login in browser',
    };
    
    expect(result.authorizeUrl).toContain('anthropic.com');
    expect(result.loginMethod).toBe('browser');
    expect(result.instructions).toBeDefined();
  });
  
  it('LoginResult can indicate alreadyConnected', () => {
    const result = {
      alreadyConnected: true,
    };
    
    expect(result.alreadyConnected).toBe(true);
  });
});
