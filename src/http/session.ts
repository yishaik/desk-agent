import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from '../core/config.ts';
import { createChildLogger } from '../core/logger.ts';

const log = createChildLogger('session');

const SESSION_FILE_MODE = 0o600;
const SESSION_TOKEN_BYTES = 32;
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface SessionData {
  id: string;
  createdAt: number;
  expiresAt: number;
}

interface SessionStore {
  sessions: Record<string, SessionData>;
  revokedIds: string[];
}

let sessionStore: SessionStore | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function getSessionPath(): string {
  return join(config.dataDir, 'sessions.json');
}

function ensureDataDir(): void {
  const path = getSessionPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function loadSessionStore(): SessionStore {
  if (sessionStore) {
    return sessionStore;
  }

  const path = getSessionPath();
  ensureDataDir();

  if (!existsSync(path)) {
    sessionStore = { sessions: {}, revokedIds: [] };
    return sessionStore;
  }

  try {
    const data = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(data) as SessionStore;
    sessionStore = {
      sessions: parsed.sessions ?? {},
      revokedIds: parsed.revokedIds ?? [],
    };
    return sessionStore;
  } catch (err) {
    log.error({ err }, 'Failed to load sessions, starting fresh');
    sessionStore = { sessions: {}, revokedIds: [] };
    return sessionStore;
  }
}

function saveSessionStore(): void {
  if (!sessionStore) return;

  ensureDataDir();
  const path = getSessionPath();
  const tempPath = `${path}.tmp`;

  const content = JSON.stringify(sessionStore, null, 2);
  writeFileSync(tempPath, content, { mode: SESSION_FILE_MODE });

  try {
    chmodSync(tempPath, SESSION_FILE_MODE);
  } catch {
    // Ignore chmod errors
  }

  renameSync(tempPath, path);

  try {
    chmodSync(path, SESSION_FILE_MODE);
  } catch {
    // Ignore chmod errors
  }
}

function generateSessionId(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('hex');
}

function signSessionId(sessionId: string): string {
  const hmac = createHmac('sha256', config.pairToken);
  hmac.update(sessionId);
  return hmac.digest('hex');
}

function verifySessionSignature(sessionId: string, signature: string): boolean {
  const expectedSignature = signSessionId(sessionId);

  const sigBuf = Buffer.from(signature, 'hex');
  const expectedBuf = Buffer.from(expectedSignature, 'hex');

  if (sigBuf.length !== expectedBuf.length) {
    return false;
  }

  return timingSafeEqual(sigBuf, expectedBuf);
}

export function createSession(): string {
  const store = loadSessionStore();
  const sessionId = generateSessionId();
  const signature = signSessionId(sessionId);
  const now = Date.now();

  const sessionData: SessionData = {
    id: sessionId,
    createdAt: now,
    expiresAt: now + SESSION_MAX_AGE_MS,
  };

  store.sessions[sessionId] = sessionData;
  saveSessionStore();

  log.debug({ sessionId: sessionId.slice(0, 8) + '...' }, 'Created new session');

  return `${sessionId}.${signature}`;
}

export function validateSession(sessionToken: string | undefined): boolean {
  if (!sessionToken || typeof sessionToken !== 'string') {
    return false;
  }

  const parts = sessionToken.split('.');
  if (parts.length !== 2) {
    return false;
  }

  const [sessionId, signature] = parts;
  if (!sessionId || !signature) {
    return false;
  }

  if (!verifySessionSignature(sessionId, signature)) {
    return false;
  }

  const store = loadSessionStore();

  if (store.revokedIds.includes(sessionId)) {
    return false;
  }

  const session = store.sessions[sessionId];
  if (!session) {
    return false;
  }

  if (Date.now() > session.expiresAt) {
    delete store.sessions[sessionId];
    saveSessionStore();
    return false;
  }

  return true;
}

export function revokeSession(sessionToken: string | undefined): boolean {
  if (!sessionToken || typeof sessionToken !== 'string') {
    return false;
  }

  const parts = sessionToken.split('.');
  if (parts.length !== 2) {
    return false;
  }

  const [sessionId] = parts;
  if (!sessionId) {
    return false;
  }

  const store = loadSessionStore();

  delete store.sessions[sessionId];

  if (!store.revokedIds.includes(sessionId)) {
    store.revokedIds.push(sessionId);
    if (store.revokedIds.length > 10000) {
      store.revokedIds = store.revokedIds.slice(-5000);
    }
  }

  saveSessionStore();
  log.debug({ sessionId: sessionId.slice(0, 8) + '...' }, 'Revoked session');

  return true;
}

export function revokeAllSessions(): void {
  const store = loadSessionStore();

  for (const sessionId of Object.keys(store.sessions)) {
    if (!store.revokedIds.includes(sessionId)) {
      store.revokedIds.push(sessionId);
    }
  }

  store.sessions = {};

  if (store.revokedIds.length > 10000) {
    store.revokedIds = store.revokedIds.slice(-5000);
  }

  saveSessionStore();
  log.info('Revoked all sessions');
}

function cleanupExpiredSessions(): void {
  const store = loadSessionStore();
  const now = Date.now();
  let cleaned = 0;

  for (const [sessionId, session] of Object.entries(store.sessions)) {
    if (now > session.expiresAt) {
      delete store.sessions[sessionId];
      cleaned++;
    }
  }

  const cutoffTime = now - (7 * 24 * 60 * 60 * 1000);
  const oldRevokedCount = store.revokedIds.length;
  store.revokedIds = store.revokedIds.slice(-5000);
  const removedRevoked = oldRevokedCount - store.revokedIds.length;

  if (cleaned > 0 || removedRevoked > 0) {
    saveSessionStore();
    log.debug({ cleaned, removedRevoked }, 'Cleaned up sessions');
  }
}

export function startSessionCleanup(): void {
  if (cleanupTimer) return;

  cleanupExpiredSessions();

  cleanupTimer = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

export function stopSessionCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

export function clearSessionCache(): void {
  sessionStore = null;
}

export const SESSION_COOKIE_NAME = 'DESK_SESSION';
export const SESSION_MAX_AGE_SECONDS = Math.floor(SESSION_MAX_AGE_MS / 1000);
