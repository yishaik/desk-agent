import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { isSelfChatJid, bareJid } from './self-chat.ts';
import type { Message } from '../core/types.ts';

const TEST_DATA_DIR = './test-data-handler';

const mockSendMessage = vi.fn();
const mockSendReaction = vi.fn();
const mockGetOwnerJid = vi.fn();
const mockGetOwnerPhone = vi.fn();
const mockGetOwnerLid = vi.fn();
const mockIsConnected = vi.fn();

const mockGetSelfChatJid = vi.fn();
const staleSkip = { notified: false };
const mockRunPromptWithCallbacks = vi.fn(async (): Promise<string | null> => null);

vi.mock('./client.ts', () => ({
  getWhatsAppClient: () => ({
    sendMessage: mockSendMessage,
    sendReaction: mockSendReaction,
    getOwnerJid: mockGetOwnerJid,
    getOwnerPhone: mockGetOwnerPhone,
    getOwnerLid: mockGetOwnerLid,
    getSelfChatJid: mockGetSelfChatJid,
    getPairingState: () => ({ isPaired: true, selfChat: 'lid' }),
    isConnected: mockIsConnected,
    takeStaleSkipNotice: () => {
      if (staleSkip.notified) return false;
      staleSkip.notified = true;
      return true;
    },
    isSelfJid: (jid: string | null | undefined) => {
      const ownerPhone = mockGetOwnerPhone();
      const ownerLid = mockGetOwnerLid();
      return isSelfChatJid(jid, ownerPhone, ownerLid);
    },
  }),
  WhatsAppClient: class {},
}));

vi.mock('../agent/session.ts', () => ({
  runPromptWithCallbacks: mockRunPromptWithCallbacks,
  clearSession: vi.fn(),
  getOrCreateSession: vi.fn(async () => ({})),
  setSessionModel: vi.fn(async () => true),
  getPendingConfirmation: vi.fn(() => undefined),
  getLatestPendingConfirmation: vi.fn(() => null),
  confirmAction: vi.fn(() => false),
  cancelConfirmation: vi.fn(() => false),
  cleanupOldConfirmations: vi.fn(),
  consumeExpiredConfirmations: vi.fn(() => []),
  checkCredentialsBeforePrompt: vi.fn(async () => ({ valid: true, model: true, modelId: 'test' })),
  recreateSessionAfterCredentialChange: vi.fn(async () => {}),
  CredentialError: class extends Error {},
  getAllPendingConfirmations: vi.fn(() => []),
  cancelAllPendingConfirmations: vi.fn(() => 0),
  formatPendingForUser: vi.fn(() => ''),
  markPayloadPresented: vi.fn(() => true),
  isPayloadPresented: vi.fn(() => false),
}));

vi.mock('../agent/claude-code.ts', () => ({
  isClaudeCodeConnected: vi.fn(() => false),
  runClaudeCodePrompt: vi.fn(async () => null),
  clearClaudeCodeSession: vi.fn(),
}));

vi.mock('../http/auth.ts', () => ({
  listRuntimeCredentials: vi.fn(async () => []),
  resolveActiveModel: vi.fn(async () => ({ valid: true, model: true, modelId: 'test' })),
}));

async function closeHandlerDb(): Promise<void> {
  try {
    const { closeDatabase } = await import('../core/memory.ts');
    closeDatabase();
  } catch {
    // memory.ts may not have been loaded yet
  }
}

function tryRmDataDir(): void {
  try {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    }
  } catch {
    // Windows can keep SQLite locked across resetModules (#174).
  }
}

beforeEach(async () => {
  await closeHandlerDb();
  vi.resetModules();
  vi.clearAllMocks();
  process.env['DATA_DIR'] = TEST_DATA_DIR;
  tryRmDataDir();
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  
  mockGetOwnerJid.mockReturnValue('1234567890:123@s.whatsapp.net');
  mockGetOwnerPhone.mockReturnValue('1234567890');
  mockGetOwnerLid.mockReturnValue('ABC123XYZ@lid');
  mockGetSelfChatJid.mockReturnValue('ABC123XYZ@lid');
  mockIsConnected.mockReturnValue(true);
  staleSkip.notified = false;
  const claude = await import('../agent/claude-code.ts');
  vi.mocked(claude.isClaudeCodeConnected).mockReturnValue(false);
});

afterEach(async () => {
  await closeHandlerDb();
  tryRmDataDir();
  delete process.env['DATA_DIR'];
});

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: 'msg_test',
    from: '1234567890:123@s.whatsapp.net',
    to: '1234567890@s.whatsapp.net',
    body: 'test message',
    timestamp: Date.now(),
    isFromMe: false,
    ...overrides,
  };
}

describe('bareJid', () => {
  it('extracts phone from standard JID', () => {
    expect(bareJid('1234567890@s.whatsapp.net')).toBe('1234567890');
  });

  it('extracts phone from JID with device suffix', () => {
    expect(bareJid('1234567890:123@s.whatsapp.net')).toBe('1234567890');
  });

  it('extracts LID without domain', () => {
    expect(bareJid('ABC123XYZ@lid')).toBe('ABC123XYZ');
  });

  it('returns null for null input', () => {
    expect(bareJid(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(bareJid(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(bareJid('')).toBeNull();
  });
});

describe('isSelfChatJid — canonical self-chat gate', () => {
  const ownerPhone = '1234567890';
  const ownerLid = 'ABC123XYZ@lid';

  describe('valid self-chat cases', () => {
    it('accepts self-chat via phone JID', () => {
      expect(isSelfChatJid('1234567890@s.whatsapp.net', ownerPhone, ownerLid)).toBe(true);
    });

    it('accepts self-chat via phone JID with device suffix', () => {
      expect(isSelfChatJid('1234567890:456@s.whatsapp.net', ownerPhone, ownerLid)).toBe(true);
    });

    it('accepts self-chat via LID', () => {
      expect(isSelfChatJid('ABC123XYZ@lid', ownerPhone, ownerLid)).toBe(true);
    });
  });

  describe('rejects other person/group/broadcast (fromMe is NOT a parameter)', () => {
    it('rejects message to another person JID', () => {
      expect(isSelfChatJid('9876543210@s.whatsapp.net', ownerPhone, ownerLid)).toBe(false);
    });

    it('rejects message to a group', () => {
      expect(isSelfChatJid('123456789-987654321@g.us', ownerPhone, ownerLid)).toBe(false);
    });

    it('rejects message to broadcast', () => {
      expect(isSelfChatJid('status@broadcast', ownerPhone, ownerLid)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns false for null JID', () => {
      expect(isSelfChatJid(null, ownerPhone, ownerLid)).toBe(false);
    });

    it('returns false when owner phone and LID are both null', () => {
      expect(isSelfChatJid('1234567890@s.whatsapp.net', null, null)).toBe(false);
    });

    it('returns false for undefined JID', () => {
      expect(isSelfChatJid(undefined, ownerPhone, ownerLid)).toBe(false);
    });
  });
});

describe('handleMessage — self-chat gate integration', () => {
  it('does NOT send/react when fromMe + otherPerson@s.whatsapp.net', async () => {
    const { handleMessage } = await import('./handler.ts');
    
    const messageToOther = makeMessage({
      from: '1234567890:123@s.whatsapp.net',
      to: '9876543210@s.whatsapp.net',
      body: 'Hello someone else',
      isFromMe: true,
      messageKey: { remoteJid: '9876543210@s.whatsapp.net', id: 'msg_1', fromMe: true },
    });

    await handleMessage(messageToOther);

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSendReaction).not.toHaveBeenCalled();
  });

  it('does NOT send/react when fromMe + group@g.us', async () => {
    const { handleMessage } = await import('./handler.ts');
    
    const groupMessage = makeMessage({
      from: '1234567890:123@s.whatsapp.net',
      to: '123456789-987654321@g.us',
      body: 'Hello group',
      isFromMe: true,
      messageKey: { remoteJid: '123456789-987654321@g.us', id: 'msg_1', fromMe: true },
    });

    await handleMessage(groupMessage);

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSendReaction).not.toHaveBeenCalled();
  });

  it('does NOT send/react when fromMe + @broadcast', async () => {
    const { handleMessage } = await import('./handler.ts');
    
    const broadcastMessage = makeMessage({
      from: '1234567890:123@s.whatsapp.net',
      to: 'status@broadcast',
      body: 'Hello broadcast',
      isFromMe: true,
      messageKey: { remoteJid: 'status@broadcast', id: 'msg_1', fromMe: true },
    });

    await handleMessage(broadcastMessage);

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSendReaction).not.toHaveBeenCalled();
  });

  it('does NOT send/react when isFromMe is false (inbound from other person)', async () => {
    const { handleMessage } = await import('./handler.ts');
    
    const inboundMessage = makeMessage({
      from: '9876543210@s.whatsapp.net',
      to: '1234567890@s.whatsapp.net',
      body: 'Hello',
      isFromMe: false,
      messageKey: { remoteJid: '1234567890@s.whatsapp.net', id: 'msg_1', fromMe: false },
    });

    await handleMessage(inboundMessage);

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSendReaction).not.toHaveBeenCalled();
  });

  it('DOES process valid self-chat via phone JID', async () => {
    const { handleMessage } = await import('./handler.ts');
    
    const selfChatMessage = makeMessage({
      from: '1234567890:123@s.whatsapp.net',
      to: '1234567890@s.whatsapp.net',
      body: '/help',
      isFromMe: true,
      messageKey: { remoteJid: '1234567890@s.whatsapp.net', id: 'msg_1', fromMe: true },
    });

    await handleMessage(selfChatMessage);

    expect(mockSendMessage).toHaveBeenCalled();
  });

  it('DOES process valid self-chat via LID', async () => {
    const { handleMessage } = await import('./handler.ts');
    
    const selfChatMessage = makeMessage({
      from: '1234567890:123@s.whatsapp.net',
      to: 'ABC123XYZ@lid',
      body: '/help',
      isFromMe: true,
      messageKey: { remoteJid: 'ABC123XYZ@lid', id: 'msg_1', fromMe: true },
    });

    await handleMessage(selfChatMessage);

    expect(mockSendMessage).toHaveBeenCalled();
  });

  it('returns early when ownerJid is null', async () => {
    mockGetOwnerJid.mockReturnValue(null);
    const { handleMessage } = await import('./handler.ts');
    
    const message = makeMessage({
      body: '/help',
      isFromMe: true,
    });

    await handleMessage(message);

    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

describe('isSelfChat — exported function uses canonical gate', () => {
  it('isSelfChat calls isSelfChatJid with owner phone and LID', async () => {
    const { isSelfChat } = await import('./handler.ts');
    
    const selfMessage = makeMessage({
      to: '1234567890@s.whatsapp.net',
      isFromMe: true,
    });
    
    expect(isSelfChat(selfMessage)).toBe(true);
  });

  it('isSelfChat rejects when isFromMe is false', async () => {
    const { isSelfChat } = await import('./handler.ts');
    
    const notFromMe = makeMessage({
      to: '1234567890@s.whatsapp.net',
      isFromMe: false,
    });
    
    expect(isSelfChat(notFromMe)).toBe(false);
  });

  it('isSelfChat rejects when to is another person', async () => {
    const { isSelfChat } = await import('./handler.ts');
    
    const toOther = makeMessage({
      to: '9876543210@s.whatsapp.net',
      isFromMe: true,
    });
    
    expect(isSelfChat(toOther)).toBe(false);
  });
});

describe('Message Key', () => {
  it('messageKey includes required fields', () => {
    const messageKey = {
      remoteJid: '1234567890@s.whatsapp.net',
      id: 'msg_123',
      fromMe: true,
    };

    expect(messageKey.remoteJid).toBeDefined();
    expect(messageKey.id).toBeDefined();
    expect(messageKey.fromMe).toBeDefined();
  });

  it('messageKey can include optional participant', () => {
    const messageKey = {
      remoteJid: '123456789-987654321@g.us',
      id: 'msg_123',
      fromMe: false,
      participant: '1234567890@s.whatsapp.net',
    };

    expect(messageKey.participant).toBeDefined();
  });
});

describe('Executed-action notes reach the model (#26)', () => {
  it('prefixes the next prompt with what ran outside the model without consuming (#170)', async () => {
    const { recordExecutedAction, consumeExecutedActionNotes } = await import('../core/confirmations.ts');
    const { withExecutedActionNotes } = await import('./handler.ts');
    recordExecutedAction({ projectId: 'default', actionId: 'gmail.send_email', success: true, summary: '{"id":"m1"}' });

    const prompt = withExecutedActionNotes('default', 'thanks');
    expect(prompt).toContain('gmail.send_email: executed successfully');
    expect(prompt).toContain('Do not execute them again');
    expect(prompt.endsWith('thanks')).toBe(true);

    expect(withExecutedActionNotes('default', 'again')).toContain('gmail.send_email');
    consumeExecutedActionNotes('default');
    expect(withExecutedActionNotes('default', 'again')).toBe('again');
  });

  it('consumes notes only after a successful model turn (#170)', async () => {
    const { recordExecutedAction } = await import('../core/confirmations.ts');
    const { handleMessage, withExecutedActionNotes } = await import('./handler.ts');
    recordExecutedAction({ projectId: 'default', actionId: 'gmail.send_email', success: true, summary: '{"id":"m1"}' });
    mockRunPromptWithCallbacks.mockResolvedValueOnce('done');

    await handleMessage(makeMessage({
      id: 'msg_notes_ok',
      body: 'thanks',
      isFromMe: true,
      to: 'ABC123XYZ@lid',
      messageKey: { remoteJid: 'ABC123XYZ@lid', id: 'msg_notes_ok', fromMe: true },
    }));

    expect(withExecutedActionNotes('default', 'next')).toBe('next');
  });

  it('keeps notes when the model turn returns null (#170)', async () => {
    const { recordExecutedAction } = await import('../core/confirmations.ts');
    const { handleMessage, withExecutedActionNotes } = await import('./handler.ts');
    recordExecutedAction({ projectId: 'default', actionId: 'gmail.send_email', success: true, summary: '{"id":"m1"}' });
    mockRunPromptWithCallbacks.mockResolvedValueOnce(null);

    await handleMessage(makeMessage({
      id: 'msg_notes_fail',
      body: 'thanks',
      isFromMe: true,
      to: 'ABC123XYZ@lid',
      messageKey: { remoteJid: 'ABC123XYZ@lid', id: 'msg_notes_fail', fromMe: true },
    }));

    expect(withExecutedActionNotes('default', 'next')).toContain('gmail.send_email');
  });
});

describe('queued /project then prompt uses the new project (#77)', () => {
  it('runPromptWithCallbacks is called with project b after /project b', async () => {
    const { createProject } = await import('../core/memory.ts');
    createProject({ id: 'b', name: 'b' });
    const { handleMessage } = await import('./handler.ts');
    mockRunPromptWithCallbacks.mockClear();

    const projectMsg = makeMessage({
      id: 'msg_project_b',
      body: '/project b',
      isFromMe: true,
      to: 'ABC123XYZ@lid',
      messageKey: { remoteJid: 'ABC123XYZ@lid', id: 'msg_project_b', fromMe: true },
    });
    const promptMsg = makeMessage({
      id: 'msg_after_project',
      body: 'check mail',
      isFromMe: true,
      to: 'ABC123XYZ@lid',
      messageKey: { remoteJid: 'ABC123XYZ@lid', id: 'msg_after_project', fromMe: true },
    });

    await Promise.all([
      handleMessage(projectMsg),
      handleMessage(promptMsg),
    ]);

    expect(mockRunPromptWithCallbacks).toHaveBeenCalled();
    const projectIds = mockRunPromptWithCallbacks.mock.calls.map((c: unknown[]) => c[0]);
    expect(projectIds).toContain('b');
  });
});

describe('/project Claude Code (#165)', () => {
  function selfChat(id: string, body: string) {
    return makeMessage({
      id,
      body,
      isFromMe: true,
      to: 'ABC123XYZ@lid',
      messageKey: { remoteJid: 'ABC123XYZ@lid', id, fromMe: true },
    });
  }

  it('does not create a missing project and points at /project-new', async () => {
    const { handleMessage } = await import('./handler.ts');
    await handleMessage(selfChat('msg_missing_proj', '/project sales'));
    const text = mockSendMessage.mock.calls.map((c) => String(c[1])).join('\n');
    expect(text).toContain('אין פרויקט');
    expect(text).toContain('/project-new');
  });

  it('early-returns when switching to the already-active project', async () => {
    const session = await import('../agent/session.ts');
    const { handleMessage } = await import('./handler.ts');
    await handleMessage(selfChat('msg_same_proj', '/project default'));
    expect(session.clearSession).not.toHaveBeenCalled();
    const text = mockSendMessage.mock.calls.map((c) => String(c[1])).join('\n');
    expect(text).toContain('פרויקט פעיל');
  });

  it('does not clear Claude Code history or require a Pi session (#165)', async () => {
    const { createProject } = await import('../core/memory.ts');
    createProject({ id: 'sales', name: 'sales' });
    const claude = await import('../agent/claude-code.ts');
    const session = await import('../agent/session.ts');
    vi.mocked(claude.isClaudeCodeConnected).mockReturnValue(true);
    const { handleMessage } = await import('./handler.ts');

    await handleMessage(selfChat('msg_switch_sales', '/project sales'));

    expect(claude.clearClaudeCodeSession).not.toHaveBeenCalled();
    expect(session.getOrCreateSession).not.toHaveBeenCalled();
    const text = mockSendMessage.mock.calls.map((c) => String(c[1])).join('\n');
    expect(text).toContain('הוחלף לפרויקט');
    expect(text).not.toContain('No AI provider');
  });

  it('/project-new creates without switching', async () => {
    const { handleMessage } = await import('./handler.ts');
    const { getProject } = await import('../core/memory.ts');
    const { loadSettings } = await import('../core/settings.ts');
    await handleMessage(selfChat('msg_new_proj', '/project-new sales'));
    expect(getProject('sales')?.name).toBe('sales');
    expect(loadSettings().activeProject).toBe('default');
    const text = mockSendMessage.mock.calls.map((c) => String(c[1])).join('\n');
    expect(text).toContain('נוצר פרויקט');
  });
});

describe('/model matches the active engine (#171)', () => {
  function selfChat(id: string, body: string) {
    return makeMessage({
      id,
      body,
      isFromMe: true,
      to: 'ABC123XYZ@lid',
      messageKey: { remoteJid: 'ABC123XYZ@lid', id, fromMe: true },
    });
  }

  it('rejects a Pi model while Claude Code is connected', async () => {
    const claude = await import('../agent/claude-code.ts');
    vi.mocked(claude.isClaudeCodeConnected).mockReturnValue(true);
    const { handleMessage } = await import('./handler.ts');
    const { loadSettings } = await import('../core/settings.ts');
    const before = loadSettings().model;

    await handleMessage(selfChat('msg_model_pi', '/model gpt-5.3-codex'));

    const text = mockSendMessage.mock.calls.map((c) => String(c[1])).join('\n');
    expect(text).toContain('Claude Code');
    expect(text).not.toContain('מודל שונה');
    expect(loadSettings().model).toBe(before);
  });

  it('stores claude-code/opus when Claude Code is connected', async () => {
    const claude = await import('../agent/claude-code.ts');
    vi.mocked(claude.isClaudeCodeConnected).mockReturnValue(true);
    const { handleMessage } = await import('./handler.ts');
    await handleMessage(selfChat('msg_model_cc', '/model claude-code/opus'));
    const { loadSettings } = await import('../core/settings.ts');
    expect(loadSettings().model).toBe('claude-code/opus');
    const text = mockSendMessage.mock.calls.map((c) => String(c[1])).join('\n');
    expect(text).toContain('opus');
  });

  it('rejects claude-code/opus on a ChatGPT stack', async () => {
    const claude = await import('../agent/claude-code.ts');
    vi.mocked(claude.isClaudeCodeConnected).mockReturnValue(false);
    const auth = await import('../http/auth.ts');
    vi.mocked(auth.listRuntimeCredentials).mockResolvedValue([
      { providerId: 'openai-codex', type: 'oauth' },
    ]);
    const { handleMessage } = await import('./handler.ts');
    const { loadSettings } = await import('../core/settings.ts');
    const before = loadSettings().model;

    await handleMessage(selfChat('msg_model_cc_on_pi', '/model claude-code/opus'));

    const text = mockSendMessage.mock.calls.map((c) => String(c[1])).join('\n');
    expect(text).toContain('Claude Code אינו מחובר');
    expect(loadSettings().model).toBe(before);
  });
});

describe('expired confirmation notice (#168)', () => {
  it('does not replace a still-valid numbered pick with the expiry notice', async () => {
    const session = await import('../agent/session.ts');
    vi.mocked(session.consumeExpiredConfirmations).mockReturnValue([
      { confirmationId: 'confirm_old', actionId: 'gmail.send_email', input: {}, createdAt: Date.now(), projectId: 'default' },
    ] as never);
    vi.mocked(session.getAllPendingConfirmations).mockReturnValue([
      {
        confirmationId: 'confirm_live',
        actionId: 'calendar.create_event',
        input: { title: 'Meeting' },
        projectId: 'default',
        createdAt: Date.now(),
      },
    ] as never);
    vi.mocked(session.formatPendingForUser).mockReturnValue('📋 *calendar.create_event*');
    vi.mocked(session.isPayloadPresented).mockReturnValue(false);

    const { handleMessage } = await import('./handler.ts');
    await handleMessage(makeMessage({
      id: 'msg_pick_after_expiry',
      body: '1',
      isFromMe: true,
      to: 'ABC123XYZ@lid',
      messageKey: { remoteJid: 'ABC123XYZ@lid', id: 'msg_pick_after_expiry', fromMe: true },
    }));

    const text = mockSendMessage.mock.calls.map((c) => String(c[1])).join('\n');
    expect(text).not.toContain('תוקף האישור פג');
    expect(text).toContain('calendar.create_event');

    vi.mocked(session.consumeExpiredConfirmations).mockReturnValue([]);
    vi.mocked(session.getAllPendingConfirmations).mockReturnValue([]);
  });
});

describe('U-12 WhatsApp leftovers (#141)', () => {
  it('captionless media in self-chat gets Hebrew need-text, not a silent drop', async () => {
    const { MEDIA_WITHOUT_TEXT_BODY } = await import('./inbound.ts');
    const { handleMessage } = await import('./handler.ts');

    await handleMessage(makeMessage({
      id: 'msg_media_self',
      from: '1234567890:123@s.whatsapp.net',
      to: 'ABC123XYZ@lid',
      body: MEDIA_WITHOUT_TEXT_BODY,
      isFromMe: true,
      messageKey: { remoteJid: 'ABC123XYZ@lid', id: 'msg_media_self', fromMe: true },
    }));

    expect(mockSendMessage).toHaveBeenCalled();
    const bodies = mockSendMessage.mock.calls.map((c) => String(c[1]));
    expect(bodies.some((b) => b.includes('צריך טקסט'))).toBe(true);
    expect(mockRunPromptWithCallbacks).not.toHaveBeenCalled();
  });

  it('captionless media in a foreign chat is still dropped by the self-chat gate', async () => {
    const { MEDIA_WITHOUT_TEXT_BODY } = await import('./inbound.ts');
    const { handleMessage } = await import('./handler.ts');

    await handleMessage(makeMessage({
      id: 'msg_media_other',
      from: '1234567890:123@s.whatsapp.net',
      to: '9876543210@s.whatsapp.net',
      body: MEDIA_WITHOUT_TEXT_BODY,
      isFromMe: true,
      messageKey: { remoteJid: '9876543210@s.whatsapp.net', id: 'msg_media_other', fromMe: true },
    }));

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockRunPromptWithCallbacks).not.toHaveBeenCalled();
  });

  it('/login is not restored as a command — falls through to the model', async () => {
    mockRunPromptWithCallbacks.mockResolvedValueOnce('login went to model');
    const { handleMessage } = await import('./handler.ts');

    await handleMessage(makeMessage({
      id: 'msg_login_cmd',
      from: '1234567890:123@s.whatsapp.net',
      to: 'ABC123XYZ@lid',
      body: '/login',
      isFromMe: true,
      messageKey: { remoteJid: 'ABC123XYZ@lid', id: 'msg_login_cmd', fromMe: true },
    }));

    expect(mockRunPromptWithCallbacks).toHaveBeenCalled();
    const bodies = mockSendMessage.mock.calls.map((c) => String(c[1]));
    expect(bodies).toContain('login went to model');
    expect(bodies.some((b) => b.includes('ספקי AI'))).toBe(false);
  });

  it('unknown /command falls through to the model, not פקודה לא מוכרת', async () => {
    mockRunPromptWithCallbacks.mockResolvedValueOnce('ok from model');
    const { handleMessage } = await import('./handler.ts');

    await handleMessage(makeMessage({
      id: 'msg_unknown_cmd',
      from: '1234567890:123@s.whatsapp.net',
      to: 'ABC123XYZ@lid',
      body: '/remind me tomorrow',
      isFromMe: true,
      messageKey: { remoteJid: 'ABC123XYZ@lid', id: 'msg_unknown_cmd', fromMe: true },
    }));

    const bodies = mockSendMessage.mock.calls.map((c) => String(c[1]));
    expect(bodies.some((b) => b.includes('פקודה לא מוכרת'))).toBe(false);
    expect(mockRunPromptWithCallbacks).toHaveBeenCalled();
    expect(bodies).toContain('ok from model');
  });

  it('/help mentions כן/לא/אשר/בטל and does not restore /login', async () => {
    const { handleMessage } = await import('./handler.ts');

    await handleMessage(makeMessage({
      id: 'msg_help_ux',
      from: '1234567890:123@s.whatsapp.net',
      to: 'ABC123XYZ@lid',
      body: '/help',
      isFromMe: true,
      messageKey: { remoteJid: 'ABC123XYZ@lid', id: 'msg_help_ux', fromMe: true },
    }));

    const text = mockSendMessage.mock.calls.map((c) => String(c[1])).join('\n');
    expect(text).toContain('כן');
    expect(text).toContain('לא');
    expect(text).toContain('אשר');
    expect(text).toContain('בטל');
    expect(text).not.toContain('/login');
  });
});

describe('skip stale inbound messages (#155)', () => {
  it('skips a self-chat message older than ~10 minutes and sends a quoted Hebrew notice', async () => {
    const { handleMessage } = await import('./handler.ts');
    const ts = Math.floor(Date.now() / 1000) - 11 * 60;

    await handleMessage(makeMessage({
      id: 'msg_stale',
      from: '1234567890:123@s.whatsapp.net',
      to: 'ABC123XYZ@lid',
      body: 'old hello',
      timestamp: ts,
      isFromMe: true,
      messageKey: { remoteJid: 'ABC123XYZ@lid', id: 'msg_stale', fromMe: true },
    }));

    expect(mockRunPromptWithCallbacks).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalled();
    const call = mockSendMessage.mock.calls.find((c) => String(c[1]).includes('דילגתי'));
    expect(call).toBeTruthy();
    expect(call![2]).toEqual(expect.objectContaining({ id: 'msg_stale' }));
  });

  it('processes a recent self-chat message', async () => {
    mockRunPromptWithCallbacks.mockResolvedValueOnce('fresh reply');
    const { handleMessage } = await import('./handler.ts');

    await handleMessage(makeMessage({
      id: 'msg_fresh',
      from: '1234567890:123@s.whatsapp.net',
      to: 'ABC123XYZ@lid',
      body: 'hello now',
      timestamp: Math.floor(Date.now() / 1000),
      isFromMe: true,
      messageKey: { remoteJid: 'ABC123XYZ@lid', id: 'msg_fresh', fromMe: true },
    }));

    expect(mockRunPromptWithCallbacks).toHaveBeenCalled();
    const bodies = mockSendMessage.mock.calls.map((c) => String(c[1]));
    expect(bodies.some((b) => b.includes('דילגתי'))).toBe(false);
  });

  it('getMessage(id) dedupe still applies — a second stale delivery is not noticed again', async () => {
    const { handleMessage } = await import('./handler.ts');
    const msg = makeMessage({
      id: 'msg_stale_dup',
      from: '1234567890:123@s.whatsapp.net',
      to: 'ABC123XYZ@lid',
      body: 'old hello',
      timestamp: Math.floor(Date.now() / 1000) - 11 * 60,
      isFromMe: true,
      messageKey: { remoteJid: 'ABC123XYZ@lid', id: 'msg_stale_dup', fromMe: true },
    });

    await handleMessage(msg);
    await handleMessage(msg);

    const skipCalls = mockSendMessage.mock.calls.filter((c) => String(c[1]).includes('דילגתי'));
    expect(skipCalls).toHaveLength(1);
  });

  it('sends one Hebrew stale notice per reconnect, then silently skips further old messages', async () => {
    const { handleMessage } = await import('./handler.ts');
    const base = {
      from: '1234567890:123@s.whatsapp.net',
      to: 'ABC123XYZ@lid',
      body: 'old hello',
      timestamp: Math.floor(Date.now() / 1000) - 11 * 60,
      isFromMe: true,
    } as const;
    await handleMessage(makeMessage({
      ...base,
      id: 'msg_stale_a',
      messageKey: { remoteJid: 'ABC123XYZ@lid', id: 'msg_stale_a', fromMe: true },
    }));
    await handleMessage(makeMessage({
      ...base,
      id: 'msg_stale_b',
      timestamp: Math.floor(Date.now() / 1000) - 12 * 60,
      messageKey: { remoteJid: 'ABC123XYZ@lid', id: 'msg_stale_b', fromMe: true },
    }));
    const skipCalls = mockSendMessage.mock.calls.filter((c) => String(c[1]).includes('דילגתי'));
    expect(skipCalls).toHaveLength(1);
    expect(mockRunPromptWithCallbacks).not.toHaveBeenCalled();
  });
});

// NOTE: the "Per-Project Processing Lock" suite below vi.doMock()s client/session/
// settings/memory/claude-code/auth for itself and never restores them; vitest keeps
// the last registered factory, so suites that need the shared mocks must come first.
describe('Per-Project Processing Lock - Issue #33', () => {
  it('concurrent handleMessage calls serialize session.prompt on same project', async () => {
    const promptCalls: { start: number; end: number; message: string }[] = [];
    let promptCallCounter = 0;

    vi.doMock('../agent/session.ts', async (importOriginal) => {
      const original = await importOriginal<typeof import('../agent/session.ts')>();
      return {
        ...original,
        checkCredentialsBeforePrompt: vi.fn().mockResolvedValue({
          model: { id: 'test' },
          modelId: 'test-model',
          valid: true,
        }),
        runPromptWithCallbacks: vi.fn().mockImplementation(async (_projectId: string, text: string) => {
          const callIndex = promptCallCounter++;
          const start = Date.now();
          promptCalls.push({ start, end: 0, message: text });
          
          await new Promise(r => setTimeout(r, 50));
          
          promptCalls[callIndex]!.end = Date.now();
          return `Response to: ${text}`;
        }),
      };
    });

    vi.doMock('./client.ts', () => ({
      getWhatsAppClient: vi.fn().mockReturnValue({
        getOwnerJid: () => '1234567890:123@s.whatsapp.net',
        getOwnerPhone: () => '1234567890',
        getOwnerLid: () => null,
        isSelfJid: (jid: string) => jid.includes('1234567890'),
        getSelfChatJid: () => '1234567890@lid',
        isConnected: () => true,
        sendMessage: vi.fn().mockResolvedValue(undefined),
        sendReaction: vi.fn().mockResolvedValue(undefined),
        takeStaleSkipNotice: () => true,
      }),
      WhatsAppClient: class {},
    }));

    vi.doMock('../core/settings.ts', async (importOriginal) => {
      const original = await importOriginal<typeof import('../core/settings.ts')>();
      return {
        ...original,
        loadSettings: vi.fn().mockReturnValue({
          botName: 'TestBot',
          ownerName: 'Test Owner',
          timezone: 'UTC',
          model: 'test-model',
          apiKeyMode: 'none',
          activeProject: 'test-project',
          services: [],
          projectTokens: {},
        }),
      };
    });

    vi.doMock('../core/memory.ts', () => ({
      saveMessage: vi.fn().mockReturnValue(true),
      getMessage: vi.fn().mockReturnValue(null),
      listProjects: vi.fn().mockReturnValue([]),
      createProject: vi.fn(),
      getProject: vi.fn(),
    }));

    vi.doMock('../agent/claude-code.ts', () => ({
      isClaudeCodeConnected: vi.fn().mockReturnValue(false),
      runClaudeCodePrompt: vi.fn(),
      clearClaudeCodeSession: vi.fn(),
    }));

    const { handleMessage } = await import('./handler.ts');

    const ownerJid = '1234567890:123@s.whatsapp.net';
    const selfChatLid = '1234567890@lid';

    const message1 = {
      id: 'msg_1',
      from: ownerJid,
      to: selfChatLid,
      body: 'First message',
      timestamp: Date.now(),
      isFromMe: true,
      messageKey: { remoteJid: selfChatLid, id: 'msg_1', fromMe: true },
    };

    const message2 = {
      id: 'msg_2',
      from: ownerJid,
      to: selfChatLid,
      body: 'Second message',
      timestamp: Date.now(),
      isFromMe: true,
      messageKey: { remoteJid: selfChatLid, id: 'msg_2', fromMe: true },
    };

    await Promise.all([
      handleMessage(message1),
      handleMessage(message2),
    ]);

    expect(promptCalls.length).toBe(2);

    const [first, second] = promptCalls.sort((a, b) => a.start - b.start);
    
    expect(second!.start).toBeGreaterThanOrEqual(first!.end);
  }, 15_000);

  it('queue-bypass commands (/status, /help) run immediately outside queue', async () => {
    const sendMessageMock = vi.fn().mockResolvedValue(undefined);
    const sendReactionMock = vi.fn().mockResolvedValue(undefined);
    
    const mockWaClient = {
      getOwnerJid: () => '1234567890:123@s.whatsapp.net',
      getOwnerPhone: () => '1234567890',
      getOwnerLid: () => '1234567890@lid',
      isSelfJid: (jid: string) => jid.includes('1234567890'),
      getSelfChatJid: () => '1234567890@lid',
      isConnected: () => true,
      sendMessage: sendMessageMock,
      sendReaction: sendReactionMock,
    };

    vi.doMock('./client.ts', () => ({
      getWhatsAppClient: vi.fn().mockReturnValue(mockWaClient),
      WhatsAppClient: class {},
    }));

    vi.doMock('../core/settings.ts', async (importOriginal) => {
      const original = await importOriginal<typeof import('../core/settings.ts')>();
      return {
        ...original,
        loadSettings: vi.fn().mockReturnValue({
          botName: 'TestBot',
          ownerName: 'Test Owner',
          timezone: 'UTC',
          model: 'test-model',
          apiKeyMode: 'none',
          activeProject: 'test-project',
          services: [],
          projectTokens: {},
        }),
        getActiveConnectorToken: vi.fn().mockReturnValue(null),
      };
    });

    vi.doMock('../core/memory.ts', () => ({
      saveMessage: vi.fn().mockReturnValue(true),
      getMessage: vi.fn().mockReturnValue(null),
    }));

    vi.doMock('../agent/claude-code.ts', () => ({
      isClaudeCodeConnected: vi.fn().mockReturnValue(false),
    }));

    vi.doMock('../http/auth.ts', () => ({
      listRuntimeCredentials: vi.fn().mockResolvedValue([]),
      resolveActiveModel: vi.fn().mockResolvedValue({ valid: false, model: null }),
    }));

    const { handleMessage } = await import('./handler.ts');

    const selfChatLid = '1234567890@lid';

    const statusMessage = {
      id: 'msg_status',
      from: '1234567890:123@s.whatsapp.net',
      to: selfChatLid,
      body: '/status',
      timestamp: Date.now(),
      isFromMe: true,
      messageKey: { remoteJid: selfChatLid, id: 'msg_status', fromMe: true },
    };

    await handleMessage(statusMessage);

    expect(sendMessageMock).toHaveBeenCalled();
  });
});

describe('Gate mutation safety', () => {
  const ownerPhone = '1234567890';
  const ownerLid = 'ABC123XYZ@lid';

  it('fails if isSelfChatJid always returns true (mutation test)', () => {
    const maliciousJid = '9999999999@s.whatsapp.net';
    const result = isSelfChatJid(maliciousJid, ownerPhone, ownerLid);
    expect(result).toBe(false);
  });

  it('fails if group check is removed (mutation test)', () => {
    const groupJid = '123456789-987654321@g.us';
    expect(isSelfChatJid(groupJid, ownerPhone, ownerLid)).toBe(false);
  });

  it('fails if broadcast check is removed (mutation test)', () => {
    const broadcastJid = 'status@broadcast';
    expect(isSelfChatJid(broadcastJid, ownerPhone, ownerLid)).toBe(false);
  });

  it('must accept valid self-chat (ensures we test both directions)', () => {
    expect(isSelfChatJid('1234567890@s.whatsapp.net', ownerPhone, ownerLid)).toBe(true);
    expect(isSelfChatJid('ABC123XYZ@lid', ownerPhone, ownerLid)).toBe(true);
  });
});

describe('Confirmation Patterns (handler)', () => {
  const CONFIRM_PATTERNS = [
    /^(yes|y|ok|okay|sure|confirm|כן|אשר|אוקיי|אוקי|בסדר|יאללה)$/i,
  ];

  it('CONFIRM_PATTERNS includes ok', () => {
    expect(CONFIRM_PATTERNS.some((p) => p.test('ok'))).toBe(true);
  });

  it('CONFIRM_PATTERNS includes בסדר', () => {
    expect(CONFIRM_PATTERNS.some((p) => p.test('בסדר'))).toBe(true);
  });

  it('CONFIRM_PATTERNS includes אוקיי', () => {
    expect(CONFIRM_PATTERNS.some((p) => p.test('אוקיי'))).toBe(true);
  });

  it('CONFIRM_PATTERNS includes כן', () => {
    expect(CONFIRM_PATTERNS.some((p) => p.test('כן'))).toBe(true);
  });

  it('CONFIRM_PATTERNS includes אשר', () => {
    expect(CONFIRM_PATTERNS.some((p) => p.test('אשר'))).toBe(true);
  });

  it('CONFIRM_PATTERNS includes yes', () => {
    expect(CONFIRM_PATTERNS.some((p) => p.test('yes'))).toBe(true);
  });

  it('CONFIRM_PATTERNS includes confirm', () => {
    expect(CONFIRM_PATTERNS.some((p) => p.test('confirm'))).toBe(true);
  });
});

describe('S-04 (#108) — handler must show payload before any execute', () => {
  it('plain כן shows payload and does NOT execute on first attempt', async () => {
    const mockFormatPendingForUser = vi.fn().mockReturnValue('📋 *gmail.send_email*\n👤 אל: test@example.com');
    const mockConfirmAction = vi.fn().mockReturnValue(true);
    const mockMarkPayloadPresented = vi.fn().mockReturnValue(true);
    const mockIsPayloadPresented = vi.fn().mockReturnValue(false);

    vi.doMock('../agent/session.ts', async (importOriginal) => {
      const original = await importOriginal<typeof import('../agent/session.ts')>();
      return {
        ...original,
        getAllPendingConfirmations: vi.fn().mockReturnValue([{
          confirmationId: 'confirm_123_abc',
          actionId: 'gmail.send_email',
          input: { to: 'test@example.com', subject: 'Test', body: 'Hello' },
          projectId: 'default',
          createdAt: Date.now(),
        }]),
        formatPendingForUser: mockFormatPendingForUser,
        confirmAction: mockConfirmAction,
        markPayloadPresented: mockMarkPayloadPresented,
        isPayloadPresented: mockIsPayloadPresented,
        getPendingConfirmation: vi.fn().mockReturnValue(undefined),
        cleanupOldConfirmations: vi.fn(),
        consumeExpiredConfirmations: vi.fn(() => []),
        cancelAllPendingConfirmations: vi.fn().mockReturnValue(0),
        checkCredentialsBeforePrompt: vi.fn().mockResolvedValue({ valid: true, model: true, modelId: 'test' }),
        runPromptWithCallbacks: vi.fn().mockResolvedValue(null),
      };
    });

    vi.doMock('./client.ts', () => ({
      getWhatsAppClient: vi.fn().mockReturnValue({
        getOwnerJid: () => '1234567890:123@s.whatsapp.net',
        getOwnerPhone: () => '1234567890',
        getOwnerLid: () => '1234567890@lid',
        isSelfJid: (jid: string) => jid.includes('1234567890'),
        getSelfChatJid: () => '1234567890@lid',
        isConnected: () => true,
        sendMessage: vi.fn().mockResolvedValue(undefined),
        sendReaction: vi.fn().mockResolvedValue(undefined),
        getPairingState: () => ({ isPaired: true, selfChat: 'lid' }),
      }),
      WhatsAppClient: class {},
    }));

    vi.doMock('../core/settings.ts', async (importOriginal) => {
      const original = await importOriginal<typeof import('../core/settings.ts')>();
      return {
        ...original,
        loadSettings: vi.fn().mockReturnValue({
          botName: 'TestBot',
          ownerName: 'Test Owner',
          timezone: 'UTC',
          model: 'test-model',
          apiKeyMode: 'none',
          activeProject: 'default',
          services: [],
          projectTokens: {},
        }),
      };
    });

    vi.doMock('../core/memory.ts', () => ({
      saveMessage: vi.fn().mockReturnValue(true),
      getMessage: vi.fn().mockReturnValue(null),
      listProjects: vi.fn().mockReturnValue([]),
      createProject: vi.fn(),
      getProject: vi.fn(),
    }));

    vi.doMock('../agent/claude-code.ts', () => ({
      isClaudeCodeConnected: vi.fn().mockReturnValue(false),
      runClaudeCodePrompt: vi.fn(),
      clearClaudeCodeSession: vi.fn(),
    }));

    const { handleMessage } = await import('./handler.ts');

    const confirmMessage = {
      id: 'msg_confirm',
      from: '1234567890:123@s.whatsapp.net',
      to: '1234567890@lid',
      body: 'כן',
      timestamp: Date.now(),
      isFromMe: true,
      messageKey: { remoteJid: '1234567890@lid', id: 'msg_confirm', fromMe: true },
    };

    await handleMessage(confirmMessage);

    // S-04: formatPendingForUser MUST be called to show the payload
    expect(mockFormatPendingForUser).toHaveBeenCalled();
    // S-04: markPayloadPresented MUST be called to track that we showed it
    expect(mockMarkPayloadPresented).toHaveBeenCalled();
    // S-04: confirmAction must NOT be called — payload not yet shown
    expect(mockConfirmAction).not.toHaveBeenCalled();
  });

  it('confirm_xxx does NOT execute without prior handler-shown payload', async () => {
    const mockConfirmAction = vi.fn().mockReturnValue(true);
    const mockMarkPayloadPresented = vi.fn().mockReturnValue(true);
    const mockIsPayloadPresented = vi.fn().mockReturnValue(false);
    const mockFormatPendingForUser = vi.fn().mockReturnValue('📋 *gmail.send_email*\n👤 אל: attacker@evil.com');

    vi.doMock('../agent/session.ts', async (importOriginal) => {
      const original = await importOriginal<typeof import('../agent/session.ts')>();
      return {
        ...original,
        getAllPendingConfirmations: vi.fn().mockReturnValue([{
          confirmationId: 'confirm_456_xyz',
          actionId: 'gmail.send_email',
          input: { to: 'attacker@evil.com', subject: 'Stolen', body: 'Secrets' },
          projectId: 'default',
          createdAt: Date.now(),
        }]),
        formatPendingForUser: mockFormatPendingForUser,
        confirmAction: mockConfirmAction,
        markPayloadPresented: mockMarkPayloadPresented,
        isPayloadPresented: mockIsPayloadPresented,
        getPendingConfirmation: vi.fn().mockReturnValue({
          actionId: 'gmail.send_email',
          input: { to: 'attacker@evil.com', subject: 'Stolen', body: 'Secrets' },
          projectId: 'default',
          createdAt: Date.now(),
        }),
        cleanupOldConfirmations: vi.fn(),
        consumeExpiredConfirmations: vi.fn(() => []),
        cancelAllPendingConfirmations: vi.fn().mockReturnValue(0),
        checkCredentialsBeforePrompt: vi.fn().mockResolvedValue({ valid: true, model: true, modelId: 'test' }),
        runPromptWithCallbacks: vi.fn().mockResolvedValue(null),
      };
    });

    vi.doMock('./client.ts', () => ({
      getWhatsAppClient: vi.fn().mockReturnValue({
        getOwnerJid: () => '1234567890:123@s.whatsapp.net',
        getOwnerPhone: () => '1234567890',
        getOwnerLid: () => '1234567890@lid',
        isSelfJid: (jid: string) => jid.includes('1234567890'),
        getSelfChatJid: () => '1234567890@lid',
        isConnected: () => true,
        sendMessage: vi.fn().mockResolvedValue(undefined),
        sendReaction: vi.fn().mockResolvedValue(undefined),
        getPairingState: () => ({ isPaired: true, selfChat: 'lid' }),
      }),
      WhatsAppClient: class {},
    }));

    vi.doMock('../core/settings.ts', async (importOriginal) => {
      const original = await importOriginal<typeof import('../core/settings.ts')>();
      return {
        ...original,
        loadSettings: vi.fn().mockReturnValue({
          botName: 'TestBot',
          ownerName: 'Test Owner',
          timezone: 'UTC',
          model: 'test-model',
          apiKeyMode: 'none',
          activeProject: 'default',
          services: [],
          projectTokens: {},
        }),
      };
    });

    vi.doMock('../core/memory.ts', () => ({
      saveMessage: vi.fn().mockReturnValue(true),
      getMessage: vi.fn().mockReturnValue(null),
      listProjects: vi.fn().mockReturnValue([]),
      createProject: vi.fn(),
      getProject: vi.fn(),
    }));

    vi.doMock('../agent/claude-code.ts', () => ({
      isClaudeCodeConnected: vi.fn().mockReturnValue(false),
      runClaudeCodePrompt: vi.fn(),
      clearClaudeCodeSession: vi.fn(),
    }));

    const { handleMessage } = await import('./handler.ts');

    // S-04 attack: model tells user to paste confirm_xxx without handler showing payload
    const confirmIdMessage = {
      id: 'msg_confirm_id_attack',
      from: '1234567890:123@s.whatsapp.net',
      to: '1234567890@lid',
      body: 'confirm_456_xyz',
      timestamp: Date.now(),
      isFromMe: true,
      messageKey: { remoteJid: '1234567890@lid', id: 'msg_confirm_id_attack', fromMe: true },
    };

    await handleMessage(confirmIdMessage);

    // S-04: confirm_xxx must NOT execute if payload was never shown by handler
    expect(mockConfirmAction).not.toHaveBeenCalled();
    // S-04: instead, the handler should show the payload
    expect(mockFormatPendingForUser).toHaveBeenCalled();
    expect(mockMarkPayloadPresented).toHaveBeenCalled();
  });

  it('number pick does NOT execute without prior handler-shown payload', async () => {
    const mockConfirmAction = vi.fn().mockReturnValue(true);
    const mockMarkPayloadPresented = vi.fn().mockReturnValue(true);
    const mockIsPayloadPresented = vi.fn().mockReturnValue(false);
    const mockFormatPendingForUser = vi.fn().mockReturnValue('📋 *gmail.send_email*\n👤 אל: test@example.com');

    vi.doMock('../agent/session.ts', async (importOriginal) => {
      const original = await importOriginal<typeof import('../agent/session.ts')>();
      return {
        ...original,
        getAllPendingConfirmations: vi.fn().mockReturnValue([
          { confirmationId: 'confirm_1', actionId: 'gmail.send_email', input: { to: 'a@example.com' }, projectId: 'default', createdAt: Date.now() },
          { confirmationId: 'confirm_2', actionId: 'calendar.create_event', input: { title: 'Meeting' }, projectId: 'default', createdAt: Date.now() },
        ]),
        formatPendingForUser: mockFormatPendingForUser,
        confirmAction: mockConfirmAction,
        markPayloadPresented: mockMarkPayloadPresented,
        isPayloadPresented: mockIsPayloadPresented,
        getPendingConfirmation: vi.fn().mockReturnValue(undefined),
        cleanupOldConfirmations: vi.fn(),
        consumeExpiredConfirmations: vi.fn(() => []),
        cancelAllPendingConfirmations: vi.fn().mockReturnValue(0),
        checkCredentialsBeforePrompt: vi.fn().mockResolvedValue({ valid: true, model: true, modelId: 'test' }),
        runPromptWithCallbacks: vi.fn().mockResolvedValue(null),
      };
    });

    vi.doMock('./client.ts', () => ({
      getWhatsAppClient: vi.fn().mockReturnValue({
        getOwnerJid: () => '1234567890:123@s.whatsapp.net',
        getOwnerPhone: () => '1234567890',
        getOwnerLid: () => '1234567890@lid',
        isSelfJid: (jid: string) => jid.includes('1234567890'),
        getSelfChatJid: () => '1234567890@lid',
        isConnected: () => true,
        sendMessage: vi.fn().mockResolvedValue(undefined),
        sendReaction: vi.fn().mockResolvedValue(undefined),
        getPairingState: () => ({ isPaired: true, selfChat: 'lid' }),
      }),
      WhatsAppClient: class {},
    }));

    vi.doMock('../core/settings.ts', async (importOriginal) => {
      const original = await importOriginal<typeof import('../core/settings.ts')>();
      return {
        ...original,
        loadSettings: vi.fn().mockReturnValue({
          botName: 'TestBot',
          ownerName: 'Test Owner',
          timezone: 'UTC',
          model: 'test-model',
          apiKeyMode: 'none',
          activeProject: 'default',
          services: [],
          projectTokens: {},
        }),
      };
    });

    vi.doMock('../core/memory.ts', () => ({
      saveMessage: vi.fn().mockReturnValue(true),
      getMessage: vi.fn().mockReturnValue(null),
      listProjects: vi.fn().mockReturnValue([]),
      createProject: vi.fn(),
      getProject: vi.fn(),
    }));

    vi.doMock('../agent/claude-code.ts', () => ({
      isClaudeCodeConnected: vi.fn().mockReturnValue(false),
      runClaudeCodePrompt: vi.fn(),
      clearClaudeCodeSession: vi.fn(),
    }));

    const { handleMessage } = await import('./handler.ts');

    // User picks number "1" without handler having shown the list
    const numberMessage = {
      id: 'msg_number_pick',
      from: '1234567890:123@s.whatsapp.net',
      to: '1234567890@lid',
      body: '1',
      timestamp: Date.now(),
      isFromMe: true,
      messageKey: { remoteJid: '1234567890@lid', id: 'msg_number_pick', fromMe: true },
    };

    await handleMessage(numberMessage);

    // S-04: number pick must NOT execute if payload was never shown
    expect(mockConfirmAction).not.toHaveBeenCalled();
    // S-04: instead, handler shows the payload for that item
    expect(mockFormatPendingForUser).toHaveBeenCalled();
    expect(mockMarkPayloadPresented).toHaveBeenCalled();
  });

  it('second כן DOES execute after payload was shown', async () => {
    const mockConfirmAction = vi.fn().mockReturnValue(true);
    const mockIsPayloadPresented = vi.fn().mockReturnValue(true); // Already shown!

    vi.doMock('../agent/session.ts', async (importOriginal) => {
      const original = await importOriginal<typeof import('../agent/session.ts')>();
      return {
        ...original,
        getAllPendingConfirmations: vi.fn().mockReturnValue([{
          confirmationId: 'confirm_789_def',
          actionId: 'gmail.send_email',
          input: { to: 'legitimate@example.com', subject: 'Hello', body: 'World' },
          projectId: 'default',
          createdAt: Date.now(),
        }]),
        formatPendingForUser: vi.fn().mockReturnValue('📋 *gmail.send_email*'),
        confirmAction: mockConfirmAction,
        markPayloadPresented: vi.fn().mockReturnValue(true),
        isPayloadPresented: mockIsPayloadPresented,
        getPendingConfirmation: vi.fn().mockReturnValue(undefined),
        cleanupOldConfirmations: vi.fn(),
        consumeExpiredConfirmations: vi.fn(() => []),
        cancelAllPendingConfirmations: vi.fn().mockReturnValue(0),
        checkCredentialsBeforePrompt: vi.fn().mockResolvedValue({ valid: true, model: true, modelId: 'test' }),
        runPromptWithCallbacks: vi.fn().mockResolvedValue(null),
      };
    });

    vi.doMock('./client.ts', () => ({
      getWhatsAppClient: vi.fn().mockReturnValue({
        getOwnerJid: () => '1234567890:123@s.whatsapp.net',
        getOwnerPhone: () => '1234567890',
        getOwnerLid: () => '1234567890@lid',
        isSelfJid: (jid: string) => jid.includes('1234567890'),
        getSelfChatJid: () => '1234567890@lid',
        isConnected: () => true,
        sendMessage: vi.fn().mockResolvedValue(undefined),
        sendReaction: vi.fn().mockResolvedValue(undefined),
        getPairingState: () => ({ isPaired: true, selfChat: 'lid' }),
      }),
      WhatsAppClient: class {},
    }));

    vi.doMock('../core/settings.ts', async (importOriginal) => {
      const original = await importOriginal<typeof import('../core/settings.ts')>();
      return {
        ...original,
        loadSettings: vi.fn().mockReturnValue({
          botName: 'TestBot',
          ownerName: 'Test Owner',
          timezone: 'UTC',
          model: 'test-model',
          apiKeyMode: 'none',
          activeProject: 'default',
          services: [],
          projectTokens: {},
        }),
      };
    });

    vi.doMock('../core/memory.ts', () => ({
      saveMessage: vi.fn().mockReturnValue(true),
      getMessage: vi.fn().mockReturnValue(null),
      listProjects: vi.fn().mockReturnValue([]),
      createProject: vi.fn(),
      getProject: vi.fn(),
    }));

    vi.doMock('../agent/claude-code.ts', () => ({
      isClaudeCodeConnected: vi.fn().mockReturnValue(false),
      runClaudeCodePrompt: vi.fn(),
      clearClaudeCodeSession: vi.fn(),
    }));

    vi.doMock('../open-connector/client.ts', () => ({
      OpenConnectorClient: class {
        async executeAction() {
          return { success: true, data: { id: 'msg_1' } };
        }
      },
    }));

    const { handleMessage } = await import('./handler.ts');

    // Second כן after payload was shown
    const secondConfirmMessage = {
      id: 'msg_second_confirm',
      from: '1234567890:123@s.whatsapp.net',
      to: '1234567890@lid',
      body: 'כן',
      timestamp: Date.now(),
      isFromMe: true,
      messageKey: { remoteJid: '1234567890@lid', id: 'msg_second_confirm', fromMe: true },
    };

    await handleMessage(secondConfirmMessage);

    // S-04: After payload was shown, כן DOES execute
    expect(mockConfirmAction).toHaveBeenCalled();
  });
});

describe('resolveReplyJid — replies stay inside the owner\'s own chat (#73)', () => {
  const ownerPhone = '123456789';
  const ownerLid = 'ABC123XYZ@lid';
  const isSelf = (jid: string) => isSelfChatJid(jid, ownerPhone, ownerLid);

  it('uses the inbound LID self-chat when the message came from it', async () => {
    const { resolveReplyJid } = await import('./self-chat.ts');
    expect(resolveReplyJid('ABC123XYZ@lid', isSelf, '123456789@s.whatsapp.net')).toBe('ABC123XYZ@lid');
  });

  it('uses the inbound phone-JID self-chat when the account has no LID', async () => {
    const { resolveReplyJid } = await import('./self-chat.ts');
    const noLid = (jid: string) => isSelfChatJid(jid, ownerPhone, null);
    expect(resolveReplyJid('123456789@s.whatsapp.net', noLid, '123456789@s.whatsapp.net')).toBe('123456789@s.whatsapp.net');
  });

  it('never replies into a foreign chat — falls back to the self-chat JID', async () => {
    const { resolveReplyJid } = await import('./self-chat.ts');
    expect(resolveReplyJid('555000111@s.whatsapp.net', isSelf, 'ABC123XYZ@lid')).toBe('ABC123XYZ@lid');
    expect(resolveReplyJid('120363@g.us', isSelf, 'ABC123XYZ@lid')).toBe('ABC123XYZ@lid');
  });

  it('returns null when nothing is available', async () => {
    const { resolveReplyJid } = await import('./self-chat.ts');
    expect(resolveReplyJid(undefined, isSelf, null)).toBeNull();
  });
});
