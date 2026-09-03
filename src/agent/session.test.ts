import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const { executeAction } = vi.hoisted(() => ({ executeAction: vi.fn() }));
vi.mock('../open-connector/client.ts', () => ({
  OpenConnectorClient: class {
    executeAction = executeAction;
    searchActions = vi.fn(async () => []);
    getActionGuide = vi.fn(async () => '');
    listConnections = vi.fn(async () => []);
  },
  isRealConnection: () => true,
  createClient: () => ({}),
  defaultClient: {},
}));

const TEST_DATA_DIR = './test-data-session';

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
  delete process.env['MODEL_API_KEY'];
});

describe('Confirmation Gate', () => {
  it('generates unique confirmation IDs', async () => {
    const { generateConfirmationId } = await import('../core/confirmations.ts');

    const id1 = generateConfirmationId();
    const id2 = generateConfirmationId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^confirm_\d+_[a-z0-9]+$/);
  });

  it('getPendingConfirmation returns undefined for nonexistent ID', async () => {
    const { getPendingConfirmation } = await import('../core/confirmations.ts');

    const pending = getPendingConfirmation('nonexistent_id');
    expect(pending).toBeUndefined();
  });

  it('createPendingConfirmation stores and retrieves confirmation', async () => {
    const { createPendingConfirmation, getPendingConfirmation } = await import('../core/confirmations.ts');

    const confirmId = createPendingConfirmation({
      actionId: 'gmail.sendEmail',
      input: { to: 'test@example.com', subject: 'Test' },
    });

    const pending = getPendingConfirmation(confirmId);
    expect(pending).toBeDefined();
    expect(pending?.actionId).toBe('gmail.sendEmail');
    expect(pending?.input).toEqual({ to: 'test@example.com', subject: 'Test' });
  });

  it('confirmAction consumes the confirmation (returns true then false)', async () => {
    const { createPendingConfirmation, confirmAction, getPendingConfirmation } = await import('../core/confirmations.ts');

    const confirmId = createPendingConfirmation({
      actionId: 'gmail.sendEmail',
      input: {},
    });

    expect(getPendingConfirmation(confirmId)).toBeDefined();

    const firstConfirm = confirmAction(confirmId);
    expect(firstConfirm).toBe(true);

    expect(getPendingConfirmation(confirmId)).toBeUndefined();

    const secondConfirm = confirmAction(confirmId);
    expect(secondConfirm).toBe(false);
  });

  it('cancelConfirmation removes pending confirmation', async () => {
    const { createPendingConfirmation, cancelConfirmation, getPendingConfirmation } = await import('../core/confirmations.ts');

    const confirmId = createPendingConfirmation({
      actionId: 'gmail.sendEmail',
      input: {},
    });

    const result = cancelConfirmation(confirmId);
    expect(result).toBe(true);

    expect(getPendingConfirmation(confirmId)).toBeUndefined();
  });

  it('cleanupOldConfirmations does not throw', async () => {
    const { cleanupOldConfirmations } = await import('../core/confirmations.ts');

    expect(() => cleanupOldConfirmations()).not.toThrow();
  });
});

describe('Pi Session Security', () => {
  it('CRITICAL: session tools array does NOT include read tool - prevents prompt injection exfiltration', async () => {
    const fs = await import('node:fs');
    const sessionCode = fs.readFileSync('./src/agent/session.ts', 'utf-8');
    
    const toolsMatch = sessionCode.match(/tools:\s*\[([^\]]+)\]/);
    expect(toolsMatch).toBeTruthy();
    
    const toolsContent = toolsMatch![1];
    expect(toolsContent).not.toContain("'read'");
    expect(toolsContent).not.toContain('"read"');
    
    expect(toolsContent).toContain('oc_search_actions');
    expect(toolsContent).toContain('oc_get_action_guide');
    expect(toolsContent).toContain('oc_execute_action');
    expect(toolsContent).toContain('oc_list_connections');
  });
});

describe('Confirmation gate uses the real classifier (#27)', () => {
  it('holds mutating actions and lets read-only ones through', async () => {
    const { requiresConfirmation } = await import('../core/confirmations.ts');

    expect(requiresConfirmation('gmail.sendEmail')).toBe(true);
    expect(requiresConfirmation('gmail.send_email')).toBe(true);
    expect(requiresConfirmation('calendar.createEvent')).toBe(true);
    expect(requiresConfirmation('slack.postMessage')).toBe(true);
    expect(requiresConfirmation('notion.updatePage')).toBe(true);
    expect(requiresConfirmation('github.deleteIssue')).toBe(true);

    expect(requiresConfirmation('gmail.getMessages')).toBe(false);
    expect(requiresConfirmation('calendar.listEvents')).toBe(false);
    expect(requiresConfirmation('notion.getPage')).toBe(false);
  });
});

describe('Pi oc_execute_action — HITL gate (#26)', () => {
  it('never executes a mutating action, with or without a claimed confirmation', async () => {
    executeAction.mockReset();
    executeAction.mockResolvedValue({ success: true, message: 'ok', data: {} });
    const { createOpenConnectorTools } = await import('./session.ts');
    const { getPendingConfirmation } = await import('../core/confirmations.ts');
    const tool = createOpenConnectorTools('default').find((t) => t.name === 'oc_execute_action')!;
    const call = (params: Record<string, unknown>) =>
      (tool.execute as (...a: unknown[]) => Promise<{ content: Array<{ text?: string }>; details?: Record<string, unknown> }>)(
        'call-1', params, undefined, undefined, undefined
      );

    const first = await call({ actionId: 'gmail.send_email', input: { to: 'a@b.c' } });
    expect(executeAction).not.toHaveBeenCalled();
    expect(first.details?.['needsConfirmation']).toBe(true);
    const id = String(first.details?.['confirmationId']);
    expect(getPendingConfirmation(id)).toBeTruthy();

    const second = await call({ actionId: 'gmail.send_email', input: { to: 'a@b.c' }, confirmed: id });
    expect(executeAction).not.toHaveBeenCalled();
    expect(second.content[0]?.text).toContain('NOT executed');
    expect(getPendingConfirmation(id)).toBeTruthy();
  }, 60_000);

  it('schema has no confirmed parameter', async () => {
    const { createOpenConnectorTools } = await import('./session.ts');
    const tool = createOpenConnectorTools('default').find((t) => t.name === 'oc_execute_action')!;
    const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(['actionId', 'input', 'connectionName']);
  });
});

describe('extractTextFromMessages - Issue #34', () => {
  it('returns null when current turn is empty — never reuses previous turn text', async () => {
    const { extractTextFromMessages } = await import('./session.ts');

    const messages = [
      // Previous turn (turn 0) - has text
      { role: 'user', content: [{ type: 'text', text: 'First question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'First answer from previous turn' }] },
      // Current turn (turn 1) - user asked but assistant produced no text (error/quota/tool-only)
      { role: 'user', content: [{ type: 'text', text: 'Second question' }] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'some_tool' }] },
    ];

    // startIndex=2 means we're looking at messages from the current turn only
    const result = extractTextFromMessages(messages, 2);
    
    // MUST return null, NOT "First answer from previous turn"
    expect(result).toBeNull();
  });

  it('extracts text only from current turn when startIndex is provided', async () => {
    const { extractTextFromMessages } = await import('./session.ts');

    const messages = [
      // Previous turn
      { role: 'user', content: [{ type: 'text', text: 'Previous question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Previous answer' }] },
      // Current turn
      { role: 'user', content: [{ type: 'text', text: 'Current question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Current answer' }] },
    ];

    const result = extractTextFromMessages(messages, 2);
    
    expect(result).toBe('Current answer');
  });

  it('collects ALL assistant text from current turn (multiple messages)', async () => {
    const { extractTextFromMessages } = await import('./session.ts');

    const messages = [
      // Current turn starts at index 0
      { role: 'user', content: [{ type: 'text', text: 'Question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'First part' }] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'some_tool' }] },
      { role: 'tool_result', content: [{ type: 'text', text: 'Tool result' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Second part after tool' }] },
    ];

    const result = extractTextFromMessages(messages, 0);
    
    // Should join all assistant text parts from the current turn
    expect(result).toContain('First part');
    expect(result).toContain('Second part after tool');
  });

  it('returns null for completely empty turn (no assistant messages)', async () => {
    const { extractTextFromMessages } = await import('./session.ts');

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Question' }] },
    ];

    const result = extractTextFromMessages(messages, 0);
    
    expect(result).toBeNull();
  });

  it('handles assistant message with errorMessage (provider error)', async () => {
    const { extractTextFromMessages } = await import('./session.ts');

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Question' }] },
      { role: 'assistant', content: [], errorMessage: 'Rate limit exceeded' },
    ];

    const result = extractTextFromMessages(messages, 0);
    
    // No text content means null (the caller handles errorMessage separately)
    expect(result).toBeNull();
  });

  it('backward compatibility: works without startIndex (extracts from all messages)', async () => {
    const { extractTextFromMessages } = await import('./session.ts');

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] },
    ];

    // Without startIndex, defaults to 0 — extracts from all messages
    const result = extractTextFromMessages(messages);
    
    expect(result).toBe('Answer');
  });
});

describe('recreateSessionAfterCredentialChange waits for the queue (#78)', () => {
  it('does not reset sessions while a turn is running', async () => {
    const { enqueue } = await import('../whatsapp/queue.ts');
    const { recreateSessionAfterCredentialChange } = await import('./session.ts');
    const order: string[] = [];
    const turn = enqueue(async () => { await new Promise((r) => setTimeout(r, 40)); order.push('turn done'); });
    await recreateSessionAfterCredentialChange('default');
    order.push('settings applied');
    await turn;
    expect(order).toEqual(['turn done', 'settings applied']);
  });

  it('skips waitForIdle when already inside the queue (#169)', async () => {
    const queue = await import('../whatsapp/queue.ts');
    const waitSpy = vi.spyOn(queue, 'waitForIdle');
    const { recreateSessionAfterCredentialChange } = await import('./session.ts');

    await queue.enqueue(async () => {
      await recreateSessionAfterCredentialChange('default', { inQueue: true });
    });

    expect(waitSpy).not.toHaveBeenCalled();
    waitSpy.mockRestore();
  });
});
