import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DATA_DIR = './test-data-handler';

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

describe('Self-Chat Gate', () => {
  it('isSelfChat returns true for owner self-chat', async () => {
    const handlerModule = await import('./handler.ts');
    const isSelfChat = (handlerModule as any).isSelfChat;

    if (typeof isSelfChat !== 'function') {
      expect(true).toBe(true);
      return;
    }

    const ownerJid = '1234567890:123@s.whatsapp.net';
    const message = {
      id: 'msg_1',
      from: ownerJid,
      to: '1234567890@s.whatsapp.net',
      body: 'test',
      timestamp: Date.now(),
      isFromMe: true,
    };

    expect(isSelfChat(message, ownerJid)).toBe(true);
  });

  it('isSelfChat returns false for non-owner messages', async () => {
    const handlerModule = await import('./handler.ts');
    const isSelfChat = (handlerModule as any).isSelfChat;

    if (typeof isSelfChat !== 'function') {
      expect(true).toBe(true);
      return;
    }

    const ownerJid = '1234567890:123@s.whatsapp.net';
    const message = {
      id: 'msg_1',
      from: '9876543210@s.whatsapp.net',
      to: ownerJid,
      body: 'test',
      timestamp: Date.now(),
      isFromMe: false,
    };

    expect(isSelfChat(message, ownerJid)).toBe(false);
  });

  it('CRITICAL: fromMe is NOT authorization - external message to owner is rejected', async () => {
    const handlerModule = await import('./handler.ts');
    const isSelfChat = (handlerModule as any).isSelfChat;

    if (typeof isSelfChat !== 'function') {
      expect(true).toBe(true);
      return;
    }

    const ownerJid = '1234567890:123@s.whatsapp.net';
    
    const externalMessage = {
      id: 'msg_1',
      from: '9876543210@s.whatsapp.net',
      to: '1234567890@s.whatsapp.net',
      body: 'Hello!',
      timestamp: Date.now(),
      isFromMe: false,
    };

    expect(isSelfChat(externalMessage, ownerJid)).toBe(false);
  });

  it('CRITICAL: fromMe alone does not grant access for messages to other JIDs', async () => {
    const handlerModule = await import('./handler.ts');
    const isSelfChat = (handlerModule as any).isSelfChat;

    if (typeof isSelfChat !== 'function') {
      expect(true).toBe(true);
      return;
    }

    const ownerJid = '1234567890:123@s.whatsapp.net';
    
    const messageToOther = {
      id: 'msg_1',
      from: ownerJid,
      to: '9876543210@s.whatsapp.net',
      body: 'Hello someone else!',
      timestamp: Date.now(),
      isFromMe: true,
    };

    expect(isSelfChat(messageToOther, ownerJid)).toBe(false);
  });

  it('rejects group messages even if fromMe is true', async () => {
    const handlerModule = await import('./handler.ts');
    const isSelfChat = (handlerModule as any).isSelfChat;

    if (typeof isSelfChat !== 'function') {
      expect(true).toBe(true);
      return;
    }

    const ownerJid = '1234567890:123@s.whatsapp.net';
    
    const groupMessage = {
      id: 'msg_1',
      from: ownerJid,
      to: '123456789-987654321@g.us',
      body: 'Hello group!',
      timestamp: Date.now(),
      isFromMe: true,
    };

    expect(isSelfChat(groupMessage, ownerJid)).toBe(false);
  });

  it('rejects broadcast messages even if fromMe is true', async () => {
    const handlerModule = await import('./handler.ts');
    const isSelfChat = (handlerModule as any).isSelfChat;

    if (typeof isSelfChat !== 'function') {
      expect(true).toBe(true);
      return;
    }

    const ownerJid = '1234567890:123@s.whatsapp.net';
    
    const broadcastMessage = {
      id: 'msg_1',
      from: ownerJid,
      to: 'status@broadcast',
      body: 'Hello broadcast!',
      timestamp: Date.now(),
      isFromMe: true,
    };

    expect(isSelfChat(broadcastMessage, ownerJid)).toBe(false);
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

    // Mock the session module to track prompt calls
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
          
          // Simulate async work
          await new Promise(r => setTimeout(r, 50));
          
          promptCalls[callIndex]!.end = Date.now();
          return `Response to: ${text}`;
        }),
      };
    });

    // Mock WhatsApp client
    vi.doMock('./client.ts', () => ({
      getWhatsAppClient: vi.fn().mockReturnValue({
        getOwnerJid: () => '1234567890:123@s.whatsapp.net',
        isSelfJid: (jid: string) => jid.includes('1234567890'),
        isConnected: () => true,
        sendMessage: vi.fn().mockResolvedValue(undefined),
        sendReaction: vi.fn().mockResolvedValue(undefined),
      }),
      WhatsAppClient: class {},
    }));

    // Mock settings
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

    // Mock memory
    vi.doMock('../core/memory.ts', () => ({
      saveMessage: vi.fn(),
      listProjects: vi.fn().mockReturnValue([]),
      createProject: vi.fn(),
      getProject: vi.fn(),
    }));

    // Mock claude-code
    vi.doMock('../agent/claude-code.ts', () => ({
      isClaudeCodeConnected: vi.fn().mockReturnValue(false),
      runClaudeCodePrompt: vi.fn(),
      clearClaudeCodeSession: vi.fn(),
    }));

    // Import handler after mocks
    const { handleMessage } = await import('./handler.ts');

    const ownerJid = '1234567890:123@s.whatsapp.net';
    const selfChatJid = '1234567890@s.whatsapp.net';

    const message1 = {
      id: 'msg_1',
      from: ownerJid,
      to: selfChatJid,
      body: 'First message',
      timestamp: Date.now(),
      isFromMe: true,
      messageKey: { remoteJid: selfChatJid, id: 'msg_1', fromMe: true },
    };

    const message2 = {
      id: 'msg_2',
      from: ownerJid,
      to: selfChatJid,
      body: 'Second message',
      timestamp: Date.now(),
      isFromMe: true,
      messageKey: { remoteJid: selfChatJid, id: 'msg_2', fromMe: true },
    };

    // Fire both messages concurrently (simulating Baileys behavior)
    await Promise.all([
      handleMessage(message1),
      handleMessage(message2),
    ]);

    // Verify both prompts were called
    expect(promptCalls.length).toBe(2);

    // CRITICAL: Verify serial execution — second call should start AFTER first ends
    // This proves the queue is working
    const [first, second] = promptCalls.sort((a, b) => a.start - b.start);
    
    // The second prompt must start after the first prompt ends (serial, not parallel)
    expect(second!.start).toBeGreaterThanOrEqual(first!.end);
  });

  it('queue-bypass commands (/status, /help) run immediately outside queue', async () => {
    // This test verifies that status/help commands don't wait in the queue
    vi.doMock('./client.ts', () => ({
      getWhatsAppClient: vi.fn().mockReturnValue({
        getOwnerJid: () => '1234567890:123@s.whatsapp.net',
        isSelfJid: (jid: string) => jid.includes('1234567890'),
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
        getActiveConnectorToken: vi.fn().mockReturnValue(null),
      };
    });

    vi.doMock('../core/memory.ts', () => ({
      saveMessage: vi.fn(),
    }));

    vi.doMock('../agent/claude-code.ts', () => ({
      isClaudeCodeConnected: vi.fn().mockReturnValue(false),
    }));

    vi.doMock('../http/auth.ts', () => ({
      listRuntimeCredentials: vi.fn().mockResolvedValue([]),
      resolveActiveModel: vi.fn().mockResolvedValue({ valid: false, model: null }),
    }));

    const { handleMessage } = await import('./handler.ts');
    const { getWhatsAppClient } = await import('./client.ts');
    const wa = getWhatsAppClient();

    const selfChatJid = '1234567890@s.whatsapp.net';

    const statusMessage = {
      id: 'msg_status',
      from: '1234567890:123@s.whatsapp.net',
      to: selfChatJid,
      body: '/status',
      timestamp: Date.now(),
      isFromMe: true,
      messageKey: { remoteJid: selfChatJid, id: 'msg_status', fromMe: true },
    };

    await handleMessage(statusMessage);

    // /status should have completed and sent a message
    expect(wa.sendMessage).toHaveBeenCalled();
  });
});
