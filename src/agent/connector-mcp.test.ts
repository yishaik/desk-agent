import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DATA_DIR = './test-data-connector-mcp';

const { executeAction } = vi.hoisted(() => ({ executeAction: vi.fn() }));
vi.mock('../open-connector/client.ts', () => ({
  OpenConnectorClient: class {
    executeAction = executeAction;
    searchActions = vi.fn(async () => []);
    getActionGuide = vi.fn(async () => '');
    listConnections = vi.fn(async () => []);
  },
  isRealConnection: () => true,
}));

beforeEach(() => {
  vi.resetModules();
  executeAction.mockReset();
  executeAction.mockResolvedValue({ success: true, message: 'ok', data: { id: 'm1' } });
  process.env['DATA_DIR'] = TEST_DATA_DIR;
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
  mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
  delete process.env['DATA_DIR'];
});

describe('connector MCP execute_action — HITL gate', () => {
  it('never executes a mutating action, even when handed an existing pending id (#26)', async () => {
    const { callTool } = await import('./connector-mcp.ts');
    const { getPendingConfirmation } = await import('../core/confirmations.ts');

    const first = await callTool('execute_action', { actionId: 'gmail.send_email', input: { to: 'a@b.c' } });
    expect(executeAction).not.toHaveBeenCalled();
    expect(first).toContain('NOT executed');
    const id = first.match(/confirm_\d+_[a-z0-9]+/)?.[0];
    expect(id).toBeTruthy();
    expect(getPendingConfirmation(id!)).toBeTruthy();

    // The former bypass: hand the pending id back as "confirmed".
    const second = await callTool('execute_action', {
      actionId: 'gmail.send_email',
      input: { to: 'a@b.c' },
      confirmed: id,
    });
    expect(executeAction).not.toHaveBeenCalled();
    expect(second).toContain('NOT executed');
    // The original request is still pending for the owner to approve — not consumed by the model.
    expect(getPendingConfirmation(id!)).toBeTruthy();
  });

  it('executes read-only actions immediately', async () => {
    const { callTool } = await import('./connector-mcp.ts');
    const out = await callTool('execute_action', { actionId: 'gmail.list_threads', input: { q: 'x' } });
    expect(executeAction).toHaveBeenCalledTimes(1);
    expect(executeAction).toHaveBeenCalledWith({ actionId: 'gmail.list_threads', input: { q: 'x' }, connectionName: undefined });
    expect(out).toContain('executed successfully');
  });

  it('exposes no confirmation parameter to the model', async () => {
    const { TOOLS } = await import('./connector-mcp.ts');
    const exec = TOOLS.find((t) => t.name === 'execute_action')!;
    expect(Object.keys(exec.inputSchema.properties)).toEqual(['actionId', 'input', 'connectionName']);
  });
});
