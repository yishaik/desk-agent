import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync, chmodSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Settings, ServiceConfig } from './types.ts';
import { DEFAULT_SETTINGS } from './types.ts';
import { config } from './config.ts';
import { createChildLogger } from './logger.ts';

const log = createChildLogger('settings');

const SETTINGS_FILE_MODE = 0o600;

export class SettingsParseError extends Error {
  // Note: no TS parameter properties here — Node's strip-only mode (npm start)
  // cannot run them, and vitest (esbuild) would not notice. See boot.test.ts.
  readonly corruptPath?: string;

  constructor(message: string, corruptPath?: string) {
    super(message);
    this.corruptPath = corruptPath;
    this.name = 'SettingsParseError';
  }
}

let lastSuccessfulLoad: Settings | null = null;
let settingsCache: { settings: Settings; mtimeMs: number } | null = null;

function getSettingsPath(): string {
  return join(config.dataDir, 'settings.json');
}

function ensureDataDir(): void {
  const path = getSettingsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function loadSettings(): Settings {
  const path = getSettingsPath();
  ensureDataDir();

  if (!existsSync(path)) {
    log.debug('No settings file found, using defaults');
    const settings = { ...DEFAULT_SETTINGS };
    if (config.openConnectorToken) {
      settings.sharedConnectorToken = config.openConnectorToken;
    }
    saveSettings(settings);
    lastSuccessfulLoad = settings;
    return settings;
  }

  const stat = statSync(path);
  const currentMtime = stat.mtimeMs;

  if (settingsCache && settingsCache.mtimeMs === currentMtime) {
    return settingsCache.settings;
  }

  try {
    const data = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(data) as Partial<Settings>;
    
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      services: parsed.services ?? DEFAULT_SETTINGS.services,
      projectTokens: parsed.projectTokens ?? DEFAULT_SETTINGS.projectTokens,
    };
    
    // S-12: env OPEN_CONNECTOR_TOKEN wins over a stale copy in settings.json.
    if (
      config.openConnectorToken &&
      settings.sharedConnectorToken !== config.openConnectorToken
    ) {
      settings.sharedConnectorToken = config.openConnectorToken;
      saveSettings(settings);
    }

    log.debug({ setupComplete: settings.setupComplete }, 'Loaded settings');
    lastSuccessfulLoad = settings;
    settingsCache = { settings, mtimeMs: currentMtime };
    return settings;
  } catch (err) {
    const timestamp = Date.now();
    const corruptPath = `${path}.corrupt-${timestamp}`;
    
    try {
      copyFileSync(path, corruptPath);
      log.error({ err, corruptPath }, 'Failed to parse settings, backed up corrupt file');
    } catch (backupErr) {
      log.error({ err, backupErr }, 'Failed to parse settings and backup failed');
    }
    
    if (lastSuccessfulLoad) {
      log.warn('Returning last successfully loaded settings');
      return lastSuccessfulLoad;
    }
    
    throw new SettingsParseError(
      `Settings file is corrupted and no previous valid settings available. Backed up to ${corruptPath}`,
      corruptPath
    );
  }
}

export function saveSettings(settings: Settings): void {
  ensureDataDir();
  const path = getSettingsPath();
  const tempPath = `${path}.tmp`;
  
  settings.updatedAt = new Date().toISOString();
  const content = JSON.stringify(settings, null, 2);
  
  writeFileSync(tempPath, content, { mode: SETTINGS_FILE_MODE });
  
  try {
    chmodSync(tempPath, SETTINGS_FILE_MODE);
  } catch {
  }
  
  renameSync(tempPath, path);
  
  try {
    chmodSync(path, SETTINGS_FILE_MODE);
  } catch {
  }
  
  lastSuccessfulLoad = settings;
  settingsCache = null;
  log.debug('Settings saved atomically');
}

export function clearSettingsCache(): void {
  settingsCache = null;
}

export function updateSettings(updates: Partial<Settings>): Settings {
  const current = loadSettings();
  const updated = { ...current, ...updates };
  saveSettings(updated);
  return updated;
}

export function getActiveConnectorToken(settings: Settings, projectId?: string): string | undefined {
  const targetProject = projectId ?? settings.activeProject;
  
  if (settings.apiKeyMode === 'per-project') {
    const token = settings.projectTokens[targetProject];
    if (token) {
      log.debug({ projectId: targetProject }, 'Using per-project token');
      return token;
    }
    log.debug({ projectId: targetProject }, 'No per-project token, falling back to shared');
  }
  
  log.debug('Using shared connector token');
  return settings.sharedConnectorToken ?? config.openConnectorToken;
}

export function setProjectToken(projectId: string, token: string): Settings {
  const settings = loadSettings();
  settings.projectTokens[projectId] = token;
  saveSettings(settings);
  log.info({ projectId }, 'Set project token');
  return settings;
}

export function removeProjectToken(projectId: string): Settings {
  const settings = loadSettings();
  delete settings.projectTokens[projectId];
  saveSettings(settings);
  log.info({ projectId }, 'Removed project token');
  return settings;
}

export function setApiKeyMode(mode: 'shared' | 'per-project'): Settings {
  const settings = loadSettings();
  settings.apiKeyMode = mode;
  saveSettings(settings);
  log.info({ mode }, 'Set API key mode');
  return settings;
}

export function addService(service: ServiceConfig): Settings {
  const settings = loadSettings();
  const existing = settings.services.findIndex((s) => s.id === service.id);
  if (existing >= 0) {
    settings.services[existing] = service;
  } else {
    settings.services.push(service);
  }
  saveSettings(settings);
  log.info({ serviceId: service.id }, 'Added/updated service');
  return settings;
}

export function removeService(serviceId: string): Settings {
  const settings = loadSettings();
  settings.services = settings.services.filter((s) => s.id !== serviceId);
  saveSettings(settings);
  log.info({ serviceId }, 'Removed service');
  return settings;
}

export function isActionDisabled(serviceId: string, actionId: string): boolean {
  const settings = loadSettings();
  const svc = settings.services.find((s) => s.id === serviceId);
  if (!svc) return false;
  return svc.disabledActions?.includes(actionId) ?? false;
}

export function getService(serviceId: string): ServiceConfig | undefined {
  const settings = loadSettings();
  return settings.services.find((s) => s.id === serviceId);
}

export function setServiceEnabled(serviceId: string, enabled: boolean): Settings {
  const settings = loadSettings();
  const service = settings.services.find((s) => s.id === serviceId);
  if (service) {
    service.enabled = enabled;
    saveSettings(settings);
    log.info({ serviceId, enabled }, 'Set service enabled state');
  }
  return settings;
}

export function isActionEnabled(serviceId: string, actionId: string): boolean {
  const settings = loadSettings();
  const service = settings.services.find((s) => s.id === serviceId);
  if (!service) {
    return true;
  }
  if (service.enabled === false) {
    return false;
  }
  const disabledActions = service.disabledActions || [];
  return !disabledActions.includes(actionId);
}

export function setActionEnabled(serviceId: string, actionId: string, enabled: boolean): Settings {
  const settings = loadSettings();
  let service = settings.services.find((s) => s.id === serviceId);
  
  if (!service) {
    service = {
      id: serviceId,
      name: serviceId,
      enabled: true,
      disabledActions: [],
      connectedAt: new Date().toISOString(),
    };
    settings.services.push(service);
  }
  
  if (!service.disabledActions) {
    service.disabledActions = [];
  }
  
  if (enabled) {
    service.disabledActions = service.disabledActions.filter((a) => a !== actionId);
  } else {
    if (!service.disabledActions.includes(actionId)) {
      service.disabledActions.push(actionId);
    }
  }
  
  saveSettings(settings);
  log.info({ serviceId, actionId, enabled }, 'Set action enabled state');
  return settings;
}

export type ConfirmationMode = 'auto' | 'always' | 'never';

/** Owner/operator override of the confirmation gate for one action ('auto' removes the override). */
export function setActionConfirmation(serviceId: string, actionId: string, mode: ConfirmationMode): Settings {
  const settings = loadSettings();
  let service = settings.services.find((s) => s.id === serviceId);
  if (!service) {
    service = { id: serviceId, name: serviceId, enabled: true, disabledActions: [], connectedAt: new Date().toISOString() };
    settings.services.push(service);
  }
  const overrides: Record<string, 'always' | 'never'> = { ...service.confirmationOverrides };
  if (mode === 'auto') {
    delete overrides[actionId];
  } else {
    overrides[actionId] = mode;
  }
  service.confirmationOverrides = overrides;
  saveSettings(settings);
  log.info({ serviceId, actionId, mode }, 'Set action confirmation mode');
  return settings;
}

export function getActionConfirmationOverride(actionId: string): ConfirmationMode {
  const serviceId = actionId.split('.')[0] ?? '';
  const service = loadSettings().services.find((s) => s.id === serviceId);
  return service?.confirmationOverrides?.[actionId] ?? 'auto';
}

export function markSetupComplete(): Settings {
  const settings = loadSettings();
  settings.setupComplete = true;
  saveSettings(settings);
  log.info('Setup marked complete');
  return settings;
}

export function isSetupRequired(): boolean {
  const settings = loadSettings();
  return !settings.setupComplete;
}

export function acknowledgeAdminToken(): Settings {
  const settings = loadSettings();
  settings.connectorAdminTokenAcknowledged = true;
  saveSettings(settings);
  log.info('Admin token acknowledged');
  return settings;
}

export function isAdminTokenAcknowledged(): boolean {
  const settings = loadSettings();
  return settings.connectorAdminTokenAcknowledged;
}
