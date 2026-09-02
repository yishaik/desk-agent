import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DATA_DIR = './test-data-memory';

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

describe('Memory - duplicate message handling', () => {
  it('saveMessage returns true for new messages', async () => {
    const { saveMessage } = await import('./memory.ts');
    
    const message = {
      id: 'msg_001',
      from: '1234567890@s.whatsapp.net',
      to: '0987654321@s.whatsapp.net',
      body: 'Hello world',
      timestamp: Math.floor(Date.now() / 1000),
      isFromMe: true,
      projectId: 'default',
    };

    const result = saveMessage(message);
    expect(result).toBe(true);
  });

  it('saveMessage returns false for duplicate messages (INSERT OR IGNORE)', async () => {
    const { saveMessage } = await import('./memory.ts');
    
    const message = {
      id: 'msg_duplicate_test',
      from: '1234567890@s.whatsapp.net',
      to: '0987654321@s.whatsapp.net',
      body: 'Hello world',
      timestamp: Math.floor(Date.now() / 1000),
      isFromMe: true,
      projectId: 'default',
    };

    const firstResult = saveMessage(message);
    expect(firstResult).toBe(true);

    const secondResult = saveMessage(message);
    expect(secondResult).toBe(false);
  });

  it('getMessage returns null for non-existent messages', async () => {
    const { getMessage } = await import('./memory.ts');
    
    const result = getMessage('non_existent_id');
    expect(result).toBeNull();
  });

  it('getMessage returns message after save', async () => {
    const { saveMessage, getMessage } = await import('./memory.ts');
    
    const message = {
      id: 'msg_get_test',
      from: '1234567890@s.whatsapp.net',
      to: '0987654321@s.whatsapp.net',
      body: 'Test message',
      timestamp: 1234567890,
      isFromMe: false,
      projectId: 'default',
    };

    saveMessage(message);

    const retrieved = getMessage('msg_get_test');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe('msg_get_test');
    expect(retrieved?.body).toBe('Test message');
    expect(retrieved?.from).toBe('1234567890@s.whatsapp.net');
    expect(retrieved?.isFromMe).toBe(false);
  });

  it('duplicate insert does not throw UNIQUE constraint error', async () => {
    const { saveMessage } = await import('./memory.ts');
    
    const message = {
      id: 'msg_no_throw',
      from: '1234567890@s.whatsapp.net',
      to: '0987654321@s.whatsapp.net',
      body: 'No throw test',
      timestamp: Math.floor(Date.now() / 1000),
      isFromMe: true,
      projectId: 'default',
    };

    saveMessage(message);
    
    expect(() => saveMessage(message)).not.toThrow();
  });
});

describe('pruneMessages keeps the log bounded (#79)', () => {
  it('keeps only the most recent N messages', async () => {
    const { saveMessage, pruneMessages, getMessage } = await import('./memory.ts');
    for (let i = 0; i < 30; i++) {
      saveMessage({
        id: `prune_${i}`, from: 'me', to: 'me', body: `m${i}`, timestamp: 1_000 + i,
        isFromMe: true, projectId: 'default',
      } as never);
    }
    expect(pruneMessages(10)).toBe(20);
    expect(getMessage('prune_0')).toBeNull();
    expect(getMessage('prune_29')).not.toBeNull();
    expect(pruneMessages(10)).toBe(0);
  });
});
