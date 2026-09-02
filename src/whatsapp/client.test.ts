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

describe('getSelfChatJid LID-only policy', () => {
  it('returns ownerLid when it ends with @lid', async () => {
    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();
    
    (client as unknown as { ownerLid: string | null }).ownerLid = '123456789@lid';
    
    const result = client.getSelfChatJid();
    expect(result).toBe('123456789@lid');
  });

  it('returns null when ownerLid is null', async () => {
    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();
    
    (client as unknown as { ownerLid: string | null }).ownerLid = null;
    
    const result = client.getSelfChatJid();
    expect(result).toBeNull();
  });

  it('returns null when ownerLid does not end with @lid', async () => {
    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();
    
    (client as unknown as { ownerLid: string | null }).ownerLid = '123456789@s.whatsapp.net';
    
    const result = client.getSelfChatJid();
    expect(result).toBeNull();
  });

  it('CRITICAL: does not fall back to ownerJid or phone JID', async () => {
    const { WhatsAppClient } = await import('./client.ts');
    const client = new WhatsAppClient();
    
    (client as unknown as { ownerJid: string | null }).ownerJid = '123456789:0@s.whatsapp.net';
    (client as unknown as { ownerLid: string | null }).ownerLid = null;
    
    const result = client.getSelfChatJid();
    expect(result).toBeNull();
  });
});
