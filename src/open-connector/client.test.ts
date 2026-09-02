import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DATA_DIR = './test-data-oc';

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
  delete process.env['OPEN_CONNECTOR_TOKEN'];
});

describe('OpenConnectorClient', () => {
  it('uses getActiveConnectorToken for token resolution', async () => {
    process.env['OPEN_CONNECTOR_TOKEN'] = 'env-token-123';
    
    vi.resetModules();
    
    const { loadSettings, updateSettings, setProjectToken, getActiveConnectorToken } = await import('../core/settings.ts');
    const { OpenConnectorClient } = await import('./client.ts');
    
    updateSettings({
      apiKeyMode: 'per-project',
      activeProject: 'test-project',
    });
    setProjectToken('test-project', 'project-token-456');
    
    const settings = loadSettings();
    const resolvedToken = getActiveConnectorToken(settings, 'test-project');
    
    expect(resolvedToken).toBe('project-token-456');
    
    const client = new OpenConnectorClient('test-project');
    expect(client).toBeDefined();
  });

  it('falls back to shared token when project has no token', async () => {
    vi.resetModules();
    
    const { loadSettings, updateSettings, getActiveConnectorToken } = await import('../core/settings.ts');
    
    updateSettings({
      apiKeyMode: 'per-project',
      sharedConnectorToken: 'shared-token-789',
      activeProject: 'no-token-project',
    });
    
    const settings = loadSettings();
    const resolvedToken = getActiveConnectorToken(settings, 'no-token-project');
    
    expect(resolvedToken).toBe('shared-token-789');
  });

  it('uses shared mode when apiKeyMode is shared', async () => {
    vi.resetModules();
    
    const { loadSettings, updateSettings, setProjectToken, getActiveConnectorToken } = await import('../core/settings.ts');
    
    updateSettings({
      apiKeyMode: 'shared',
      sharedConnectorToken: 'shared-token',
      activeProject: 'any-project',
    });
    setProjectToken('any-project', 'project-token');
    
    const settings = loadSettings();
    const resolvedToken = getActiveConnectorToken(settings);
    
    expect(resolvedToken).toBe('shared-token');
  });

  it('respects project parameter over active project', async () => {
    vi.resetModules();
    
    const { loadSettings, updateSettings, setProjectToken, getActiveConnectorToken } = await import('../core/settings.ts');
    
    updateSettings({
      apiKeyMode: 'per-project',
      activeProject: 'active-project',
    });
    setProjectToken('active-project', 'active-token');
    setProjectToken('other-project', 'other-token');
    
    const settings = loadSettings();
    
    const activeToken = getActiveConnectorToken(settings);
    expect(activeToken).toBe('active-token');
    
    const otherToken = getActiveConnectorToken(settings, 'other-project');
    expect(otherToken).toBe('other-token');
  });
});

describe('Token resolution in handler', () => {
  it('handler uses project-specific token when in per-project mode', async () => {
    process.env['OPEN_CONNECTOR_URL'] = 'http://localhost:3000';
    
    vi.resetModules();
    
    const { loadSettings, updateSettings, setProjectToken, getActiveConnectorToken } = await import('../core/settings.ts');
    
    updateSettings({
      apiKeyMode: 'per-project',
      activeProject: 'client-a',
    });
    setProjectToken('client-a', 'client-a-token');
    setProjectToken('client-b', 'client-b-token');
    
    const settings = loadSettings();
    
    expect(getActiveConnectorToken(settings)).toBe('client-a-token');
    
    updateSettings({ activeProject: 'client-b' });
    const updatedSettings = loadSettings();
    expect(getActiveConnectorToken(updatedSettings)).toBe('client-b-token');
  });
});

describe('API Path Correctness', () => {
  it('listProviders should use /v1/providers not /v1/apps', async () => {
    vi.resetModules();
    
    const { OpenConnectorClient } = await import('./client.ts');
    
    const client = new OpenConnectorClient();
    
    const listProvidersSource = client.listProviders.toString();
    expect(listProvidersSource).toContain('/v1/providers');
    expect(listProvidersSource).not.toMatch(/['"]\/v1\/apps['"]/);
  });

  it('listConnections should use /api/connections', async () => {
    vi.resetModules();
    
    const { OpenConnectorClient } = await import('./client.ts');
    
    const client = new OpenConnectorClient();
    
    const listConnectionsSource = client.listConnections.toString();
    expect(listConnectionsSource).toContain('/api/connections');
  });

  it('startOAuth should use /api/oauth/authorizations', async () => {
    vi.resetModules();
    
    const { OpenConnectorClient } = await import('./client.ts');
    
    const client = new OpenConnectorClient();
    
    const startOAuthSource = client.startOAuth.toString();
    expect(startOAuthSource).toContain('/api/oauth/authorizations');
  });

  it('disconnectService should use DELETE /api/connections/:service', async () => {
    vi.resetModules();
    
    const { OpenConnectorClient } = await import('./client.ts');
    
    const client = new OpenConnectorClient();
    
    const disconnectServiceSource = client.disconnectService.toString();
    expect(disconnectServiceSource).toContain('/api/connections/');
    expect(disconnectServiceSource).toContain('DELETE');
  });

  it('listConnectedApps should use /v1/apps for connected apps', async () => {
    vi.resetModules();
    
    const { OpenConnectorClient } = await import('./client.ts');
    
    const client = new OpenConnectorClient();
    
    const listConnectedAppsSource = client.listConnectedApps.toString();
    expect(listConnectedAppsSource).toContain('/v1/apps');
  });

  it('listActions should handle both raw array and {success,data} responses', async () => {
    vi.resetModules();
    
    const { OpenConnectorClient } = await import('./client.ts');
    
    const client = new OpenConnectorClient();
    
    const listActionsSource = client.listActions.toString();
    expect(listActionsSource).toContain('Array.isArray');
    expect(listActionsSource).toContain('/v1/actions');
  });

  it('disconnectService should accept connectionName parameter', async () => {
    vi.resetModules();
    
    const { OpenConnectorClient } = await import('./client.ts');
    
    const client = new OpenConnectorClient();
    
    const disconnectServiceSource = client.disconnectService.toString();
    expect(disconnectServiceSource).toContain('connectionName');
    expect(disconnectServiceSource).toContain('?connectionName=');
  });
});

describe('Health Check Path', () => {
  it('checkHealth uses unauthenticated /health (not /v1/health)', async () => {
    vi.resetModules();
    
    const { OpenConnectorClient } = await import('./client.ts');
    
    const client = new OpenConnectorClient();
    
    const checkHealthSource = client.checkHealth.toString();
    expect(checkHealthSource).toContain('/health');
    expect(checkHealthSource).not.toContain('/v1/health');
    expect(checkHealthSource).not.toContain('this.request');
  });

  it('handler /status uses OpenConnectorClient.checkHealth not standalone fetch', async () => {
    vi.resetModules();
    
    const handlerSource = await import('node:fs').then(fs => 
      fs.readFileSync('./src/whatsapp/handler.ts', 'utf-8')
    );
    
    expect(handlerSource).not.toMatch(/fetch\([^)]*\/v1\/health/);
    expect(handlerSource).not.toMatch(/checkConnectorHealth\(\)/);
    expect(handlerSource).toContain('client.checkHealth()');
  });
});

describe('isRealConnection helper', () => {
  it('identifies oauth2 as real connection', async () => {
    vi.resetModules();
    
    const { isRealConnection } = await import('./client.ts');
    
    expect(isRealConnection({ service: 'gmail', connectionName: 'default', authType: 'oauth2' })).toBe(true);
  });

  it('identifies api_key as real connection', async () => {
    vi.resetModules();
    
    const { isRealConnection } = await import('./client.ts');
    
    expect(isRealConnection({ service: 'openai', connectionName: 'default', authType: 'api_key' })).toBe(true);
  });

  it('rejects no_auth as NOT real', async () => {
    vi.resetModules();
    
    const { isRealConnection } = await import('./client.ts');
    
    expect(isRealConnection({ service: 'arxiv', connectionName: 'default', authType: 'no_auth' })).toBe(false);
  });

  it('rejects virtual:true as NOT real', async () => {
    vi.resetModules();
    
    const { isRealConnection } = await import('./client.ts');
    
    expect(isRealConnection({ service: 'test', connectionName: 'default', authType: 'oauth2', virtual: true })).toBe(false);
  });

  it('rejects virtual no_auth catalog providers', async () => {
    vi.resetModules();
    
    const { isRealConnection } = await import('./client.ts');
    
    expect(isRealConnection({ service: 'wikipedia', connectionName: 'default', authType: 'no_auth', virtual: true })).toBe(false);
  });
});

describe('Path traversal protection (#30)', () => {
  it('getActionGuide rejects path traversal actionId before request', async () => {
    vi.resetModules();
    
    const { OpenConnectorClient } = await import('./client.ts');
    const client = new OpenConnectorClient();
    
    await expect(client.getActionGuide('../x')).rejects.toThrow('invalid action id');
    await expect(client.getActionGuide('../../connections')).rejects.toThrow('invalid action id');
    await expect(client.getActionGuide('../../../etc/passwd')).rejects.toThrow('invalid action id');
  });

  it('getAction rejects invalid actionId', async () => {
    vi.resetModules();
    
    const { OpenConnectorClient } = await import('./client.ts');
    const client = new OpenConnectorClient();
    
    await expect(client.getAction('../x')).rejects.toThrow('invalid action id');
    await expect(client.getAction('')).rejects.toThrow('invalid action id');
  });

  it('executeAction rejects invalid actionId', async () => {
    vi.resetModules();
    
    const { OpenConnectorClient } = await import('./client.ts');
    const client = new OpenConnectorClient();
    
    await expect(client.executeAction({ actionId: '../x', input: {} })).rejects.toThrow('invalid action id');
  });

  it('listActions rejects invalid serviceId', async () => {
    vi.resetModules();
    
    const { OpenConnectorClient } = await import('./client.ts');
    const client = new OpenConnectorClient();
    
    await expect(client.listActions('../x')).rejects.toThrow('invalid service id');
  });

  it('getProvider rejects invalid serviceId', async () => {
    vi.resetModules();
    
    const { OpenConnectorClient } = await import('./client.ts');
    const client = new OpenConnectorClient();
    
    await expect(client.getProvider('../x')).rejects.toThrow('invalid service id');
  });

  it('disconnectService rejects invalid serviceId', async () => {
    vi.resetModules();
    
    const { OpenConnectorClient } = await import('./client.ts');
    const client = new OpenConnectorClient();
    
    await expect(client.disconnectService('../x')).rejects.toThrow('invalid service id');
  });

  it('accepts valid actionId formats', async () => {
    vi.resetModules();
    
    const { OpenConnectorClient } = await import('./client.ts');
    const client = new OpenConnectorClient();
    
    const validIds = [
      'gmail.send_email',
      'googlecalendar.list_events',
      'notion.create_page',
      'my-service.my_action',
      'a1.b2-c3_d4',
    ];
    
    for (const id of validIds) {
      expect(() => client.getAction(id)).not.toThrow('invalid action id');
    }
  });
});

describe('S-07: Admin token isolation (#111)', () => {
  it('client.ts does NOT reference connectorAdminToken in request logic', async () => {
    vi.resetModules();
    const fs = await import('node:fs');
    const code = fs.readFileSync('./src/open-connector/client.ts', 'utf-8');
    
    // The request() method should NOT prefer connectorAdminToken
    expect(code).not.toMatch(/path\.startsWith\(['"]\/api/);
    expect(code).not.toMatch(/connectorAdminToken\s*\?\?/);
  });

  it('request method uses only runtime token (getToken)', async () => {
    vi.resetModules();
    const fs = await import('node:fs');
    const code = fs.readFileSync('./src/open-connector/client.ts', 'utf-8');
    
    // Find the request method and verify it uses this.getToken() directly
    const requestMethod = code.match(/private async request<T>\([^)]+\)[\s\S]*?const token = ([^;]+);/);
    expect(requestMethod).not.toBeNull();
    expect(requestMethod![1]).toBe('this.getToken()');
  });

  it('getActionGuide uses only runtime token', async () => {
    vi.resetModules();
    const fs = await import('node:fs');
    const code = fs.readFileSync('./src/open-connector/client.ts', 'utf-8');
    
    // getActionGuide should use this.getToken(), not config.connectorAdminToken
    const getActionGuide = code.match(/async getActionGuide\([^)]+\)[\s\S]*?const token = ([^;]+);/);
    expect(getActionGuide).not.toBeNull();
    expect(getActionGuide![1]).toBe('this.getToken()');
  });

  it('docker-compose.yml does NOT pass CONNECTOR_ADMIN_TOKEN to agent', async () => {
    vi.resetModules();
    const fs = await import('node:fs');
    const dockerCompose = fs.readFileSync('./docker-compose.yml', 'utf-8');
    
    // Find the agent service section
    const agentSection = dockerCompose.match(/services:\s*\n\s*#.*\n\s*agent:[\s\S]*?(?=\n\s*#.*connector:|$)/);
    expect(agentSection).not.toBeNull();
    
    // CONNECTOR_ADMIN_TOKEN should NOT appear as an env var in agent section
    // (it can appear as a comment explaining why it was removed)
    const agentEnv = agentSection![0];
    expect(agentEnv).not.toMatch(/^\s*-\s*CONNECTOR_ADMIN_TOKEN=/m);
  });
});

describe('S-07: OAuth flows work WITHOUT admin token (#111 product lock)', () => {
  let originalFetch: typeof globalThis.fetch;
  let capturedRequests: Array<{ url: string; options: RequestInit }>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedRequests = [];
    
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      capturedRequests.push({ url, options: init ?? {} });
      
      // Mock successful OAuth start response
      if (url.includes('/api/oauth/authorizations')) {
        return new Response(JSON.stringify({
          authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?client_id=test',
          state: 'test-state-123',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Mock successful connections list
      if (url.includes('/api/connections') && !init?.method) {
        return new Response(JSON.stringify({
          success: true,
          data: [{ service: 'gmail', connectionName: 'default', authType: 'oauth2' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Mock successful disconnect
      if (url.includes('/api/connections/') && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      return new Response('Not found', { status: 404 });
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env['CONNECTOR_ADMIN_TOKEN'];
  });

  it('gmail OAuth start returns authorizationUrl with runtime token only (no admin token)', async () => {
    // Simulate agent env: runtime token present, admin token ABSENT
    process.env['OPEN_CONNECTOR_TOKEN'] = 'runtime-token-xyz';
    delete process.env['CONNECTOR_ADMIN_TOKEN'];
    
    vi.resetModules();
    
    const { updateSettings } = await import('../core/settings.ts');
    updateSettings({ sharedConnectorToken: 'runtime-token-xyz' });
    
    const { OpenConnectorClient } = await import('./client.ts');
    const client = new OpenConnectorClient();
    
    const result = await client.startOAuth('gmail');
    
    expect(result.authorizationUrl).toContain('https://accounts.google.com');
    expect(result.state).toBeDefined();
    
    // Verify the request used runtime token, not admin token
    const oauthRequest = capturedRequests.find(r => r.url.includes('/api/oauth/authorizations'));
    expect(oauthRequest).toBeDefined();
    expect(oauthRequest!.options.headers).toBeDefined();
    const headers = oauthRequest!.options.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer runtime-token-xyz');
  });

  it('googlecalendar OAuth start returns authorizationUrl with runtime token only', async () => {
    process.env['OPEN_CONNECTOR_TOKEN'] = 'runtime-token-calendar';
    delete process.env['CONNECTOR_ADMIN_TOKEN'];
    
    vi.resetModules();
    
    const { updateSettings } = await import('../core/settings.ts');
    updateSettings({ sharedConnectorToken: 'runtime-token-calendar' });
    
    const { OpenConnectorClient } = await import('./client.ts');
    const client = new OpenConnectorClient();
    
    const result = await client.startOAuth('googlecalendar');
    
    expect(result.authorizationUrl).toContain('https://accounts.google.com');
    
    const oauthRequest = capturedRequests.find(r => r.url.includes('/api/oauth/authorizations'));
    expect(oauthRequest).toBeDefined();
    const headers = oauthRequest!.options.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer runtime-token-calendar');
  });

  it('listConnections uses runtime token when admin token is absent', async () => {
    process.env['OPEN_CONNECTOR_TOKEN'] = 'runtime-list-token';
    delete process.env['CONNECTOR_ADMIN_TOKEN'];
    
    vi.resetModules();
    
    const { updateSettings } = await import('../core/settings.ts');
    updateSettings({ sharedConnectorToken: 'runtime-list-token' });
    
    const { OpenConnectorClient } = await import('./client.ts');
    const client = new OpenConnectorClient();
    
    const connections = await client.listConnections();
    
    expect(connections).toBeDefined();
    expect(Array.isArray(connections)).toBe(true);
    
    const listRequest = capturedRequests.find(r => r.url.includes('/api/connections') && !r.options.method);
    expect(listRequest).toBeDefined();
    const headers = listRequest!.options.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer runtime-list-token');
  });

  it('disconnectService uses runtime token when admin token is absent', async () => {
    process.env['OPEN_CONNECTOR_TOKEN'] = 'runtime-disconnect-token';
    delete process.env['CONNECTOR_ADMIN_TOKEN'];
    
    vi.resetModules();
    
    const { updateSettings } = await import('../core/settings.ts');
    updateSettings({ sharedConnectorToken: 'runtime-disconnect-token' });
    
    const { OpenConnectorClient } = await import('./client.ts');
    const client = new OpenConnectorClient();
    
    await client.disconnectService('gmail', 'default');
    
    const deleteRequest = capturedRequests.find(r => r.options.method === 'DELETE');
    expect(deleteRequest).toBeDefined();
    const headers = deleteRequest!.options.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer runtime-disconnect-token');
  });

  it('OAuth start uses runtime token even when admin token IS present (ignores admin)', async () => {
    // Even if admin token somehow exists, the client should use runtime token
    process.env['OPEN_CONNECTOR_TOKEN'] = 'runtime-token-preferred';
    process.env['CONNECTOR_ADMIN_TOKEN'] = 'admin-token-should-be-ignored';
    
    vi.resetModules();
    
    const { updateSettings } = await import('../core/settings.ts');
    updateSettings({ sharedConnectorToken: 'runtime-token-preferred' });
    
    const { OpenConnectorClient } = await import('./client.ts');
    const client = new OpenConnectorClient();
    
    await client.startOAuth('gmail');
    
    const oauthRequest = capturedRequests.find(r => r.url.includes('/api/oauth/authorizations'));
    expect(oauthRequest).toBeDefined();
    const headers = oauthRequest!.options.headers as Record<string, string>;
    // MUST use runtime token, NOT admin token
    expect(headers['Authorization']).toBe('Bearer runtime-token-preferred');
    expect(headers['Authorization']).not.toContain('admin-token');
  });
});

