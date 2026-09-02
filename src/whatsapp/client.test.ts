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
  it('rejects pairing from a different phone when ownerPhone is already set', async () => {
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
    
    const connectionHandler = vi.fn();
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
    
    expect(mockSocket.end).toHaveBeenCalled();
    
    const settingsAfter = loadSettings();
    expect(settingsAfter.ownerPhone).toBe('972501234567');
  });

  it('allows pairing from the same phone when ownerPhone is already set', async () => {
    const { updateSettings, loadSettings } = await import('../core/settings.ts');
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
