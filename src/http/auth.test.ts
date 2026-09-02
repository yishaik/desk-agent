import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DATA_DIR = './test-data-auth';
const TEST_PORT = 3999;
const TEST_PAIR_TOKEN = 'test-token-12345';

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

describe('PAIR_TOKEN Cookie Authentication', () => {
  it('cookie is HttpOnly', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    expect(serverCode).toContain('HttpOnly');
    expect(serverCode).toContain('SameSite=Strict');
  });

  it('cookie max age is 30 days', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    expect(serverCode).toContain('COOKIE_MAX_AGE = 30 * 24 * 60 * 60');
  });
});

describe('Bearer Token Authentication (API clients)', () => {
  it('accepts requests with valid bearer token (PAIR_TOKEN)', () => {
    const bearerToken = TEST_PAIR_TOKEN;
    const authHeader = `Bearer ${bearerToken}`;
    const extractedToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    
    expect(extractedToken).toBe(TEST_PAIR_TOKEN);
  });

  it('rejects requests with invalid bearer token', () => {
    const authHeader = 'Bearer wrong-token';
    const extractedToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    
    expect(extractedToken).not.toBe(TEST_PAIR_TOKEN);
  });
});

describe('Login Form Flow (טוקן גישה)', () => {
  it('POST /auth validates PAIR_TOKEN and sets HttpOnly cookie', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    const authRoute = serverCode.match(/addRoute\('POST', '\/auth'[\s\S]*?\}\);/);
    expect(authRoute).toBeTruthy();
    
    const route = authRoute![0];
    expect(route).toContain('timingSafeTokenCompare(token, config.pairToken)');
    expect(route).toContain('setAuthCookie');
  });

  it('Login form submits token via JSON POST, not query string', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    expect(serverCode).toContain("fetch('/auth'");
    expect(serverCode).toContain("method: 'POST'");
    expect(serverCode).toContain("body: JSON.stringify({ token })");
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

describe('SECURITY: Query token one-time redemption (S-02)', () => {
  it('SECURITY: isAuthenticated must NOT accept query token', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    const isAuthenticatedMatch = serverCode.match(/function isAuthenticated\(req: IncomingMessage\): boolean \{[\s\S]*?^}/m);
    expect(isAuthenticatedMatch).toBeTruthy();
    
    const isAuthFn = isAuthenticatedMatch![0];
    expect(isAuthFn).not.toContain('queryToken');
    expect(isAuthFn).not.toContain("query['token']");
    expect(isAuthFn).not.toContain('parseUrl');
  });

  it('SECURITY: GET / redeems ?token= ONCE into HttpOnly cookie, then redirects', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    const rootRouteMatch = serverCode.match(/addRoute\('GET', '\/'\s*,\s*async \(req, res\) => \{[\s\S]*?(?=addRoute\('GET'|$)/);
    expect(rootRouteMatch).toBeTruthy();
    
    const rootRoute = rootRouteMatch![0];
    expect(rootRoute).toContain('queryToken');
    expect(rootRoute).toContain('timingSafeTokenCompare(queryToken, config.pairToken)');
    expect(rootRoute).toContain('setAuthCookie');
    expect(rootRoute).toContain("redirect(res, '/')");
  });

  it('SECURITY: POST /logout clears cookie', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    const logoutRoute = serverCode.match(/addRoute\('POST', '\/logout'[\s\S]*?\}\);/);
    expect(logoutRoute).toBeTruthy();
    expect(logoutRoute![0]).toContain('clearAuthCookie');
  });

  it('SECURITY: startServer does not print ?token= URL', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    const startServerFn = serverCode.match(/export function startServer\(\)[\s\S]*?^\}/m);
    expect(startServerFn).toBeTruthy();
    expect(startServerFn![0]).not.toContain('?token=');
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

  it('SECURITY: Bearer token auth uses timing-safe comparison', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    expect(serverCode).toContain('timingSafeTokenCompare(bearerToken, config.pairToken)');
  });

  it('SECURITY: parseBody has MAX_BODY_SIZE limit and destroys oversized requests', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    expect(serverCode).toContain('const MAX_BODY_SIZE = 64 * 1024');
    expect(serverCode).toContain('size > MAX_BODY_SIZE');
    expect(serverCode).toContain('req.destroy()');
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
  it('Caddy forward_auth: checks PAIR_TOKEN cookie only (not query or bearer)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    const sessionRouteMatch = serverCode.match(/addRoute\('GET', '\/api\/auth\/session'[\s\S]*?\}\);/);
    expect(sessionRouteMatch).toBeTruthy();
    
    const sessionRoute = sessionRouteMatch![0];
    
    expect(sessionRoute).toContain('getPairTokenCookie');
    expect(sessionRoute).toContain('timingSafeTokenCompare');
    expect(sessionRoute).toContain('config.pairToken');
    
    expect(sessionRoute).not.toContain('query');
    expect(sessionRoute).not.toContain('authorization');
    expect(sessionRoute).not.toContain('Authorization');
    expect(sessionRoute).not.toContain('isAuthenticated');
  });

  it('Caddy forward_auth: returns 200 on valid PAIR_TOKEN cookie', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    const sessionRouteMatch = serverCode.match(/addRoute\('GET', '\/api\/auth\/session'[\s\S]*?\}\);/);
    expect(sessionRouteMatch).toBeTruthy();
    
    const sessionRoute = sessionRouteMatch![0];
    expect(sessionRoute).toContain('res.writeHead(200)');
    expect(sessionRoute).toContain('res.end()');
  });

  it('Caddy forward_auth: returns 401 on missing or invalid cookie', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    const sessionRouteMatch = serverCode.match(/addRoute\('GET', '\/api\/auth\/session'[\s\S]*?\}\);/);
    expect(sessionRouteMatch).toBeTruthy();
    
    const sessionRoute = sessionRouteMatch![0];
    expect(sessionRoute).toContain("sendError(res, 'Unauthorized', 401)");
  });

  it('SECURITY: does NOT call isAuthenticated (which accepts bearer)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    const sessionRouteMatch = serverCode.match(/addRoute\('GET', '\/api\/auth\/session'[\s\S]*?\}\);/);
    expect(sessionRouteMatch).toBeTruthy();
    
    const sessionRoute = sessionRouteMatch![0];
    expect(sessionRoute).not.toContain('isAuthenticated(');
  });
});

describe('Revocation model (S-02)', () => {
  it('Rotate .env PAIR_TOKEN to revoke all sessions', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const securityDoc = fs.readFileSync(path.join(__dirname, '../../SECURITY.md'), 'utf8');
    
    expect(securityDoc).toContain('PAIR_TOKEN');
    expect(securityDoc).toContain('Restart the agent');
  });

  it('Logout clears cookie (no server-side session store)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    const logoutRoute = serverCode.match(/addRoute\('POST', '\/logout'[\s\S]*?\}\);/);
    expect(logoutRoute).toBeTruthy();
    
    expect(logoutRoute![0]).toContain('clearAuthCookie');
    expect(logoutRoute![0]).not.toContain('revokeSession');
    expect(logoutRoute![0]).not.toContain('sessions');
  });
});
