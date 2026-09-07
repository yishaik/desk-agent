import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.ts';
import { createChildLogger } from './logger.ts';
import { getActionConfirmationOverride } from './settings.ts';

const log = createChildLogger('confirmations');

// File-backed so the WhatsApp handler (agent process) and the connector MCP
// server (a Claude Code subprocess) share one pending-confirmation store.
const STORE_PATH = join(config.dataDir, 'pending-confirmations.json');
/** Window from payload presentation → execute (the owner has seen what will run). */
const MAX_AGE_MS = 3 * 60 * 1000;
/** Cap on unpresented items so a tool-call that never reached the owner is still pruned. */
const UNPRESENTED_MAX_AGE_MS = 15 * 60 * 1000;

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

function isConfirmationExpired(pending: PendingConfirmation, now: number): boolean {
  if (pending.payloadPresentedAt !== undefined) {
    return now - pending.payloadPresentedAt > MAX_AGE_MS;
  }
  return now - pending.createdAt > UNPRESENTED_MAX_AGE_MS;
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

/** Peek notes without consuming them — consume only after the prompt is sent. */
export function peekExecutedActionNotes(projectId: string): ExecutedActionNote[] {
  return loadExecuted()
    .filter((n) => Date.now() - n.at < EXECUTED_MAX_AGE_MS)
    .filter((n) => n.projectId === projectId);
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
    if (!isConfirmationExpired(pending, now)) continue;
    if (projectId === undefined || pending.projectId === projectId) {
      expired.push({ confirmationId: id, ...pending });
      delete store[id];
      changed = true;
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
/** Format a recipient-ish value (string, string[], or {email}[]) for WhatsApp. */
function formatRecipientList(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'email' in item) {
          return String((item as { email: unknown }).email);
        }
        return JSON.stringify(item);
      })
      .filter(Boolean)
      .join(', ');
  }
  if (value && typeof value === 'object' && 'email' in value) {
    return String((value as { email: unknown }).email);
  }
  return String(value);
}

function truncateField(value: unknown, max: number): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  return str.length > max ? str.slice(0, max) + '...' : str;
}

/**
 * Format pending confirmation input as a human-readable Hebrew summary.
 * #180: always surface recipient-ish / exfil fields (cc, bcc, attendees, forward,
 * scope, …). Named keys first; then any remaining top-level keys so an omitted
 * field cannot hide a hidden recipient behind a matching `to`/`start`.
 */
export function formatPendingForUser(pending: PendingConfirmation): string {
  const { actionId, input } = pending;
  const lines: string[] = [];
  const consumed = new Set<string>();

  const take = (key: string): unknown => {
    if (!(key in input)) return undefined;
    consumed.add(key);
    return input[key];
  };

  lines.push(`📋 *${actionId}*`);

  const to = take('to');
  if (to !== undefined && to !== null && to !== '') {
    lines.push(`👤 אל: ${formatRecipientList(to)}`);
  }
  const recipient = take('recipient');
  if (recipient !== undefined && recipient !== null && recipient !== '') {
    lines.push(`👤 אל: ${formatRecipientList(recipient)}`);
  }
  const email = take('email');
  if (email !== undefined && email !== null && email !== '') {
    lines.push(`👤 אל: ${formatRecipientList(email)}`);
  }

  // #180 — exfiltration / hidden-recipient channels must always appear
  const cc = take('cc');
  if (cc !== undefined && cc !== null && cc !== '') {
    lines.push(`👥 עותק (cc): ${formatRecipientList(cc)}`);
  }
  const bcc = take('bcc');
  if (bcc !== undefined && bcc !== null && bcc !== '') {
    lines.push(`🙈 עותק מוסתר (bcc): ${formatRecipientList(bcc)}`);
  }
  const attendees = take('attendees');
  if (attendees !== undefined && attendees !== null && attendees !== '') {
    lines.push(`👥 מוזמנים: ${formatRecipientList(attendees)}`);
  }

  const subject = take('subject');
  if (subject !== undefined && subject !== null && subject !== '') {
    lines.push(`📌 נושא: ${subject}`);
  }
  const title = take('title');
  if (title !== undefined && title !== null && title !== '') {
    lines.push(`📌 כותרת: ${title}`);
  }
  const summary = take('summary');
  if (summary !== undefined && summary !== null && summary !== '') {
    lines.push(`📌 כותרת: ${summary}`);
  }
  const name = take('name');
  if (name !== undefined && name !== null && name !== '') {
    lines.push(`📛 שם: ${name}`);
  }

  const body = take('body');
  if (body !== undefined && body !== null && body !== '') {
    lines.push(`📝 תוכן: ${truncateField(body, 100)}`);
  }
  const message = take('message');
  if (message !== undefined && message !== null && message !== '') {
    lines.push(`📝 הודעה: ${truncateField(message, 100)}`);
  }
  const content = take('content');
  if (content !== undefined && content !== null && content !== '') {
    lines.push(`📝 תוכן: ${truncateField(content, 100)}`);
  }
  const description = take('description');
  if (description !== undefined && description !== null && description !== '') {
    lines.push(`📝 תיאור: ${truncateField(description, 100)}`);
  }

  const start = take('start') ?? take('startTime') ?? take('start_time');
  if (start !== undefined && start !== null && start !== '') {
    lines.push(`🕐 התחלה: ${start}`);
  }
  const end = take('end') ?? take('endTime') ?? take('end_time');
  if (end !== undefined && end !== null && end !== '') {
    lines.push(`🕐 סיום: ${end}`);
  }

  const attachments = take('attachments');
  if (attachments !== undefined && attachments !== null && attachments !== '') {
    if (Array.isArray(attachments)) {
      const names = attachments.map((a) => {
        if (typeof a === 'string') return a;
        if (a && typeof a === 'object') {
          const o = a as Record<string, unknown>;
          return String(o['filename'] ?? o['name'] ?? o['title'] ?? JSON.stringify(a));
        }
        return String(a);
      });
      lines.push(`📎 קבצים מצורפים: ${names.join(', ') || `(${attachments.length})`}`);
    } else {
      lines.push(`📎 קבצים מצורפים: ${truncateField(attachments, 80)}`);
    }
  }

  const forwardingEmail = take('forwardingEmail');
  if (forwardingEmail !== undefined && forwardingEmail !== null && forwardingEmail !== '') {
    lines.push(`↪️ העברה אל: ${formatRecipientList(forwardingEmail)}`);
  }
  const sendUpdates = take('sendUpdates');
  if (sendUpdates !== undefined && sendUpdates !== null && sendUpdates !== '') {
    lines.push(`📣 עדכון מוזמנים: ${sendUpdates}`);
  }

  const scope = take('scope');
  if (scope !== undefined && scope !== null && scope !== '') {
    if (scope && typeof scope === 'object') {
      const s = scope as Record<string, unknown>;
      const value = s['value'] ?? s['email'];
      const kind = s['type'];
      lines.push(`🔓 היקף גישה: ${value ?? JSON.stringify(scope)}${kind ? ` (${kind})` : ''}`);
    } else {
      lines.push(`🔓 היקף גישה: ${scope}`);
    }
  }

  const action = take('action');
  if (action !== undefined && action !== null && action !== '') {
    if (action && typeof action === 'object') {
      const a = action as Record<string, unknown>;
      if (a['forward'] !== undefined && a['forward'] !== null && a['forward'] !== '') {
        lines.push(`↪️ העברה אל: ${formatRecipientList(a['forward'])}`);
      }
      const other = { ...a };
      delete other['forward'];
      if (Object.keys(other).length > 0) {
        lines.push(`⚙️ פעולה: ${truncateField(other, 80)}`);
      }
    } else {
      lines.push(`⚙️ פעולה: ${truncateField(action, 80)}`);
    }
  }

  // Remaining top-level keys — never hide a field just because `to` already matched
  const remaining = Object.keys(input).filter((k) => !consumed.has(k));
  for (const key of remaining) {
    const val = input[key];
    if (val === undefined || val === null || val === '') continue;
    lines.push(`• ${key}: ${truncateField(val, 80)}`);
  }

  return lines.join('\n');
}

export { MAX_AGE_MS, UNPRESENTED_MAX_AGE_MS };
