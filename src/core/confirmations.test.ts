import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DATA_DIR = './test-data-confirmations';

beforeEach(() => {
  vi.resetModules();
  process.env['DATA_DIR'] = TEST_DATA_DIR;
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
  mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
  delete process.env['DATA_DIR'];
});

describe('formatConfirmationRequest', () => {
  it('states the action was not executed and carries the confirmation id', async () => {
    const { formatConfirmationRequest } = await import('./confirmations.ts');
    const text = formatConfirmationRequest('gmail.send_email', { to: 'a@b.c' }, 'confirm_1_abc');
    expect(text).toContain('gmail.send_email');
    expect(text).toContain('NOT executed');
    expect(text).toContain('confirm_1_abc');
    expect(text).toContain('"to": "a@b.c"');
    expect(text).toMatch(/cannot approve/i);
  });
});

describe('executed-action notes', () => {
  it('records notes per project and consumes them once', async () => {
    const { recordExecutedAction, consumeExecutedActionNotes } = await import('./confirmations.ts');
    recordExecutedAction({ projectId: 'default', actionId: 'gmail.send_email', success: true, summary: '{"id":"m1"}' });
    recordExecutedAction({ projectId: 'other', actionId: 'notion.create_page', success: false, summary: 'boom' });

    const mine = consumeExecutedActionNotes('default');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ actionId: 'gmail.send_email', success: true, summary: '{"id":"m1"}' });

    // consumed — gone on the second read; the other project's note is untouched
    expect(consumeExecutedActionNotes('default')).toHaveLength(0);
    expect(consumeExecutedActionNotes('other')).toHaveLength(1);
  });

  it('truncates oversized summaries', async () => {
    const { recordExecutedAction, consumeExecutedActionNotes } = await import('./confirmations.ts');
    recordExecutedAction({ projectId: 'p', actionId: 'x.create_thing', success: true, summary: 'a'.repeat(5000) });
    expect(consumeExecutedActionNotes('p')[0]?.summary.length).toBe(1500);
  });
});
