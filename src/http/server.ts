import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { parse as parseUrl } from 'node:url';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { config } from '../core/config.ts';
import { createChildLogger } from '../core/logger.ts';
import {
  loadSettings,
  updateSettings,
  setProjectToken,
  removeProjectToken,
  markSetupComplete,
  isSetupRequired,
  addService,
  removeService,
  setActionEnabled,
  setActionConfirmation,
  getActionConfirmationOverride,
} from '../core/settings.ts';
import { requiresConfirmation } from '../core/confirmations.ts';
import { listSkillPacks, isKnownSkillPack, DEFAULT_SKILL_PACKS } from '../core/skills.ts';
import { listProjects, createProject, getProject } from '../core/memory.ts';
import { slugifyProjectName, validateProjectId, ProjectIdValidationError } from '../core/projects.ts';
import { validateServiceId, ServiceIdValidationError } from '../open-connector/client.ts';
import { getWhatsAppClient } from '../whatsapp/client.ts';
import { createClient, isRealConnection } from '../open-connector/client.ts';
import { 
  startLogin, 
  completeLogin, 
  getLoginStatusAsync, 
  listProviders, 
  logout,
  listRuntimeCredentials,
  resolveActiveModel,
} from './auth.ts';
import { writeIdentityFiles } from '../core/identity-files.ts';
import { recreateSessionAfterCredentialChange } from '../agent/session.ts';
import { getSettingsHtml, type SettingsPageData } from './settings-page.ts';
import { getThemeCss } from './theme.ts';
import { escapeHtml } from './html.ts';

const log = createChildLogger('http');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

const routes: Route[] = [];

function addRoute(method: string, path: string, handler: RouteHandler): void {
  const paramNames: string[] = [];
  const pattern = path.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  routes.push({
    method,
    pattern: new RegExp(`^${pattern}$`),
    paramNames,
    handler,
  });
}

function matchRoute(
  method: string,
  path: string
): { handler: RouteHandler; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = path.match(route.pattern);
    if (match) {
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = match[i + 1] ?? '';
      });
      return { handler: route.handler, params };
    }
  }
  return null;
}

function timingSafeTokenCompare(provided: string | undefined, expected: string): boolean {
  if (!provided || typeof provided !== 'string') {
    return false;
  }
  
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  
  return timingSafeEqual(providedBuf, expectedBuf);
}

function isAuthenticated(req: IncomingMessage): boolean {
  const url = parseUrl(req.url ?? '', true);
  const queryToken = url.query['token'] as string | undefined;
  
  const cookies = req.headers.cookie ?? '';
  const cookieToken = cookies
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([key]) => key === 'PAIR_TOKEN')?.[1];

  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : undefined;

  const token = queryToken ?? cookieToken ?? bearerToken;
  return timingSafeTokenCompare(token, config.pairToken);
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendHtml(res: ServerResponse, html: string, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendError(res: ServerResponse, message: string, status = 400): void {
  sendJson(res, { success: false, error: message }, status);
}

function redirect(res: ServerResponse, url: string): void {
  res.writeHead(302, { Location: url });
  res.end();
}

const MAX_BODY_SIZE = 64 * 1024;

class BodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
    this.name = 'BodyTooLargeError';
  }
}

async function parseBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    
    req.on('data', (chunk: Buffer | string) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      body += chunk;
    });
    
    req.on('end', () => {
      try {
        resolve(JSON.parse(body) as T);
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

addRoute('GET', '/health', async (req, res) => {
  const wa = getWhatsAppClient();
  const connector = createClient();
  const connectorHealth = await connector.checkHealth().catch(() => false);

  sendJson(res, {
    status: 'ok',
    whatsapp: wa.isConnected() ? 'connected' : 'disconnected',
    connector: connectorHealth ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
  });
});

const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

addRoute('GET', '/', async (req, res) => {
  if (!isAuthenticated(req)) {
    const loginHtml = getLoginHtml();
    sendHtml(res, loginHtml);
    return;
  }

  const url = parseUrl(req.url ?? '', true);
  const queryToken = url.query['token'] as string | undefined;
  
  if (queryToken && timingSafeTokenCompare(queryToken, config.pairToken)) {
    const isHttps = req.headers['x-forwarded-proto'] === 'https' ||
                    req.headers.host?.startsWith('https') ||
                    config.isProduction;
    const securePart = isHttps ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `PAIR_TOKEN=${config.pairToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}${securePart}`
    );
    redirect(res, '/');
    return;
  }

  const settings = loadSettings();
  const wa = getWhatsAppClient();
  const pairingState = wa.getPairingState();

  if (isSetupRequired() || !pairingState.isPaired) {
    const providers = await listProviders();
    const hasAiProvider = providers.some(p => p.isConnected);
    const wizardHtml = getWizardHtml(settings, pairingState, hasAiProvider);
    sendHtml(res, wizardHtml);
    return;
  }

  const dashboardHtml = getDashboardHtml(settings, pairingState);
  sendHtml(res, dashboardHtml);
});

addRoute('GET', '/settings', async (req, res) => {
  if (!isAuthenticated(req)) {
    redirect(res, '/');
    return;
  }

  const settings = loadSettings();
  
  if (!settings.setupComplete) {
    redirect(res, '/');
    return;
  }

  const wa = getWhatsAppClient();
  const pairingState = wa.getPairingState();
  const connector = createClient(settings.activeProject);

  let consoleUrl: string;
  try {
    consoleUrl = getConsoleUrl();
  } catch {
    consoleUrl = '';
  }

  let connectorStatus = {
    healthy: false,
    connectionCount: 0,
    consoleUrl,
  };

  try {
    const healthy = await connector.checkHealth();
    if (healthy) {
      const connections = await connector.listConnections();
      connectorStatus = {
        healthy: true,
        connectionCount: connections.length,
        consoleUrl,
      };
    }
  } catch {
    // Keep defaults
  }

  const pageData: SettingsPageData = {
    settings,
    pairingState,
    connectorStatus,
  };

  const html = getSettingsHtml(pageData);
  sendHtml(res, html);
});

addRoute('GET', '/api/auth/session', async (req, res) => {
  const cookies = req.headers.cookie ?? '';
  const cookieToken = cookies
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([key]) => key === 'PAIR_TOKEN')?.[1];

  if (timingSafeTokenCompare(cookieToken, config.pairToken)) {
    res.writeHead(200);
    res.end();
  } else {
    sendError(res, 'Unauthorized', 401);
  }
});

addRoute('GET', '/api/auth/providers', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  try {
    const providers = await listProviders();
    sendJson(res, { success: true, data: providers });
  } catch (err) {
    log.error({ err }, 'Failed to list providers');
    sendError(res, 'Failed to list providers', 500);
  }
});

addRoute('POST', '/api/auth/login', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const body = await parseBody<{ provider: string }>(req);
  if (!body.provider) {
    sendError(res, 'Provider is required');
    return;
  }

  try {
    const result = await startLogin(body.provider);
    if (result.error) {
      sendError(res, result.error);
    } else {
      sendJson(res, { success: true, authorizeUrl: result.authorizeUrl });
    }
  } catch (err) {
    log.error({ err }, 'Login error');
    sendError(res, 'Login failed', 500);
  }
});

addRoute('GET', '/api/auth/login/:provider/status', async (req, res, params) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const provider = params.provider;
  if (!provider) {
    sendError(res, 'Provider is required');
    return;
  }

  try {
    const status = await getLoginStatusAsync(provider);
    
    // On success, persist the model and recreate session
    if (status.status === 'success') {
      const settings = loadSettings();
      const defaultModel = provider === 'claude-code' 
        ? 'claude-code/default' 
        : provider === 'openai-codex'
          ? 'openai-codex/gpt-5.3-codex'
          : settings.model;
      
      if (settings.model !== defaultModel) {
        updateSettings({ model: defaultModel });
      }
      
      const { recreateSessionAfterCredentialChange } = await import('../agent/session.ts');
      await recreateSessionAfterCredentialChange(settings.activeProject, { credentialsChanged: true });
    }
    
    sendJson(res, { success: true, data: status });
  } catch (err) {
    log.error({ err }, 'Login status error');
    sendError(res, 'Failed to get login status', 500);
  }
});

addRoute('POST', '/api/auth/complete', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const body = await parseBody<{ provider: string; codeOrRedirectUrl: string }>(req);
  if (!body.provider || !body.codeOrRedirectUrl) {
    sendError(res, 'Provider and codeOrRedirectUrl are required');
    return;
  }

  try {
    const result = await completeLogin(body.provider, body.codeOrRedirectUrl);
    if (result.success) {
      // On successful login, persist the model and recreate session
      const settings = loadSettings();
      const defaultModel = body.provider === 'claude-code' 
        ? 'claude-code/default' 
        : body.provider === 'openai-codex'
          ? 'openai-codex/gpt-5.3-codex'
          : settings.model;
      
      if (settings.model !== defaultModel) {
        updateSettings({ model: defaultModel });
      }
      
      const { recreateSessionAfterCredentialChange } = await import('../agent/session.ts');
      await recreateSessionAfterCredentialChange(settings.activeProject, { credentialsChanged: true });
      
      sendJson(res, { success: true });
    } else {
      sendError(res, result.error || 'Failed to complete login');
    }
  } catch (err) {
    log.error({ err }, 'Complete login error');
    sendError(res, 'Failed to complete login', 500);
  }
});

addRoute('POST', '/api/auth/logout', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const body = await parseBody<{ provider: string }>(req);
  if (!body.provider) {
    sendError(res, 'Provider is required');
    return;
  }

  try {
    const result = await logout(body.provider);
    if (result.success) {
      sendJson(res, { success: true });
    } else {
      sendError(res, result.error || 'Failed to logout');
    }
  } catch (err) {
    log.error({ err }, 'Logout error');
    sendError(res, 'Failed to logout', 500);
  }
});

addRoute('GET', '/api/ai/status', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  try {
    const settings = loadSettings();
    const credentials = await listRuntimeCredentials();
    const modelResolution = await resolveActiveModel(settings.model);

    sendJson(res, {
      success: true,
      data: {
        currentModel: settings.model,
        resolvedModel: modelResolution.modelId,
        resolvedModelId: modelResolution.model?.id,
        providerId: modelResolution.providerId,
        valid: modelResolution.valid,
        error: modelResolution.error,
        connectedProviders: credentials.map(c => ({
          providerId: c.providerId,
          type: c.type,
        })),
      },
    });
  } catch (err) {
    log.error({ err }, 'Failed to get AI status');
    sendError(res, 'Failed to get AI status', 500);
  }
});

addRoute('POST', '/api/ai/sync-model', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  try {
    const settings = loadSettings();
    const modelResolution = await resolveActiveModel(settings.model);
    
    if (!modelResolution.model) {
      sendError(res, modelResolution.error || 'No AI provider connected', 400);
      return;
    }
    
    const wasAdjusted = !modelResolution.valid;
    
    if (wasAdjusted) {
      updateSettings({ model: modelResolution.modelId });
      const { recreateSessionAfterCredentialChange } = await import('../agent/session.ts');
      await recreateSessionAfterCredentialChange(settings.activeProject);
    }

    sendJson(res, {
      success: true,
      data: {
        model: modelResolution.modelId,
        modelId: modelResolution.model.id,
        providerId: modelResolution.providerId,
        wasAdjusted,
      },
    });
  } catch (err) {
    log.error({ err }, 'Failed to sync model with credentials');
    sendError(res, err instanceof Error ? err.message : 'Failed to sync model', 500);
  }
});

addRoute('POST', '/auth', async (req, res) => {
  let body: { token?: string };
  try {
    body = await parseBody<{ token?: string }>(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendError(res, 'Request body too large', 413);
      return;
    }
    body = { token: undefined };
  }
  
  const token = body.token;

  if (timingSafeTokenCompare(token, config.pairToken)) {
    const isHttps = req.headers['x-forwarded-proto'] === 'https' || 
                    req.headers.host?.startsWith('https') ||
                    config.isProduction;
    const securePart = isHttps ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `PAIR_TOKEN=${config.pairToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}${securePart}`
    );
    sendJson(res, { success: true });
  } else {
    sendError(res, 'Invalid token', 401);
  }
});

addRoute('POST', '/logout', async (req, res) => {
  const isHttps = req.headers['x-forwarded-proto'] === 'https' || 
                  req.headers.host?.startsWith('https') ||
                  config.isProduction;
  const securePart = isHttps ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `PAIR_TOKEN=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${securePart}`
  );
  sendJson(res, { success: true });
});

addRoute('GET', '/api/skills', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }
  const selected = new Set(loadSettings().skillPacks ?? DEFAULT_SKILL_PACKS);
  sendJson(res, {
    success: true,
    data: listSkillPacks().map((p) => ({ id: p.id, name: p.name, description: p.description, enabled: selected.has(p.id) })),
  });
});

addRoute('GET', '/api/pairing', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const wa = getWhatsAppClient();
  const state = wa.getPairingState();
  let qrDataUrl: string | undefined;
  if (!state.isPaired && state.qrCode) {
    qrDataUrl = await QRCode.toDataURL(state.qrCode, { width: 280, margin: 1 });
  }
  sendJson(res, { success: true, data: { ...state, qrDataUrl } });
});

function redactSettings(settings: ReturnType<typeof loadSettings>): ReturnType<typeof loadSettings> {
  return {
    ...settings,
    sharedConnectorToken: settings.sharedConnectorToken ? '***' : undefined,
    projectTokens: Object.fromEntries(
      Object.entries(settings.projectTokens).map(([k, v]) => [k, v ? '***' : ''])
    ),
  };
}

addRoute('GET', '/api/settings', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const settings = loadSettings();
  sendJson(res, { success: true, data: redactSettings(settings) });
});

addRoute('PUT', '/api/settings', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const body = await parseBody<Partial<{
    botName: string;
    ownerName: string;
    businessName: string;
    businessDescription: string;
    agentVoice: string;
    agentBoundaries: string;
    timezone: string;
    model: string;
    apiKeyMode: 'shared' | 'per-project';
    skillPacks: string[];
  }>>(req);

  if (body.skillPacks !== undefined) {
    if (!Array.isArray(body.skillPacks) || !body.skillPacks.every((id) => typeof id === 'string' && isKnownSkillPack(id))) {
      sendError(res, 'skillPacks חייב להיות רשימה של חבילות סקילים קיימות', 400);
      return;
    }
  }

  const stringFields: Array<keyof typeof body> = [
    'botName', 'ownerName', 'businessName', 'businessDescription',
    'agentVoice', 'agentBoundaries', 'timezone', 'model',
  ];
  for (const field of stringFields) {
    const value = body[field];
    if (value !== undefined && typeof value === 'string' && value.length > 2000) {
      sendError(res, `השדה ${field} ארוך מדי (מקסימום 2000 תווים)`, 400);
      return;
    }
  }

  if (body.timezone !== undefined) {
    try {
      const validTimezones = Intl.supportedValuesOf('timeZone');
      if (!validTimezones.includes(body.timezone)) {
        sendError(res, `אזור זמן לא תקין: ${body.timezone}`, 400);
        return;
      }
    } catch {
      sendError(res, `אזור זמן לא תקין: ${body.timezone}`, 400);
      return;
    }
  }

  if (body.apiKeyMode !== undefined && body.apiKeyMode !== 'shared' && body.apiKeyMode !== 'per-project') {
    sendError(res, `ערך apiKeyMode לא תקין`, 400);
    return;
  }

  if (body.model !== undefined && !/^[a-z0-9./_-]+$/i.test(body.model)) {
    sendError(res, `שם מודל לא תקין`, 400);
    return;
  }

  const previousSettings = loadSettings();

  const updates: Partial<typeof body> = {};
  if (body.botName !== undefined) updates.botName = body.botName;
  if (body.ownerName !== undefined) updates.ownerName = body.ownerName;
  if (body.businessName !== undefined) updates.businessName = body.businessName;
  if (body.businessDescription !== undefined) updates.businessDescription = body.businessDescription;
  if (body.agentVoice !== undefined) updates.agentVoice = body.agentVoice;
  if (body.agentBoundaries !== undefined) updates.agentBoundaries = body.agentBoundaries;
  if (body.timezone !== undefined) updates.timezone = body.timezone;
  if (body.model !== undefined) updates.model = body.model;
  if (body.apiKeyMode !== undefined) updates.apiKeyMode = body.apiKeyMode;
  if (body.skillPacks !== undefined) updates.skillPacks = Array.from(new Set(body.skillPacks));

  const settings = updateSettings(updates);
  
  writeIdentityFiles(settings);

  const identityFields = ['botName', 'ownerName', 'businessName', 'businessDescription', 'agentVoice', 'agentBoundaries', 'timezone'] as const;
  const identityChanged = identityFields.some(
    (field) => body[field] !== undefined && body[field] !== previousSettings[field]
  );
  const modelChanged = body.model !== undefined && body.model !== previousSettings.model;

  let sessionRecreated = false;
  const skillsChanged =
    body.skillPacks !== undefined &&
    JSON.stringify([...body.skillPacks].sort()) !== JSON.stringify([...(previousSettings.skillPacks ?? DEFAULT_SKILL_PACKS)].sort());

  if (modelChanged || identityChanged || skillsChanged) {
    try {
      await recreateSessionAfterCredentialChange(settings.activeProject);
      sessionRecreated = true;
      log.info(
        { modelChanged, identityChanged, projectId: settings.activeProject },
        'Session recreated after settings change'
      );
    } catch (err) {
      log.error({ err }, 'Failed to recreate session after settings change');
    }
  }

  sendJson(res, { 
    success: true, 
    data: redactSettings(settings),
    applied: sessionRecreated,
  });
});

addRoute('GET', '/api/projects', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const projects = listProjects();
  const settings = loadSettings();
  
  const data = projects.map((p) => ({
    ...p,
    isActive: p.id === settings.activeProject,
    hasToken: !!settings.projectTokens[p.id],
  }));

  sendJson(res, { success: true, data });
});

addRoute('POST', '/api/projects', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const body = await parseBody<{ name: string; description?: string }>(req);
  if (!body.name) {
    sendError(res, 'Name is required');
    return;
  }

  let id: string;
  try {
    id = slugifyProjectName(body.name);
  } catch (err) {
    if (err instanceof ProjectIdValidationError) {
      sendError(res, err.message);
      return;
    }
    throw err;
  }

  const existing = getProject(id);
  if (existing) {
    sendJson(res, { success: false, error: 'Project with this ID already exists' }, 409);
    return;
  }

  const project = createProject({ id, name: body.name, description: body.description });
  sendJson(res, { success: true, data: project });
});

addRoute('PUT', '/api/projects/:id/token', async (req, res, _params) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const rawProjectId = req.url?.split('/')[3] ?? '';
  
  let projectId: string;
  try {
    projectId = validateProjectId(decodeURIComponent(rawProjectId));
  } catch (err) {
    if (err instanceof ProjectIdValidationError) {
      sendError(res, err.message);
      return;
    }
    throw err;
  }

  const body = await parseBody<{ token?: string }>(req);

  if (body.token) {
    setProjectToken(projectId, body.token);
  } else {
    removeProjectToken(projectId);
  }

  sendJson(res, { success: true });
});

addRoute('PUT', '/api/projects/:id/activate', async (req, res, _params) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const rawProjectId = req.url?.split('/')[3] ?? '';
  
  let projectId: string;
  try {
    projectId = validateProjectId(decodeURIComponent(rawProjectId));
  } catch (err) {
    if (err instanceof ProjectIdValidationError) {
      sendError(res, err.message);
      return;
    }
    throw err;
  }
  
  const project = getProject(projectId);
  
  if (!project) {
    sendError(res, 'Project not found', 404);
    return;
  }

  updateSettings({ activeProject: projectId });
  sendJson(res, { success: true });
});

addRoute('POST', '/api/setup/complete', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const settings = loadSettings();
  const connector = createClient(settings.activeProject);

  const healthy = await connector.checkHealth().catch(() => false);
  if (!healthy) {
    sendError(res, 'Open Connector לא זמין. ודא שהשירות פועל ונסה שוב.', 400);
    return;
  }

  markSetupComplete();
  sendJson(res, { success: true });
});

export function getConsoleUrl(): string {
  // The Open Connector console owns its own host (CONSOLE_DOMAIN in the Caddyfile):
  // its SPA uses absolute paths and a router without basename, so a sub-path
  // on the agent's origin cannot serve it (#72). Never hand out the docker-internal
  // http://connector:3000 — the customer's browser cannot reach it.
  const explicit = process.env['CONSOLE_URL']?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const domain = process.env['DOMAIN']?.trim();
  if (domain && domain !== 'localhost') return `https://console.${domain}`;
  if (config.isProduction) {
    throw new Error('CONSOLE_URL or DOMAIN must be set in production');
  }
  return 'http://console.localhost';
}

addRoute('GET', '/api/connector/status', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const settings = loadSettings();
  const connector = createClient(settings.activeProject);

  try {
    const healthy = await connector.checkHealth();
    const connections = healthy ? await connector.listConnections() : [];
    const realConnections = connections.filter(isRealConnection);
    sendJson(res, {
      success: true,
      data: {
        healthy,
        url: config.openConnectorUrl,
        consoleUrl: getConsoleUrl(),
        connectionCount: realConnections.length,
      },
    });
  } catch {
    sendJson(res, {
      success: true,
      data: {
        healthy: false,
        url: config.openConnectorUrl,
        consoleUrl: getConsoleUrl(),
        connectionCount: 0,
      },
    });
  }
});

addRoute('GET', '/api/connector/onboarding', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const settings = loadSettings();
  const connector = createClient(settings.activeProject);

  let healthy = false;
  let connectionCount = 0;

  try {
    healthy = await connector.checkHealth();
    if (healthy) {
      const connections = await connector.listConnections();
      const realConnections = connections.filter(isRealConnection);
      connectionCount = realConnections.length;
    }
  } catch {
    healthy = false;
  }

  const consoleUrl = getConsoleUrl();
  const hasAdminToken = !!config.connectorAdminToken;
  const acknowledged = settings.connectorAdminTokenAcknowledged;

  const data: {
    healthy: boolean;
    consoleUrl: string;
    connectionCount: number;
    adminToken?: string;
    requiresAck: boolean;
  } = {
    healthy,
    consoleUrl,
    connectionCount,
    requiresAck: hasAdminToken && !acknowledged,
  };

  if (hasAdminToken && !acknowledged) {
    data.adminToken = config.connectorAdminToken;
  }

  sendJson(res, { success: true, data });
});

addRoute('POST', '/api/connector/ack-admin-token', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  updateSettings({ connectorAdminTokenAcknowledged: true });
  sendJson(res, { success: true });
});

interface ServiceInfo {
  id: string;
  name: string;
  description?: string;
  authTypes: string[];
  isConnected: boolean;
  identity?: string;
}

const DEFAULT_CONNECT_SERVICES = new Set(['gmail', 'googlecalendar']);

addRoute('GET', '/api/connector/services', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const settings = loadSettings();
  const connector = createClient(settings.activeProject);

  try {
    const [providers, connections] = await Promise.all([
      connector.listProviders(),
      connector.listConnections(),
    ]);

    const realConnections = connections.filter(isRealConnection);
    const connectionMap = new Map(realConnections.map((c) => [c.service, c]));

    const filteredProviders = providers.filter((p) => DEFAULT_CONNECT_SERVICES.has(p.id));

    const data: ServiceInfo[] = filteredProviders.map((p) => {
      const conn = connectionMap.get(p.id);
      return {
        id: p.id,
        name: p.displayName,
        description: p.description,
        authTypes: p.authTypes,
        isConnected: !!conn,
        identity: conn?.identity?.label ?? conn?.identity?.email,
      };
    });

    sendJson(res, { success: true, data });
  } catch (err) {
    log.error({ err }, 'Failed to fetch connector services');
    sendError(res, 'Failed to fetch services', 500);
  }
});

interface ToolInfo {
  id: string;
  hebrewName: string;
  hebrewDescription: string;
  icon: string;
  serviceId: string;
  identity?: string;
  enabled: boolean;
}

const SERVICE_HEBREW_OVERLAY: Record<string, { name: string; description: string; icon: string }> = {
  gmail: {
    name: 'Gmail',
    description: 'קריאת ושליחת מיילים',
    icon: '📧',
  },
  googlecalendar: {
    name: 'יומן',
    description: 'ניהול אירועים ופגישות',
    icon: '📅',
  },
  slack: {
    name: 'Slack',
    description: 'הודעות וערוצים',
    icon: '💬',
  },
  notion: {
    name: 'Notion',
    description: 'מסמכים ומאגרי מידע',
    icon: '📝',
  },
  github: {
    name: 'GitHub',
    description: 'ניהול קוד ופרויקטים',
    icon: '🐙',
  },
  linear: {
    name: 'Linear',
    description: 'ניהול משימות',
    icon: '📋',
  },
};

function getDefaultIcon(): string {
  return '🔌';
}

addRoute('GET', '/api/connector/tools', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const settings = loadSettings();
  const connector = createClient(settings.activeProject);
  const serviceConfigMap = new Map(settings.services.map((s) => [s.id, s]));

  try {
    const connections = await connector.listConnections();
    const realConnections = connections.filter(isRealConnection);
    
    const tools: ToolInfo[] = realConnections.map((conn) => {
      const serviceId = conn.service;
      const overlay = SERVICE_HEBREW_OVERLAY[serviceId];
      const serviceConfig = serviceConfigMap.get(serviceId);
      
      return {
        id: serviceId,
        hebrewName: overlay?.name ?? serviceId,
        hebrewDescription: overlay?.description ?? '',
        icon: overlay?.icon ?? getDefaultIcon(),
        serviceId,
        identity: conn.identity?.label ?? conn.identity?.email,
        enabled: serviceConfig?.enabled ?? true,
      };
    });

    sendJson(res, { success: true, data: tools });
  } catch (err) {
    log.error({ err }, 'Failed to fetch tools');
    sendError(res, 'Failed to fetch tools', 500);
  }
});

addRoute('PATCH', '/api/connector/tools/:service/enabled', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const url = parseUrl(req.url ?? '', true);
  const pathParts = (url.pathname ?? '').split('/');
  const service = pathParts[4];

  if (!service) {
    sendError(res, 'Service ID required', 400);
    return;
  }

  let body: { enabled?: boolean };
  try {
    body = await parseBody<{ enabled?: boolean }>(req);
  } catch {
    sendError(res, 'Invalid JSON body', 400);
    return;
  }

  if (typeof body.enabled !== 'boolean') {
    sendError(res, 'enabled (boolean) is required', 400);
    return;
  }

  const settings = loadSettings();
  const connector = createClient(settings.activeProject);

  try {
    const connections = await connector.listConnections();
    const realConnection = connections.find(
      (c) => c.service === service && isRealConnection(c)
    );

    if (!realConnection) {
      sendJson(res, {
        success: false,
        error: 'Service not found or is a no_auth virtual tool',
      }, 404);
      return;
    }

    const overlay = SERVICE_HEBREW_OVERLAY[service];
    addService({
      id: service,
      name: overlay?.name ?? service,
      enabled: body.enabled,
    });

    sendJson(res, {
      success: true,
      data: { service, enabled: body.enabled },
    });
  } catch (err) {
    log.error({ err, service }, 'Failed to update tool enabled state');
    sendError(res, 'Failed to update tool', 500);
  }
});

addRoute('PATCH', '/api/connector/tools/:service/actions/:action/enabled', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const url = parseUrl(req.url ?? '', true);
  const pathParts = (url.pathname ?? '').split('/');
  const service = pathParts[4];
  const actionEncoded = pathParts[6];
  const action = actionEncoded ? decodeURIComponent(actionEncoded) : undefined;

  if (!service || !action) {
    sendError(res, 'Service ID and action ID required', 400);
    return;
  }

  let body: { enabled?: boolean };
  try {
    body = await parseBody<{ enabled?: boolean }>(req);
  } catch {
    sendError(res, 'Invalid JSON body', 400);
    return;
  }

  if (typeof body.enabled !== 'boolean') {
    sendError(res, 'enabled (boolean) is required', 400);
    return;
  }

  const settings = loadSettings();
  const connector = createClient(settings.activeProject);

  try {
    const connections = await connector.listConnections();
    const realConnection = connections.find(
      (c) => c.service === service && isRealConnection(c)
    );

    if (!realConnection) {
      sendJson(res, {
        success: false,
        error: 'Service not found or is a no_auth virtual tool',
      }, 404);
      return;
    }

    const actions = await connector.listActions(service);
    const actionExists = actions.some((a) => a.id === action);
    
    if (!actionExists) {
      sendJson(res, {
        success: false,
        error: `Action '${action}' not found for service '${service}'`,
      }, 404);
      return;
    }

    setActionEnabled(service, action, body.enabled);

    sendJson(res, {
      success: true,
      data: { service, action, enabled: body.enabled },
    });
  } catch (err) {
    log.error({ err, service, action }, 'Failed to update action enabled state');
    sendError(res, 'Failed to update action', 500);
  }
});

interface ActionInfo {
  id: string;
  service: string;
  displayName: string;
  description: string;
  enabled: boolean;
  /** Override set by the owner: 'auto' (verb-based), 'always', or 'never'. */
  confirmation: 'auto' | 'always' | 'never';
  /** Effective gate: will the agent ask for a "yes" before running this action? */
  requiresConfirmation: boolean;
}

addRoute('GET', '/api/connector/actions', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const url = parseUrl(req.url ?? '', true);
  const serviceFilter = url.query['service'] as string | undefined;

  const settings = loadSettings();
  const connector = createClient(settings.activeProject);
  
  const disabledActionsMap = new Map<string, Set<string>>();
  for (const svc of settings.services) {
    if (svc.disabledActions && svc.disabledActions.length > 0) {
      disabledActionsMap.set(svc.id, new Set(svc.disabledActions));
    }
  }

  try {
    const actions = await connector.listActions(serviceFilter);
    
    const data: ActionInfo[] = actions.map((action) => {
      const disabledSet = disabledActionsMap.get(action.service);
      const enabled = !disabledSet?.has(action.id);
      return {
        id: action.id,
        service: action.service,
        displayName: action.displayName,
        description: action.description,
        enabled,
        confirmation: getActionConfirmationOverride(action.id),
        requiresConfirmation: requiresConfirmation(action.id),
      };
    });

    sendJson(res, { success: true, data });
  } catch (err) {
    log.error({ err, service: serviceFilter }, 'Failed to fetch actions');
    sendError(res, 'Failed to fetch actions', 500);
  }
});

addRoute('PATCH', '/api/connector/tools/:service/actions/:action/confirmation', async (req, res, params) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const service = params.service ? decodeURIComponent(params.service) : '';
  const action = params.action ? decodeURIComponent(params.action) : '';
  if (!service || !action) {
    sendError(res, 'Service ID and action ID required', 400);
    return;
  }

  let body: { mode?: string };
  try {
    body = await parseBody<{ mode?: string }>(req);
  } catch {
    sendError(res, 'Invalid JSON body', 400);
    return;
  }
  const mode = body.mode;
  if (mode !== 'auto' && mode !== 'always' && mode !== 'never') {
    sendError(res, "mode must be 'auto', 'always' or 'never'", 400);
    return;
  }

  const settings = loadSettings();
  const connector = createClient(settings.activeProject);

  try {
    const actions = await connector.listActions(service);
    if (!actions.some((a) => a.id === action)) {
      sendJson(res, { success: false, error: `Action '${action}' not found for service '${service}'` }, 404);
      return;
    }

    setActionConfirmation(service, action, mode);
    sendJson(res, {
      success: true,
      data: { service, action, confirmation: mode, requiresConfirmation: requiresConfirmation(action) },
    });
  } catch (err) {
    log.error({ err, service, action }, 'Failed to update action confirmation mode');
    sendError(res, 'Failed to update confirmation mode', 500);
  }
});

addRoute('POST', '/api/connector/services/:service/connect', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const url = parseUrl(req.url ?? '', true);
  const pathParts = (url.pathname ?? '').split('/');
  const rawService = pathParts[4];

  if (!rawService) {
    sendError(res, 'Service ID required', 400);
    return;
  }

  let service: string;
  try {
    service = validateServiceId(decodeURIComponent(rawService));
  } catch (err) {
    if (err instanceof ServiceIdValidationError) {
      sendError(res, err.message, 400);
      return;
    }
    throw err;
  }

  if (!DEFAULT_CONNECT_SERVICES.has(service)) {
    sendJson(res, {
      success: false,
      error: `שירות '${service}' אינו זמין להתחברות ישירה. ניתן לחבר כלים נוספים בהתאם לצרכים.`,
    }, 400);
    return;
  }

  const settings = loadSettings();
  const connector = createClient(settings.activeProject);
  const consoleUrl = getConsoleUrl();

  try {
    const providers = await connector.listProviders();
    const provider = providers.find((p) => p.id === service);
    
    if (!provider) {
      sendJson(res, {
        success: false,
        error: `Service '${service}' not found in Open Connector catalog`,
        consoleUrl,
      }, 404);
      return;
    }

    if (!provider.authTypes.includes('oauth2')) {
      sendJson(res, {
        success: false,
        error: `שגיאת תצורה בשירות '${service}'. אנא נסה שוב מאוחר יותר.`,
      }, 400);
      return;
    }

    const result = await connector.startOAuth(service);
    sendJson(res, {
      success: true,
      data: {
        authorizationUrl: result.authorizationUrl,
      },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    log.error({ err, service }, 'Failed to start OAuth');
    
    if (errorMessage.includes('OAuth') || errorMessage.includes('client') || errorMessage.includes('config')) {
      sendJson(res, {
        success: false,
        error: `שגיאת תצורה בחיבור '${service}'. אנא נסה שוב מאוחר יותר.`,
      }, 400);
      return;
    }
    
    sendError(res, `Failed to start OAuth: ${errorMessage}`, 500);
  }
});

addRoute('DELETE', '/api/connector/services/:service', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const url = parseUrl(req.url ?? '', true);
  const pathParts = (url.pathname ?? '').split('/');
  const service = pathParts[4];
  const queryConnectionName = url.query['connectionName'] as string | undefined;

  if (!service) {
    sendError(res, 'Service ID required', 400);
    return;
  }

  const settings = loadSettings();
  const connector = createClient(settings.activeProject);

  try {
    const connections = await connector.listConnections();
    
    const targetConnection = queryConnectionName
      ? connections.find((c) => c.service === service && c.connectionName === queryConnectionName)
      : connections.find((c) => c.service === service && isRealConnection(c));

    if (!targetConnection || !isRealConnection(targetConnection)) {
      sendJson(res, {
        success: false,
        error: 'אי אפשר לנתק כלי שלא דורש התחברות',
      }, 400);
      return;
    }

    await connector.disconnectService(service, targetConnection.connectionName);
    removeService(service);
    sendJson(res, { success: true });
  } catch (err) {
    log.error({ err, service }, 'Failed to disconnect service');
    sendError(res, 'Failed to disconnect service', 500);
  }
});

export function getLoginHtml(): string {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Desk Agent - התחברות</title>
  <style>
    ${getThemeCss()}
    
    body {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 16px;
      padding: 40px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    }
    h1 { text-align: center; margin-bottom: 8px; font-size: 28px; }
    .subtitle { text-align: center; color: var(--text-secondary); margin-bottom: 32px; }
    label { display: block; margin-bottom: 8px; font-weight: 500; }
    input {
      width: 100%;
      padding: 12px 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      font-size: 16px;
      margin-bottom: 24px;
    }
    input:focus { outline: none; border-color: var(--accent); }
    button {
      width: 100%;
      padding: 14px;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: var(--accent-hover); }
    .error { color: var(--error); text-align: center; margin-top: 16px; display: none; }
  </style>
</head>
<body>
  <div class="login-card">
    <h1>🤖 Desk Agent</h1>
    <p class="subtitle">הזן טוקן גישה להמשך</p>
    <form id="loginForm">
      <label for="token">טוקן גישה</label>
      <input type="password" id="token" name="token" placeholder="הזן PAIR_TOKEN" required>
      <button type="submit">התחבר</button>
    </form>
    <p class="error" id="error">טוקן שגוי</p>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = document.getElementById('token').value;
      try {
        const res = await fetch('/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        if (res.ok) {
          window.location.reload();
        } else {
          document.getElementById('error').style.display = 'block';
        }
      } catch {
        document.getElementById('error').style.display = 'block';
      }
    });
  </script>
</body>
</html>`;
}

export function getWizardHtml(settings: ReturnType<typeof loadSettings>, pairingState: { isPaired: boolean; qrCode?: string; qrDataUrl?: string; phoneNumber?: string }, hasAiProvider: boolean = false): string {
  let step: number;
  if (!pairingState.isPaired) {
    step = 1;
  } else if (!hasAiProvider) {
    step = 2;
  } else if (!settings.ownerName) {
    step = 3;
  } else {
    step = 4;
  }
  
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Desk Agent - הגדרה ראשונית</title>
  <style>
    ${getThemeCss()}
    
    body { padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; }
    .header { text-align: center; padding: 40px 0; }
    h1 { font-size: 32px; margin-bottom: 8px; }
    .subtitle { color: var(--text-secondary); }
    .steps {
      display: flex;
      justify-content: center;
      gap: 16px;
      margin: 40px 0;
      flex-wrap: wrap;
    }
    .step {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text-muted);
    }
    .step.active { color: var(--accent); }
    .step.done { color: var(--success); }
    .step-num {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--bg-tertiary);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      font-size: 14px;
    }
    .step.active .step-num { background: var(--accent); color: #fff; }
    .step.done .step-num { background: var(--success); color: #fff; }
    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 16px;
      padding: 32px;
      margin-bottom: 20px;
    }
    .qr-container {
      background: #fff;
      padding: 20px;
      border-radius: 8px;
      display: inline-block;
      margin: 20px 0;
    }
    .qr-container img {
      display: block;
      max-width: 200px;
    }
    label { display: block; margin-bottom: 8px; font-weight: 500; }
    input, select, textarea {
      width: 100%;
      padding: 12px 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      font-size: 16px;
      margin-bottom: 16px;
    }
    input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); }
    select option { background: var(--bg-tertiary); }
    textarea { resize: vertical; min-height: 80px; }
    button {
      padding: 14px 28px;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: var(--accent-hover); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.secondary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-primary);
    }
    .provider-card {
      background: var(--bg-tertiary);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .provider-info { display: flex; align-items: center; gap: 12px; }
    .provider-icon { font-size: 32px; }
    .provider-name { font-weight: 600; }
    .provider-status { font-size: 13px; color: var(--text-muted); }
    .provider-status.connected { color: var(--success); }
    .form-group { margin-bottom: 20px; }
    .btn-group { display: flex; gap: 12px; margin-top: 24px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🤖 Desk Agent</h1>
      <p class="subtitle">הגדרה ראשונית</p>
    </div>

    <div class="steps">
      <div class="step ${step >= 1 ? (step > 1 ? 'done' : 'active') : ''}">
        <span class="step-num">${step > 1 ? '✓' : '1'}</span>
        <span>WhatsApp</span>
      </div>
      <div class="step ${step >= 2 ? (step > 2 ? 'done' : 'active') : ''}">
        <span class="step-num">${step > 2 ? '✓' : '2'}</span>
        <span>AI</span>
      </div>
      <div class="step ${step >= 3 ? (step > 3 ? 'done' : 'active') : ''}">
        <span class="step-num">${step > 3 ? '✓' : '3'}</span>
        <span>זהות</span>
      </div>
    </div>

    ${step === 1 ? `
    <div class="card" style="text-align: center;">
      <h2>סרוק QR לחיבור WhatsApp</h2>
      <p style="color: var(--text-secondary); margin: 16px 0;">פתח WhatsApp → הגדרות → מכשירים מקושרים → קשר מכשיר</p>
      <div class="qr-container">
        <img id="qr-img" src="" alt="QR Code" style="display: none;">
        <p id="qr-loading" style="color: #000;">טוען QR...</p>
      </div>
      <p style="color: var(--text-muted);">QR מתעדכן אוטומטית</p>
      <script>
        async function pollPairing() {
          try {
            const res = await fetch('/api/pairing');
            const { data } = await res.json();
            
            if (data.isPaired) {
              location.reload();
              return;
            }
            
            if (data.qrDataUrl) {
              document.getElementById('qr-img').src = data.qrDataUrl;
              document.getElementById('qr-img').style.display = 'block';
              document.getElementById('qr-loading').style.display = 'none';
            }
          } catch (err) {
            console.error('Pairing poll error:', err);
          }
          setTimeout(pollPairing, 3000);
        }
        pollPairing();
      </script>
    </div>
    ` : step === 2 ? `
    <div class="card">
      <h2>🧠 התחבר לספק AI</h2>
      <p style="color: var(--text-secondary); margin-bottom: 24px;">
        התחבר ל-ChatGPT או Claude כדי להפעיל את הסוכן
      </p>
      
      <div id="providersContainer">
        <div class="provider-card" id="claude-code-card">
          <div class="provider-info">
            <span class="provider-icon">⭐</span>
            <div>
              <div class="provider-name">Claude (מנוי — Claude Code) (מומלץ)</div>
              <div class="provider-status" id="claude-code-status">בודק...</div>
            </div>
          </div>
          <button id="claude-code-btn" onclick="connectProvider('claude-code')">התחבר</button>
        </div>
        
        <div class="provider-card" id="openai-codex-card">
          <div class="provider-info">
            <span class="provider-icon">💬</span>
            <div>
              <div class="provider-name">ChatGPT</div>
              <div class="provider-status" id="openai-codex-status">בודק...</div>
            </div>
          </div>
          <button id="openai-codex-btn" onclick="connectProvider('openai-codex')">התחבר</button>
        </div>
      </div>
      
      <div id="deviceCodeModal" style="display: none; margin-top: 24px; padding: 16px; background: var(--bg-tertiary); border-radius: 8px;">
        <p style="margin-bottom: 12px; color: var(--text-secondary);">היכנס ל-ChatGPT והזן את הקוד הבא:</p>
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
          <span id="userCodeDisplay" style="font-size: 24px; font-weight: bold; font-family: monospace; background: var(--bg-primary); padding: 8px 16px; border-radius: 6px;"></span>
          <button class="secondary" onclick="copyUserCode()" style="padding: 8px 12px;">העתק</button>
        </div>
        <a id="verificationLink" href="#" target="_blank" style="color: var(--accent); text-decoration: none;">פתח עמוד אימות ChatGPT →</a>
        <p id="deviceCodeHint" style="margin-top: 12px; font-size: 13px; color: var(--text-muted);">ממתין לאישור...</p>
      </div>

      <div id="pasteModal" style="display: none; margin-top: 24px; padding: 16px; background: var(--bg-tertiary); border-radius: 8px;">
        <p id="pasteHint" style="margin-bottom: 12px; color: var(--text-secondary);"></p>
        <input type="text" id="callbackUrl" placeholder="" style="margin-bottom: 12px;">
        <div class="btn-group">
          <button onclick="submitCallback()">אשר</button>
          <button class="secondary" onclick="closePasteModal()">ביטול</button>
        </div>
      </div>
    </div>
    <script>
      let currentProvider = null;
      let currentPopup = null;
      let loginPollInterval = null;
      let loginPollTicks = 0;
      let connectedProviders = new Set();

      function getMaxPollTicks(providerId) {
        return providerId === 'openai-codex' ? 45 : 45;
      }

      async function loadProviders() {
        try {
          const res = await fetch('/api/auth/providers');
          const { data } = await res.json();
          
          connectedProviders.clear();
          for (const p of data) {
            if (p.id === 'anthropic') continue;
            
            const statusEl = document.getElementById(p.id + '-status');
            const btnEl = document.getElementById(p.id + '-btn');
            if (p.isConnected) {
              connectedProviders.add(p.id);
            }
            if (statusEl && btnEl) {
              if (p.isConnected) {
                statusEl.textContent = p.account ? ('✓ מחובר — ' + p.account) : '✓ מחובר';
                statusEl.classList.add('connected');
                btnEl.textContent = 'התחבר מחדש';
                btnEl.disabled = false;
              } else {
                statusEl.textContent = 'לא מחובר';
              }
            }
          }
          
          const anyConnected = data.some(p => p.isConnected && p.id !== 'anthropic');
          if (anyConnected) {
            setTimeout(() => location.reload(), 1000);
          }
        } catch (err) {
          console.error('Failed to load providers:', err);
        }
      }

      async function connectProvider(providerId) {
        currentProvider = providerId;
        const btnEl = document.getElementById(providerId + '-btn');
        if (btnEl) {
          btnEl.disabled = true;
          btnEl.textContent = 'מתחבר...';
        }
        
        if (providerId === 'claude-code') {
          currentPopup = window.open('about:blank', '_blank');
        }
        
        try {
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: providerId })
          });
          
          const json = await res.json();
          
          if (providerId === 'claude-code') {
            if (json.authorizeUrl && currentPopup) {
              currentPopup.location = json.authorizeUrl;
              showPasteModal('claude-code');
              startLoginPoll(providerId);
            } else {
              if (currentPopup) currentPopup.close();
              currentPopup = null;
              if (btnEl) {
                btnEl.disabled = false;
                btnEl.textContent = connectedProviders.has(providerId) ? 'התחבר מחדש' : 'התחבר';
              }
              alert(json.error || 'לא התקבל URL להתחברות');
            }
          } else if (providerId === 'openai-codex') {
            if (json.userCode && json.verificationUri) {
              document.getElementById('userCodeDisplay').textContent = json.userCode;
              document.getElementById('verificationLink').href = json.verificationUri;
              document.getElementById('deviceCodeModal').style.display = 'block';
              document.getElementById('deviceCodeHint').textContent = 'ממתין לאישור...';
              document.getElementById('deviceCodeHint').style.color = 'var(--text-muted)';
              startLoginPoll(providerId);
            } else if (json.authorizeUrl) {
              window.open(json.authorizeUrl, '_blank');
              showPasteModal('openai-codex');
              startLoginPoll(providerId);
            } else {
              if (btnEl) {
                btnEl.disabled = false;
                btnEl.textContent = connectedProviders.has(providerId) ? 'התחבר מחדש' : 'התחבר';
              }
              alert(json.error || 'שגיאה בהתחברות');
            }
          } else {
            if (json.authorizeUrl) {
              window.open(json.authorizeUrl, '_blank');
              startLoginPoll(providerId);
            } else {
              if (btnEl) {
                btnEl.disabled = false;
                btnEl.textContent = connectedProviders.has(providerId) ? 'התחבר מחדש' : 'התחבר';
              }
              alert(json.error || 'שגיאה בהתחברות');
            }
          }
        } catch (err) {
          if (currentPopup) currentPopup.close();
          currentPopup = null;
          if (btnEl) {
            btnEl.disabled = false;
            btnEl.textContent = connectedProviders.has(providerId) ? 'התחבר מחדש' : 'התחבר';
          }
          alert('שגיאה בהתחברות');
        }
      }

      function showPasteModal(providerId) {
        const pasteHint = document.getElementById('pasteHint');
        const callbackUrl = document.getElementById('callbackUrl');
        
        if (providerId === 'claude-code') {
          pasteHint.textContent = 'אם החלון נסגר, הדבק את הקוד שקיבלת מ-Claude:';
          callbackUrl.placeholder = 'הדבק קוד כאן...';
        } else {
          pasteHint.textContent = 'הדבק את ה-callback URL שחזר מ-ChatGPT:';
          callbackUrl.placeholder = 'הדבק כאן...';
        }
        
        document.getElementById('pasteModal').style.display = 'block';
      }

      function copyUserCode() {
        const code = document.getElementById('userCodeDisplay').textContent;
        navigator.clipboard.writeText(code);
      }

      function startLoginPoll(providerId) {
        if (loginPollInterval) clearInterval(loginPollInterval);
        loginPollTicks = 0;
        const maxPollTicks = getMaxPollTicks(providerId);
        
        loginPollInterval = setInterval(async () => {
          loginPollTicks++;
          
          if (loginPollTicks >= maxPollTicks) {
            clearInterval(loginPollInterval);
            loginPollInterval = null;
            
            if (providerId === 'openai-codex') {
              const hint = document.getElementById('deviceCodeHint');
              if (hint) {
                hint.textContent = 'הזמן עבר. נסה להזין את הקוד שוב או הדבק callback URL למטה.';
                hint.style.color = 'var(--accent)';
              }
              showPasteModal('openai-codex');
            } else if (providerId === 'claude-code') {
              const pasteHint = document.getElementById('pasteHint');
              if (pasteHint) {
                pasteHint.textContent = 'הדבק את הקוד שקיבלת מ-Claude:';
                pasteHint.style.color = 'var(--accent)';
              }
            }
            return;
          }
          
          try {
            const res = await fetch('/api/auth/login/' + providerId + '/status');
            const { data } = await res.json();
            
            if (data.status === 'success' || data.status === 'connected') {
              clearInterval(loginPollInterval);
              loginPollInterval = null;
              closePasteModal();
              closeDeviceCodeModal();
              location.reload();
            } else if (data.status === 'failed') {
              clearInterval(loginPollInterval);
              loginPollInterval = null;
              closePasteModal();
              closeDeviceCodeModal();
              const btnEl = document.getElementById(providerId + '-btn');
              if (btnEl) {
                btnEl.disabled = false;
                btnEl.textContent = connectedProviders.has(providerId) ? 'התחבר מחדש' : 'התחבר';
              }
              alert(data.error || 'ההתחברות נכשלה');
            }
          } catch (err) {}
        }, 2000);
      }

      async function submitCallback() {
        const callbackUrl = document.getElementById('callbackUrl').value;
        if (!callbackUrl || !currentProvider) return;
        
        try {
          const res = await fetch('/api/auth/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: currentProvider, codeOrRedirectUrl: callbackUrl })
          });
          
          const json = await res.json();
          
          if (json.success) {
            if (loginPollInterval) {
              clearInterval(loginPollInterval);
              loginPollInterval = null;
            }
            closePasteModal();
            closeDeviceCodeModal();
            location.reload();
          } else {
            alert(json.error || 'שגיאה באישור');
          }
        } catch (err) {
          alert('שגיאה באישור');
        }
      }

      function closeDeviceCodeModal() {
        const modal = document.getElementById('deviceCodeModal');
        if (modal) {
          modal.style.display = 'none';
        }
      }

      function closePasteModal() {
        const pasteModal = document.getElementById('pasteModal');
        if (pasteModal) {
          pasteModal.style.display = 'none';
        }
        document.getElementById('callbackUrl').value = '';
        if (currentPopup) {
          currentPopup = null;
        }
        if (currentProvider) {
          const btnEl = document.getElementById(currentProvider + '-btn');
          if (btnEl) {
            btnEl.disabled = false;
            btnEl.textContent = connectedProviders.has(currentProvider) ? 'התחבר מחדש' : 'התחבר';
          }
        }
        currentProvider = null;
      }

      loadProviders();
    </script>
    ` : step === 3 ? `
    <div class="card">
      <h2>👤 זהות</h2>
      <p style="color: var(--text-secondary); margin-bottom: 20px;">
        הזן את פרטי הזהות שלך והעסק. פרטים אלו ישמשו את הסוכן.
      </p>
      <form id="identityForm">
        <div class="form-group">
          <label for="ownerName">שם הבעלים *</label>
          <input type="text" id="ownerName" name="ownerName" value="${escapeHtml(settings.ownerName)}" placeholder="השם שלך" required>
        </div>
        <div class="form-group">
          <label for="businessName">שם העסק</label>
          <input type="text" id="businessName" name="businessName" value="${escapeHtml(settings.businessName)}" placeholder="שם החברה או העסק">
        </div>
        <div class="form-group">
          <label for="timezone">אזור זמן</label>
          <select id="timezone" name="timezone">
            <option value="Asia/Jerusalem" ${settings.timezone === 'Asia/Jerusalem' ? 'selected' : ''}>ישראל (Asia/Jerusalem)</option>
            <option value="UTC" ${settings.timezone === 'UTC' ? 'selected' : ''}>UTC</option>
            <option value="America/New_York" ${settings.timezone === 'America/New_York' ? 'selected' : ''}>ניו יורק</option>
            <option value="Europe/London" ${settings.timezone === 'Europe/London' ? 'selected' : ''}>לונדון</option>
          </select>
        </div>
        <div class="form-group">
          <label for="businessDescription">תיאור העסק</label>
          <textarea id="businessDescription" name="businessDescription" placeholder="תאר את העסק שלך בקצרה...">${escapeHtml(settings.businessDescription)}</textarea>
        </div>
        <div class="btn-group">
          <button type="submit">סיום הגדרה</button>
        </div>
      </form>
    </div>
    <script>
      document.getElementById('identityForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = new FormData(e.target);
        const data = Object.fromEntries(form.entries());

        try {
          const settingsRes = await fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          });
          if (!settingsRes.ok) {
            const err = await settingsRes.json().catch(() => ({}));
            alert('שמירת ההגדרות נכשלה: ' + (err.error || settingsRes.status));
            return;
          }

          const completeRes = await fetch('/api/setup/complete', { method: 'POST' });
          if (!completeRes.ok) {
            const err = await completeRes.json().catch(() => ({}));
            alert('סיום ההגדרה נכשל: ' + (err.error || completeRes.status));
            return;
          }

          location.href = '/';
        } catch (err) {
          alert('שגיאה בסיום ההגדרה: ' + err.message);
        }
      });
    </script>
    ` : `
    <div class="card" style="text-align: center;">
      <h2>✅ ההגדרה הושלמה</h2>
      <p style="color: var(--text-secondary); margin: 20px 0;">הסוכן שלך מוכן לשימוש!</p>
      <button onclick="location.href='/'">עבור ללוח הבקרה</button>
    </div>
    `}
  </div>
</body>
</html>`;
}

export function getDashboardHtml(settings: ReturnType<typeof loadSettings>, pairingState: { isPaired: boolean; phoneNumber?: string; name?: string; selfChat?: 'lid' | 'phone' | 'none' }): string {
  const safeBotName = escapeHtml(settings.botName);
  const safeName = escapeHtml(pairingState.name);
  const safePhone = escapeHtml(pairingState.phoneNumber);
  const safeActiveProject = escapeHtml(settings.activeProject);
  
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeBotName} - לוח בקרה</title>
  <style>
    ${getThemeCss()}
    
    .navbar {
      background: var(--bg-secondary);
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
    }
    .navbar h1 { font-size: 20px; }
    .nav-links {
      display: flex;
      align-items: center;
      gap: 24px;
    }
    .nav-link {
      color: var(--text-secondary);
      text-decoration: none;
      font-size: 14px;
      transition: color 0.2s;
    }
    .nav-link:hover { color: var(--text-primary); }
    .nav-status {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--success);
    }
    .status-dot.offline { background: var(--error); }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 20px;
    }
    .card {
      background: var(--bg-secondary);
      border-radius: 12px;
      padding: 24px;
      border: 1px solid var(--border);
    }
    .card h2 {
      font-size: 18px;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .stat {
      font-size: 32px;
      font-weight: 700;
      color: var(--accent);
    }
    .stat-label { color: var(--text-muted); font-size: 14px; }
    button {
      padding: 10px 20px;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: var(--accent-hover); }
    button.secondary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-primary);
    }
  </style>
</head>
<body>
  <nav class="navbar">
    <h1>🤖 ${safeBotName}</h1>
    <div class="nav-links">
      <a href="/settings" class="nav-link">⚙️ הגדרות</a>
      <div class="nav-status">
        <span class="status-dot ${pairingState.isPaired ? '' : 'offline'}"></span>
        <span>${pairingState.isPaired ? `${safeName || safePhone}` : 'מנותק'}</span>
      </div>
    </div>
  </nav>

  <div class="container">
    <div class="grid">
      <div class="card">
        <h2>📱 WhatsApp</h2>
        <div class="stat">${pairingState.isPaired ? '✅' : '❌'}</div>
        <div class="stat-label">${pairingState.isPaired ? 'מחובר' : 'מנותק'}</div>
        ${safePhone ? `<p style="margin-top: 12px; color: var(--text-muted);">${safePhone}</p>` : ''}
        ${pairingState.selfChat === 'phone' ? `<p style="margin-top: 8px; color: var(--warning, #b45309); font-size: 13px;">⚠️ לחשבון אין LID — התשובות נשלחות דרך מספר הטלפון</p>` : ''}
      </div>
      <div class="card">
        <h2>📁 פרויקט פעיל</h2>
        <div class="stat" style="font-size: 24px;">${safeActiveProject}</div>
        <div class="stat-label">מצב מפתחות: ${settings.apiKeyMode === 'shared' ? 'משותף' : 'לפי פרויקט'}</div>
      </div>
      <div class="card">
        <h2>🔌 Open Connector</h2>
        <div id="connectorStatus">בודק...</div>
        <div id="connectorAdminToken" style="display: none; margin-top: 16px; background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.3); border-radius: 8px; padding: 12px;">
          <h4 style="margin-bottom: 8px; color: #a5b4fc;">🔑 טוקן ניהול (חד-פעמי)</h4>
          <p style="color: var(--text-muted); font-size: 12px; margin-bottom: 8px;">שמור את הטוקן הזה - לא יוצג שוב!</p>
          <div style="background: var(--bg-primary); padding: 8px; border-radius: 4px; font-family: monospace; word-break: break-all; margin-bottom: 8px; font-size: 12px;">
            <span id="dashboardAdminToken"></span>
          </div>
          <button onclick="copyDashboardToken()" class="secondary" style="padding: 6px 12px; font-size: 12px;">העתק</button>
          <button onclick="ackDashboardToken()" style="padding: 6px 12px; font-size: 12px;">שמרתי את הטוקן</button>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top: 20px;">
      <h2>📖 איך להשתמש</h2>
      <ol style="color: var(--text-secondary); line-height: 2; padding-right: 20px;">
        <li>פתח את WhatsApp בטלפון שחיברת</li>
        <li>שלח הודעה לעצמך (לשיחה שלך)</li>
        <li>הסוכן יענה לך בצ'אט הפרטי</li>
        <li>השתמש ב-/help לראות פקודות זמינות</li>
      </ol>
    </div>
  </div>

  <script>
    async function loadConnectorStatus() {
      try {
        const res = await fetch('/api/connector/onboarding');
        const { data } = await res.json();
        document.getElementById('connectorStatus').innerHTML = \`
          <div class="stat">\${data.healthy ? '✅' : '❌'}</div>
          <div class="stat-label">\${data.healthy ? \`\${data.connectionCount} חיבורים\` : 'לא זמין'}</div>
          <a href="\${data.consoleUrl}" target="_blank" style="display: block; margin-top: 12px; color: var(--accent); font-size: 14px;">
            פתח קונסול →
          </a>
        \`;
        
        if (data.adminToken) {
          document.getElementById('connectorAdminToken').style.display = 'block';
          document.getElementById('dashboardAdminToken').textContent = data.adminToken;
        }
      } catch {
        document.getElementById('connectorStatus').innerHTML = '<div class="stat">❌</div><div class="stat-label">שגיאה</div>';
      }
    }

    function copyDashboardToken() {
      const token = document.getElementById('dashboardAdminToken').textContent;
      navigator.clipboard.writeText(token);
    }

    async function ackDashboardToken() {
      await fetch('/api/connector/ack-admin-token', { method: 'POST' });
      document.getElementById('connectorAdminToken').style.display = 'none';
    }

    loadConnectorStatus();
  </script>
</body>
</html>`;
}

export function startServer(): void {
  const server = createServer(async (req, res) => {
    const url = parseUrl(req.url ?? '', true);
    const path = url.pathname ?? '/';
    const method = req.method ?? 'GET';

    log.debug({ method, path }, 'Request');

    try {
      const match = matchRoute(method, path);
      if (match) {
        await match.handler(req, res, match.params);
      } else {
        sendError(res, 'Not found', 404);
      }
    } catch (err) {
      log.error({ err, method, path }, 'Request error');
      sendError(res, 'Internal server error', 500);
    }
  });

  server.listen(config.port, config.host, () => {
    log.info({ host: config.host, port: config.port }, 'HTTP server started');
    
    if (config.isProduction) {
      console.log(`\n🌐 Web UI: http://${config.host}:${config.port}/`);
      console.log(`   Enter your PAIR_TOKEN to authenticate`);
    } else {
      console.log(`\n🌐 Web UI: http://${config.host}:${config.port}/?token=${config.pairToken}`);
    }
  });
}
