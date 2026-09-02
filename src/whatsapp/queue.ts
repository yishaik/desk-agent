/**
 * Serial message queue shared by the WhatsApp handler and anything that must
 * not touch a session while a turn is running (settings saves, #78).
 * No imports on purpose — session.ts and handler.ts both depend on it.
 */
let tail: Promise<void> = Promise.resolve();
let pending = 0;

/** Run `task` after everything queued before it; rejections are surfaced to the caller only. */
export function enqueue(task: () => Promise<void>): Promise<void> {
  pending += 1;
  const run = tail.then(task).finally(() => {
    pending -= 1;
  });
  tail = run.catch(() => {});
  return run;
}

/** Resolves once every task queued so far has finished (bounded by `maxWaitMs`). */
export async function waitForIdle(maxWaitMs = 30_000): Promise<boolean> {
  if (pending === 0) return true;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), maxWaitMs);
  });
  try {
    return await Promise.race([tail.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function queuedCount(): number {
  return pending;
}
