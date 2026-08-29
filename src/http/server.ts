import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { parse as parseUrl } from 'node:url';
import { parse as parseQuery } from 'node:querystring';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../core/config.ts';
import { createChildLogger } from '../core/logger.ts';
import {
  loadSettings,
  updateSettings,
  setProjectToken,
  removeProjectToken,
  setApiKeyMode,
  markSetupComplete,
  isSetupRequired,
  acknowledgeAdminToken,
  isAdminTokenAcknowledged,
  addService,
  removeService,
  setActionEnabled,
  getService,
  setServiceEnabled,
  isActionEnabled,
} from '../core/settings.ts';
import { listProjects, createProject, getProject } from '../core/memory.ts';
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
import { getSettingsHtml, type SettingsPageData } from './settings-page.ts';
import { getThemeCss } from './theme.ts';

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
  return token === config.pairToken;
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

async function parseBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
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

addRoute('GET', '/', async (req, res) => {
  if (!isAuthenticated(req)) {
    const loginHtml = getLoginHtml();
    sendHtml(res, loginHtml);
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

  let connectorStatus = {
    healthy: false,
    connectionCount: 0,
    consoleUrl: config.openConnectorUrl,
  };

  try {
    const healthy = await connector.checkHealth();
    if (healthy) {
      const connections = await connector.listConnections();
      connectorStatus = {
        healthy: true,
        connectionCount: connections.length,
        consoleUrl: config.openConnectorUrl,
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
  const body = await parseBody<{ token?: string }>(req).catch(() => ({ token: undefined }));
  const token = body.token;

  if (token === config.pairToken) {
    const isHttps = req.headers['x-forwarded-proto'] === 'https' || 
                    req.headers.host?.startsWith('https') ||
                    config.isProduction;
    const securePart = isHttps ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `PAIR_TOKEN=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${securePart}`
    );
    sendJson(res, { success: true });
  } else {
    sendError(res, 'Invalid token', 401);
  }
});

addRoute('GET', '/api/pairing', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const wa = getWhatsAppClient();
  const state = wa.getPairingState();
  sendJson(res, { success: true, data: state });
});

addRoute('GET', '/api/settings', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const settings = loadSettings();
  const safeSettings = {
    ...settings,
    sharedConnectorToken: settings.sharedConnectorToken ? '***' : undefined,
    projectTokens: Object.fromEntries(
      Object.entries(settings.projectTokens).map(([k, v]) => [k, v ? '***' : ''])
    ),
  };
  sendJson(res, { success: true, data: safeSettings });
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
    sharedConnectorToken: string;
  }>>(req);

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
  if (body.sharedConnectorToken !== undefined) updates.sharedConnectorToken = body.sharedConnectorToken;

  const settings = updateSettings(updates);
  
  writeIdentityFiles(settings);

  sendJson(res, { success: true, data: { ...settings, sharedConnectorToken: '***' } });
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

  const id = body.name.toLowerCase().replace(/\s+/g, '-');
  const project = createProject({ id, name: body.name, description: body.description });
  sendJson(res, { success: true, data: project });
});

addRoute('PUT', '/api/projects/:id/token', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const body = await parseBody<{ token?: string }>(req);
  const projectId = req.url?.split('/')[3] ?? '';

  if (body.token) {
    setProjectToken(projectId, body.token);
  } else {
    removeProjectToken(projectId);
  }

  sendJson(res, { success: true });
});

addRoute('PUT', '/api/projects/:id/activate', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const projectId = req.url?.split('/')[3] ?? '';
  const project = getProject(projectId);
  
  if (!project) {
    sendError(res, 'Project not found', 404);
    return;
  }

  updateSettings({ activeProject: projectId });
  sendJson(res, { success: true });
});

addRoute('GET', '/api/services', async (req, res) => {
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

    const data = providers.map((p) => {
      const conn = connectionMap.get(p.id);
      return {
        id: p.id,
        name: p.displayName,
        description: p.description,
        authTypes: p.authTypes,
        isConnected: !!conn,
        identity: conn?.identity?.label,
      };
    });

    sendJson(res, { success: true, data });
  } catch (err) {
    log.error({ err }, 'Failed to fetch services');
    sendError(res, 'Failed to fetch services', 500);
  }
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

  if (config.connectorAdminToken && !settings.connectorAdminTokenAcknowledged) {
    sendError(res, 'יש לאשר את שמירת טוקן הניהול של Open Connector לפני סיום ההגדרה.', 400);
    return;
  }

  markSetupComplete();
  sendJson(res, { success: true });
});

function getConsoleUrl(): string {
  const origin = config.connectorOrigin;
  if (config.isProduction && origin.includes('localhost')) {
    throw new Error('CONNECTOR_ORIGIN must be set to a public URL in production');
  }
  return origin;
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
  } catch (err) {
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

    const data: ServiceInfo[] = providers.map((p) => {
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
      };
    });

    sendJson(res, { success: true, data });
  } catch (err) {
    log.error({ err, service: serviceFilter }, 'Failed to fetch actions');
    sendError(res, 'Failed to fetch actions', 500);
  }
});

addRoute('POST', '/api/connector/services/:service/connect', async (req, res) => {
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
      const authTypesDisplay = provider.authTypes.length > 0 
        ? provider.authTypes.join(', ') 
        : 'none';
      sendJson(res, {
        success: false,
        error: `Service '${service}' does not support OAuth2 (supports: ${authTypesDisplay}). Configure it in Open Connector console.`,
        consoleUrl,
        authTypes: provider.authTypes,
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
        error: `OAuth not configured for '${service}'. Configure OAuth credentials in Open Connector console.`,
        consoleUrl,
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

addRoute('PATCH', '/api/connector/tools/:service/actions/:action/enabled', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const match = req.url?.match(/\/api\/connector\/tools\/([^/]+)\/actions\/([^/]+)\/enabled/);
  const service = match?.[1] ? decodeURIComponent(match[1]) : null;
  const actionId = match?.[2] ? decodeURIComponent(match[2]) : null;

  if (!service || !actionId) {
    sendError(res, 'Missing service or action parameter', 400);
    return;
  }

  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }

  let enabled: boolean;
  try {
    const parsed = JSON.parse(body);
    enabled = parsed.enabled === true;
  } catch {
    sendError(res, 'Invalid JSON body', 400);
    return;
  }

  const settings = loadSettings();
  const connector = createClient(settings.activeProject);

  try {
    const connections = await connector.listConnections();
    const realConnections = connections.filter(isRealConnection);
    const hasRealConnection = realConnections.some((c) => c.service === service);

    if (!hasRealConnection) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: false, 
        error: 'אי אפשר לשנות מצב של פעולה בכלי שלא מחובר' 
      }));
      return;
    }

    const actions = await connector.listActions(service);
    const actionExists = actions.some((a) => a.id === actionId);

    if (!actionExists) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: false, 
        error: 'הפעולה לא נמצאה בכלי זה' 
      }));
      return;
    }

    setActionEnabled(service, actionId, enabled);
    sendJson(res, { success: true, enabled });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'שגיאה בעדכון מצב הפעולה';
    sendError(res, errorMessage, 500);
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
  const hasAdminToken = !!config.connectorAdminToken;
  const adminTokenAcked = settings.connectorAdminTokenAcknowledged;
  const needsConnectorAck = hasAdminToken && !adminTokenAcked;
  
  let step: number;
  if (!pairingState.isPaired) {
    step = 1;
  } else if (!hasAiProvider) {
    step = 2;
  } else if (needsConnectorAck) {
    step = 3;
  } else if (!settings.ownerName) {
    step = 4;
  } else {
    step = 5;
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
        <span>Open Connector</span>
      </div>
      <div class="step ${step >= 4 ? (step > 4 ? 'done' : 'active') : ''}">
        <span class="step-num">${step > 4 ? '✓' : '4'}</span>
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
        <div class="provider-card">
          <div class="provider-info">
            <span class="provider-icon">🤖</span>
            <div>
              <div class="provider-name">Claude (Anthropic)</div>
              <div class="provider-status" id="anthropic-status">בודק...</div>
            </div>
          </div>
          <button id="anthropic-btn" onclick="connectProvider('anthropic')">התחבר</button>
        </div>
        
        <div class="provider-card">
          <div class="provider-info">
            <span class="provider-icon">💬</span>
            <div>
              <div class="provider-name">ChatGPT (OpenAI)</div>
              <div class="provider-status" id="openai-codex-status">בודק...</div>
            </div>
          </div>
          <button id="openai-codex-btn" onclick="connectProvider('openai-codex')">התחבר</button>
        </div>
      </div>
      
      <div id="pasteModal" style="display: none; margin-top: 24px; padding: 16px; background: var(--bg-tertiary); border-radius: 8px;">
        <p style="margin-bottom: 12px; color: var(--text-secondary);">אם החלון לא נפתח, הדבק את הקוד או URL שחזר:</p>
        <input type="text" id="callbackUrl" placeholder="הדבק כאן..." style="margin-bottom: 12px;">
        <div class="btn-group">
          <button onclick="submitCallback()">אשר</button>
          <button class="secondary" onclick="closePasteModal()">ביטול</button>
        </div>
      </div>
    </div>
    <script>
      let currentProvider = null;
      let loginPollInterval = null;

      async function loadProviders() {
        try {
          const res = await fetch('/api/auth/providers');
          const { data } = await res.json();
          
          for (const p of data) {
            const statusEl = document.getElementById(p.id + '-status');
            const btnEl = document.getElementById(p.id + '-btn');
            if (statusEl && btnEl) {
              if (p.isConnected) {
                statusEl.textContent = '✓ מחובר';
                statusEl.classList.add('connected');
                btnEl.textContent = 'מחובר ✓';
                btnEl.disabled = true;
              } else {
                statusEl.textContent = 'לא מחובר';
              }
            }
          }
          
          const anyConnected = data.some(p => p.isConnected);
          if (anyConnected) {
            setTimeout(() => location.reload(), 1000);
          }
        } catch (err) {
          console.error('Failed to load providers:', err);
        }
      }

      async function connectProvider(providerId) {
        currentProvider = providerId;
        const popup = window.open('about:blank', '_blank', 'noopener');
        
        try {
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: providerId })
          });
          
          const json = await res.json();
          
          if (json.authorizeUrl) {
            if (popup && !popup.closed) {
              popup.location = json.authorizeUrl;
            } else {
              window.open(json.authorizeUrl, '_blank');
            }
            
            startLoginPoll(providerId);
            setTimeout(() => {
              document.getElementById('pasteModal').style.display = 'block';
            }, 2000);
          } else {
            if (popup && !popup.closed) popup.close();
            alert(json.error || 'שגיאה בהתחברות');
          }
        } catch (err) {
          if (popup && !popup.closed) popup.close();
          alert('שגיאה בהתחברות');
        }
      }

      function startLoginPoll(providerId) {
        if (loginPollInterval) clearInterval(loginPollInterval);
        
        loginPollInterval = setInterval(async () => {
          try {
            const res = await fetch('/api/auth/login/' + providerId + '/status');
            const { data } = await res.json();
            
            if (data.status === 'success') {
              clearInterval(loginPollInterval);
              closePasteModal();
              location.reload();
            } else if (data.status === 'failed') {
              clearInterval(loginPollInterval);
              closePasteModal();
              alert(data.error || 'ההתחברות נכשלה');
            }
          } catch (err) {}
        }, 2000);
        
        setTimeout(() => {
          if (loginPollInterval) clearInterval(loginPollInterval);
        }, 120000);
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
            closePasteModal();
            location.reload();
          } else {
            alert(json.error || 'שגיאה באישור');
          }
        } catch (err) {
          alert('שגיאה באישור');
        }
      }

      function closePasteModal() {
        document.getElementById('pasteModal').style.display = 'none';
        document.getElementById('callbackUrl').value = '';
        currentProvider = null;
      }

      loadProviders();
    </script>
    ` : step === 3 ? `
    <div class="card">
      <h2>🔌 Open Connector</h2>
      <p style="color: var(--text-secondary); margin-bottom: 20px;">
        Open Connector מאפשר לסוכן להתחבר לשירותים חיצוניים כמו Gmail, Calendar ועוד.
      </p>
      
      <div id="connectorStatus" style="margin-bottom: 24px;">
        <div style="display: flex; align-items: center; gap: 12px; padding: 16px; background: var(--bg-tertiary); border-radius: 8px;">
          <span id="healthIcon" style="font-size: 24px;">⏳</span>
          <div>
            <div id="healthText" style="font-weight: 500;">בודק חיבור...</div>
            <div id="healthDetails" style="color: var(--text-muted); font-size: 14px;"></div>
          </div>
        </div>
      </div>

      <div id="adminTokenSection" style="display: none; margin-bottom: 24px;">
        <div style="background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.3); border-radius: 8px; padding: 16px;">
          <h3 style="margin-bottom: 12px; color: #a5b4fc;">🔑 טוקן ניהול (חד-פעמי)</h3>
          <p style="color: var(--text-secondary); margin-bottom: 12px; font-size: 14px;">
            שמור את הטוקן הבא במקום בטוח. הוא משמש להתחברות לקונסולת Open Connector ולא יוצג שוב.
          </p>
          <div style="background: var(--bg-primary); padding: 12px; border-radius: 6px; font-family: monospace; word-break: break-all; margin-bottom: 16px;">
            <span id="adminTokenValue"></span>
            <button onclick="copyToken()" style="margin-right: 8px; padding: 4px 8px; font-size: 12px;">העתק</button>
          </div>
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
            <input type="checkbox" id="ackCheckbox" style="width: 18px; height: 18px;">
            <span>שמרתי את הטוקן</span>
          </label>
        </div>
      </div>

      <div id="consoleLink" style="margin-bottom: 24px; display: none;">
        <a id="consoleLinkHref" href="#" target="_blank" style="display: inline-flex; align-items: center; gap: 8px; color: var(--accent); text-decoration: none;">
          <span>פתח קונסולת Open Connector</span>
          <span>←</span>
        </a>
      </div>

      <div class="btn-group">
        <button id="continueBtn" onclick="continueToNext()" disabled>המשך</button>
      </div>
    </div>
    <script>
      let connectorData = null;

      async function loadConnectorStatus() {
        try {
          const res = await fetch('/api/connector/onboarding');
          const { data } = await res.json();
          connectorData = data;

          const healthIcon = document.getElementById('healthIcon');
          const healthText = document.getElementById('healthText');
          const healthDetails = document.getElementById('healthDetails');

          if (data.healthy) {
            healthIcon.textContent = '✅';
            healthText.textContent = 'Open Connector מחובר';
            healthDetails.textContent = data.connectionCount + ' חיבורים פעילים';
          } else {
            healthIcon.textContent = '❌';
            healthText.textContent = 'Open Connector לא זמין';
            healthDetails.textContent = 'ודא שהשירות פועל ונסה שוב';
          }

          if (data.consoleUrl) {
            document.getElementById('consoleLink').style.display = 'block';
            document.getElementById('consoleLinkHref').href = data.consoleUrl;
          }

          if (data.adminToken) {
            document.getElementById('adminTokenSection').style.display = 'block';
            document.getElementById('adminTokenValue').textContent = data.adminToken;
          }

          updateContinueButton();
        } catch (err) {
          document.getElementById('healthIcon').textContent = '❌';
          document.getElementById('healthText').textContent = 'שגיאה בבדיקת החיבור';
        }
      }

      function updateContinueButton() {
        const btn = document.getElementById('continueBtn');
        const ackCheckbox = document.getElementById('ackCheckbox');
        
        if (!connectorData?.healthy) {
          btn.disabled = true;
          return;
        }
        
        if (connectorData.requiresAck && !ackCheckbox?.checked) {
          btn.disabled = true;
          return;
        }
        
        btn.disabled = false;
      }

      document.getElementById('ackCheckbox')?.addEventListener('change', updateContinueButton);

      function copyToken() {
        const token = document.getElementById('adminTokenValue').textContent;
        navigator.clipboard.writeText(token);
      }

      async function continueToNext() {
        const ackCheckbox = document.getElementById('ackCheckbox');
        if (connectorData?.requiresAck && ackCheckbox?.checked) {
          await fetch('/api/connector/ack-admin-token', { method: 'POST' });
        }
        location.reload();
      }

      loadConnectorStatus();
    </script>
    ` : step === 4 ? `
    <div class="card">
      <h2>👤 זהות</h2>
      <p style="color: var(--text-secondary); margin-bottom: 20px;">
        הזן את פרטי הזהות שלך והעסק. פרטים אלו ישמשו את הסוכן.
      </p>
      <form id="identityForm">
        <div class="form-group">
          <label for="ownerName">שם הבעלים *</label>
          <input type="text" id="ownerName" name="ownerName" value="${settings.ownerName || ''}" placeholder="השם שלך" required>
        </div>
        <div class="form-group">
          <label for="businessName">שם העסק</label>
          <input type="text" id="businessName" name="businessName" value="${settings.businessName || ''}" placeholder="שם החברה או העסק">
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
          <textarea id="businessDescription" name="businessDescription" placeholder="תאר את העסק שלך בקצרה...">${settings.businessDescription || ''}</textarea>
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
        
        await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        
        await fetch('/api/setup/complete', { method: 'POST' });
        location.href = '/';
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

export function getDashboardHtml(settings: ReturnType<typeof loadSettings>, pairingState: { isPaired: boolean; phoneNumber?: string; name?: string }): string {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${settings.botName} - לוח בקרה</title>
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
    <h1>🤖 ${settings.botName}</h1>
    <div class="nav-links">
      <a href="/settings" class="nav-link">⚙️ הגדרות</a>
      <div class="nav-status">
        <span class="status-dot ${pairingState.isPaired ? '' : 'offline'}"></span>
        <span>${pairingState.isPaired ? `${pairingState.name || pairingState.phoneNumber}` : 'מנותק'}</span>
      </div>
    </div>
  </nav>

  <div class="container">
    <div class="grid">
      <div class="card">
        <h2>📱 WhatsApp</h2>
        <div class="stat">${pairingState.isPaired ? '✅' : '❌'}</div>
        <div class="stat-label">${pairingState.isPaired ? 'מחובר' : 'מנותק'}</div>
        ${pairingState.phoneNumber ? `<p style="margin-top: 12px; color: var(--text-muted);">${pairingState.phoneNumber}</p>` : ''}
      </div>
      <div class="card">
        <h2>📁 פרויקט פעיל</h2>
        <div class="stat" style="font-size: 24px;">${settings.activeProject}</div>
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
