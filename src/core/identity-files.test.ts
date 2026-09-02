import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DATA_DIR = './test-data-identity';

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

describe('buildIdentityPrompt', () => {
  it('includes all identity fields when provided', async () => {
    const { buildIdentityPrompt } = await import('./identity-files.ts');
    const { DEFAULT_SETTINGS } = await import('./types.ts');
    
    const settings = {
      ...DEFAULT_SETTINGS,
      botName: 'Test Bot',
      ownerName: 'John Doe',
      businessName: 'Acme Corp',
      businessDescription: 'We sell widgets',
      agentVoice: 'Friendly and professional',
      agentBoundaries: 'No financial advice',
      timezone: 'Asia/Jerusalem',
    };
    
    const content = buildIdentityPrompt(settings);
    
    expect(content).toContain('Test Bot');
    expect(content).toContain('John Doe');
    expect(content).toContain('Acme Corp');
    expect(content).toContain('We sell widgets');
    expect(content).toContain('Friendly and professional');
    expect(content).toContain('No financial advice');
    expect(content).toContain('Asia/Jerusalem');
  });

  it('includes agentBoundaries in the prompt', async () => {
    const { buildIdentityPrompt } = await import('./identity-files.ts');
    const { DEFAULT_SETTINGS } = await import('./types.ts');
    
    const settings = {
      ...DEFAULT_SETTINGS,
      agentBoundaries: 'Never give medical advice. Always refer to professionals.',
    };
    
    const content = buildIdentityPrompt(settings);
    
    expect(content).toContain('## Boundaries');
    expect(content).toContain('Never give medical advice');
    expect(content).toContain('MUST follow these boundaries');
  });

  it('handles missing optional fields gracefully', async () => {
    const { buildIdentityPrompt } = await import('./identity-files.ts');
    const { DEFAULT_SETTINGS } = await import('./types.ts');
    
    const settings = {
      ...DEFAULT_SETTINGS,
      botName: 'Minimal Bot',
      timezone: 'UTC',
    };
    
    const content = buildIdentityPrompt(settings);
    
    expect(content).toContain('Minimal Bot');
    expect(content).toContain('UTC');
    expect(content).not.toContain('## About the Business');
    expect(content).not.toContain('## Voice & Personality');
    expect(content).not.toContain('## Boundaries');
  });
});

describe('generateSoulMd', () => {
  it('generates SOUL.md with all identity fields', async () => {
    const { generateSoulMd } = await import('./identity-files.ts');
    const { DEFAULT_SETTINGS } = await import('./types.ts');
    
    const settings = {
      ...DEFAULT_SETTINGS,
      botName: 'Test Bot',
      ownerName: 'John Doe',
      businessName: 'Acme Corp',
      businessDescription: 'We sell widgets',
      agentVoice: 'Friendly and professional',
      agentBoundaries: 'No financial advice',
      timezone: 'Asia/Jerusalem',
    };
    
    const content = generateSoulMd(settings);
    
    expect(content).toContain('# Test Bot');
    expect(content).toContain('Acme Corp');
    expect(content).toContain('John Doe');
    expect(content).toContain('We sell widgets');
    expect(content).toContain('Friendly and professional');
    expect(content).toContain('No financial advice');
    expect(content).toContain('Asia/Jerusalem');
  });

  it('handles missing optional fields gracefully', async () => {
    const { generateSoulMd } = await import('./identity-files.ts');
    const { DEFAULT_SETTINGS } = await import('./types.ts');
    
    const settings = {
      ...DEFAULT_SETTINGS,
      botName: 'Minimal Bot',
      timezone: 'UTC',
    };
    
    const content = generateSoulMd(settings);
    
    expect(content).toContain('# Minimal Bot');
    expect(content).toContain('UTC');
    expect(content).not.toContain('## About the Business');
    expect(content).not.toContain('## Voice & Personality');
    expect(content).not.toContain('## Boundaries');
  });
});

describe('generateAgentsMd', () => {
  it('generates AGENTS.md with project context', async () => {
    const { generateAgentsMd } = await import('./identity-files.ts');
    const { DEFAULT_SETTINGS } = await import('./types.ts');
    
    const settings = {
      ...DEFAULT_SETTINGS,
      botName: 'Test Bot',
      ownerName: 'John Doe',
      businessName: 'Acme Corp',
      activeProject: 'test-project',
      timezone: 'Asia/Jerusalem',
    };
    
    const content = generateAgentsMd(settings);
    
    expect(content).toContain('# test-project');
    expect(content).toContain('Test Bot');
    expect(content).toContain('John Doe');
    expect(content).toContain('Acme Corp');
    expect(content).toContain('Asia/Jerusalem');
    expect(content).toContain('oc_search_actions');
    expect(content).toContain('oc_execute_action');
  });

  it('includes identity fields like voice and boundaries', async () => {
    const { generateAgentsMd } = await import('./identity-files.ts');
    const { DEFAULT_SETTINGS } = await import('./types.ts');
    
    const settings = {
      ...DEFAULT_SETTINGS,
      botName: 'Identity Bot',
      ownerName: 'Jane Smith',
      businessName: 'Smith Co',
      businessDescription: 'A consulting business',
      agentVoice: 'Professional and concise',
      agentBoundaries: 'No legal advice',
      activeProject: 'identity-test',
      timezone: 'UTC',
    };
    
    const content = generateAgentsMd(settings);
    
    expect(content).toContain('# identity-test');
    expect(content).toContain('Identity Bot');
    expect(content).toContain('Jane Smith');
    expect(content).toContain('Smith Co');
    expect(content).toContain('A consulting business');
    expect(content).toContain('Professional and concise');
    expect(content).toContain('No legal advice');
    expect(content).toContain('## Boundaries');
    expect(content).toContain('## Voice & Personality');
  });
});

describe('writeIdentityFiles', () => {
  it('writes SOUL.md and AGENTS.md to project directory', async () => {
    const { writeIdentityFiles } = await import('./identity-files.ts');
    const { DEFAULT_SETTINGS } = await import('./types.ts');
    
    const settings = {
      ...DEFAULT_SETTINGS,
      botName: 'Test Bot',
      ownerName: 'John Doe',
      businessName: 'Acme Corp',
      businessDescription: 'We sell widgets',
      activeProject: 'test-project',
    };
    
    writeIdentityFiles(settings);
    
    const projectDir = join(TEST_DATA_DIR, 'projects', 'test-project');
    const soulPath = join(projectDir, 'SOUL.md');
    const agentsPath = join(projectDir, 'AGENTS.md');
    
    expect(existsSync(soulPath)).toBe(true);
    expect(existsSync(agentsPath)).toBe(true);
    
    const soulContent = readFileSync(soulPath, 'utf-8');
    const agentsContent = readFileSync(agentsPath, 'utf-8');
    
    expect(soulContent).toContain('Test Bot');
    expect(soulContent).toContain('John Doe');
    expect(soulContent).toContain('Acme Corp');
    expect(soulContent).toContain('We sell widgets');
    
    expect(agentsContent).toContain('test-project');
    expect(agentsContent).toContain('Test Bot');
  });

  it('writes to specified projectId even if different from activeProject', async () => {
    const { writeIdentityFiles } = await import('./identity-files.ts');
    const { DEFAULT_SETTINGS } = await import('./types.ts');
    
    const settings = {
      ...DEFAULT_SETTINGS,
      botName: 'Test Bot',
      ownerName: 'Jane Doe',
      activeProject: 'active-project',
    };
    
    writeIdentityFiles(settings, 'different-project');
    
    const differentProjectDir = join(TEST_DATA_DIR, 'projects', 'different-project');
    const activeProjectDir = join(TEST_DATA_DIR, 'projects', 'active-project');
    
    expect(existsSync(join(differentProjectDir, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(activeProjectDir, 'AGENTS.md'))).toBe(false);
    
    const agentsContent = readFileSync(join(differentProjectDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).toContain('# different-project');
    expect(agentsContent).toContain('Test Bot');
    expect(agentsContent).toContain('Jane Doe');
  });

  it('creates project directory if it does not exist', async () => {
    const { writeIdentityFiles } = await import('./identity-files.ts');
    const { DEFAULT_SETTINGS } = await import('./types.ts');
    
    const settings = {
      ...DEFAULT_SETTINGS,
      activeProject: 'new-project',
    };
    
    const projectDir = join(TEST_DATA_DIR, 'projects', 'new-project');
    expect(existsSync(projectDir)).toBe(false);
    
    writeIdentityFiles(settings);
    
    expect(existsSync(projectDir)).toBe(true);
    expect(existsSync(join(projectDir, 'SOUL.md'))).toBe(true);
    expect(existsSync(join(projectDir, 'AGENTS.md'))).toBe(true);
  });

  it('overwrites existing files on subsequent calls', async () => {
    const { writeIdentityFiles } = await import('./identity-files.ts');
    const { DEFAULT_SETTINGS } = await import('./types.ts');
    
    const projectDir = join(TEST_DATA_DIR, 'projects', 'overwrite-test');
    const soulPath = join(projectDir, 'SOUL.md');
    
    const settings1 = {
      ...DEFAULT_SETTINGS,
      botName: 'First Bot',
      activeProject: 'overwrite-test',
    };
    
    writeIdentityFiles(settings1);
    
    let content = readFileSync(soulPath, 'utf-8');
    expect(content).toContain('First Bot');
    
    const settings2 = {
      ...DEFAULT_SETTINGS,
      botName: 'Second Bot',
      activeProject: 'overwrite-test',
    };
    
    writeIdentityFiles(settings2);
    
    content = readFileSync(soulPath, 'utf-8');
    expect(content).toContain('Second Bot');
    expect(content).not.toContain('First Bot');
  });
});
