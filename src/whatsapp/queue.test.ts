import { describe, it, expect, vi, beforeEach } from 'vitest';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('message queue (#78)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

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
    expect(await waitForIdle()).toBe(true); // nothing queued

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
