import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * vitest transpiles with esbuild, which accepts TypeScript that Node's
 * strip-only mode (`npm start`, the MCP server) rejects — parameter
 * properties, enums, namespaces. This loads the real entry points the way
 * production does, so such syntax fails here instead of at boot.
 */
const ENTRY_POINTS = ['./src/http/server.ts', './src/whatsapp/handler.ts', './src/agent/connector-mcp.ts'];

describe('production boot (node --experimental-strip-types)', () => {
  for (const entry of ENTRY_POINTS) {
    it(`${entry} loads under strip-only TypeScript`, () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'desk-boot-'));
      try {
        const result = spawnSync(
          process.execPath,
          ['--experimental-strip-types', '--no-warnings', '-e',
            `import('${entry}').then(() => { console.log('BOOT_OK'); process.exit(0); }, (e) => { console.error(e && e.stack || e); process.exit(2); })`],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              DATA_DIR: dataDir,
              NODE_ENV: 'test',
              PAIR_TOKEN: 'boot-test-token',
              OPEN_CONNECTOR_URL: 'http://127.0.0.1:9',
              OPEN_CONNECTOR_TOKEN: 'x',
              DESK_MCP_SERVER: '1',
            },
            encoding: 'utf8',
            timeout: 60_000,
          }
        );
        expect(result.stderr, result.stderr).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SyntaxError|Cannot find/);
        expect(result.stdout).toContain('BOOT_OK');
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });
  }
});
