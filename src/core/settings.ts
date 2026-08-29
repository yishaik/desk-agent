import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Settings, Project, ServiceConfig } from './types.ts';
import { DEFAULT_SETTINGS } from './types.ts';
import { config } from './config.ts';
import { createChildLogger } from './logger.ts';

const log = createChildLogger('settings');

function getSettingsPath(): string {
  return join(config.dataDir, 'settings.json');
}

function ensureDataDir(): void {
  const path = getSettingsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadSettings(): Settings {
  const path = getSettingsPath();
  ensureDataDir();

  if (!existsSync(path)) {
    log.info('No settings file found, using defaults');
    const settings = { ...DEFAULT_SETTINGS };
    if (config.openConnectorToken) {
      settings.sharedConnectorToken = config.openConnectorToken;
    }
    saveSettings(settings);
    return settings;
  }

  try {
    const data = readFileSync(path, 'utf-8');
    const settings = JSON.parse(data) as Settings;
    log.info({ setupComplete: settings.setupComplete }, 'Loaded settings');
    return settings;
  } catch (err) {
    log.error({ err }, 'Failed to load settings, using defaults');
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  ensureDataDir();
  const path = getSettingsPath();
  settings.updatedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(settings, null, 2));
  log.debug('Settings saved');
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

export function setActionEnabled(serviceId: string, actionId: string, enabled: boolean): Settings {
  const settings = loadSettings();
  let svc = settings.services.find((s) => s.id === serviceId);
  
  if (!svc) {
    svc = { id: serviceId, name: serviceId, enabled: true, disabledActions: [] };
    settings.services.push(svc);
  }
  
  if (!svc.disabledActions) {
    svc.disabledActions = [];
  }
  
  if (enabled) {
    svc.disabledActions = svc.disabledActions.filter((a) => a !== actionId);
  } else {
    if (!svc.disabledActions.includes(actionId)) {
      svc.disabledActions.push(actionId);
    }
  }
  
  saveSettings(settings);
  log.info({ serviceId, actionId, enabled }, 'Set action enabled state');
  return settings;
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
