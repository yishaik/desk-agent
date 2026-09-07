import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TEST_DATA_DIR = './test-data-queue-199';

beforeEach(async () => {
  try {
    const { closeDatabase } = await import('../core/memory.ts');
    closeDatabase();
  } catch {
    // first test
  }
  vi.resetModules();
  process.env['DATA_DIR'] = TEST_DATA_DIR;
  if (existsSync(TEST_DATA_DIR)) {
    rmSync(TEST_DATA_DIR, { recursive: true });
  }
  mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(async () => {
  const { closeDatabase } = await import('../core/memory.ts');
  closeDatabase();
  if (existsSync(TEST_DATA_DIR)) {
    rmSync(TEST_DATA_DIR, { recursive: true });
  }
  delete process.env['DATA_DIR'];
});

describe('message queue (#78)', () => {
  it('runs tasks strictly one after another and survives a rejection', async () => {
    const { enqueue, queuedCount } = await import('./queue.ts');
    const order: string[] = [];
    const a = enqueue(async () => { order.push('a:start'); await sleep(30); order.push('a:end'); });
    const b = enqueue(async () => { order.push('b'); throw new Error('boom'); });
    const c = enqueue(async () => { order.push('c'); });
    expect(queuedCount()).toBe(3);
    await a;
    await expect(b).rejects.toThrow('boom');
    await c;
    expect(order).toEqual(['a:start', 'a:end', 'b', 'c']);
    expect(queuedCount()).toBe(0);
  });

  it('waitForIdle resolves only after the queued turn finished, and times out when stuck', async () => {
    const { enqueue, waitForIdle } = await import('./queue.ts');
    expect(await waitForIdle()).toBe(true);

    let finished = false;
    const task = enqueue(async () => { await sleep(40); finished = true; });
    const idle = await waitForIdle();
    expect(idle).toBe(true);
    expect(finished).toBe(true);
    await task;

    let release!: () => void;
    const stuck = enqueue(() => new Promise<void>((r) => { release = r; }));
    expect(await waitForIdle(20)).toBe(false);
    release();
    await stuck;
  });
});

describe('durable message jobs (#199)', () => {
  const baseMessage = {
    id: 'wa_msg_1',
    from: '123@s.whatsapp.net',
    to: '123@s.whatsapp.net',
    body: 'hello',
    timestamp: Math.floor(Date.now() / 1000),
    isFromMe: true,
    projectId: 'default',
  };

  it('duplicate delivery creates only one job', async () => {
    const { acceptMessageJob, countOpenMessageJobs } = await import('../core/memory.ts');
    expect(acceptMessageJob(baseMessage, '123@s.whatsapp.net')).toBe(true);
    expect(acceptMessageJob({ ...baseMessage }, '123@s.whatsapp.net')).toBe(false);
    expect(countOpenMessageJobs()).toBe(1);
  });

  it('crash after accept leaves pending work that resume re-runs once', async () => {
    const { acceptMessageJob, recoverInterruptedMessageJobs, listPendingMessageJobs, claimMessageJob, markMessageJobDone } =
      await import('../core/memory.ts');

    expect(acceptMessageJob(baseMessage, 'chat@jid')).toBe(true);
    const claimed = claimMessageJob(baseMessage.id);
    expect(claimed?.status).toBe('running');

    // Simulate process crash while running:
    recoverInterruptedMessageJobs();
    const pending = listPendingMessageJobs();
    expect(pending.map((j) => j.id)).toContain(baseMessage.id);

    const again = claimMessageJob(baseMessage.id);
    expect(again?.attempts).toBe(2);
    markMessageJobDone(baseMessage.id);
    expect(listPendingMessageJobs()).toHaveLength(0);
  });

  it('enqueueInboundJob serializes and rejects duplicates', async () => {
    const { enqueueInboundJob, openJobCount, waitForIdle } = await import('./queue.ts');
    const order: string[] = [];

    const r1 = enqueueInboundJob(baseMessage, 'chat@jid', async () => {
      order.push('start');
      await sleep(30);
      order.push('end');
      return 'reply-text';
    });
    const r2 = enqueueInboundJob(baseMessage, 'chat@jid', async () => {
      order.push('dup');
      return null;
    });

    expect(r1).toBe('queued');
    expect(r2).toBe('duplicate');
    expect(await waitForIdle(500)).toBe(true);
    expect(order).toEqual(['start', 'end']);
    expect(openJobCount()).toBe(0);

    const { listPendingOutboundReplies } = await import('../core/memory.ts');
    const outbound = listPendingOutboundReplies();
    expect(outbound.some((j) => j.id === baseMessage.id && j.outboundReply === 'reply-text')).toBe(true);
  });

  it('preserves FIFO order across jobs (e.g. /project then prompt)', async () => {
    const { enqueueInboundJob, waitForIdle } = await import('./queue.ts');
    const order: string[] = [];
    const mk = (id: string, body: string) => ({ ...baseMessage, id, body });

    enqueueInboundJob(mk('m1', '/project other'), 'chat@jid', async (p) => {
      order.push(p.message.body);
      await sleep(40);
      return null;
    });
    enqueueInboundJob(mk('m2', 'follow-up'), 'chat@jid', async (p) => {
      order.push(p.message.body);
      return null;
    });
    expect(await waitForIdle(500)).toBe(true);
    expect(order).toEqual(['/project other', 'follow-up']);
  });
});
