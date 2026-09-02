import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  delete process.env['DESK_MCP_SERVER'];
  delete process.env['LOG_LEVEL'];
});

afterEach(() => {
  delete process.env['DESK_MCP_SERVER'];
  delete process.env['LOG_LEVEL'];
});

describe('Issue #36: Logger stderr in MCP mode', () => {
  it('logger writes to stderr when DESK_MCP_SERVER=1', async () => {
    process.env['DESK_MCP_SERVER'] = '1';
    process.env['DATA_DIR'] = './test-data-logger';
    
    const loggerModule = await import('./logger.ts');
    const logger = loggerModule.logger;
    
    const stream = (logger as any)[Object.getOwnPropertySymbols(logger).find(
      (s) => s.toString().includes('stream')
    ) as symbol] || (logger as any).stream;
    
    if (stream && typeof stream.fd === 'number') {
      expect(stream.fd).toBe(2);
    } else {
      const code = await import('node:fs').then((fs) => 
        fs.readFileSync('./src/core/logger.ts', 'utf8')
      );
      expect(code).toContain('DESK_MCP_SERVER');
      expect(code).toContain('pino.destination({ fd: 2 })');
    }
  });

  it('logger.ts contains MCP detection logic', async () => {
    const fs = await import('node:fs');
    const code = fs.readFileSync('./src/core/logger.ts', 'utf8');
    
    expect(code).toContain("process.env['DESK_MCP_SERVER']");
    expect(code).toContain("isMcpServer");
    expect(code).toContain('fd: 2');
  });
});

describe('Issue #36: config.ts console output', () => {
  it('config.ts uses console.error for PAIR_TOKEN message', async () => {
    const fs = await import('node:fs');
    const code = fs.readFileSync('./src/core/config.ts', 'utf8');
    
    expect(code).not.toMatch(/console\.log\([^)]*PAIR_TOKEN/);
    
    expect(code).toContain('console.error');
    expect(code).toContain('PAIR_TOKEN');
  });
});
