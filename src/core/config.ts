import { randomBytes } from 'node:crypto';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  pairToken: string;
  openConnectorUrl: string;
  openConnectorToken?: string;
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

export function loadConfig(): Config {
  const isProduction = process.env['NODE_ENV'] === 'production';
  const dataDir = getEnvOrDefault('DATA_DIR', './data');
  
  let pairToken = process.env['PAIR_TOKEN'] ?? '';
  if (!pairToken) {
    pairToken = generatePairToken();
    console.log(`[config] Generated PAIR_TOKEN: ${pairToken}`);
    console.log('[config] Save this token for future use or set PAIR_TOKEN env var');
  }

  return {
    port: parseInt(getEnvOrDefault('PORT', '3001'), 10),
    host: getEnvOrDefault('HOST', isProduction ? '0.0.0.0' : '127.0.0.1'),
    dataDir,
    pairToken,
    openConnectorUrl: getEnvOrDefault('OPEN_CONNECTOR_URL', 'http://localhost:3000'),
    openConnectorToken: process.env['OPEN_CONNECTOR_TOKEN'],
    modelApiKey: process.env['MODEL_API_KEY'],
    modelApiUrl: process.env['MODEL_API_URL'],
    logLevel: getEnvOrDefault('LOG_LEVEL', 'info'),
    isProduction,
  };
}

export const config = loadConfig();
