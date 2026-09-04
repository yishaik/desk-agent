import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

const TEST_DATA_DIR = './test-data-onboarding';

beforeEach(async () => {
  try {
    const { closeDatabase } = await import('./memory.ts');
    closeDatabase();
  } catch {
    // First test has no database yet.
  }
  vi.resetModules();
  process.env['DATA_DIR'] = TEST_DATA_DIR;
  process.env['DOMAIN'] = 'agent.example.com';
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
  mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(async () => {
  const { closeDatabase } = await import('./memory.ts');
  closeDatabase();
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
  delete process.env['DATA_DIR'];
  delete process.env['DOMAIN'];
});

describe('ensureUsableActiveProject', () => {
  it('migrates the reserved default project to workspace', async () => {
    const { loadSettings, updateSettings } = await import('./settings.ts');
    updateSettings({
      activeProject: 'default',
      projectTokens: { default: 'legacy-token' },
    });

    const { ensureUsableActiveProject } = await import('./onboarding.ts');
    const project = ensureUsableActiveProject();
    const settings = loadSettings();

    expect(project.id).toBe('workspace');
    expect(settings.activeProject).toBe('workspace');
    expect(settings.projectTokens.workspace).toBe('legacy-token');
  });

  it('creates a missing valid active project without renaming it', async () => {
    const { loadSettings, updateSettings } = await import('./settings.ts');
    updateSettings({ activeProject: 'customer-project', businessName: 'Customer Co' });

    const { ensureUsableActiveProject } = await import('./onboarding.ts');
    const project = ensureUsableActiveProject();

    expect(project).toMatchObject({ id: 'customer-project', name: 'Customer Co' });
    expect(loadSettings().activeProject).toBe('customer-project');
  });
});

describe('guided onboarding', () => {
  it('uses the public Settings URL and forbids secrets in WhatsApp', async () => {
    const { buildGuidedOnboardingPrompt } = await import('./onboarding.ts');
    const { DEFAULT_SETTINGS } = await import('./types.ts');
    const prompt = buildGuidedOnboardingPrompt({ ...DEFAULT_SETTINGS, activeProject: 'workspace' });

    expect(prompt).toContain('https://agent.example.com/settings');
    expect(prompt).toContain('one question at a time');
    expect(prompt).toContain('Never ask');
    expect(prompt).toContain('workspace');
  });
});
