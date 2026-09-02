import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DATA_DIR = './test-data-projects';

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

describe('slugifyProjectName', () => {
  it('converts name to lowercase slug', async () => {
    const { slugifyProjectName } = await import('./projects.ts');
    expect(slugifyProjectName('My Project')).toBe('my-project');
    expect(slugifyProjectName('Test  Name')).toBe('test-name');
  });

  it('removes special characters', async () => {
    const { slugifyProjectName } = await import('./projects.ts');
    expect(slugifyProjectName('My@Project#1!')).toBe('my-project-1');
  });

  it('SECURITY: blocks path traversal attempts', async () => {
    const { slugifyProjectName } = await import('./projects.ts');
    expect(slugifyProjectName('../../../tmp/evil')).toBe('tmp-evil');
    expect(slugifyProjectName('..%2F..%2Ftmp')).toBe('2f-2ftmp');
  });

  it('handles unicode names by generating hash-based ID', async () => {
    const { slugifyProjectName } = await import('./projects.ts');
    const result = slugifyProjectName('פרויקט בעברית');
    expect(result).toMatch(/^p-[a-zA-Z0-9_-]+$/);
  });

  it('truncates long names to max length', async () => {
    const { slugifyProjectName } = await import('./projects.ts');
    const longName = 'a'.repeat(100);
    const result = slugifyProjectName(longName);
    expect(result.length).toBeLessThanOrEqual(40);
  });

  it('throws on reserved names', async () => {
    const { slugifyProjectName, ProjectIdValidationError } = await import('./projects.ts');
    expect(() => slugifyProjectName('default')).toThrow(ProjectIdValidationError);
    expect(() => slugifyProjectName('admin')).toThrow(ProjectIdValidationError);
    expect(() => slugifyProjectName('__proto__')).toThrow(ProjectIdValidationError);
  });

  it('throws on empty input', async () => {
    const { slugifyProjectName, ProjectIdValidationError } = await import('./projects.ts');
    expect(() => slugifyProjectName('')).toThrow(ProjectIdValidationError);
    expect(() => slugifyProjectName('   ')).toThrow(ProjectIdValidationError);
  });
});

describe('validateProjectId', () => {
  it('accepts valid project IDs', async () => {
    const { validateProjectId } = await import('./projects.ts');
    expect(validateProjectId('my-project')).toBe('my-project');
    expect(validateProjectId('project123')).toBe('project123');
    expect(validateProjectId('a')).toBe('a');
  });

  it('SECURITY: rejects path traversal characters', async () => {
    const { validateProjectId, ProjectIdValidationError } = await import('./projects.ts');
    expect(() => validateProjectId('../etc')).toThrow(ProjectIdValidationError);
    expect(() => validateProjectId('foo/bar')).toThrow(ProjectIdValidationError);
    expect(() => validateProjectId('foo\\bar')).toThrow(ProjectIdValidationError);
    expect(() => validateProjectId('..')).toThrow(ProjectIdValidationError);
  });

  it('SECURITY: rejects null bytes', async () => {
    const { validateProjectId, ProjectIdValidationError } = await import('./projects.ts');
    expect(() => validateProjectId('foo\x00bar')).toThrow(ProjectIdValidationError);
  });

  it('rejects reserved IDs', async () => {
    const { validateProjectId, ProjectIdValidationError } = await import('./projects.ts');
    expect(() => validateProjectId('default')).toThrow(ProjectIdValidationError);
    expect(() => validateProjectId('constructor')).toThrow(ProjectIdValidationError);
    expect(() => validateProjectId('prototype')).toThrow(ProjectIdValidationError);
  });

  it('normalizes to lowercase', async () => {
    const { validateProjectId } = await import('./projects.ts');
    expect(validateProjectId('MyProject')).toBe('myproject');
  });
});

describe('assertPathInsideDataDir', () => {
  it('allows paths inside data directory', async () => {
    const { assertPathInsideDataDir } = await import('./projects.ts');
    expect(() => assertPathInsideDataDir(`${TEST_DATA_DIR}/projects/test`)).not.toThrow();
  });

  it('SECURITY: blocks paths outside data directory', async () => {
    const { assertPathInsideDataDir, ProjectIdValidationError } = await import('./projects.ts');
    expect(() => assertPathInsideDataDir('/tmp/evil')).toThrow(ProjectIdValidationError);
    expect(() => assertPathInsideDataDir('/etc/passwd')).toThrow(ProjectIdValidationError);
  });

  it('SECURITY: blocks path traversal escapes', async () => {
    const { assertPathInsideDataDir, ProjectIdValidationError } = await import('./projects.ts');
    expect(() => assertPathInsideDataDir(`${TEST_DATA_DIR}/../../../tmp`)).toThrow(ProjectIdValidationError);
  });
});
