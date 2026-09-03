import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const caddy = readFileSync(join(__dirname, '../../Caddyfile'), 'utf8');

describe('Caddyfile public surface (S-08, S-25, U-02, S-10)', () => {
  it('does not expose connector /api/oauth/* on the agent domain', () => {
    expect(caddy).not.toMatch(/handle \/api\/oauth\/\*/);
  });

  it('still proxies only /oauth/* (the public callback) to the connector', () => {
    expect(caddy).toMatch(/handle \/oauth\/\*/);
  });

  it('does not use PAIR_TOKEN forward_auth on the console host (U-02)', () => {
    expect(caddy).not.toContain('forward_auth');
  });

  it('sets a Content-Security-Policy', () => {
    expect(caddy).toContain('Content-Security-Policy');
  });
});
