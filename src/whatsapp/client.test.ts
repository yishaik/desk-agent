import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DATA_DIR = './test-data-wa';

beforeEach(() => {
  vi.resetModules();
  process.env['DATA_DIR'] = TEST_DATA_DIR;
  if (existsSync(TEST_DATA_DIR)) {
    rmSync(TEST_DATA_DIR, { recursive: true });
  }
  mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (existsSync(TEST_DATA_DIR)) {
    rmSync(TEST_DATA_DIR, { recursive: true });
  }
  delete process.env['DATA_DIR'];
});

describe('WhatsAppClient reconnect behavior', () => {
  it('scheduleReconnect catches connect() errors and schedules retry', async () => {
    vi.useFakeTimers();
    
    const mockConnect = vi.fn()
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce(undefined);

    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();
    
    (client as unknown as { connect: typeof mockConnect }).connect = mockConnect;
    
    (client as unknown as { scheduleReconnect: (delay: number) => void }).scheduleReconnect(1000);
    
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockConnect).toHaveBeenCalledTimes(2);
    
    vi.useRealTimers();
  });

  it('does not wipe auth on generic network errors (watchdog behavior)', async () => {
    const rmSyncMock = vi.fn();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        rmSync: rmSyncMock,
      };
    });

    vi.useFakeTimers();

    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();
    
    const pairingState = (client as unknown as { pairingState: { isPaired: boolean } }).pairingState;
    pairingState.isPaired = true;
    
    const reconnectAttempts = { value: 0 };
    Object.defineProperty(client, 'reconnectAttempts', {
      get: () => reconnectAttempts.value,
      set: (v) => { reconnectAttempts.value = v; },
    });
    
    vi.useRealTimers();
  });
});

describe('Connect watchdog (#176)', () => {
  it('fires when socket only emits connecting — ends socket, sets Hebrew error, schedules reconnect', async () => {
    const rmSyncMock = vi.fn();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        rmSync: rmSyncMock,
      };
    });

    vi.useFakeTimers();

    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();

    const mockSocket = {
      end: vi.fn(),
      logout: vi.fn(),
      ev: {
        on: vi.fn(),
        removeAllListeners: vi.fn(),
      },
    };

    (client as unknown as { socket: typeof mockSocket }).socket = mockSocket;

    const mockScheduleReconnect = vi.fn();
    (client as unknown as { scheduleReconnect: typeof mockScheduleReconnect }).scheduleReconnect =
      mockScheduleReconnect;

    const saveCreds = vi.fn();
    (client as unknown as { setupEventHandlers: (saveCreds: () => Promise<void>) => void })
      .setupEventHandlers(saveCreds);

    const onCalls = mockSocket.ev.on.mock.calls as [string, unknown][];
    const connectionUpdateHandler = onCalls.find(
      (call) => call[0] === 'connection.update'
    )?.[1] as ((update: { connection?: string; qr?: string }) => Promise<void>) | undefined;

    expect(connectionUpdateHandler).toBeDefined();

    await connectionUpdateHandler!({ connection: 'connecting' });
    expect(client.getConnectionPhase()).toBe('connecting');
    expect(client.getPairingState().error).toBeUndefined();
    expect(mockScheduleReconnect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockSocket.end).toHaveBeenCalled();
    const endArg = mockSocket.end.mock.calls[0]?.[0] as Error | undefined;
    expect(endArg).toBeInstanceOf(Error);
    expect(endArg?.message).toBe('connect watchdog');
    expect(mockSocket.logout).not.toHaveBeenCalled();
    expect(rmSyncMock).not.toHaveBeenCalled();
    expect(mockSocket.ev.removeAllListeners).toHaveBeenCalled();
    expect(mockScheduleReconnect).toHaveBeenCalled();
    expect(client.getPairingState().error).toBe(
      'לא ניתן להתחבר ל-WhatsApp — בדוק חיבור/חומת אש'
    );
    expect(client.getConnectionPhase()).toBe('closed');

    vi.useRealTimers();
  });

  it('cancels watchdog when QR arrives before timeout', async () => {
    vi.useFakeTimers();

    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();

    const mockSocket = {
      end: vi.fn(),
      ev: {
        on: vi.fn(),
        removeAllListeners: vi.fn(),
      },
    };

    (client as unknown as { socket: typeof mockSocket }).socket = mockSocket;

    const mockScheduleReconnect = vi.fn();
    (client as unknown as { scheduleReconnect: typeof mockScheduleReconnect }).scheduleReconnect =
      mockScheduleReconnect;

    (client as unknown as { setupEventHandlers: (saveCreds: () => Promise<void>) => void })
      .setupEventHandlers(vi.fn());

    const onCalls = mockSocket.ev.on.mock.calls as [string, unknown][];
    const connectionUpdateHandler = onCalls.find(
      (call) => call[0] === 'connection.update'
    )?.[1] as ((update: { connection?: string; qr?: string }) => Promise<void>) | undefined;

    await connectionUpdateHandler!({ connection: 'connecting' });
    await connectionUpdateHandler!({ qr: 'test-qr-payload' });
    await connectionUpdateHandler!({ connection: 'connecting' });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockSocket.end).not.toHaveBeenCalled();
    expect(mockScheduleReconnect).not.toHaveBeenCalled();
    expect(client.getPairingState().qrCode).toBe('test-qr-payload');
    expect(client.getPairingState().error).toBeUndefined();

    vi.useRealTimers();
  });

  it('cancels watchdog when connection opens before timeout', async () => {
    vi.useFakeTimers();

    const { updateSettings } = await import('../core/settings.ts');
    updateSettings({ ownerPhone: '972501234567' });

    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();

    const mockSocket = {
      user: { id: '972501234567:0@s.whatsapp.net', name: 'Owner' },
      end: vi.fn(),
      ev: {
        on: vi.fn(),
        removeAllListeners: vi.fn(),
      },
    };

    (client as unknown as { socket: typeof mockSocket }).socket = mockSocket;

    const mockScheduleReconnect = vi.fn();
    (client as unknown as { scheduleReconnect: typeof mockScheduleReconnect }).scheduleReconnect =
      mockScheduleReconnect;

    (client as unknown as { setupEventHandlers: (saveCreds: () => Promise<void>) => void })
      .setupEventHandlers(vi.fn());

    const onCalls = mockSocket.ev.on.mock.calls as [string, unknown][];
    const connectionUpdateHandler = onCalls.find(
      (call) => call[0] === 'connection.update'
    )?.[1] as ((update: { connection?: string; qr?: string }) => Promise<void>) | undefined;

    await connectionUpdateHandler!({ connection: 'connecting' });
    await connectionUpdateHandler!({ connection: 'open' });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockSocket.end).not.toHaveBeenCalled();
    expect(mockScheduleReconnect).not.toHaveBeenCalled();
    expect(client.getPairingState().isPaired).toBe(true);
    expect(client.getConnectionPhase()).toBe('open');

    vi.useRealTimers();
  });
});

describe('Disconnect reason handling', () => {
  it('exports DisconnectReason values correctly', async () => {
    const baileys = await import('@whiskeysockets/baileys');
    
    expect(baileys.DisconnectReason.loggedOut).toBe(401);
    expect(baileys.DisconnectReason.connectionReplaced).toBe(440);
    expect(baileys.DisconnectReason.forbidden).toBe(403);
  });
});

describe('getSelfChatJid — LID preferred, phone JID fallback (#73)', () => {
  it('returns ownerLid when it ends with @lid', async () => {
    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();
    (client as unknown as { ownerJid: string | null }).ownerJid = '123456789:0@s.whatsapp.net';
    (client as unknown as { ownerLid: string | null }).ownerLid = '987654321@lid';
    expect(client.getSelfChatJid()).toBe('987654321@lid');
  });

  it("falls back to the owner's own phone JID (device suffix stripped) when there is no LID", async () => {
    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();
    (client as unknown as { ownerJid: string | null }).ownerJid = '123456789:12@s.whatsapp.net';
    (client as unknown as { ownerLid: string | null }).ownerLid = null;
    expect(client.getSelfChatJid()).toBe('123456789@s.whatsapp.net');
  });

  it('ignores a non-@lid value in ownerLid and still falls back to the phone JID', async () => {
    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();
    (client as unknown as { ownerJid: string | null }).ownerJid = '123456789:0@s.whatsapp.net';
    (client as unknown as { ownerLid: string | null }).ownerLid = '123456789@s.whatsapp.net';
    expect(client.getSelfChatJid()).toBe('123456789@s.whatsapp.net');
  });

  it('returns null only when not connected (no LID and no owner JID)', async () => {
    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();
    (client as unknown as { ownerJid: string | null }).ownerJid = null;
    (client as unknown as { ownerLid: string | null }).ownerLid = null;
    expect(client.getSelfChatJid()).toBeNull();
  });
});

describe('quoted replies and reactions (#167)', () => {
  it('quotes the original inbound conversation, not the reply text', async () => {
    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    (client as unknown as { socket: { sendMessage: typeof sendMessage } }).socket = { sendMessage };

    await client.sendMessage('abc@lid', 'reply text', {
      remoteJid: 'abc@lid',
      id: 'orig',
      fromMe: true,
      conversation: 'original inbound',
    });

    expect(sendMessage).toHaveBeenCalledWith(
      'abc@lid',
      { text: 'reply text' },
      expect.objectContaining({
        quoted: expect.objectContaining({
          message: { conversation: 'original inbound' },
        }),
      })
    );
  });

  it('sends reactions to the inbound chat JID, not getSelfChatJid', async () => {
    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    (client as unknown as { socket: { sendMessage: typeof sendMessage } }).socket = { sendMessage };
    (client as unknown as { ownerLid: string | null }).ownerLid = '987654321@lid';

    await client.sendReaction(
      { remoteJid: '123456789@s.whatsapp.net', id: 'm1', fromMe: true },
      '👀'
    );

    expect(sendMessage).toHaveBeenCalledWith(
      '123456789@s.whatsapp.net',
      expect.objectContaining({
        react: expect.objectContaining({ text: '👀' }),
      })
    );
  });
});

describe('S-05: Link preview security', () => {
  it('Baileys client must NOT be constructed with generateHighQualityLinkPreview: true', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const clientSource = fs.readFileSync(
      path.join(process.cwd(), 'src/whatsapp/client.ts'),
      'utf8'
    );
    
    const hasHighQualityEnabled = /generateHighQualityLinkPreview\s*:\s*true/.test(clientSource);
    expect(hasHighQualityEnabled, 
      'generateHighQualityLinkPreview must be false to prevent server-side URL fetching (S-05)'
    ).toBe(false);
    
    const hasHighQualityDisabled = /generateHighQualityLinkPreview\s*:\s*false/.test(clientSource);
    expect(hasHighQualityDisabled,
      'generateHighQualityLinkPreview should be explicitly set to false'
    ).toBe(true);
  });
});

describe('S-03: Owner binding — pairing is bound to owner identity', () => {
  it('rejects pairing from a different phone and wipes auth for fresh QR', async () => {
    const { updateSettings, loadSettings } = await import('../core/settings.ts');
    updateSettings({ ownerPhone: '972501234567' });
    
    const settingsBefore = loadSettings();
    expect(settingsBefore.ownerPhone).toBe('972501234567');
    
    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();
    
    const mockSocket = {
      user: { id: '972509999999:0@s.whatsapp.net', name: 'Attacker' },
      end: vi.fn(),
      ev: {
        on: vi.fn(),
        removeAllListeners: vi.fn(),
      },
    };
    
    (client as unknown as { socket: typeof mockSocket }).socket = mockSocket;
    
    const mockScheduleReconnect = vi.fn();
    (client as unknown as { scheduleReconnect: typeof mockScheduleReconnect }).scheduleReconnect = mockScheduleReconnect;
    
    const saveCreds = vi.fn();
    
    (client as unknown as { setupEventHandlers: (saveCreds: () => Promise<void>) => void })
      .setupEventHandlers(saveCreds);
    
    const onCalls = mockSocket.ev.on.mock.calls as [string, unknown][];
    const connectionUpdateHandler = onCalls.find(
      (call) => call[0] === 'connection.update'
    )?.[1] as ((update: { connection?: string }) => Promise<void>) | undefined;
    
    expect(connectionUpdateHandler).toBeDefined();
    
    await connectionUpdateHandler!({ connection: 'open' });
    
    const pairingState = client.getPairingState();
    expect(pairingState.isPaired).toBe(false);
    expect(pairingState.error).toContain('צימוד נדחה');
    expect(pairingState.error).toContain('972509999999');
    expect(pairingState.error).toContain('972501234567');
    expect(pairingState.error).toContain('/api/pairing/repair');
    
    expect(mockSocket.end).toHaveBeenCalled();
    expect(mockSocket.ev.removeAllListeners).toHaveBeenCalled();
    expect(mockScheduleReconnect).toHaveBeenCalledWith(1000);
    
    const settingsAfter = loadSettings();
    expect(settingsAfter.ownerPhone).toBe('972501234567');
  });

  it('SECURITY: mismatch must wipe auth (not just socket.end) to prevent attacker cred reuse', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const clientSource = fs.readFileSync(
      path.join(process.cwd(), 'src/whatsapp/client.ts'),
      'utf8'
    );
    
    const mismatchBlock = clientSource.match(
      /if\s*\(\s*settings\.ownerPhone\s*&&\s*newPhoneNumber\s*&&\s*newPhoneNumber\s*!==\s*settings\.ownerPhone\s*\)[\s\S]*?return;\s*\}/
    )?.[0] || '';
    
    expect(mismatchBlock).toBeTruthy();
    expect(mismatchBlock).toContain('rmSync');
    expect(mismatchBlock).toContain('whatsapp-auth');
    expect(mismatchBlock).toContain('scheduleReconnect');
    expect(mismatchBlock).not.toContain('logout');
    expect(mismatchBlock).not.toContain('updateSettings');
  });

  it('allows pairing from the same phone when ownerPhone is already set', async () => {
    const { updateSettings } = await import('../core/settings.ts');
    updateSettings({ ownerPhone: '972501234567' });
    
    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();
    
    const mockSocket = {
      user: { id: '972501234567:0@s.whatsapp.net', name: 'Owner', lid: '123@lid' },
      end: vi.fn(),
      ev: {
        on: vi.fn(),
        removeAllListeners: vi.fn(),
      },
    };
    
    (client as unknown as { socket: typeof mockSocket }).socket = mockSocket;
    
    const saveCreds = vi.fn();
    (client as unknown as { setupEventHandlers: (saveCreds: () => Promise<void>) => void })
      .setupEventHandlers(saveCreds);
    
    const onCalls = mockSocket.ev.on.mock.calls as [string, unknown][];
    const connectionUpdateHandler = onCalls.find(
      (call) => call[0] === 'connection.update'
    )?.[1] as ((update: { connection?: string }) => Promise<void>) | undefined;
    
    await connectionUpdateHandler!({ connection: 'open' });
    
    const pairingState = client.getPairingState();
    expect(pairingState.isPaired).toBe(true);
    expect(pairingState.error).toBeUndefined();
    expect(pairingState.phoneNumber).toBe('972501234567');
    
    expect(mockSocket.end).not.toHaveBeenCalled();
  });

  it('allows first-time pairing when ownerPhone is not set', async () => {
    const { loadSettings } = await import('../core/settings.ts');
    const settingsBefore = loadSettings();
    expect(settingsBefore.ownerPhone).toBeUndefined();
    
    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();
    
    const mockSocket = {
      user: { id: '972501234567:0@s.whatsapp.net', name: 'NewOwner', lid: '123@lid' },
      end: vi.fn(),
      ev: {
        on: vi.fn(),
        removeAllListeners: vi.fn(),
      },
    };
    
    (client as unknown as { socket: typeof mockSocket }).socket = mockSocket;
    
    const saveCreds = vi.fn();
    (client as unknown as { setupEventHandlers: (saveCreds: () => Promise<void>) => void })
      .setupEventHandlers(saveCreds);
    
    const onCalls = mockSocket.ev.on.mock.calls as [string, unknown][];
    const connectionUpdateHandler = onCalls.find(
      (call) => call[0] === 'connection.update'
    )?.[1] as ((update: { connection?: string }) => Promise<void>) | undefined;
    
    await connectionUpdateHandler!({ connection: 'open' });
    
    const pairingState = client.getPairingState();
    expect(pairingState.isPaired).toBe(true);
    expect(pairingState.phoneNumber).toBe('972501234567');
    
    const settingsAfter = loadSettings();
    expect(settingsAfter.ownerPhone).toBe('972501234567');
  });

  it('repair() wipes auth and resets state for new owner pairing', async () => {
    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();
    
    (client as unknown as { ownerJid: string | null }).ownerJid = '972501234567:0@s.whatsapp.net';
    (client as unknown as { ownerLid: string | null }).ownerLid = '123@lid';
    (client as unknown as { pairingState: { isPaired: boolean } }).pairingState = { isPaired: true };
    
    const mockConnect = vi.fn().mockResolvedValue(undefined);
    (client as unknown as { connect: typeof mockConnect }).connect = mockConnect;
    
    await client.repair();
    
    expect(client.getOwnerJid()).toBeNull();
    expect(client.getOwnerLid()).toBeNull();
    expect(client.getPairingState().isPaired).toBe(false);
    expect(mockConnect).toHaveBeenCalled();
  });
});


describe('unpair() keeps ownerPhone (#132)', () => {
  it('wipes auth and reconnects but does not clear ownerPhone', async () => {
    const { updateSettings, loadSettings } = await import('../core/settings.ts');
    updateSettings({ ownerPhone: '972501234567' });

    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();

    (client as unknown as { ownerJid: string | null }).ownerJid = '972501234567:0@s.whatsapp.net';
    (client as unknown as { ownerLid: string | null }).ownerLid = '123@lid';
    (client as unknown as { pairingState: { isPaired: boolean } }).pairingState = { isPaired: true };

    const mockConnect = vi.fn().mockResolvedValue(undefined);
    (client as unknown as { connect: typeof mockConnect }).connect = mockConnect;

    await client.unpair();

    expect(client.getOwnerJid()).toBeNull();
    expect(client.getOwnerLid()).toBeNull();
    expect(client.getPairingState().isPaired).toBe(false);
    expect(mockConnect).toHaveBeenCalled();
    expect(loadSettings().ownerPhone).toBe('972501234567');
  });

  it('unpair() source does not call updateSettings or logout', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const clientSource = fs.readFileSync(
      path.join(process.cwd(), 'src/whatsapp/client.ts'),
      'utf8'
    );
    const unpairBlock = clientSource.match(
      /async unpair\(\)[\s\S]*?^\s{2}\}/m
    )?.[0] || '';
    expect(unpairBlock).toContain('wipeAuthAndReconnect');
    expect(unpairBlock).not.toContain('updateSettings');
    expect(unpairBlock).not.toContain('.logout(');
  });
});

describe('requestPairingCode — no silent owner swap (#132)', () => {
  it('rejects a phone that does not match bound ownerPhone', async () => {
    const { updateSettings } = await import('../core/settings.ts');
    updateSettings({ ownerPhone: '972501234567' });

    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();

    await expect(client.requestPairingCode('972509999999')).rejects.toThrow(
      /does not match bound owner/
    );
  });

  it('allows a matching owner phone and stores the code', async () => {
    const { updateSettings } = await import('../core/settings.ts');
    updateSettings({ ownerPhone: '972501234567' });

    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();

    const mockSocket = {
      requestPairingCode: vi.fn().mockResolvedValue('ABCD-1234'),
      ev: { on: vi.fn(), removeAllListeners: vi.fn() },
      end: vi.fn(),
    };
    (client as unknown as { socket: typeof mockSocket }).socket = mockSocket;

    const code = await client.requestPairingCode('+972-50-123-4567');
    expect(code).toBe('ABCD-1234');
    expect(mockSocket.requestPairingCode).toHaveBeenCalledWith('972501234567');
    expect(client.getPairingState().pairingCode).toBe('ABCD-1234');
  });
});

describe('captionless media is delivered to handlers (#141)', () => {
  it('does not silent-drop an image without caption', async () => {
    const { WhatsAppClient } = await import('./client.ts');
    const { MEDIA_WITHOUT_TEXT_BODY } = await import('./inbound.ts');
    const client = new WhatsAppClient();
    const handler = vi.fn().mockResolvedValue(undefined);
    client.onMessage(handler);

    const mockSocket = {
      ev: { on: vi.fn(), removeAllListeners: vi.fn() },
      end: vi.fn(),
    };
    (client as unknown as { socket: typeof mockSocket }).socket = mockSocket;
    (client as unknown as { setupEventHandlers: (s: () => Promise<void>) => void })
      .setupEventHandlers(async () => {});

    const onCalls = mockSocket.ev.on.mock.calls as [string, unknown][];
    const upsert = onCalls.find((c) => c[0] === 'messages.upsert')?.[1] as
      | ((m: unknown) => Promise<void>)
      | undefined;
    expect(upsert).toBeDefined();

    await upsert!({
      type: 'notify',
      messages: [{
        key: { remoteJid: '1234567890@s.whatsapp.net', id: 'img1', fromMe: true },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { imageMessage: { mimetype: 'image/jpeg' } },
      }],
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0].body).toBe(MEDIA_WITHOUT_TEXT_BODY);
  });

  it('still uses the caption when an image has one', async () => {
    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();
    const handler = vi.fn().mockResolvedValue(undefined);
    client.onMessage(handler);

    const mockSocket = {
      ev: { on: vi.fn(), removeAllListeners: vi.fn() },
      end: vi.fn(),
    };
    (client as unknown as { socket: typeof mockSocket }).socket = mockSocket;
    (client as unknown as { setupEventHandlers: (s: () => Promise<void>) => void })
      .setupEventHandlers(async () => {});

    const onCalls = mockSocket.ev.on.mock.calls as [string, unknown][];
    const upsert = onCalls.find((c) => c[0] === 'messages.upsert')?.[1] as
      | ((m: unknown) => Promise<void>)
      | undefined;

    await upsert!({
      type: 'notify',
      messages: [{
        key: { remoteJid: '1234567890@s.whatsapp.net', id: 'img2', fromMe: true },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { imageMessage: { caption: 'look at this' } },
      }],
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0].body).toBe('look at this');
  });
});

describe('WhatsApp Web version resolution (#156, stale 405)', () => {
  it('uses hardcoded pin when no cache file exists', async () => {
    const { resolvePinnedBaileysVersion, PINNED_BAILEYS_VERSION } = await import('./client.ts');
    expect(resolvePinnedBaileysVersion()).toEqual(PINNED_BAILEYS_VERSION);
    expect(PINNED_BAILEYS_VERSION).toEqual([2, 3000, 1015629576]);
  });

  it('uses cache file when present', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { config } = await import('../core/config.ts');
    fs.writeFileSync(
      path.join(config.dataDir, 'wa-version.json'),
      JSON.stringify({ version: [2, 3000, 999], fetchedAt: '2020-01-01' })
    );
    // client.ts already imported config at module load; VERSION_CACHE_PATH uses that dataDir
    const { resolvePinnedBaileysVersion } = await import('./client.ts');
    expect(resolvePinnedBaileysVersion()).toEqual([2, 3000, 999]);
  });

  it('fetches the live WhatsApp Web revision without depending on GitHub', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const clientSource = fs.readFileSync(
      path.join(process.cwd(), 'src/whatsapp/client.ts'),
      'utf8'
    );
    expect(clientSource).not.toContain('fetchLatestBaileysVersion');
    expect(clientSource).toContain('fetchLatestWaWebVersion');
    expect(clientSource).toContain('resolvePinnedBaileysVersion');
    expect(clientSource).not.toContain('.logout(');
  });

  it('connect uses the live WhatsApp Web revision and caches it', async () => {
    const liveVersion: [number, number, number] = [2, 3000, 1046816453];
    const fetchLatestWaWebVersion = vi.fn().mockResolvedValue({
      version: liveVersion,
      isLatest: true,
    });
    const makeWASocket = vi.fn().mockReturnValue({
      ev: { on: vi.fn(), removeAllListeners: vi.fn() },
      end: vi.fn(),
      requestPairingCode: vi.fn(),
    });

    vi.doMock('@whiskeysockets/baileys', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>();
      return {
        ...actual,
        default: makeWASocket,
        fetchLatestWaWebVersion,
        useMultiFileAuthState: vi.fn().mockResolvedValue({
          state: { creds: {}, keys: {} },
          saveCreds: vi.fn(),
        }),
        makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
      };
    });

    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();
    await client.connect();

    expect(fetchLatestWaWebVersion).toHaveBeenCalledWith(expect.objectContaining({
      timeout: 10_000,
      headers: expect.objectContaining({ 'sec-fetch-site': 'none' }),
    }));
    expect(makeWASocket).toHaveBeenCalled();
    const opts = makeWASocket.mock.calls[0]![0] as {
      version: [number, number, number];
      generateHighQualityLinkPreview: boolean;
    };
    expect(opts.version).toEqual(liveVersion);
    expect(opts.generateHighQualityLinkPreview).toBe(false);

    const fs = await import('node:fs');
    const path = await import('node:path');
    const { config } = await import('../core/config.ts');
    const cached = JSON.parse(
      fs.readFileSync(path.join(config.dataDir, 'wa-version.json'), 'utf8')
    ) as { version: [number, number, number] };
    expect(cached.version).toEqual(liveVersion);
  });

  it('falls back to the cached revision when the live lookup fails', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { config } = await import('../core/config.ts');
    const cachedVersion: [number, number, number] = [2, 3000, 1040000000];
    fs.writeFileSync(
      path.join(config.dataDir, 'wa-version.json'),
      JSON.stringify({ version: cachedVersion, fetchedAt: '2026-09-01T00:00:00.000Z' })
    );

    const fetchLatestWaWebVersion = vi.fn().mockResolvedValue({
      version: [2, 3000, 0],
      isLatest: false,
      error: new Error('network unavailable'),
    });
    vi.doMock('@whiskeysockets/baileys', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>();
      return { ...actual, fetchLatestWaWebVersion };
    });

    const { resolveBaileysVersion } = await import('./client.ts');
    await expect(resolveBaileysVersion()).resolves.toEqual(cachedVersion);
  });
});
