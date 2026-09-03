import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.ts';
import { createChildLogger } from './logger.ts';
import { getActionConfirmationOverride } from './settings.ts';

const log = createChildLogger('confirmations');

// File-backed so the WhatsApp handler (agent process) and the connector MCP
// server (a Claude Code subprocess) share one pending-confirmation store.
const STORE_PATH = join(config.dataDir, 'pending-confirmations.json');
const MAX_AGE_MS = 3 * 60 * 1000;

export interface PendingConfirmation {
  actionId: string;
  input: Record<string, unknown>;
  connectionName?: string;
  projectId?: string;
  createdAt: number;
  /**
   * S-04 (#108): Timestamp when the WhatsApp handler showed formatPendingForUser
   * for this pending item. Execution is blocked until this is set — the customer
   * must see the real payload (to/subject/body), not just the model's description.
   */
  payloadPresentedAt?: number;
}

type Store = Record<string, PendingConfirmation>;

function load(): Store {
  try {
    return JSON.parse(readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, content, { mode: 0o600 });
  renameSync(tempPath, path);
}

function save(store: Store): void {
  try {
    atomicWrite(STORE_PATH, JSON.stringify(store));
  } catch (err) {
    log.error({ err }, 'Failed to persist pending confirmations');
  }
}

// --- classification --------------------------------------------------------
// The gate is an ALLOW-list: only actions whose leading verb is unambiguously
// read-only run without the owner's approval. Everything else — including
// verbs we have never seen — is held for a "yes". (The previous deny-list
// missed reply/trash/modify/schedule/upload, see #27.) Open Connector's
// catalog carries no read-only/mutating metadata, so the verb is the signal.
const READ_ONLY_VERBS = new Set([
  'get', 'list', 'search', 'fetch', 'retrieve', 'query', 'find', 'describe', 'read',
  'lookup', 'count', 'check', 'exists', 'is', 'has', 'preview', 'download', 'validate',
  'render', 'calculate', 'compute', 'translate', 'summarize', 'analyze', 'classify',
  'detect', 'parse', 'convert', 'ping', 'whoami',
]);

// S-06 (#110): Hardcoded mutating verbs that ALWAYS require confirmation, even
// if the operator sets confirmation=never. These are the real-world-impact
// actions for the default inbox-calendar skill pack (Gmail + Calendar).
// The verb heuristic stays as a fallback for other OC actions.
const ALWAYS_CONFIRM_VERBS = new Set([
  'send',
  'create',
  'update',
  'delete',
  'remove',
  'trash',
  'modify',
  'patch',
  'reply',
  'forward',
  'schedule',
  'cancel',
  'move',
]);

/** Leading verb of an action name: "gmail.get_message" → "get", "getMessages" → "get". */
export function actionVerb(actionId: string): string {
  const name = actionId.includes('.') ? actionId.slice(actionId.indexOf('.') + 1) : actionId;
  const first = name.split(/[_\-\s]/)[0] ?? '';
  const match = first.match(/^[A-Za-z][a-z]*/);
  return (match ? match[0] : first).toLowerCase();
}

export function isReadOnlyAction(actionId: string): boolean {
  return READ_ONLY_VERBS.has(actionVerb(actionId));
}

/**
 * S-06 (#110): Returns true if the action's leading verb is in the hardcoded
 * list of mutating verbs that must ALWAYS require confirmation.
 */
export function isAlwaysConfirmAction(actionId: string): boolean {
  return ALWAYS_CONFIRM_VERBS.has(actionVerb(actionId));
}

export function requiresConfirmation(actionId: string): boolean {
  const override = getActionConfirmationOverride(actionId);

  // S-06 (#110): 'never' override must NOT skip confirmation for known
  // mutating verbs (send/create/update/delete/etc). This protects against
  // operator misconfiguration bypassing the gate for real-world writes.
  if (isAlwaysConfirmAction(actionId)) {
    return true;
  }

  if (override === 'never') return false;
  if (override === 'always') return true;
  return !isReadOnlyAction(actionId);
}

/**
 * The text both engines hand back to the model when a mutating action needs
 * the owner's approval. The model has no way to approve — the owner replies
 * "yes" in WhatsApp and the handler resolves it outside the model.
 */
export function formatConfirmationRequest(actionId: string, input: unknown, confirmationId: string): string {
  return [
    `⚠️ Action "${actionId}" requires the user's confirmation and was NOT executed.`,
    '',
    '**Planned action:**',
    `- Action: ${actionId}`,
    `- Input: ${JSON.stringify(input, null, 2)}`,
    '',
    'Describe to the user exactly what will happen and ask them to reply "yes" (or "אשר") to approve, or "no" (or "בטל") to cancel. The approval is handled outside the model — you cannot approve it yourself, and you must NOT call execute_action again for this action.',
    '',
    `_Confirmation ID: ${confirmationId}_`,
  ].join('\n');
}

export function generateConfirmationId(): string {
  return `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createPendingConfirmation(pending: Omit<PendingConfirmation, 'createdAt'>): string {
  const store = load();
  const id = generateConfirmationId();
  store[id] = { ...pending, createdAt: Date.now() };
  save(store);
  return id;
}

export function getPendingConfirmation(confirmationId: string): PendingConfirmation | undefined {
  return load()[confirmationId];
}

/** Most recently created pending confirmation — the one a plain "yes" refers to. */
export function getLatestPendingConfirmation():
  | (PendingConfirmation & { confirmationId: string })
  | null {
  const store = load();
  let latest: (PendingConfirmation & { confirmationId: string }) | null = null;
  for (const [confirmationId, pending] of Object.entries(store)) {
    if (!latest || pending.createdAt > latest.createdAt) {
      latest = { confirmationId, ...pending };
    }
  }
  return latest;
}

/** Consumes the confirmation. Returns true if it existed. */
export function confirmAction(confirmationId: string): boolean {
  const store = load();
  if (!store[confirmationId]) return false;
  delete store[confirmationId];
  save(store);
  return true;
}

export function cancelConfirmation(confirmationId: string): boolean {
  return confirmAction(confirmationId);
}

/**
 * S-04 (#108): Mark that the WhatsApp handler has shown formatPendingForUser
 * for this pending item. Execution is blocked until this is set.
 */
export function markPayloadPresented(confirmationId: string): boolean {
  const store = load();
  if (!store[confirmationId]) return false;
  store[confirmationId]!.payloadPresentedAt = Date.now();
  save(store);
  return true;
}

/**
 * S-04 (#108): Check if the handler has shown the payload for this pending item.
 */
export function isPayloadPresented(confirmationId: string): boolean {
  const pending = load()[confirmationId];
  return pending?.payloadPresentedAt !== undefined;
}

// --- executed-action notes -------------------------------------------------
// A confirmed action runs in the WhatsApp handler, outside the model's turn, so
// the model never sees its tool result. The handler records a note here and the
// next prompt to the model is prefixed with it (see whatsapp/handler.ts).
const EXECUTED_PATH = join(config.dataDir, 'executed-actions.json');
const EXECUTED_MAX_AGE_MS = 30 * 60 * 1000;

export interface ExecutedActionNote {
  projectId: string;
  actionId: string;
  success: boolean;
  summary: string;
  at: number;
}

function loadExecuted(): ExecutedActionNote[] {
  try {
    const parsed = JSON.parse(readFileSync(EXECUTED_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveExecuted(notes: ExecutedActionNote[]): void {
  try {
    atomicWrite(EXECUTED_PATH, JSON.stringify(notes));
  } catch (err) {
    log.error({ err }, 'Failed to persist executed-action notes');
  }
}

export function recordExecutedAction(note: Omit<ExecutedActionNote, 'at'>): void {
  const notes = loadExecuted().filter((n) => Date.now() - n.at < EXECUTED_MAX_AGE_MS);
  notes.push({ ...note, summary: note.summary.slice(0, 1500), at: Date.now() });
  saveExecuted(notes);
}

/** Returns (and clears) the notes for a project; expired notes are dropped. */
export function consumeExecutedActionNotes(projectId: string): ExecutedActionNote[] {
  const all = loadExecuted().filter((n) => Date.now() - n.at < EXECUTED_MAX_AGE_MS);
  const mine = all.filter((n) => n.projectId === projectId);
  if (mine.length > 0 || all.length !== loadExecuted().length) {
    saveExecuted(all.filter((n) => n.projectId !== projectId));
  }
  return mine;
}

export function cleanupOldConfirmations(): void {
  consumeExpiredConfirmations();
}

/** Remove expired pending items and return them so the handler can tell the owner. */
export function consumeExpiredConfirmations(
  projectId?: string
): Array<PendingConfirmation & { confirmationId: string }> {
  const store = load();
  const now = Date.now();
  const expired: Array<PendingConfirmation & { confirmationId: string }> = [];
  let changed = false;
  for (const [id, pending] of Object.entries(store)) {
    if (now - pending.createdAt > MAX_AGE_MS) {
      if (projectId === undefined || pending.projectId === projectId) {
        expired.push({ confirmationId: id, ...pending });
        delete store[id];
        changed = true;
      }
    }
  }
  if (changed) save(store);
  return expired;
}

/** Get all pending confirmations for a project (or all if projectId undefined). */
export function getAllPendingConfirmations(
  projectId?: string
): Array<PendingConfirmation & { confirmationId: string }> {
  const store = load();
  const results: Array<PendingConfirmation & { confirmationId: string }> = [];
  for (const [confirmationId, pending] of Object.entries(store)) {
    if (projectId === undefined || pending.projectId === projectId) {
      results.push({ confirmationId, ...pending });
    }
  }
  return results.sort((a, b) => a.createdAt - b.createdAt);
}

/** Cancel all pending confirmations for a project. Returns count cancelled. */
export function cancelAllPendingConfirmations(projectId?: string): number {
  const store = load();
  let count = 0;
  for (const [id, pending] of Object.entries(store)) {
    if (projectId === undefined || pending.projectId === projectId) {
      delete store[id];
      count++;
    }
  }
  if (count > 0) save(store);
  return count;
}

/** Format pending confirmation input as a human-readable summary. */
export function formatPendingForUser(pending: PendingConfirmation): string {
  const { actionId, input } = pending;
  const lines: string[] = [];
  
  lines.push(`📋 *${actionId}*`);
  
  if (input['to']) lines.push(`👤 אל: ${input['to']}`);
  if (input['recipient']) lines.push(`👤 אל: ${input['recipient']}`);
  if (input['email']) lines.push(`👤 אל: ${input['email']}`);
  if (input['subject']) lines.push(`📌 נושא: ${input['subject']}`);
  if (input['title']) lines.push(`📌 כותרת: ${input['title']}`);
  if (input['name']) lines.push(`📛 שם: ${input['name']}`);
  
  if (input['body']) {
    const body = String(input['body']);
    const truncated = body.length > 100 ? body.slice(0, 100) + '...' : body;
    lines.push(`📝 תוכן: ${truncated}`);
  }
  if (input['message']) {
    const msg = String(input['message']);
    const truncated = msg.length > 100 ? msg.slice(0, 100) + '...' : msg;
    lines.push(`📝 הודעה: ${truncated}`);
  }
  if (input['content']) {
    const content = String(input['content']);
    const truncated = content.length > 100 ? content.slice(0, 100) + '...' : content;
    lines.push(`📝 תוכן: ${truncated}`);
  }
  
  if (input['start'] || input['startTime'] || input['start_time']) {
    const start = input['start'] || input['startTime'] || input['start_time'];
    lines.push(`🕐 התחלה: ${start}`);
  }
  if (input['end'] || input['endTime'] || input['end_time']) {
    const end = input['end'] || input['endTime'] || input['end_time'];
    lines.push(`🕐 סיום: ${end}`);
  }
  
  if (lines.length === 1) {
    const keys = Object.keys(input).slice(0, 3);
    for (const key of keys) {
      const val = input[key];
      const strVal = typeof val === 'string' ? val : JSON.stringify(val);
      const truncated = strVal.length > 50 ? strVal.slice(0, 50) + '...' : strVal;
      lines.push(`• ${key}: ${truncated}`);
    }
    if (Object.keys(input).length > 3) {
      lines.push(`_...ועוד ${Object.keys(input).length - 3} שדות_`);
    }
  }
  
  return lines.join('\n');
}

export { MAX_AGE_MS };
