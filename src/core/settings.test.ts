import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DATA_DIR = './test-data';

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

describe('Settings', () => {
  it('creates default settings on first load', async () => {
    const settingsModule = await import('./settings.ts');
    const typesModule = await import('./types.ts');
    const settings = settingsModule.loadSettings();
    
    expect(settings.botName).toBe(typesModule.DEFAULT_SETTINGS.botName);
    expect(settings.apiKeyMode).toBe('shared');
    expect(settings.setupComplete).toBe(false);
    expect(existsSync(join(TEST_DATA_DIR, 'settings.json'))).toBe(true);
  });

  it('persists and reloads settings', async () => {
    const { loadSettings, updateSettings } = await import('./settings.ts');
    
    updateSettings({ botName: 'Test Bot', ownerName: 'Test Owner' });
    
    const reloaded = loadSettings();
    expect(reloaded.botName).toBe('Test Bot');
    expect(reloaded.ownerName).toBe('Test Owner');
  });

  it('handles api key mode changes', async () => {
    const { loadSettings, setApiKeyMode } = await import('./settings.ts');
    
    setApiKeyMode('per-project');
    
    const settings = loadSettings();
    expect(settings.apiKeyMode).toBe('per-project');
  });

  it('manages project tokens', async () => {
    const { loadSettings, setProjectToken, removeProjectToken } = await import('./settings.ts');
    
    setProjectToken('project-a', 'token-a');
    setProjectToken('project-b', 'token-b');
    
    let settings = loadSettings();
    expect(settings.projectTokens['project-a']).toBe('token-a');
    expect(settings.projectTokens['project-b']).toBe('token-b');
    
    removeProjectToken('project-a');
    settings = loadSettings();
    expect(settings.projectTokens['project-a']).toBeUndefined();
    expect(settings.projectTokens['project-b']).toBe('token-b');
  });
});

describe('getActiveConnectorToken', () => {
  beforeEach(() => {
    delete process.env['OPEN_CONNECTOR_TOKEN'];
  });

  it('returns shared token in shared mode', async () => {
    const { loadSettings, updateSettings, getActiveConnectorToken } = await import('./settings.ts');
    
    updateSettings({ 
      apiKeyMode: 'shared',
      sharedConnectorToken: 'shared-token',
    });
    
    const settings = loadSettings();
    const token = getActiveConnectorToken(settings);
    expect(token).toBe('shared-token');
  });

  it('returns project token in per-project mode when available', async () => {
    const { loadSettings, updateSettings, setProjectToken, getActiveConnectorToken } = await import('./settings.ts');
    
    updateSettings({ 
      apiKeyMode: 'per-project',
      sharedConnectorToken: 'shared-token',
      activeProject: 'project-a',
    });
    setProjectToken('project-a', 'project-a-token');
    
    const settings = loadSettings();
    const token = getActiveConnectorToken(settings);
    expect(token).toBe('project-a-token');
  });

  it('falls back to shared token when project token missing in per-project mode', async () => {
    const { loadSettings, updateSettings, getActiveConnectorToken } = await import('./settings.ts');
    
    updateSettings({ 
      apiKeyMode: 'per-project',
      sharedConnectorToken: 'shared-token',
      activeProject: 'project-without-token',
    });
    
    const settings = loadSettings();
    const token = getActiveConnectorToken(settings);
    expect(token).toBe('shared-token');
  });

  it('respects explicit projectId parameter', async () => {
    const { loadSettings, updateSettings, setProjectToken, getActiveConnectorToken } = await import('./settings.ts');
    
    updateSettings({ 
      apiKeyMode: 'per-project',
      sharedConnectorToken: 'shared-token',
      activeProject: 'default',
    });
    setProjectToken('other-project', 'other-token');
    
    const settings = loadSettings();
    const token = getActiveConnectorToken(settings, 'other-project');
    expect(token).toBe('other-token');
  });

  it('uses env token as fallback when no settings token', async () => {
    process.env['OPEN_CONNECTOR_TOKEN'] = 'env-token';
    
    vi.resetModules();
    
    const configModule = await import('./config.ts');
    expect(configModule.config.openConnectorToken).toBe('env-token');
    
    const { loadSettings, getActiveConnectorToken } = await import('./settings.ts');
    const settings = loadSettings();
    
    const token = getActiveConnectorToken(settings);
    expect(token).toBe('env-token');
  });
});
