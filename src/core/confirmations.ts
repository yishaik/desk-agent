import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.ts';
import { createChildLogger } from './logger.ts';

const log = createChildLogger('confirmations');

// File-backed so the WhatsApp handler (agent process) and the connector MCP
// server (a Claude Code subprocess) share one pending-confirmation store.
const STORE_PATH = join(config.dataDir, 'pending-confirmations.json');
const MAX_AGE_MS = 10 * 60 * 1000;

export interface PendingConfirmation {
  actionId: string;
  input: Record<string, unknown>;
  connectionName?: string;
  createdAt: number;
}

type Store = Record<string, PendingConfirmation>;

function load(): Store {
  try {
    return JSON.parse(readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function save(store: Store): void {
  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(store), { mode: 0o600 });
  } catch (err) {
    log.error({ err }, 'Failed to persist pending confirmations');
  }
}

const MUTATING_ACTION_PATTERNS = [
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

export function requiresConfirmation(actionId: string): boolean {
  return MUTATING_ACTION_PATTERNS.some((pattern) => pattern.test(actionId));
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

export function cleanupOldConfirmations(): void {
  const store = load();
  const now = Date.now();
  let changed = false;
  for (const [id, pending] of Object.entries(store)) {
    if (now - pending.createdAt > MAX_AGE_MS) {
      delete store[id];
      changed = true;
    }
  }
  if (changed) save(store);
}
