import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  pairToken: string;
  openConnectorUrl: string;
  openConnectorToken?: string;
  connectorOrigin: string;
  connectorAdminToken?: string;
  modelApiKey?: string;
  modelApiUrl?: string;
  logLevel: string;
  isProduction: boolean;
}

function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function generatePairToken(): string {
  return randomBytes(32).toString('hex');
}

/** Persist a generated PAIR_TOKEN so an empty env var does not mint a new one every boot (S-16). */
function loadOrCreatePairToken(dataDir: string): string {
  const fromEnv = process.env['PAIR_TOKEN'] ?? '';
  if (fromEnv) return fromEnv;

  const tokenPath = join(dataDir, '.pair-token');
  try {
    const existing = readFileSync(tokenPath, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // first boot
  }

  const generated = generatePairToken();
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, generated, { mode: 0o600 });
    console.error(`[config] Generated PAIR_TOKEN and saved to ${tokenPath}`);
    console.error('[config] Set PAIR_TOKEN in .env for production; this file is not a substitute.');
  } catch (err) {
    console.error('[config] Generated PAIR_TOKEN but failed to persist it:', err);
    console.error(`[config] PAIR_TOKEN=${generated}`);
  }
  return generated;
}

export function loadConfig(): Config {
  const isProduction = process.env['NODE_ENV'] === 'production';
  // Absolute: it becomes HOME/CLAUDE_CONFIG_DIR of child processes that run with another cwd.
  const dataDir = resolve(getEnvOrDefault('DATA_DIR', './data'));
  
  const pairToken = loadOrCreatePairToken(dataDir);

  const openConnectorUrl = getEnvOrDefault('OPEN_CONNECTOR_URL', 'http://localhost:3000');
  
  return {
    port: parseInt(getEnvOrDefault('PORT', '3001'), 10),
    host: getEnvOrDefault('HOST', isProduction ? '0.0.0.0' : '127.0.0.1'),
    dataDir,
    pairToken,
    openConnectorUrl,
    openConnectorToken: process.env['OPEN_CONNECTOR_TOKEN'],
    connectorOrigin: getEnvOrDefault('CONNECTOR_ORIGIN', openConnectorUrl),
    connectorAdminToken: process.env['CONNECTOR_ADMIN_TOKEN'],
    modelApiKey: process.env['MODEL_API_KEY'],
    modelApiUrl: process.env['MODEL_API_URL'],
    logLevel: getEnvOrDefault('LOG_LEVEL', 'info'),
    isProduction,
  };
}

export const config = loadConfig();
