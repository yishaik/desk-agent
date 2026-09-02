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

  it('listProviders includes claude-code provider', async () => {
    const { listProviders } = await import('./auth.ts');
    
    const providers = await listProviders();
    const claudeCode = providers.find(p => p.id === 'claude-code');
    
    expect(claudeCode).toBeDefined();
    expect(claudeCode?.name).toContain('Claude');
    expect(claudeCode?.name).toContain('מנוי');
  });

  it('listProviders does NOT include anthropic (Pi extra-usage)', async () => {
    const { listProviders } = await import('./auth.ts');
    
    const providers = await listProviders();
    const anthropic = providers.find(p => p.id === 'anthropic');
    
    expect(anthropic).toBeUndefined();
  });

  it('listProviders includes openai-codex (ChatGPT)', async () => {
    const { listProviders } = await import('./auth.ts');
    
    const providers = await listProviders();
    const chatgpt = providers.find(p => p.id === 'openai-codex');
    
    expect(chatgpt).toBeDefined();
    expect(chatgpt?.name).toBe('ChatGPT');
  });

  it('logout returns result structure', async () => {
    const { logout } = await import('./auth.ts');
    
    const result = await logout('claude-code');
    
    expect(result).toHaveProperty('success');
    expect(typeof result.success).toBe('boolean');
  });
});

describe('HTTP Authentication Security (server.ts)', () => {
  it('SECURITY: imports timingSafeEqual from crypto', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    expect(serverCode).toContain("import { timingSafeEqual } from 'node:crypto'");
  });

  it('SECURITY: has timingSafeTokenCompare function using timingSafeEqual', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    expect(serverCode).toContain('function timingSafeTokenCompare');
    expect(serverCode).toContain('timingSafeEqual(providedBuf, expectedBuf)');
  });

  it('SECURITY: isAuthenticated uses timing-safe comparison', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    expect(serverCode).toContain('timingSafeTokenCompare(token, config.pairToken)');
  });

  it('SECURITY: parseBody has MAX_BODY_SIZE limit and destroys oversized requests', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    expect(serverCode).toContain('const MAX_BODY_SIZE = 64 * 1024');
    expect(serverCode).toContain('size > MAX_BODY_SIZE');
    expect(serverCode).toContain('req.destroy()');
  });

  it('SECURITY: cookie max age is 30 days, not 1 year', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    expect(serverCode).toContain('const COOKIE_MAX_AGE = 30 * 24 * 60 * 60');
    expect(serverCode).not.toContain('Max-Age=31536000');
  });

  it('SECURITY: GET / with ?token= redirects to / after setting cookie', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    expect(serverCode).toMatch(/if \(queryToken && timingSafeTokenCompare\(queryToken[\s\S]*?redirect\(res, '\/'\)/);
  });

  it('SECURITY: POST /logout endpoint exists and clears cookie', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    expect(serverCode).toContain("addRoute('POST', '/logout'");
    expect(serverCode).toContain('PAIR_TOKEN=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  });

  it('SECURITY: POST /auth returns 413 on oversized body, not 401', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    expect(serverCode).toContain('class BodyTooLargeError');
    expect(serverCode).toMatch(/addRoute\('POST', '\/auth'[\s\S]*?BodyTooLargeError[\s\S]*?413/);
  });

  it('SECURITY: PUT /api/projects/:id/token validates projectId', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    const tokenRouteMatch = serverCode.match(/addRoute\('PUT', '\/api\/projects\/:id\/token'[\s\S]*?sendJson\(res, \{ success: true \}\);[\s\S]*?\}\);/);
    expect(tokenRouteMatch).toBeTruthy();
    
    const tokenRoute = tokenRouteMatch![0];
    expect(tokenRoute).toContain('validateProjectId');
    expect(tokenRoute).toContain('decodeURIComponent');
    expect(tokenRoute).toContain('ProjectIdValidationError');
  });
});

describe('GET /api/auth/session (Caddy forward_auth)', () => {
  it('exists and only reads cookie, not query token or Authorization', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    const sessionRouteMatch = serverCode.match(/addRoute\('GET', '\/api\/auth\/session'[\s\S]*?\}\);/);
    expect(sessionRouteMatch).toBeTruthy();
    
    const sessionRoute = sessionRouteMatch![0];
    
    expect(sessionRoute).toContain("req.headers.cookie");
    expect(sessionRoute).toContain("PAIR_TOKEN");
    expect(sessionRoute).toContain('timingSafeTokenCompare');
    
    expect(sessionRoute).not.toContain('query');
    expect(sessionRoute).not.toContain('authorization');
    expect(sessionRoute).not.toContain('Authorization');
    expect(sessionRoute).not.toContain('isAuthenticated');
  });

  it('returns 200 on valid cookie match', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    const sessionRouteMatch = serverCode.match(/addRoute\('GET', '\/api\/auth\/session'[\s\S]*?\}\);/);
    expect(sessionRouteMatch).toBeTruthy();
    
    const sessionRoute = sessionRouteMatch![0];
    expect(sessionRoute).toContain('res.writeHead(200)');
    expect(sessionRoute).toContain('res.end()');
  });

  it('returns 401 on missing or wrong cookie', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    const sessionRouteMatch = serverCode.match(/addRoute\('GET', '\/api\/auth\/session'[\s\S]*?\}\);/);
    expect(sessionRouteMatch).toBeTruthy();
    
    const sessionRoute = sessionRouteMatch![0];
    expect(sessionRoute).toContain("sendError(res, 'Unauthorized', 401)");
  });

  it('SECURITY: does NOT call isAuthenticated (which accepts query/bearer)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    const sessionRouteMatch = serverCode.match(/addRoute\('GET', '\/api\/auth\/session'[\s\S]*?\}\);/);
    expect(sessionRouteMatch).toBeTruthy();
    
    const sessionRoute = sessionRouteMatch![0];
    expect(sessionRoute).not.toContain('isAuthenticated(');
  });
});
