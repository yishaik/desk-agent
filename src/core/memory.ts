import Database from 'better-sqlite3';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { config } from './config.ts';
import { createChildLogger } from './logger.ts';
import type { Message, Project } from './types.ts';

const log = createChildLogger('memory');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    if (!existsSync(config.dataDir)) {
      mkdirSync(config.dataDir, { recursive: true });
    }
    const dbPath = join(config.dataDir, 'memory.sqlite');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initSchema();
    log.info({ path: dbPath }, 'Database initialized');
  }
  return db;
}

function initSchema(): void {
  const database = getDb();

  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      connector_token TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      from_jid TEXT NOT NULL,
      to_jid TEXT NOT NULL,
      body TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      is_from_me INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_summaries_project ON summaries(project_id);

    CREATE TABLE IF NOT EXISTS message_jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL,
      outbound_reply TEXT,
      outbound_status TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_message_jobs_status_created
      ON message_jobs(status, created_at);
  `);

  const defaultProject = database
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get('default');
  if (!defaultProject) {
    database
      .prepare('INSERT INTO projects (id, name, description) VALUES (?, ?, ?)')
      .run('default', 'Default', 'Default project');
    log.info('Created default project');
  }
}

export function createProject(project: Omit<Project, 'createdAt'>): Project {
  const database = getDb();
  const createdAt = new Date().toISOString();

  database
    .prepare(
      'INSERT INTO projects (id, name, description, connector_token, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(project.id, project.name, project.description ?? null, project.connectorToken ?? null, createdAt);

  log.info({ projectId: project.id }, 'Created project');
  return { ...project, createdAt };
}

export function getProject(id: string): Project | null {
  const database = getDb();
  const row = database.prepare('SELECT * FROM projects WHERE id = ?').get(id) as {
    id: string;
    name: string;
    description: string | null;
    connector_token: string | null;
    created_at: string;
  } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    connectorToken: row.connector_token ?? undefined,
    createdAt: row.created_at,
  };
}

export function listProjects(): Project[] {
  const database = getDb();
  const rows = database.prepare('SELECT * FROM projects ORDER BY created_at').all() as {
    id: string;
    name: string;
    description: string | null;
    connector_token: string | null;
    created_at: string;
  }[];

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    connectorToken: row.connector_token ?? undefined,
    createdAt: row.created_at,
  }));
}

export function updateProjectToken(projectId: string, token: string | null): void {
  const database = getDb();
  database
    .prepare('UPDATE projects SET connector_token = ? WHERE id = ?')
    .run(token, projectId);
  log.info({ projectId }, 'Updated project token');
}

export function getMessage(id: string): Message | null {
  const database = getDb();
  const row = database.prepare('SELECT * FROM messages WHERE id = ?').get(id) as {
    id: string;
    project_id: string;
    from_jid: string;
    to_jid: string;
    body: string;
    timestamp: number;
    is_from_me: number;
  } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    from: row.from_jid,
    to: row.to_jid,
    body: row.body,
    timestamp: row.timestamp,
    isFromMe: row.is_from_me === 1,
    projectId: row.project_id,
  };
}

export function saveMessage(message: Message): boolean {
  const database = getDb();
  const projectId = message.projectId ?? 'default';

  const result = database
    .prepare(
      `INSERT OR IGNORE INTO messages (id, project_id, from_jid, to_jid, body, timestamp, is_from_me)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      message.id,
      projectId,
      message.from,
      message.to,
      message.body,
      message.timestamp,
      message.isFromMe ? 1 : 0
    );

  if (result.changes === 0) {
    log.debug({ messageId: message.id }, 'Duplicate message ignored');
    return false;
  }
  return true;
}


export type MessageJobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface MessageJobPayload {
  message: Message;
  chatJid: string;
}

export interface MessageJob {
  id: string;
  projectId: string;
  status: MessageJobStatus;
  attempts: number;
  payload: MessageJobPayload;
  outboundReply?: string;
  outboundStatus?: 'pending' | 'sent' | 'failed';
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

const MAX_JOB_ATTEMPTS = 3;

function rowToJob(row: {
  id: string;
  project_id: string;
  status: string;
  attempts: number;
  payload: string;
  outbound_reply: string | null;
  outbound_status: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}): MessageJob {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status as MessageJobStatus,
    attempts: row.attempts,
    payload: JSON.parse(row.payload) as MessageJobPayload,
    outboundReply: row.outbound_reply ?? undefined,
    outboundStatus: (row.outbound_status as MessageJob['outboundStatus']) ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
  };
}

/**
 * Accept an inbound WhatsApp message as a durable job (#199).
 * Transaction: insert pending job (id = WA message id) + archive row in messages.
 * Returns false if the job id already exists (duplicate delivery).
 */
export function acceptMessageJob(message: Message, chatJid: string): boolean {
  const database = getDb();
  const projectId = message.projectId ?? 'default';
  const now = Date.now();
  const payload: string = JSON.stringify({ message, chatJid } as MessageJobPayload);

  const tx = database.transaction(() => {
    const jobInsert = database
      .prepare(
        `INSERT OR IGNORE INTO message_jobs
          (id, project_id, status, attempts, payload, created_at, updated_at)
         VALUES (?, ?, 'pending', 0, ?, ?, ?)`
      )
      .run(message.id, projectId, payload, now, now);

    if (jobInsert.changes === 0) {
      return false;
    }

    // messages.project_id has an FK to projects — ensure the row exists for
    // non-default active projects (tests and /project-new paths).
    database
      .prepare(
        `INSERT OR IGNORE INTO projects (id, name, description) VALUES (?, ?, ?)`
      )
      .run(projectId, projectId, null);

    database
      .prepare(
        `INSERT OR IGNORE INTO messages (id, project_id, from_jid, to_jid, body, timestamp, is_from_me)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        message.id,
        projectId,
        message.from,
        message.to,
        message.body,
        message.timestamp,
        message.isFromMe ? 1 : 0
      );

    return true;
  });

  const accepted = tx();
  if (!accepted) {
    log.debug({ messageId: message.id }, 'Duplicate message job ignored');
  }
  return accepted;
}

export function countOpenMessageJobs(): number {
  const database = getDb();
  const row = database
    .prepare(
      `SELECT COUNT(*) AS n FROM message_jobs WHERE status IN ('pending', 'running')`
    )
    .get() as { n: number };
  return Number(row.n);
}

export function listPendingMessageJobs(): MessageJob[] {
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT * FROM message_jobs WHERE status = 'pending' ORDER BY created_at ASC, id ASC`
    )
    .all() as Parameters<typeof rowToJob>[0][];
  return rows.map(rowToJob);
}

export function claimMessageJob(id: string): MessageJob | null {
  const database = getDb();
  const now = Date.now();
  const tx = database.transaction(() => {
    const row = database.prepare(`SELECT * FROM message_jobs WHERE id = ?`).get(id) as
      | Parameters<typeof rowToJob>[0]
      | undefined;
    if (!row || row.status !== 'pending') {
      return null;
    }
    if (row.attempts >= MAX_JOB_ATTEMPTS) {
      database
        .prepare(
          `UPDATE message_jobs
           SET status = 'failed', last_error = ?, updated_at = ?, finished_at = ?
           WHERE id = ?`
        )
        .run('exceeded max attempts', now, now, id);
      return null;
    }
    database
      .prepare(
        `UPDATE message_jobs
         SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ?, last_error = NULL
         WHERE id = ? AND status = 'pending'`
      )
      .run(now, now, id);
    const claimed = database.prepare(`SELECT * FROM message_jobs WHERE id = ?`).get(id) as
      Parameters<typeof rowToJob>[0];
    return rowToJob(claimed);
  });
  return tx();
}

export function markMessageJobDone(id: string): void {
  const database = getDb();
  const now = Date.now();
  database
    .prepare(
      `UPDATE message_jobs
       SET status = 'done', updated_at = ?, finished_at = ?
       WHERE id = ?`
    )
    .run(now, now, id);
}

export function markMessageJobFailed(id: string, error: string): void {
  const database = getDb();
  const now = Date.now();
  database
    .prepare(
      `UPDATE message_jobs
       SET status = 'failed', last_error = ?, updated_at = ?, finished_at = ?
       WHERE id = ?`
    )
    .run(error.slice(0, 2000), now, now, id);
}

export function storeOutboundReply(id: string, reply: string): void {
  const database = getDb();
  const now = Date.now();
  database
    .prepare(
      `UPDATE message_jobs
       SET outbound_reply = ?, outbound_status = 'pending', updated_at = ?
       WHERE id = ?`
    )
    .run(reply, now, id);
}

export function markOutboundSent(id: string): void {
  const database = getDb();
  const now = Date.now();
  database
    .prepare(
      `UPDATE message_jobs SET outbound_status = 'sent', updated_at = ? WHERE id = ?`
    )
    .run(now, id);
}

export function markOutboundFailed(id: string, error: string): void {
  const database = getDb();
  const now = Date.now();
  database
    .prepare(
      `UPDATE message_jobs
       SET outbound_status = 'failed', last_error = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(error.slice(0, 2000), now, id);
}

export function listPendingOutboundReplies(): MessageJob[] {
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT * FROM message_jobs
       WHERE outbound_status = 'pending' AND outbound_reply IS NOT NULL
       ORDER BY created_at ASC`
    )
    .all() as Parameters<typeof rowToJob>[0][];
  return rows.map(rowToJob);
}

/**
 * After a crash: running jobs become pending again so the serial worker can
 * retry inbound processing. Mutating provider actions must still be claim-once
 * at the confirmation layer (#200) — this only re-drives the message handler.
 */
export function recoverInterruptedMessageJobs(): number {
  const database = getDb();
  const now = Date.now();
  const result = database
    .prepare(
      `UPDATE message_jobs
       SET status = 'pending', updated_at = ?,
           last_error = COALESCE(last_error, 'interrupted by restart')
       WHERE status = 'running'`
    )
    .run(now);
  const n = Number(result.changes ?? 0);
  if (n > 0) {
    log.warn({ count: n }, 'Re-queued message jobs interrupted by restart');
  }
  return n;
}

/**
 * Keep the message log bounded (#79). It only serves duplicate detection and
 * debugging, so the most recent `keep` rows are plenty. Runs at startup and daily.
 */
export function pruneMessages(keep = 500): number {
  const db = getDb();
  const result = db
    .prepare(
      `DELETE FROM messages WHERE id NOT IN (
         SELECT id FROM messages ORDER BY timestamp DESC LIMIT ?
       )`
    )
    .run(keep);
  const deleted = Number(result.changes ?? 0);
  if (deleted > 0) {
    log.info({ deleted, keep }, 'Pruned old messages');
  }
  return deleted;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    log.info('Database closed');
  }
}
