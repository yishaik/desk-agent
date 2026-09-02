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

describe('requiresConfirmation — allow-list of read-only verbs (#27)', () => {
  const MUTATING = [
    // real Open Connector action ids the old deny-list let through
    'gmail.reply_email', 'gmail.reply_to_thread', 'gmail.move_to_trash', 'gmail.move_thread_to_trash',
    'gmail.untrash_message', 'gmail.batch_modify_messages', 'gmail.add_label_to_email',
    'gmail.modify_thread_labels', 'gmail.patch_label', 'gmail.stop_watch',
    'notion.append_block', 'notion.append_block_children', 'notion.move_page',
    'slack.reply_message', 'slack.schedule_message', 'slack.upload_file', 'slack.add_reaction',
    'slack.open_conversation',
    // still covered
    'gmail.send_email', 'gmail.send', 'gmail.create_draft', 'gmail.delete_draft',
    'googlecalendar.update_event', 'slack.post_message', 'slack.postMessage',
    // unknown verbs fail safe
    'foo.frobnicate_thing', 'foo.x', 'foo.SEND',
  ];
  const READ_ONLY = [
    'gmail.list_threads', 'gmail.get_message', 'gmail.fetch_emails', 'gmail.search_threads',
    'gmail.get_profile', 'gmail.list_labels',
    'googlecalendar.list_events', 'googlecalendar.get_event',
    'notion.search', 'notion.retrieve_page', 'notion.query_data_source',
    'slack.get_channel_messages', 'slack.search_messages', 'slack.list_users',
    'x.getMessages', 'x.listEvents', 'x.fetchMessageById', 'x.lookup_contact', 'x.is_member',
  ];

  it('classifies verbs', async () => {
    const { actionVerb } = await import('./confirmations.ts');
    expect(actionVerb('gmail.get_message')).toBe('get');
    expect(actionVerb('x.getMessages')).toBe('get');
    expect(actionVerb('x.GetMessages')).toBe('get');
    expect(actionVerb('gmail.reply_to_thread')).toBe('reply');
    expect(actionVerb('search')).toBe('search');
  });

  it('holds every non-read-only action', async () => {
    const { requiresConfirmation } = await import('./confirmations.ts');
    for (const id of MUTATING) expect(requiresConfirmation(id), id).toBe(true);
  });

  it('lets read-only actions run immediately', async () => {
    const { requiresConfirmation } = await import('./confirmations.ts');
    for (const id of READ_ONLY) expect(requiresConfirmation(id), id).toBe(false);
  });

  it('honours per-action overrides from settings', async () => {
    const { setActionConfirmation } = await import('./settings.ts');
    const { requiresConfirmation } = await import('./confirmations.ts');

    setActionConfirmation('gmail', 'gmail.get_profile', 'always');
    expect(requiresConfirmation('gmail.get_profile')).toBe(true);

    setActionConfirmation('gmail', 'gmail.create_draft', 'never');
    expect(requiresConfirmation('gmail.create_draft')).toBe(false);

    setActionConfirmation('gmail', 'gmail.create_draft', 'auto');
    expect(requiresConfirmation('gmail.create_draft')).toBe(true);
  });
});
