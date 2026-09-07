import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from './config.ts';
import { createChildLogger } from './logger.ts';
import { getActionConfirmationOverride } from './settings.ts';

const log = createChildLogger('confirmations');

// #200: Durable action log in the shared memory.sqlite (table action_confirmations).
// Pi Session owns message_jobs in the same file; we never delete-before-exec.
const DB_PATH = join(config.dataDir, 'memory.sqlite');
const LEGACY_STORE_PATH = join(config.dataDir, 'pending-confirmations.json');
/** Window from payload presentation → execute (the owner has seen what will run). */
const MAX_AGE_MS = 3 * 60 * 1000;
/** Cap on unpresented items so a tool-call that never reached the owner is still pruned. */
const UNPRESENTED_MAX_AGE_MS = 15 * 60 * 1000;
const EXECUTED_NOTE_MAX_AGE_MS = 30 * 60 * 1000;

export type ConfirmationStatus =
  | 'pending'
  | 'presented'
  | 'approved'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'cancelled'
  | 'expired';

const OPEN_STATUSES = new Set<ConfirmationStatus>(['pending', 'presented', 'approved']);

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
  /** #200 durable status. */
  status?: ConfirmationStatus;
  payloadHash?: string;
  idempotencyKey?: string;
}

export interface ClaimedConfirmation extends PendingConfirmation {
  confirmationId: string;
  payloadHash: string;
  idempotencyKey: string;
}

export interface CompleteExecutionResult {
  outcome: 'succeeded' | 'failed' | 'unknown';
  summary: string;
  providerResultId?: string;
}

let db: Database.Database | null = null;

/** Test/boot helper: release the shared SQLite handle so DATA_DIR can be wiped. */
export function closeConfirmationsDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
  }
}


function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function computePayloadHash(pending: {
  actionId: string;
  input: Record<string, unknown>;
  connectionName?: string;
  projectId?: string;
}): string {
  return createHash('sha256')
    .update(
      stableStringify({
        actionId: pending.actionId,
        input: pending.input,
        connectionName: pending.connectionName ?? null,
        projectId: pending.projectId ?? null,
      }),
    )
    .digest('hex');
}

function getDb(): Database.Database {
  if (!db) {
    if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS action_confirmations (
        confirmation_id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL,
        input_json TEXT NOT NULL,
        connection_name TEXT,
        project_id TEXT,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        payload_presented_at INTEGER,
        approved_at INTEGER,
        executing_at INTEGER,
        completed_at INTEGER,
        summary TEXT,
        provider_result_id TEXT,
        idempotency_key TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_action_confirmations_project_status
        ON action_confirmations(project_id, status);
    `);
    migrateLegacyJsonIfNeeded(db);
    log.info({ path: DB_PATH }, 'action_confirmations store ready');
  }
  return db;
}

function migrateLegacyJsonIfNeeded(database: Database.Database): void {
  if (!existsSync(LEGACY_STORE_PATH)) return;
  try {
    const raw = JSON.parse(readFileSync(LEGACY_STORE_PATH, 'utf8')) as Record<string, PendingConfirmation>;
    const insert = database.prepare(`
      INSERT OR IGNORE INTO action_confirmations (
        confirmation_id, action_id, input_json, connection_name, project_id,
        payload_hash, status, created_at, payload_presented_at, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = database.transaction(() => {
      for (const [id, pending] of Object.entries(raw)) {
        const hash = computePayloadHash({
          actionId: pending.actionId,
          input: pending.input ?? {},
          connectionName: pending.connectionName,
          projectId: pending.projectId,
        });
        const status: ConfirmationStatus = pending.payloadPresentedAt ? 'presented' : 'pending';
        insert.run(
          id,
          pending.actionId,
          JSON.stringify(pending.input ?? {}),
          pending.connectionName ?? null,
          pending.projectId ?? null,
          hash,
          status,
          pending.createdAt,
          pending.payloadPresentedAt ?? null,
          `desk-${id}`,
        );
      }
    });
    tx();
    renameSync(LEGACY_STORE_PATH, `${LEGACY_STORE_PATH}.migrated`);
    log.info('Migrated legacy pending-confirmations.json into action_confirmations');
  } catch (err) {
    log.error({ err }, 'Failed to migrate legacy pending-confirmations.json');
  }
}

type Row = {
  confirmation_id: string;
  action_id: string;
  input_json: string;
  connection_name: string | null;
  project_id: string | null;
  payload_hash: string;
  status: ConfirmationStatus;
  created_at: number;
  payload_presented_at: number | null;
  approved_at: number | null;
  executing_at: number | null;
  completed_at: number | null;
  summary: string | null;
  provider_result_id: string | null;
  idempotency_key: string;
};

function rowToPending(row: Row): PendingConfirmation & { confirmationId: string } {
  return {
    confirmationId: row.confirmation_id,
    actionId: row.action_id,
    input: JSON.parse(row.input_json) as Record<string, unknown>,
    connectionName: row.connection_name ?? undefined,
    projectId: row.project_id ?? undefined,
    createdAt: row.created_at,
    payloadPresentedAt: row.payload_presented_at ?? undefined,
    status: row.status,
    payloadHash: row.payload_hash,
    idempotencyKey: row.idempotency_key,
  };
}

function getRow(confirmationId: string): Row | undefined {
  return getDb()
    .prepare('SELECT * FROM action_confirmations WHERE confirmation_id = ?')
    .get(confirmationId) as Row | undefined;
}

function isConfirmationExpired(pending: PendingConfirmation, now: number): boolean {
  if (pending.payloadPresentedAt !== undefined) {
    return now - pending.payloadPresentedAt > MAX_AGE_MS;
  }
  return now - pending.createdAt > UNPRESENTED_MAX_AGE_MS;
}

// --- classification --------------------------------------------------------
// The gate is an ALLOW-list: only actions whose verbs are unambiguously
// read-only run without the owner's approval. Everything else — including
// verbs we have never seen — is held for a "yes". (The previous deny-list
// missed reply/trash/modify/schedule/upload, see #27.) Open Connector's
// catalog carries no read-only/mutating metadata, so the verb is the signal.
//
// #189: tokenize the FULL action name. Compound mutators such as
// find_or_create_*, get_or_create_*, check_in_* must not classify as read-only
// just because the first token is "find"/"get"/"check".
const READ_ONLY_VERBS = new Set([
  'get', 'list', 'search', 'fetch', 'retrieve', 'query', 'find', 'describe', 'read',
  'lookup', 'count', 'check', 'exists', 'is', 'has', 'preview', 'download', 'validate',
  'render', 'calculate', 'compute', 'translate', 'summarize', 'analyze', 'classify',
  'detect', 'parse', 'convert', 'ping', 'whoami',
]);

// Bridges that join a read-only-looking prefix to a mutating suffix.
const COMPOUND_MUTATING_BRIDGES = new Set(['or', 'and', 'in', 'out', 'upsert']);

// S-06 (#110) + #189: mutating verbs that ALWAYS require confirmation, even
// if the operator sets confirmation=never. Includes share/post/upload/grant/pay
// so a PAIR_TOKEN holder cannot silence those via Settings.
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
  'share',
  'post',
  'publish',
  'upload',
  'archive',
  'pay',
  'transfer',
  'refund',
  'charge',
  'invite',
  'add',
  'set',
  'mark',
  'label',
  'insert',
  'write',
  'execute',
  'run',
  'submit',
  'approve',
  'grant',
  'revoke',
  'book',
  'accept',
  'decline',
  'clear',
]);

/** Split action name into verb-like tokens: "find_or_create_dataset" → ["find","or","create","dataset"], "getMessages" → ["get","messages"]. */
export function actionTokens(actionId: string): string[] {
  const name = actionId.includes('.') ? actionId.slice(actionId.indexOf('.') + 1) : actionId;
  const withSeps = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return withSeps
    .split(/[_\-\s]+/)
    .map((part) => {
      const match = part.match(/^[A-Za-z][a-z]*/);
      return (match ? match[0] : part).toLowerCase();
    })
    .filter((t) => t.length > 0);
}

/** Leading verb of an action name: "gmail.get_message" → "get", "getMessages" → "get". */
export function actionVerb(actionId: string): string {
  return actionTokens(actionId)[0] ?? '';
}

export function isReadOnlyAction(actionId: string): boolean {
  const tokens = actionTokens(actionId);
  if (tokens.length === 0) return false;
  for (const token of tokens) {
    if (ALWAYS_CONFIRM_VERBS.has(token) || COMPOUND_MUTATING_BRIDGES.has(token)) {
      return false;
    }
  }
  return READ_ONLY_VERBS.has(tokens[0]!);
}

/**
 * Returns true if any verb token is in the hardcoded ALWAYS_CONFIRM set
 * (send/create/.../share/post/upload/grant/pay/...).
 */
export function isAlwaysConfirmAction(actionId: string): boolean {
  return actionTokens(actionId).some((token) => ALWAYS_CONFIRM_VERBS.has(token));
}

/** #190: fetch/scrape/crawl-style actions are an unconfirmed exfil channel. */
export function isExfilRiskAction(actionId: string): boolean {
  const name = (actionId.includes('.') ? actionId.slice(actionId.indexOf('.') + 1) : actionId).toLowerCase();
  return /fetch_url|fetch_html|scrape|get_html|get_page|download_url|crawl|browser_render/.test(name);
}

function valueContainsAbsoluteUrl(value: unknown): boolean {
  if (typeof value === 'string') {
    return /https?:[/][/]/i.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(valueContainsAbsoluteUrl);
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(valueContainsAbsoluteUrl);
  }
  return false;
}

/** #190: any absolute URL in the model-supplied input needs a "yes". */
export function inputHasExfilUrl(input?: Record<string, unknown>): boolean {
  if (!input) return false;
  return valueContainsAbsoluteUrl(input);
}

/**
 * #189: mode "never" is only legal for actions that are already read-only-safe
 * (and not exfil-risk by id). Never silences the default gate for mutators.
 */
export function canSetNeverOverride(actionId: string): boolean {
  return isReadOnlyAction(actionId) && !isAlwaysConfirmAction(actionId) && !isExfilRiskAction(actionId);
}

export function requiresConfirmation(actionId: string, input?: Record<string, unknown>): boolean {
  // Hard mutators and scrape/fetch_url-style ids always confirm (#189 / #190).
  if (isAlwaysConfirmAction(actionId) || isExfilRiskAction(actionId)) {
    return true;
  }

  // #190: URL in input (e.g. search_*/fetch with https://attacker) → confirm.
  if (inputHasExfilUrl(input)) {
    return true;
  }

  const override = getActionConfirmationOverride(actionId);

  // #189: 'never' only suppresses confirmation for read-only-safe actions.
  if (override === 'never') {
    return !canSetNeverOverride(actionId);
  }
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
  const id = generateConfirmationId();
  const createdAt = Date.now();
  const hash = computePayloadHash(pending);
  getDb()
    .prepare(
      `INSERT INTO action_confirmations (
        confirmation_id, action_id, input_json, connection_name, project_id,
        payload_hash, status, created_at, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      id,
      pending.actionId,
      JSON.stringify(pending.input ?? {}),
      pending.connectionName ?? null,
      pending.projectId ?? null,
      hash,
      createdAt,
      `desk-${id}`,
    );
  return id;
}

export function getPendingConfirmation(confirmationId: string): PendingConfirmation | undefined {
  const row = getRow(confirmationId);
  if (!row) return undefined;
  if (!OPEN_STATUSES.has(row.status)) return undefined;
  const { confirmationId: _id, ...rest } = rowToPending(row);
  return rest;
}

/** Most recently created open confirmation — the one a plain "yes" refers to. */
export function getLatestPendingConfirmation():
  | (PendingConfirmation & { confirmationId: string })
  | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM action_confirmations
       WHERE status IN ('pending','presented','approved')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as Row | undefined;
  return row ? rowToPending(row) : null;
}

/**
 * #200: Approve after S-04 payload was shown. Does NOT delete the row and does NOT execute.
 */
export function approveConfirmation(confirmationId: string): boolean {
  const row = getRow(confirmationId);
  if (!row) return false;
  if (row.status !== 'presented' && row.status !== 'approved') return false;
  const pending = rowToPending(row);
  if (isConfirmationExpired(pending, Date.now())) {
    getDb()
      .prepare(
        `UPDATE action_confirmations SET status = 'expired', completed_at = ? WHERE confirmation_id = ?`,
      )
      .run(Date.now(), confirmationId);
    return false;
  }
  if (row.status === 'approved') return true;
  const result = getDb()
    .prepare(
      `UPDATE action_confirmations
       SET status = 'approved', approved_at = ?
       WHERE confirmation_id = ? AND status = 'presented'`,
    )
    .run(Date.now(), confirmationId);
  return result.changes > 0;
}

/**
 * #200: Atomic claim approved → executing. Second caller gets null (no double exec).
 */
export function claimForExecution(confirmationId: string): ClaimedConfirmation | null {
  const now = Date.now();
  const result = getDb()
    .prepare(
      `UPDATE action_confirmations
       SET status = 'executing', executing_at = ?
       WHERE confirmation_id = ? AND status = 'approved'`,
    )
    .run(now, confirmationId);
  if (result.changes === 0) return null;
  const row = getRow(confirmationId);
  if (!row) return null;
  const pending = rowToPending(row);
  return {
    ...pending,
    confirmationId,
    payloadHash: row.payload_hash,
    idempotencyKey: row.idempotency_key,
  };
}

/** #200: Finalize an executing row. */
export function completeExecution(
  confirmationId: string,
  result: CompleteExecutionResult,
): boolean {
  const outcome = result.outcome;
  const res = getDb()
    .prepare(
      `UPDATE action_confirmations
       SET status = ?, completed_at = ?, summary = ?, provider_result_id = ?
       WHERE confirmation_id = ? AND status = 'executing'`,
    )
    .run(
      outcome,
      Date.now(),
      result.summary.slice(0, 1500),
      result.providerResultId ?? null,
      confirmationId,
    );
  return res.changes > 0;
}

/**
 * @deprecated #200 — was delete-before-exec. Now approve-only (no delete).
 */
export function confirmAction(confirmationId: string): boolean {
  return approveConfirmation(confirmationId);
}

export function cancelConfirmation(confirmationId: string): boolean {
  const res = getDb()
    .prepare(
      `UPDATE action_confirmations
       SET status = 'cancelled', completed_at = ?
       WHERE confirmation_id = ? AND status IN ('pending','presented','approved')`,
    )
    .run(Date.now(), confirmationId);
  return res.changes > 0;
}

/**
 * S-04 (#108): Mark that the WhatsApp handler has shown formatPendingForUser
 * for this pending item. Execution is blocked until this is set.
 */
export function markPayloadPresented(confirmationId: string): boolean {
  const now = Date.now();
  const res = getDb()
    .prepare(
      `UPDATE action_confirmations
       SET status = 'presented', payload_presented_at = COALESCE(payload_presented_at, ?)
       WHERE confirmation_id = ? AND status IN ('pending','presented')`,
    )
    .run(now, confirmationId);
  return res.changes > 0;
}

/**
 * S-04 (#108): Check if the handler has shown the payload for this pending item.
 */
export function isPayloadPresented(confirmationId: string): boolean {
  const row = getRow(confirmationId);
  return row?.payload_presented_at != null;
}

// --- executed-action notes (model context; short TTL) ----------------------
const EXECUTED_PATH = join(config.dataDir, 'executed-actions.json');

export interface ExecutedActionNote {
  projectId: string;
  actionId: string;
  success: boolean;
  summary: string;
  at: number;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, content, { mode: 0o600 });
  renameSync(tempPath, path);
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
  const notes = loadExecuted().filter((n) => Date.now() - n.at < EXECUTED_NOTE_MAX_AGE_MS);
  notes.push({ ...note, summary: note.summary.slice(0, 1500), at: Date.now() });
  saveExecuted(notes);
}

/** Peek notes without consuming them — consume only after the prompt is sent. */
export function peekExecutedActionNotes(projectId: string): ExecutedActionNote[] {
  return loadExecuted()
    .filter((n) => Date.now() - n.at < EXECUTED_NOTE_MAX_AGE_MS)
    .filter((n) => n.projectId === projectId);
}

/** Returns (and clears) the notes for a project; expired notes are dropped. */
export function consumeExecutedActionNotes(projectId: string): ExecutedActionNote[] {
  const all = loadExecuted().filter((n) => Date.now() - n.at < EXECUTED_NOTE_MAX_AGE_MS);
  const mine = all.filter((n) => n.projectId === projectId);
  if (mine.length > 0 || all.length !== loadExecuted().length) {
    saveExecuted(all.filter((n) => n.projectId !== projectId));
  }
  return mine;
}

export function cleanupOldConfirmations(): void {
  consumeExpiredConfirmations();
}

/** Mark expired open items and return them so the handler can tell the owner. */
export function consumeExpiredConfirmations(
  projectId?: string,
): Array<PendingConfirmation & { confirmationId: string }> {
  const now = Date.now();
  const rows = getDb()
    .prepare(
      `SELECT * FROM action_confirmations WHERE status IN ('pending','presented','approved')`,
    )
    .all() as Row[];
  const expired: Array<PendingConfirmation & { confirmationId: string }> = [];
  const mark = getDb().prepare(
    `UPDATE action_confirmations SET status = 'expired', completed_at = ? WHERE confirmation_id = ?`,
  );
  for (const row of rows) {
    if (projectId !== undefined && row.project_id !== projectId) continue;
    const pending = rowToPending(row);
    if (!isConfirmationExpired(pending, now)) continue;
    mark.run(now, row.confirmation_id);
    expired.push(pending);
  }
  return expired;
}

/** Get all open confirmations for a project (or all if projectId undefined). */
export function getAllPendingConfirmations(
  projectId?: string,
): Array<PendingConfirmation & { confirmationId: string }> {
  const rows = (
    projectId === undefined
      ? (getDb()
          .prepare(
            `SELECT * FROM action_confirmations WHERE status IN ('pending','presented','approved') ORDER BY created_at ASC`,
          )
          .all() as Row[])
      : (getDb()
          .prepare(
            `SELECT * FROM action_confirmations WHERE project_id = ? AND status IN ('pending','presented','approved') ORDER BY created_at ASC`,
          )
          .all(projectId) as Row[])
  );
  return rows.map(rowToPending);
}

/** Cancel all open confirmations for a project. Returns count cancelled. */
export function cancelAllPendingConfirmations(projectId?: string): number {
  const now = Date.now();
  if (projectId === undefined) {
    const res = getDb()
      .prepare(
        `UPDATE action_confirmations SET status = 'cancelled', completed_at = ?
         WHERE status IN ('pending','presented','approved')`,
      )
      .run(now);
    return res.changes;
  }
  const res = getDb()
    .prepare(
      `UPDATE action_confirmations SET status = 'cancelled', completed_at = ?
       WHERE project_id = ? AND status IN ('pending','presented','approved')`,
    )
    .run(now, projectId);
  return res.changes;
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
