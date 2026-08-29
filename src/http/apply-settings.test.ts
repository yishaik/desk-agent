import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { DEFAULT_SETTINGS } from '../core/types.ts';

const TEST_DATA_DIR = './test-data-apply-settings';

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

describe('detectChangedFields', () => {
  it('detects no changes when objects are equal', async () => {
    const { detectChangedFields } = await import('./apply-settings.ts');
    
    const old = { botName: 'Test', model: 'claude' };
    const updated = { botName: 'Test', model: 'claude' };
    
    expect(detectChangedFields(old, updated)).toEqual([]);
  });

  it('detects changed fields', async () => {
    const { detectChangedFields } = await import('./apply-settings.ts');
    
    const old = { botName: 'Old', model: 'claude' };
    const updated = { botName: 'New', model: 'claude' };
    
    expect(detectChangedFields(old, updated)).toContain('botName');
    expect(detectChangedFields(old, updated)).not.toContain('model');
  });

  it('detects multiple changed fields', async () => {
    const { detectChangedFields } = await import('./apply-settings.ts');
    
    const old = { botName: 'Old', model: 'claude', timezone: 'UTC' };
    const updated = { botName: 'New', model: 'gpt', timezone: 'UTC' };
    
    const changed = detectChangedFields(old, updated);
    expect(changed).toContain('botName');
    expect(changed).toContain('model');
    expect(changed).not.toContain('timezone');
  });

  it('detects added fields', async () => {
    const { detectChangedFields } = await import('./apply-settings.ts');
    
    const old = { botName: 'Test' };
    const updated = { botName: 'Test', model: 'claude' };
    
    expect(detectChangedFields(old, updated)).toContain('model');
  });
});

describe('applySavedSettings', () => {
  it('calls setSessionModel for model changes', async () => {
    const mockSetSessionModel = vi.fn().mockResolvedValue(undefined);
    const mockClearSession = vi.fn();
    const mockGetOrCreateSession = vi.fn().mockResolvedValue({});
    
    vi.doMock('../agent/session.ts', () => ({
      setSessionModel: mockSetSessionModel,
      clearSession: mockClearSession,
      getOrCreateSession: mockGetOrCreateSession,
    }));
    
    vi.resetModules();
    const { applySavedSettings } = await import('./apply-settings.ts');
    
    const settings = {
      ...DEFAULT_SETTINGS,
      activeProject: 'test-project',
      model: 'anthropic/claude-sonnet-4-6',
    };
    
    await applySavedSettings(settings, ['model']);
    
    expect(mockSetSessionModel).toHaveBeenCalledWith('test-project', 'anthropic/claude-sonnet-4-6');
    expect(mockClearSession).not.toHaveBeenCalled();
  });

  it('calls clearSession and getOrCreateSession for identity changes', async () => {
    const mockSetSessionModel = vi.fn().mockResolvedValue(undefined);
    const mockClearSession = vi.fn();
    const mockGetOrCreateSession = vi.fn().mockResolvedValue({});
    
    vi.doMock('../agent/session.ts', () => ({
      setSessionModel: mockSetSessionModel,
      clearSession: mockClearSession,
      getOrCreateSession: mockGetOrCreateSession,
    }));
    
    vi.resetModules();
    const { applySavedSettings } = await import('./apply-settings.ts');
    
    const settings = {
      ...DEFAULT_SETTINGS,
      activeProject: 'test-project',
      model: 'claude',
      botName: 'New Bot',
    };
    
    await applySavedSettings(settings, ['botName']);
    
    expect(mockClearSession).toHaveBeenCalledWith('test-project');
    expect(mockGetOrCreateSession).toHaveBeenCalledWith('test-project');
    expect(mockSetSessionModel).not.toHaveBeenCalled();
  });

  it('recognizes all identity fields', async () => {
    const mockSetSessionModel = vi.fn().mockResolvedValue(undefined);
    const mockClearSession = vi.fn();
    const mockGetOrCreateSession = vi.fn().mockResolvedValue({});
    
    vi.doMock('../agent/session.ts', () => ({
      setSessionModel: mockSetSessionModel,
      clearSession: mockClearSession,
      getOrCreateSession: mockGetOrCreateSession,
    }));
    
    const identityFields = [
      'ownerName',
      'businessName',
      'businessDescription',
      'botName',
      'agentVoice',
      'agentBoundaries',
      'timezone',
    ];
    
    for (const field of identityFields) {
      vi.resetModules();
      mockClearSession.mockClear();
      mockGetOrCreateSession.mockClear();
      
      const { applySavedSettings } = await import('./apply-settings.ts');
      
      const settings = {
        ...DEFAULT_SETTINGS,
        activeProject: 'test-project',
        model: 'claude',
      };
      
      await applySavedSettings(settings, [field]);
      
      expect(mockClearSession).toHaveBeenCalledWith('test-project');
      expect(mockGetOrCreateSession).toHaveBeenCalledWith('test-project');
    }
  });

  it('does nothing for non-session-affecting changes', async () => {
    const mockSetSessionModel = vi.fn().mockResolvedValue(undefined);
    const mockClearSession = vi.fn();
    const mockGetOrCreateSession = vi.fn().mockResolvedValue({});
    
    vi.doMock('../agent/session.ts', () => ({
      setSessionModel: mockSetSessionModel,
      clearSession: mockClearSession,
      getOrCreateSession: mockGetOrCreateSession,
    }));
    
    vi.resetModules();
    const { applySavedSettings } = await import('./apply-settings.ts');
    
    const settings = {
      ...DEFAULT_SETTINGS,
      activeProject: 'test-project',
      model: 'claude',
    };
    
    await applySavedSettings(settings, ['apiKeyMode']);
    
    expect(mockSetSessionModel).not.toHaveBeenCalled();
    expect(mockClearSession).not.toHaveBeenCalled();
    expect(mockGetOrCreateSession).not.toHaveBeenCalled();
  });

  it('prioritizes model change over identity change', async () => {
    const mockSetSessionModel = vi.fn().mockResolvedValue(undefined);
    const mockClearSession = vi.fn();
    const mockGetOrCreateSession = vi.fn().mockResolvedValue({});
    
    vi.doMock('../agent/session.ts', () => ({
      setSessionModel: mockSetSessionModel,
      clearSession: mockClearSession,
      getOrCreateSession: mockGetOrCreateSession,
    }));
    
    vi.resetModules();
    const { applySavedSettings } = await import('./apply-settings.ts');
    
    const settings = {
      ...DEFAULT_SETTINGS,
      activeProject: 'test-project',
      model: 'anthropic/claude-sonnet-4-6',
    };
    
    await applySavedSettings(settings, ['model', 'botName']);
    
    expect(mockSetSessionModel).toHaveBeenCalledWith('test-project', 'anthropic/claude-sonnet-4-6');
    expect(mockClearSession).not.toHaveBeenCalled();
  });
});
