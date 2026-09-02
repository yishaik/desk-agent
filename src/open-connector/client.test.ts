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
  it('checkHealth uses authenticated /v1/health (not bare fetch)', async () => {
    vi.resetModules();
    
    const { OpenConnectorClient } = await import('./client.ts');
    
    const client = new OpenConnectorClient();
    
    const checkHealthSource = client.checkHealth.toString();
    expect(checkHealthSource).toContain('this.request');
    expect(checkHealthSource).toContain('/v1/health');
    expect(checkHealthSource).not.toContain('fetch(');
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

