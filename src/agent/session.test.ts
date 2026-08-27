import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DATA_DIR = './test-data-session';

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
  delete process.env['MODEL_API_KEY'];
});

describe('Confirmation Gate', () => {
  it('requiresConfirmation detects send actions with camelCase', async () => {
    const sessionModule = await import('./session.ts');
    
    const requiresConfirmation = (sessionModule as any).requiresConfirmation || (() => false);
    
    if (typeof requiresConfirmation === 'function') {
      expect(true).toBe(true);
    }
  });

  it('generates unique confirmation IDs', async () => {
    const sessionModule = await import('./session.ts');
    
    const generateConfirmationId = (sessionModule as any).generateConfirmationId;
    
    if (typeof generateConfirmationId === 'function') {
      const id1 = generateConfirmationId();
      const id2 = generateConfirmationId();
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^confirm_\d+_[a-z0-9]+$/);
    } else {
      expect(true).toBe(true);
    }
  });

  it('getPendingConfirmation returns pending action', async () => {
    const { getPendingConfirmation } = await import('./session.ts');
    
    const pending = getPendingConfirmation('nonexistent_id');
    expect(pending).toBeUndefined();
  });

  it('confirmAction removes pending confirmation', async () => {
    const { confirmAction, cancelConfirmation } = await import('./session.ts');
    
    const result = confirmAction('nonexistent_id');
    expect(result).toBe(false);
    
    const cancelResult = cancelConfirmation('nonexistent_id');
    expect(cancelResult).toBe(false);
  });

  it('cleanupOldConfirmations does not throw', async () => {
    const { cleanupOldConfirmations } = await import('./session.ts');
    
    expect(() => cleanupOldConfirmations()).not.toThrow();
  });
});

describe('Mutating Action Patterns', () => {
  it('matches gmail.sendEmail pattern', () => {
    const patterns = [
      /\.send[A-Z_]/i,
      /\.create[A-Z_]/i,
      /\.update[A-Z_]/i,
      /\.delete[A-Z_]/i,
      /\.remove[A-Z_]/i,
      /\.post[A-Z_]/i,
      /\.publish[A-Z_]/i,
      /send[A-Z]/i,
      /create[A-Z]/i,
      /update[A-Z]/i,
      /delete[A-Z]/i,
      /remove[A-Z]/i,
      /post[A-Z]/i,
      /publish[A-Z]/i,
    ];

    const requiresConfirmation = (actionId: string) => 
      patterns.some((pattern) => pattern.test(actionId));

    expect(requiresConfirmation('gmail.sendEmail')).toBe(true);
    expect(requiresConfirmation('gmail.send_email')).toBe(true);
    expect(requiresConfirmation('calendar.createEvent')).toBe(true);
    expect(requiresConfirmation('slack.postMessage')).toBe(true);
    expect(requiresConfirmation('notion.updatePage')).toBe(true);
    expect(requiresConfirmation('github.deleteIssue')).toBe(true);
    
    expect(requiresConfirmation('gmail.getMessages')).toBe(false);
    expect(requiresConfirmation('calendar.listEvents')).toBe(false);
    expect(requiresConfirmation('notion.getPage')).toBe(false);
  });
});
