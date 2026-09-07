/**
 * Serial message queue shared by the WhatsApp handler and anything that must
 * not touch a session while a turn is running (settings saves, #78).
 *
 * #199: inbound work is also durable in SQLite `message_jobs` (same DB as
 * memory.sqlite). The in-process promise chain still serializes execution;
 * the table survives crashes so pending work is restored on boot.
 */
import {
  acceptMessageJob,
  claimMessageJob,
  countOpenMessageJobs,
  listPendingMessageJobs,
  markMessageJobDone,
  markMessageJobFailed,
  recoverInterruptedMessageJobs,
  storeOutboundReply,
  markOutboundSent,
  markOutboundFailed,
  listPendingOutboundReplies,
  type MessageJob,
  type MessageJobPayload,
} from '../core/memory.ts';
import { createChildLogger } from '../core/logger.ts';
import type { Message } from '../core/types.ts';

const log = createChildLogger('queue');

/** Soft cap on open (pending+running) jobs — further inbound is rejected clearly. */
export const MAX_QUEUE_DEPTH = 50;

let tail: Promise<void> = Promise.resolve();
let pending = 0;
let resumed = false;

export type InboundProcessFn = (payload: MessageJobPayload) => Promise<string | null | void>;

let inboundProcessor: InboundProcessFn | null = null;

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

export function openJobCount(): number {
  return countOpenMessageJobs();
}

export type EnqueueInboundResult = 'queued' | 'duplicate' | 'full';

async function runClaimedJob(jobId: string, process: InboundProcessFn): Promise<void> {
  const claimed = claimMessageJob(jobId);
  if (!claimed) {
    log.debug({ jobId }, 'Job not claimable (missing, not pending, or max attempts)');
    return;
  }

  try {
    const reply = await process(claimed.payload);
    if (typeof reply === 'string' && reply.length > 0) {
      storeOutboundReply(jobId, reply);
    }
    markMessageJobDone(jobId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markMessageJobFailed(jobId, msg);
    log.error({ err, jobId }, 'Message job failed');
    throw err;
  }
}

/**
 * Accept inbound message as a durable job (id = WhatsApp message id) and run it
 * on the serial queue. Duplicate WA deliveries return `duplicate`.
 */
export function enqueueInboundJob(
  message: Message,
  chatJid: string,
  process?: InboundProcessFn
): EnqueueInboundResult {
  if (countOpenMessageJobs() >= MAX_QUEUE_DEPTH) {
    log.warn({ messageId: message.id, depth: MAX_QUEUE_DEPTH }, 'Message queue full');
    return 'full';
  }

  const accepted = acceptMessageJob(message, chatJid);
  if (!accepted) {
    return 'duplicate';
  }

  const runProcess = process ?? inboundProcessor;
  if (!runProcess) {
    log.error({ messageId: message.id }, 'No inbound processor registered');
    markMessageJobFailed(message.id, 'no inbound processor');
    return 'queued';
  }

  // Schedule on the serial chain; do not await — concurrency enters via Baileys
  // while FIFO is preserved by `enqueue` (#77 / #199).
  void enqueue(() => runClaimedJob(message.id, runProcess));
  return 'queued';
}

/**
 * Register the handler callback and re-queue any pending (or crash-interrupted)
 * jobs onto the serial chain. Safe to call once after WhatsApp is up.
 */
export function resumePendingJobs(process: InboundProcessFn): void {
  inboundProcessor = process;
  if (resumed) {
    return;
  }
  resumed = true;

  recoverInterruptedMessageJobs();
  const pendingJobs = listPendingMessageJobs();
  log.info({ count: pendingJobs.length }, 'Resuming durable message jobs');
  for (const job of pendingJobs) {
    void enqueue(() => runClaimedJob(job.id, process));
  }
}

export {
  storeOutboundReply,
  markOutboundSent,
  markOutboundFailed,
  listPendingOutboundReplies,
};
export type { MessageJob, MessageJobPayload };
