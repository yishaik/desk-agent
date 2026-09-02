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

vi.mock('./client.ts', () => ({
  getWhatsAppClient: () => ({
    sendMessage: mockSendMessage,
    sendReaction: mockSendReaction,
    getOwnerJid: mockGetOwnerJid,
    getOwnerPhone: mockGetOwnerPhone,
    getOwnerLid: mockGetOwnerLid,
    getSelfChatJid: mockGetSelfChatJid,
    isConnected: mockIsConnected,
    isSelfJid: (jid: string | null | undefined) => {
      const ownerPhone = mockGetOwnerPhone();
      const ownerLid = mockGetOwnerLid();
      return isSelfChatJid(jid, ownerPhone, ownerLid);
    },
  }),
  WhatsAppClient: class {},
}));

vi.mock('../agent/session.ts', () => ({
  runPromptWithCallbacks: vi.fn(async () => null),
  clearSession: vi.fn(),
  getOrCreateSession: vi.fn(async () => ({})),
  setSessionModel: vi.fn(async () => true),
  getPendingConfirmation: vi.fn(() => undefined),
  getLatestPendingConfirmation: vi.fn(() => null),
  confirmAction: vi.fn(() => false),
  cancelConfirmation: vi.fn(() => false),
  cleanupOldConfirmations: vi.fn(),
  checkCredentialsBeforePrompt: vi.fn(async () => ({ valid: true, model: true, modelId: 'test' })),
  recreateSessionAfterCredentialChange: vi.fn(async () => {}),
  CredentialError: class extends Error {},
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

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env['DATA_DIR'] = TEST_DATA_DIR;
  if (existsSync(TEST_DATA_DIR)) {
    rmSync(TEST_DATA_DIR, { recursive: true });
  }
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  
  mockGetOwnerJid.mockReturnValue('1234567890:123@s.whatsapp.net');
  mockGetOwnerPhone.mockReturnValue('1234567890');
  mockGetOwnerLid.mockReturnValue('ABC123XYZ@lid');
  mockGetSelfChatJid.mockReturnValue('ABC123XYZ@lid');
  mockIsConnected.mockReturnValue(true);
});

afterEach(() => {
  if (existsSync(TEST_DATA_DIR)) {
    rmSync(TEST_DATA_DIR, { recursive: true });
  }
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
  it('prefixes the next prompt once with what ran outside the model', async () => {
    const { recordExecutedAction } = await import('../core/confirmations.ts');
    const { withExecutedActionNotes } = await import('./handler.ts');
    recordExecutedAction({ projectId: 'default', actionId: 'gmail.send_email', success: true, summary: '{"id":"m1"}' });

    const prompt = withExecutedActionNotes('default', 'thanks');
    expect(prompt).toContain('gmail.send_email: executed successfully');
    expect(prompt).toContain('Do not execute them again');
    expect(prompt.endsWith('thanks')).toBe(true);

    expect(withExecutedActionNotes('default', 'again')).toBe('again');
  });
});

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
  });

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
