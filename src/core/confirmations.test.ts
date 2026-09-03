import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DATA_DIR = './test-data-confirmations';

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

describe('Confirmation Patterns', () => {
  const CONFIRM_PATTERNS = [
    /^(yes|y|ok|okay|sure|confirm|כן|אשר|אוקיי|אוקי|בסדר|יאללה)$/i,
  ];

  const CANCEL_PATTERNS = [
    /^(no|לא|בטל|cancel|ביטול)$/i,
  ];

  it('ok DOES match confirm patterns', () => {
    const text = 'ok';
    const matches = CONFIRM_PATTERNS.some((p) => p.test(text.trim()));
    expect(matches).toBe(true);
  });

  it('אוקיי DOES match confirm patterns', () => {
    const text = 'אוקיי';
    const matches = CONFIRM_PATTERNS.some((p) => p.test(text.trim()));
    expect(matches).toBe(true);
  });

  it('בסדר DOES match confirm patterns', () => {
    const text = 'בסדר';
    const matches = CONFIRM_PATTERNS.some((p) => p.test(text.trim()));
    expect(matches).toBe(true);
  });

  it('כן DOES match confirm patterns', () => {
    const text = 'כן';
    const matches = CONFIRM_PATTERNS.some((p) => p.test(text.trim()));
    expect(matches).toBe(true);
  });

  it('אשר DOES match confirm patterns', () => {
    const text = 'אשר';
    const matches = CONFIRM_PATTERNS.some((p) => p.test(text.trim()));
    expect(matches).toBe(true);
  });

  it('yes DOES match confirm patterns', () => {
    const text = 'yes';
    const matches = CONFIRM_PATTERNS.some((p) => p.test(text.trim()));
    expect(matches).toBe(true);
  });

  it('confirm DOES match confirm patterns', () => {
    const text = 'confirm';
    const matches = CONFIRM_PATTERNS.some((p) => p.test(text.trim()));
    expect(matches).toBe(true);
  });

  it('לא DOES match cancel patterns', () => {
    const text = 'לא';
    const matches = CANCEL_PATTERNS.some((p) => p.test(text.trim()));
    expect(matches).toBe(true);
  });

  it('no DOES match cancel patterns', () => {
    const text = 'no';
    const matches = CANCEL_PATTERNS.some((p) => p.test(text.trim()));
    expect(matches).toBe(true);
  });
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

    expect(consumeExecutedActionNotes('default')).toHaveLength(0);
    expect(consumeExecutedActionNotes('other')).toHaveLength(1);
  });

  it('peek does not consume notes (#170)', async () => {
    const { recordExecutedAction, peekExecutedActionNotes, consumeExecutedActionNotes } = await import('./confirmations.ts');
    recordExecutedAction({ projectId: 'default', actionId: 'gmail.send_email', success: true, summary: '{"id":"m1"}' });

    expect(peekExecutedActionNotes('default')).toHaveLength(1);
    expect(peekExecutedActionNotes('default')).toHaveLength(1);
    expect(consumeExecutedActionNotes('default')).toHaveLength(1);
    expect(peekExecutedActionNotes('default')).toHaveLength(0);
  });

  it('truncates oversized summaries', async () => {
    const { recordExecutedAction, consumeExecutedActionNotes } = await import('./confirmations.ts');
    recordExecutedAction({ projectId: 'p', actionId: 'x.create_thing', success: true, summary: 'a'.repeat(5000) });
    expect(consumeExecutedActionNotes('p')[0]?.summary.length).toBe(1500);
  });
});

describe('requiresConfirmation — allow-list of read-only verbs (#27)', () => {
  const MUTATING = [
    'gmail.reply_email', 'gmail.reply_to_thread', 'gmail.move_to_trash', 'gmail.move_thread_to_trash',
    'gmail.untrash_message', 'gmail.batch_modify_messages', 'gmail.add_label_to_email',
    'gmail.modify_thread_labels', 'gmail.patch_label', 'gmail.stop_watch',
    'notion.append_block', 'notion.append_block_children', 'notion.move_page',
    'slack.reply_message', 'slack.schedule_message', 'slack.upload_file', 'slack.add_reaction',
    'slack.open_conversation',
    'gmail.send_email', 'gmail.send', 'gmail.create_draft', 'gmail.delete_draft',
    'googlecalendar.update_event', 'slack.post_message', 'slack.postMessage',
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

  it('honours per-action overrides from settings for read-only actions', async () => {
    const { setActionConfirmation } = await import('./settings.ts');
    const { requiresConfirmation } = await import('./confirmations.ts');

    // 'always' on a read-only action forces confirmation
    setActionConfirmation('gmail', 'gmail.get_profile', 'always');
    expect(requiresConfirmation('gmail.get_profile')).toBe(true);

    // Reset
    setActionConfirmation('gmail', 'gmail.get_profile', 'auto');
  });
});

describe('S-06 (#110) — confirmation=never must NOT skip send/create/update/delete', () => {
  const ALWAYS_CONFIRM_ACTIONS = [
    'gmail.send_email',
    'gmail.send_message',
    'googlecalendar.create_event',
    'googlecalendar.update_event',
    'googlecalendar.delete_event',
    'gmail.delete_draft',
    'gmail.trash_message',
    'gmail.reply_to_thread',
    'slack.send_message',
    'notion.create_page',
    'notion.update_page',
    'notion.delete_block',
    'x.schedule_meeting',
    'x.cancel_appointment',
    'x.forward_email',
    'x.move_file',
  ];

  it('always requires confirmation for send/create/update/delete verbs', async () => {
    const { requiresConfirmation, isAlwaysConfirmAction } = await import('./confirmations.ts');
    
    for (const actionId of ALWAYS_CONFIRM_ACTIONS) {
      expect(isAlwaysConfirmAction(actionId), `${actionId} should be always-confirm`).toBe(true);
      expect(requiresConfirmation(actionId), `${actionId} should require confirmation`).toBe(true);
    }
  });

  it('never override does NOT skip confirmation for mutating verbs', async () => {
    const { setActionConfirmation } = await import('./settings.ts');
    const { requiresConfirmation } = await import('./confirmations.ts');

    // Set 'never' on a send action — must STILL require confirmation
    setActionConfirmation('gmail', 'gmail.send_email', 'never');
    expect(requiresConfirmation('gmail.send_email')).toBe(true);

    setActionConfirmation('googlecalendar', 'googlecalendar.create_event', 'never');
    expect(requiresConfirmation('googlecalendar.create_event')).toBe(true);

    setActionConfirmation('googlecalendar', 'googlecalendar.delete_event', 'never');
    expect(requiresConfirmation('googlecalendar.delete_event')).toBe(true);

    // Reset
    setActionConfirmation('gmail', 'gmail.send_email', 'auto');
    setActionConfirmation('googlecalendar', 'googlecalendar.create_event', 'auto');
    setActionConfirmation('googlecalendar', 'googlecalendar.delete_event', 'auto');
  });

  it('never override DOES skip confirmation for read-only actions', async () => {
    const { setActionConfirmation } = await import('./settings.ts');
    const { requiresConfirmation } = await import('./confirmations.ts');

    // 'never' on a read-only action skips confirmation (this is safe)
    setActionConfirmation('gmail', 'gmail.list_threads', 'never');
    expect(requiresConfirmation('gmail.list_threads')).toBe(false);

    // Reset
    setActionConfirmation('gmail', 'gmail.list_threads', 'auto');
  });

  it('verb heuristic still works as fallback for non-mutating unknown actions', async () => {
    const { requiresConfirmation, isAlwaysConfirmAction } = await import('./confirmations.ts');

    // Unknown action with read-only verb — no confirmation needed
    expect(isAlwaysConfirmAction('custom.get_status')).toBe(false);
    expect(requiresConfirmation('custom.get_status')).toBe(false);

    // Unknown action with unknown verb — requires confirmation (fail closed)
    expect(requiresConfirmation('custom.frobnicate_thing')).toBe(true);
  });
});

describe('Confirmation TTL', () => {
  it('MAX_AGE_MS is 3 minutes (presented window) and unpresented is 15 minutes (#168)', async () => {
    const { MAX_AGE_MS, UNPRESENTED_MAX_AGE_MS } = await import('./confirmations.ts');
    expect(MAX_AGE_MS).toBe(3 * 60 * 1000);
    expect(UNPRESENTED_MAX_AGE_MS).toBe(15 * 60 * 1000);
  });

  it('unpresented items survive the 3-minute presented window (#168)', async () => {
    const {
      createPendingConfirmation,
      getPendingConfirmation,
      cleanupOldConfirmations,
    } = await import('./confirmations.ts');

    const confirmationId = createPendingConfirmation({
      actionId: 'gmail.sendEmail',
      input: { to: 'test@example.com' },
      projectId: 'test-project',
    });

    const storePath = join(TEST_DATA_DIR, 'pending-confirmations.json');
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    store[confirmationId].createdAt = Date.now() - 4 * 60 * 1000;
    writeFileSync(storePath, JSON.stringify(store), { mode: 0o600 });

    cleanupOldConfirmations();
    expect(getPendingConfirmation(confirmationId)).toBeDefined();
  });

  it('unpresented items expire after 15 minutes (#168)', async () => {
    const {
      createPendingConfirmation,
      getPendingConfirmation,
      cleanupOldConfirmations,
    } = await import('./confirmations.ts');

    const confirmationId = createPendingConfirmation({
      actionId: 'gmail.sendEmail',
      input: { to: 'test@example.com' },
      projectId: 'test-project',
    });

    const storePath = join(TEST_DATA_DIR, 'pending-confirmations.json');
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    store[confirmationId].createdAt = Date.now() - 16 * 60 * 1000;
    writeFileSync(storePath, JSON.stringify(store), { mode: 0o600 });

    cleanupOldConfirmations();
    expect(getPendingConfirmation(confirmationId)).toBeUndefined();
  });

  it('presented items expire 3 minutes after payloadPresentedAt (#168)', async () => {
    const {
      createPendingConfirmation,
      markPayloadPresented,
      getPendingConfirmation,
      cleanupOldConfirmations,
    } = await import('./confirmations.ts');

    const confirmationId = createPendingConfirmation({
      actionId: 'gmail.sendEmail',
      input: { to: 'test@example.com' },
      projectId: 'test-project',
    });
    markPayloadPresented(confirmationId);

    const storePath = join(TEST_DATA_DIR, 'pending-confirmations.json');
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    store[confirmationId].createdAt = Date.now() - 10 * 60 * 1000;
    store[confirmationId].payloadPresentedAt = Date.now() - 4 * 60 * 1000;
    writeFileSync(storePath, JSON.stringify(store), { mode: 0o600 });

    cleanupOldConfirmations();
    expect(getPendingConfirmation(confirmationId)).toBeUndefined();
  });
});

describe('PendingConfirmation with projectId', () => {
  it('stores projectId in pending confirmation', async () => {
    const { createPendingConfirmation, getPendingConfirmation } = await import('./confirmations.ts');

    const confirmationId = createPendingConfirmation({
      actionId: 'gmail.sendEmail',
      input: { to: 'test@example.com' },
      projectId: 'my-project',
    });

    const pending = getPendingConfirmation(confirmationId);
    expect(pending?.projectId).toBe('my-project');
  });

  it('getAllPendingConfirmations filters by projectId', async () => {
    const { createPendingConfirmation, getAllPendingConfirmations } = await import('./confirmations.ts');

    createPendingConfirmation({
      actionId: 'gmail.sendEmail',
      input: { to: 'a@example.com' },
      projectId: 'project-a',
    });

    createPendingConfirmation({
      actionId: 'slack.postMessage',
      input: { channel: '#general' },
      projectId: 'project-b',
    });

    createPendingConfirmation({
      actionId: 'calendar.createEvent',
      input: { title: 'Meeting' },
      projectId: 'project-a',
    });

    const projectA = getAllPendingConfirmations('project-a');
    expect(projectA.length).toBe(2);
    expect(projectA.every((p) => p.projectId === 'project-a')).toBe(true);

    const projectB = getAllPendingConfirmations('project-b');
    expect(projectB.length).toBe(1);
    expect(projectB[0]?.projectId).toBe('project-b');

    const all = getAllPendingConfirmations();
    expect(all.length).toBe(3);
  });

  it('cancelAllPendingConfirmations removes all for project', async () => {
    const { 
      createPendingConfirmation, 
      getAllPendingConfirmations,
      cancelAllPendingConfirmations,
    } = await import('./confirmations.ts');

    createPendingConfirmation({
      actionId: 'gmail.sendEmail',
      input: { to: 'a@example.com' },
      projectId: 'project-a',
    });

    createPendingConfirmation({
      actionId: 'slack.postMessage',
      input: { channel: '#general' },
      projectId: 'project-b',
    });

    createPendingConfirmation({
      actionId: 'calendar.createEvent',
      input: { title: 'Meeting' },
      projectId: 'project-a',
    });

    const count = cancelAllPendingConfirmations('project-a');
    expect(count).toBe(2);

    const projectA = getAllPendingConfirmations('project-a');
    expect(projectA.length).toBe(0);

    const projectB = getAllPendingConfirmations('project-b');
    expect(projectB.length).toBe(1);
  });
});

describe('S-04 (#108) — payloadPresentedAt tracking', () => {
  it('markPayloadPresented sets the flag', async () => {
    const { createPendingConfirmation, markPayloadPresented, isPayloadPresented } = await import('./confirmations.ts');

    const confirmationId = createPendingConfirmation({
      actionId: 'gmail.send_email',
      input: { to: 'test@example.com' },
      projectId: 'default',
    });

    // Initially not presented
    expect(isPayloadPresented(confirmationId)).toBe(false);

    // Mark as presented
    const result = markPayloadPresented(confirmationId);
    expect(result).toBe(true);

    // Now it should be presented
    expect(isPayloadPresented(confirmationId)).toBe(true);
  });

  it('isPayloadPresented returns false for unknown confirmation', async () => {
    const { isPayloadPresented } = await import('./confirmations.ts');
    expect(isPayloadPresented('confirm_nonexistent_xxx')).toBe(false);
  });

  it('markPayloadPresented returns false for unknown confirmation', async () => {
    const { markPayloadPresented } = await import('./confirmations.ts');
    expect(markPayloadPresented('confirm_nonexistent_xxx')).toBe(false);
  });

  it('payloadPresentedAt is preserved when loading from disk', async () => {
    const { createPendingConfirmation, markPayloadPresented, getPendingConfirmation } = await import('./confirmations.ts');

    const confirmationId = createPendingConfirmation({
      actionId: 'gmail.send_email',
      input: { to: 'test@example.com' },
      projectId: 'default',
    });

    markPayloadPresented(confirmationId);

    // Reload and check
    const pending = getPendingConfirmation(confirmationId);
    expect(pending?.payloadPresentedAt).toBeDefined();
    expect(typeof pending?.payloadPresentedAt).toBe('number');
  });

  it('does not rewrite createdAt when marking presented (#168)', async () => {
    const { createPendingConfirmation, markPayloadPresented, getPendingConfirmation } = await import('./confirmations.ts');

    const confirmationId = createPendingConfirmation({
      actionId: 'gmail.send_email',
      input: { to: 'test@example.com' },
      projectId: 'default',
    });
    const createdAt = getPendingConfirmation(confirmationId)!.createdAt;
    markPayloadPresented(confirmationId);
    expect(getPendingConfirmation(confirmationId)!.createdAt).toBe(createdAt);
  });
});

describe('formatPendingForUser', () => {
  it('formats email action nicely', async () => {
    const { formatPendingForUser } = await import('./confirmations.ts');

    const summary = formatPendingForUser({
      actionId: 'gmail.sendEmail',
      input: {
        to: 'boss@company.com',
        subject: 'Meeting Request',
        body: 'Hi, I would like to schedule a meeting to discuss the project progress.',
      },
      createdAt: Date.now(),
    });

    expect(summary).toContain('gmail.sendEmail');
    expect(summary).toContain('boss@company.com');
    expect(summary).toContain('Meeting Request');
    expect(summary).toContain('Hi, I would like');
    expect(summary).not.toContain('JSON');
  });

  it('formats calendar event nicely', async () => {
    const { formatPendingForUser } = await import('./confirmations.ts');

    const summary = formatPendingForUser({
      actionId: 'calendar.createEvent',
      input: {
        title: 'Team Sync',
        start: '2024-01-15T10:00:00',
        end: '2024-01-15T11:00:00',
      },
      createdAt: Date.now(),
    });

    expect(summary).toContain('calendar.createEvent');
    expect(summary).toContain('Team Sync');
    expect(summary).toContain('2024-01-15T10:00:00');
  });

  it('truncates long body text', async () => {
    const { formatPendingForUser } = await import('./confirmations.ts');

    const longBody = 'A'.repeat(200);
    const summary = formatPendingForUser({
      actionId: 'gmail.sendEmail',
      input: {
        to: 'test@test.com',
        body: longBody,
      },
      createdAt: Date.now(),
    });

    expect(summary.length).toBeLessThan(longBody.length + 100);
    expect(summary).toContain('...');
  });

  it('shows generic fields for unknown action types', async () => {
    const { formatPendingForUser } = await import('./confirmations.ts');

    const summary = formatPendingForUser({
      actionId: 'custom.doSomething',
      input: {
        fieldA: 'valueA',
        fieldB: 'valueB',
        fieldC: 'valueC',
        fieldD: 'valueD',
      },
      createdAt: Date.now(),
    });

    expect(summary).toContain('custom.doSomething');
    expect(summary).toContain('fieldA');
    expect(summary).toContain('valueA');
    expect(summary).toContain('ועוד');
  });
});
