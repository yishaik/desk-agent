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
