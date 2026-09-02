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

export function saveMessage(message: Message): void {
  const database = getDb();
  const projectId = message.projectId ?? 'default';

  database
    .prepare(
      `INSERT INTO messages (id, project_id, from_jid, to_jid, body, timestamp, is_from_me)
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
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    log.info('Database closed');
  }
}
