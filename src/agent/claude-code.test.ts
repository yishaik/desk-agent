import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DATA_DIR = './test-data-claude-code';

beforeEach(() => {
  vi.resetModules();
  process.env['DATA_DIR'] = TEST_DATA_DIR;
  process.env['OPEN_CONNECTOR_TOKEN'] = 'test-connector-token';
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
  delete process.env['ANTHROPIC_API_KEY'];
  delete process.env['MODEL_API_KEY'];
  delete process.env['PAIR_TOKEN'];
});

describe('Issue #31: Claude Code child env security', () => {
  it('buildClaudeCodeEnv does not include ANTHROPIC_API_KEY', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'secret-api-key';
    
    const mod = await import('./claude-code.ts');
    const buildEnv = (mod as any).buildClaudeCodeEnv;
    
    if (typeof buildEnv !== 'function') {
      const code = readFileSync(join(process.cwd(), 'src/agent/claude-code.ts'), 'utf8');
      expect(code).not.toContain('...process.env');
      expect(code).toContain('buildClaudeCodeEnv');
      return;
    }
    
    const env = buildEnv();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('buildClaudeCodeEnv does not include MODEL_API_KEY', async () => {
    process.env['MODEL_API_KEY'] = 'secret-model-key';
    
    const mod = await import('./claude-code.ts');
    const buildEnv = (mod as any).buildClaudeCodeEnv;
    
    if (typeof buildEnv !== 'function') {
      const code = readFileSync(join(process.cwd(), 'src/agent/claude-code.ts'), 'utf8');
      expect(code).not.toContain('...process.env');
      return;
    }
    
    const env = buildEnv();
    expect(env['MODEL_API_KEY']).toBeUndefined();
  });

  it('buildClaudeCodeEnv does not include PAIR_TOKEN', async () => {
    process.env['PAIR_TOKEN'] = 'secret-pair-token';
    
    const mod = await import('./claude-code.ts');
    const buildEnv = (mod as any).buildClaudeCodeEnv;
    
    if (typeof buildEnv !== 'function') {
      const code = readFileSync(join(process.cwd(), 'src/agent/claude-code.ts'), 'utf8');
      expect(code).not.toContain('...process.env');
      return;
    }
    
    const env = buildEnv();
    expect(env['PAIR_TOKEN']).toBeUndefined();
  });

  it('buildClaudeCodeEnv includes only safe env vars', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'secret';
    process.env['MODEL_API_KEY'] = 'secret';
    process.env['PAIR_TOKEN'] = 'secret';
    process.env['CONNECTOR_ADMIN_TOKEN'] = 'secret';
    
    const mod = await import('./claude-code.ts');
    const buildEnv = (mod as any).buildClaudeCodeEnv;
    
    if (typeof buildEnv !== 'function') {
      return;
    }
    
    const env = buildEnv();
    const allowedKeys = ['PATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'TERM', 'LANG', 'DISABLE_AUTOUPDATER', 'COLUMNS'];
    
    for (const key of Object.keys(env)) {
      expect(allowedKeys).toContain(key);
    }
  });

  it('spawn does not use ...process.env spread', async () => {
    const code = readFileSync(join(process.cwd(), 'src/agent/claude-code.ts'), 'utf8');
    
    const spawnEnvMatches = code.match(/spawn\([^)]+\{[^}]*env:\s*\{[^}]*\.\.\.process\.env/g);
    expect(spawnEnvMatches).toBeNull();
  });

  it('MCP config does not include PAIR_TOKEN', async () => {
    const mod = await import('./claude-code.ts');
    const buildMcpConfig = (mod as any).buildMcpConfig;
    
    if (typeof buildMcpConfig !== 'function') {
      const code = readFileSync(join(process.cwd(), 'src/agent/claude-code.ts'), 'utf8');
      const mcpEnvSection = code.match(/mcpServers[\s\S]*?env:\s*\{([^}]+)\}/);
      expect(mcpEnvSection).not.toBeNull();
      expect(mcpEnvSection![1]).not.toContain('PAIR_TOKEN');
      return;
    }
    
    const configPath = buildMcpConfig('test-project');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const mcpEnv = config.mcpServers.connector.env;
    
    expect(mcpEnv['PAIR_TOKEN']).toBeUndefined();
  });

  it('MCP config does not include CONNECTOR_ADMIN_TOKEN', async () => {
    const mod = await import('./claude-code.ts');
    const buildMcpConfig = (mod as any).buildMcpConfig;
    
    if (typeof buildMcpConfig !== 'function') {
      return;
    }
    
    const configPath = buildMcpConfig('test-project');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const mcpEnv = config.mcpServers.connector.env;
    
    expect(mcpEnv['CONNECTOR_ADMIN_TOKEN']).toBeUndefined();
  });

  it('MCP config is written to file with 0600 permissions', async () => {
    const mod = await import('./claude-code.ts');
    const buildMcpConfig = (mod as any).buildMcpConfig;
    
    if (typeof buildMcpConfig !== 'function') {
      return;
    }
    
    const configPath = buildMcpConfig('test-project');
    expect(existsSync(configPath)).toBe(true);
    
    const stat = statSync(configPath);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('MCP config includes DESK_MCP_SERVER=1 flag', async () => {
    const mod = await import('./claude-code.ts');
    const buildMcpConfig = (mod as any).buildMcpConfig;
    
    if (typeof buildMcpConfig !== 'function') {
      const code = readFileSync(join(process.cwd(), 'src/agent/claude-code.ts'), 'utf8');
      expect(code).toContain('DESK_MCP_SERVER');
      return;
    }
    
    const configPath = buildMcpConfig('test-project');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const mcpEnv = config.mcpServers.connector.env;
    
    expect(mcpEnv['DESK_MCP_SERVER']).toBe('1');
  });
});

describe('Issue #32: Session handling and prompt delivery', () => {
  it('prompt is passed via stdin, not argv (-p -)', async () => {
    const code = readFileSync(join(process.cwd(), 'src/agent/claude-code.ts'), 'utf8');
    
    expect(code).toContain("'-p', '-'");
    expect(code).toContain('child.stdin?.write(text)');
    expect(code).toContain('child.stdin?.end()');
  });

  it('SESSION_INVALID_PATTERNS are defined for targeted retry', async () => {
    const code = readFileSync(join(process.cwd(), 'src/agent/claude-code.ts'), 'utf8');
    
    expect(code).toContain('SESSION_INVALID_PATTERNS');
    expect(code).toContain('no conversation found');
    expect(code).toContain('session not found');
    expect(code).toContain('isSessionInvalid');
  });

  it('transient errors do not clear session', async () => {
    const code = readFileSync(join(process.cwd(), 'src/agent/claude-code.ts'), 'utf8');
    
    expect(code).toContain('isSessionInvalid');
    expect(code).toContain('keeping session intact');
    
    const retryBlock = code.match(/if \(!run\.text && previousSession\)[\s\S]*?clearClaudeCodeSession/);
    expect(retryBlock).not.toBeNull();
    expect(retryBlock![0]).toContain('isSessionInvalid');
  });

  it('only session-invalid errors trigger clearClaudeCodeSession in retry', async () => {
    const code = readFileSync(join(process.cwd(), 'src/agent/claude-code.ts'), 'utf8');
    
    const retrySection = code.slice(code.indexOf('// Only clear session'));
    const clearCallsInRetry = (retrySection.match(/clearClaudeCodeSession/g) || []).length;
    
    expect(clearCallsInRetry).toBe(1);
    expect(retrySection).toContain('if (isSessionInvalid)');
  });
});

describe('Issue #32: clearClaudeCodeSession', () => {
  it('clearClaudeCodeSession removes only the specified project session', async () => {
    const { clearClaudeCodeSession } = await import('./claude-code.ts');
    
    const sessionsPath = join(TEST_DATA_DIR, 'claude-code', 'sessions.json');
    mkdirSync(join(TEST_DATA_DIR, 'claude-code'), { recursive: true });
    writeFileSync(sessionsPath, JSON.stringify({
      'project-a': 'session-a',
      'project-b': 'session-b',
    }), { mode: 0o600 });
    
    clearClaudeCodeSession('project-a');
    
    const sessions = JSON.parse(readFileSync(sessionsPath, 'utf8'));
    expect(sessions['project-a']).toBeUndefined();
    expect(sessions['project-b']).toBe('session-b');
  });
});
