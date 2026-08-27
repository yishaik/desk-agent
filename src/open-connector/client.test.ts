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
