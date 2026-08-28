import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { parse as parseUrl } from 'node:url';
import { parse as parseQuery } from 'node:querystring';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
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
} from '../core/settings.ts';
import { listProjects, createProject, getProject } from '../core/memory.ts';
import { getWhatsAppClient } from '../whatsapp/client.ts';
import { createClient } from '../open-connector/client.ts';
import {
  listProviders,
  startLogin,
  completeLogin,
  getLoginStatusAsync,
  logout,
  hasAnyAuthConfigured,
  getModelAliases,
  type ProviderId,
} from './auth.ts';

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
  const hasAuth = await hasAnyAuthConfigured();

  if (isSetupRequired() || !pairingState.isPaired || !hasAuth) {
    const wizardHtml = await getWizardHtml(settings, pairingState);
    sendHtml(res, wizardHtml);
    return;
  }

  const dashboardHtml = await getDashboardHtml(settings, pairingState);
  sendHtml(res, dashboardHtml);
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
    timezone: string;
    model: string;
    apiKeyMode: 'shared' | 'per-project';
    sharedConnectorToken: string;
  }>>(req);

  const updates: Partial<typeof body> = {};
  if (body.botName) updates.botName = body.botName;
  if (body.ownerName) updates.ownerName = body.ownerName;
  if (body.timezone) updates.timezone = body.timezone;
  if (body.model) updates.model = body.model;
  if (body.apiKeyMode) updates.apiKeyMode = body.apiKeyMode;
  if (body.sharedConnectorToken) updates.sharedConnectorToken = body.sharedConnectorToken;

  const settings = updateSettings(updates);
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

    const connectionMap = new Map(connections.map((c) => [c.service, c]));

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

  markSetupComplete();
  sendJson(res, { success: true });
});

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

    sendJson(res, {
      success: true,
      data: {
        healthy,
        url: config.openConnectorUrl,
        connectionCount: connections.length,
      },
    });
  } catch (err) {
    sendJson(res, {
      success: true,
      data: {
        healthy: false,
        url: config.openConnectorUrl,
        connectionCount: 0,
      },
    });
  }
});

addRoute('GET', '/api/pairing/qr', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const wa = getWhatsAppClient();
  const state = wa.getPairingState();

  if (!state.qrCode) {
    sendJson(res, { success: true, data: { qrDataUrl: null, isPaired: state.isPaired } });
    return;
  }

  try {
    const qrDataUrl = await QRCode.toDataURL(state.qrCode, {
      width: 256,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });
    sendJson(res, { success: true, data: { qrDataUrl, isPaired: false } });
  } catch (err) {
    log.error({ err }, 'Failed to generate QR code');
    sendError(res, 'Failed to generate QR code', 500);
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
    log.error({ err }, 'Failed to list auth providers');
    sendError(res, 'Failed to list providers', 500);
  }
});

addRoute('POST', '/api/auth/login', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const body = await parseBody<{ provider?: string }>(req).catch(() => ({ provider: undefined }));
  const provider = body.provider as ProviderId | undefined;

  if (!provider || (provider !== 'anthropic' && provider !== 'openai-codex')) {
    sendError(res, 'Invalid provider. Use "anthropic" or "openai-codex"');
    return;
  }

  try {
    const result = await startLogin(provider);
    sendJson(res, { success: true, data: result });
  } catch (err) {
    log.error({ err, provider }, 'Failed to start login');
    sendError(res, `Failed to start login: ${err instanceof Error ? err.message : 'Unknown error'}`, 500);
  }
});

addRoute('POST', '/api/auth/complete', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const body = await parseBody<{ provider?: string; codeOrRedirectUrl?: string }>(req).catch(() => ({ provider: undefined, codeOrRedirectUrl: undefined }));
  const provider = body.provider as ProviderId | undefined;
  const codeOrRedirectUrl = body.codeOrRedirectUrl;

  if (!provider || (provider !== 'anthropic' && provider !== 'openai-codex')) {
    sendError(res, 'Invalid provider. Use "anthropic" or "openai-codex"');
    return;
  }

  if (!codeOrRedirectUrl) {
    sendError(res, 'codeOrRedirectUrl is required');
    return;
  }

  try {
    const result = await completeLogin(provider, codeOrRedirectUrl);
    if (result.success) {
      sendJson(res, { success: true });
    } else {
      sendError(res, result.error ?? 'Login failed');
    }
  } catch (err) {
    log.error({ err, provider }, 'Failed to complete login');
    sendError(res, `Failed to complete login: ${err instanceof Error ? err.message : 'Unknown error'}`, 500);
  }
});

addRoute('GET', '/api/auth/login/:provider/status', async (req, res, params) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const provider = params.provider as ProviderId;
  if (provider !== 'anthropic' && provider !== 'openai-codex') {
    sendError(res, 'Invalid provider. Use "anthropic" or "openai-codex"');
    return;
  }

  const status = await getLoginStatusAsync(provider);
  sendJson(res, { success: true, data: status });
});

addRoute('POST', '/api/auth/logout', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const body = await parseBody<{ provider?: string }>(req).catch(() => ({ provider: undefined }));
  const provider = body.provider as ProviderId | undefined;

  if (!provider || (provider !== 'anthropic' && provider !== 'openai-codex')) {
    sendError(res, 'Invalid provider. Use "anthropic" or "openai-codex"');
    return;
  }

  try {
    const result = await logout(provider);
    if (result.success) {
      sendJson(res, { success: true });
    } else {
      sendError(res, result.error ?? 'Logout failed');
    }
  } catch (err) {
    log.error({ err, provider }, 'Failed to logout');
    sendError(res, `Failed to logout: ${err instanceof Error ? err.message : 'Unknown error'}`, 500);
  }
});

addRoute('GET', '/api/auth/aliases', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const aliases = getModelAliases();
  sendJson(res, { success: true, data: aliases });
});

function getLoginHtml(): string {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Desk Agent - התחברות</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
    }
    .login-card {
      background: rgba(255,255,255,0.1);
      backdrop-filter: blur(10px);
      border-radius: 16px;
      padding: 40px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    }
    h1 { text-align: center; margin-bottom: 8px; font-size: 28px; }
    .subtitle { text-align: center; color: #aaa; margin-bottom: 32px; }
    label { display: block; margin-bottom: 8px; font-weight: 500; }
    input {
      width: 100%;
      padding: 12px 16px;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      background: rgba(255,255,255,0.1);
      color: #fff;
      font-size: 16px;
      margin-bottom: 24px;
    }
    input:focus { outline: none; border-color: #4f46e5; }
    button {
      width: 100%;
      padding: 14px;
      background: #4f46e5;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: #4338ca; }
    .error { color: #f87171; text-align: center; margin-top: 16px; display: none; }
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

async function getWizardHtml(settings: ReturnType<typeof loadSettings>, pairingState: { isPaired: boolean; qrCode?: string; phoneNumber?: string }): Promise<string> {
  const hasAuth = await hasAnyAuthConfigured();
  const step = !pairingState.isPaired ? 1 : !settings.ownerName ? 2 : !hasAuth ? 3 : 4;
  
  let qrDataUrl = '';
  if (pairingState.qrCode) {
    try {
      qrDataUrl = await QRCode.toDataURL(pairingState.qrCode, {
        width: 256,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
    } catch (err) {
      log.error({ err }, 'Failed to generate QR code for wizard');
    }
  }
  
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Desk Agent - הגדרה ראשונית</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      color: #fff;
      padding: 20px;
    }
    .container { max-width: 700px; margin: 0 auto; }
    .header { text-align: center; padding: 40px 0; }
    h1 { font-size: 32px; margin-bottom: 8px; }
    .subtitle { color: #aaa; }
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
      color: #666;
    }
    .step.active { color: #4f46e5; }
    .step.done { color: #10b981; }
    .step-num {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: rgba(255,255,255,0.1);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
    }
    .step.active .step-num { background: #4f46e5; }
    .step.done .step-num { background: #10b981; }
    .card {
      background: rgba(255,255,255,0.1);
      backdrop-filter: blur(10px);
      border-radius: 16px;
      padding: 32px;
      margin-bottom: 20px;
    }
    .qr-container {
      background: #fff;
      padding: 16px;
      border-radius: 12px;
      display: inline-block;
      margin: 20px 0;
    }
    .qr-container img {
      display: block;
      width: 256px;
      height: 256px;
    }
    label { display: block; margin-bottom: 8px; font-weight: 500; }
    input, select {
      width: 100%;
      padding: 12px 16px;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      background: rgba(255,255,255,0.1);
      color: #fff;
      font-size: 16px;
      margin-bottom: 16px;
    }
    input:focus, select:focus { outline: none; border-color: #4f46e5; }
    select option { background: #1a1a2e; }
    button {
      padding: 14px 28px;
      background: #4f46e5;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: #4338ca; }
    button:disabled { background: #666; cursor: not-allowed; }
    button.secondary {
      background: transparent;
      border: 1px solid rgba(255,255,255,0.3);
    }
    button.secondary:hover { background: rgba(255,255,255,0.1); }
    .connected { color: #10b981; }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 14px;
    }
    .status-badge.connected { background: rgba(16, 185, 129, 0.2); color: #10b981; }
    .status-badge.pending { background: rgba(251, 191, 36, 0.2); color: #fbbf24; }
    .status-badge.error { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
    .form-group { margin-bottom: 20px; }
    .btn-group { display: flex; gap: 12px; margin-top: 24px; flex-wrap: wrap; }
    .provider-card {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
    }
    .provider-card.connected { border-color: #10b981; }
    .provider-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    .provider-icon { font-size: 32px; }
    .provider-info { flex: 1; }
    .provider-name { font-weight: 600; font-size: 18px; }
    .provider-desc { color: #aaa; font-size: 14px; }
    .provider-actions {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .paste-input {
      display: none;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid rgba(255,255,255,0.1);
    }
    .paste-input.show { display: block; }
    .paste-input input { margin-bottom: 8px; }
    .spinner {
      width: 20px;
      height: 20px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
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
        <span>הגדרות</span>
      </div>
      <div class="step ${step >= 3 ? (step > 3 ? 'done' : 'active') : ''}">
        <span class="step-num">${step > 3 ? '✓' : '3'}</span>
        <span>מנוי AI</span>
      </div>
      <div class="step ${step >= 4 ? 'active' : ''}">
        <span class="step-num">4</span>
        <span>שירותים</span>
      </div>
    </div>

    ${step === 1 ? `
    <div class="card" style="text-align: center;">
      <h2>סרוק QR לחיבור WhatsApp</h2>
      <p style="color: #aaa; margin: 16px 0;">פתח WhatsApp ← הגדרות ← מכשירים מקושרים ← קשר מכשיר</p>
      <div id="qr-area">
        ${qrDataUrl ? `
          <div class="qr-container">
            <img id="qr-img" src="${qrDataUrl}" alt="WhatsApp QR Code" />
          </div>
          <p style="color: #aaa; font-size: 14px;">QR מתעדכן אוטומטית</p>
        ` : `
          <div style="padding: 40px;">
            <div class="spinner" style="margin: 0 auto 16px;"></div>
            <p style="color: #aaa;">ממתין ל-QR...</p>
          </div>
        `}
      </div>
    </div>
    <script>
      let pollCount = 0;
      const maxPolls = 120;
      
      async function pollPairing() {
        if (pollCount++ > maxPolls) {
          document.getElementById('qr-area').innerHTML = '<p style="color: #f87171;">זמן QR פג. רענן את הדף.</p>';
          return;
        }
        
        try {
          const pairingRes = await fetch('/api/pairing');
          const { data: pairingData } = await pairingRes.json();
          
          if (pairingData.isPaired) {
            location.reload();
            return;
          }
          
          const qrRes = await fetch('/api/pairing/qr');
          const { data: qrData } = await qrRes.json();
          
          if (qrData.qrDataUrl) {
            const img = document.getElementById('qr-img');
            if (img) {
              img.src = qrData.qrDataUrl;
            } else {
              document.getElementById('qr-area').innerHTML = \`
                <div class="qr-container">
                  <img id="qr-img" src="\${qrData.qrDataUrl}" alt="WhatsApp QR Code" />
                </div>
                <p style="color: #aaa; font-size: 14px;">QR מתעדכן אוטומטית</p>
              \`;
            }
          }
        } catch (err) {
          console.error('Polling error:', err);
        }
        
        setTimeout(pollPairing, 3000);
      }
      
      pollPairing();
    </script>
    ` : step === 2 ? `
    <div class="card">
      <h2>הגדרות בסיסיות</h2>
      <form id="settingsForm">
        <div class="form-group">
          <label for="ownerName">שם הבעלים</label>
          <input type="text" id="ownerName" name="ownerName" value="${settings.ownerName}" placeholder="השם שלך" required>
        </div>
        <div class="form-group">
          <label for="botName">שם הבוט</label>
          <input type="text" id="botName" name="botName" value="${settings.botName}" placeholder="Desk Agent">
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
        <div class="btn-group">
          <button type="submit">המשך</button>
        </div>
      </form>
    </div>
    <script>
      document.getElementById('settingsForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = new FormData(e.target);
        const data = Object.fromEntries(form.entries());
        await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        location.reload();
      });
    </script>
    ` : step === 3 ? `
    <div class="card">
      <h2>התחבר עם מנוי AI</h2>
      <p style="color: #aaa; margin-bottom: 24px;">
        חבר את מנוי ה-Claude או ChatGPT שלך. הסוכן ישתמש במנוי שלך לתשובות.
        <br><strong>צריך לפחות חיבור אחד כדי להמשיך.</strong>
      </p>
      
      <div id="providers">
        <div class="provider-card" id="anthropic-card">
          <div class="provider-header">
            <span class="provider-icon">🟣</span>
            <div class="provider-info">
              <div class="provider-name">Claude Pro/Max</div>
              <div class="provider-desc">השתמש במנוי Claude Pro או Max שלך</div>
            </div>
            <div class="provider-actions">
              <span id="anthropic-status" class="status-badge"></span>
              <button id="anthropic-btn" onclick="startLogin('anthropic')">התחבר</button>
            </div>
          </div>
          <div class="paste-input" id="anthropic-paste">
            <p style="font-size: 14px; color: #aaa; margin-bottom: 8px;">
              אם הדפדפן לא באותו מחשב, העתק את כתובת ה-callback והדבק כאן:
            </p>
            <input type="text" id="anthropic-code" placeholder="הדבק כתובת callback או קוד...">
            <button onclick="completeLogin('anthropic')" class="secondary">אשר</button>
          </div>
        </div>
        
        <div class="provider-card" id="openai-card">
          <div class="provider-header">
            <span class="provider-icon">🟢</span>
            <div class="provider-info">
              <div class="provider-name">ChatGPT Plus/Pro</div>
              <div class="provider-desc">השתמש במנוי ChatGPT Plus או Pro שלך</div>
            </div>
            <div class="provider-actions">
              <span id="openai-status" class="status-badge"></span>
              <button id="openai-btn" onclick="startLogin('openai-codex')">התחבר</button>
            </div>
          </div>
          <div class="paste-input" id="openai-paste">
            <p style="font-size: 14px; color: #aaa; margin-bottom: 8px;">
              אם הדפדפן לא באותו מחשב, העתק את הקוד או כתובת ה-callback והדבק כאן:
            </p>
            <input type="text" id="openai-code" placeholder="הדבק כתובת callback או קוד...">
            <button onclick="completeLogin('openai-codex')" class="secondary">אשר</button>
          </div>
        </div>
      </div>
      
      <div class="btn-group">
        <button id="continueBtn" onclick="continueSetup()" disabled>המשך</button>
      </div>
    </div>
    <script>
      const providerStatus = { anthropic: false, 'openai-codex': false };
      
      function updateUI() {
        const canContinue = providerStatus.anthropic || providerStatus['openai-codex'];
        document.getElementById('continueBtn').disabled = !canContinue;
        
        if (providerStatus.anthropic) {
          document.getElementById('anthropic-card').classList.add('connected');
          document.getElementById('anthropic-status').className = 'status-badge connected';
          document.getElementById('anthropic-status').textContent = '✓ מחובר';
          document.getElementById('anthropic-btn').textContent = 'מחובר';
          document.getElementById('anthropic-btn').disabled = true;
          document.getElementById('anthropic-paste').classList.remove('show');
        }
        
        if (providerStatus['openai-codex']) {
          document.getElementById('openai-card').classList.add('connected');
          document.getElementById('openai-status').className = 'status-badge connected';
          document.getElementById('openai-status').textContent = '✓ מחובר';
          document.getElementById('openai-btn').textContent = 'מחובר';
          document.getElementById('openai-btn').disabled = true;
          document.getElementById('openai-paste').classList.remove('show');
        }
      }
      
      async function loadProviders() {
        try {
          const res = await fetch('/api/auth/providers');
          const { data } = await res.json();
          
          for (const p of data) {
            if (p.connected) {
              providerStatus[p.id] = true;
            }
          }
          
          updateUI();
        } catch (err) {
          console.error('Failed to load providers:', err);
        }
      }
      
      async function startLogin(provider) {
        const btn = document.getElementById(provider === 'anthropic' ? 'anthropic-btn' : 'openai-btn');
        const status = document.getElementById(provider === 'anthropic' ? 'anthropic-status' : 'openai-status');
        const pasteDiv = document.getElementById(provider === 'anthropic' ? 'anthropic-paste' : 'openai-paste');
        
        btn.disabled = true;
        btn.innerHTML = '<div class="spinner" style="width: 16px; height: 16px; margin: 0 auto;"></div>';
        status.className = 'status-badge pending';
        status.textContent = 'מתחבר...';
        
        try {
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider })
          });
          const { success, data, error } = await res.json();
          
          if (!success) {
            throw new Error(error || 'Login failed');
          }
          
          window.open(data.authorizeUrl, '_blank');
          
          pasteDiv.classList.add('show');
          
          btn.textContent = 'ממתין לאישור...';
          
          pollLoginStatus(provider);
        } catch (err) {
          status.className = 'status-badge error';
          status.textContent = 'שגיאה';
          btn.textContent = 'נסה שוב';
          btn.disabled = false;
          console.error('Login error:', err);
        }
      }
      
      async function completeLogin(provider) {
        const codeInput = document.getElementById(provider === 'anthropic' ? 'anthropic-code' : 'openai-code');
        const code = codeInput.value.trim();
        
        if (!code) {
          alert('הזן קוד או כתובת callback');
          return;
        }
        
        try {
          const res = await fetch('/api/auth/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider, codeOrRedirectUrl: code })
          });
          const { success, error } = await res.json();
          
          if (success) {
            providerStatus[provider] = true;
            updateUI();
          } else {
            alert('שגיאה: ' + (error || 'Unknown error'));
          }
        } catch (err) {
          alert('שגיאה בהתחברות');
          console.error('Complete login error:', err);
        }
      }
      
      async function pollLoginStatus(provider) {
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 3000));
          
          try {
            const res = await fetch('/api/auth/login/' + provider + '/status');
            const { data } = await res.json();
            
            if (data.status === 'connected') {
              providerStatus[provider] = true;
              updateUI();
              return;
            }
          } catch (err) {
            console.error('Poll error:', err);
          }
        }
      }
      
      function continueSetup() {
        location.reload();
      }
      
      loadProviders();
    </script>
    ` : `
    <div class="card">
      <h2>חיבור שירותים</h2>
      <p style="color: #aaa; margin-bottom: 20px;">
        חבר את השירותים שהסוכן יוכל לגשת אליהם דרך Open Connector.
        <br>ניתן לדלג ולחבר מאוחר יותר.
      </p>
      <div id="services">טוען...</div>
      <div class="btn-group">
        <button onclick="completeSetup()">סיום הגדרה</button>
        <a href="/connector/" target="_blank">
          <button type="button" class="secondary">פתח Open Connector</button>
        </a>
      </div>
    </div>
    <script>
      async function loadServices() {
        try {
          const res = await fetch('/api/services');
          const { data } = await res.json();
          const container = document.getElementById('services');
          if (data.length === 0) {
            container.innerHTML = '<p style="color: #aaa;">לא נמצאו שירותים. ודא ש-Open Connector פועל.</p>';
            return;
          }
          container.innerHTML = data.slice(0, 10).map(s => \`
            <div style="display: flex; align-items: center; gap: 12px; padding: 12px; background: rgba(255,255,255,0.05); border-radius: 8px; margin-bottom: 8px;">
              <span style="font-size: 20px;">\${s.isConnected ? '✅' : '⚪'}</span>
              <div style="flex: 1;">
                <strong>\${s.name}</strong>
                \${s.identity ? \`<span style="color: #aaa; font-size: 14px;"> - \${s.identity}</span>\` : ''}
              </div>
            </div>
          \`).join('');
        } catch (err) {
          document.getElementById('services').innerHTML = '<p style="color: #f87171;">שגיאה בטעינת שירותים</p>';
        }
      }
      async function completeSetup() {
        await fetch('/api/setup/complete', { method: 'POST' });
        location.href = '/';
      }
      loadServices();
    </script>
    `}
  </div>
</body>
</html>`;
}

async function getDashboardHtml(settings: ReturnType<typeof loadSettings>, pairingState: { isPaired: boolean; phoneNumber?: string; name?: string }): Promise<string> {
  const providers = await listProviders();
  const modelAliases = getModelAliases();
  
  const currentModelAlias = Object.entries(modelAliases).find(([_, v]) => 
    settings.model.includes(v.model) || settings.model.includes(v.provider)
  )?.[0] || '';
  
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${settings.botName} - לוח בקרה</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f1a;
      min-height: 100vh;
      color: #fff;
    }
    .navbar {
      background: rgba(255,255,255,0.05);
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .navbar h1 { font-size: 20px; }
    .nav-status {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #10b981;
    }
    .status-dot.offline { background: #ef4444; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 20px;
    }
    .card {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 24px;
      border: 1px solid rgba(255,255,255,0.1);
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
      color: #4f46e5;
    }
    .stat-label { color: #888; font-size: 14px; }
    label { display: block; margin-bottom: 8px; font-weight: 500; color: #aaa; }
    input, select {
      width: 100%;
      padding: 10px 14px;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      background: rgba(255,255,255,0.05);
      color: #fff;
      font-size: 14px;
      margin-bottom: 12px;
    }
    input:focus, select:focus { outline: none; border-color: #4f46e5; }
    select option { background: #1a1a2e; }
    button {
      padding: 10px 20px;
      background: #4f46e5;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: #4338ca; }
    button:disabled { background: #666; cursor: not-allowed; }
    button.secondary {
      background: transparent;
      border: 1px solid rgba(255,255,255,0.2);
    }
    button.secondary:hover { background: rgba(255,255,255,0.1); }
    button.danger {
      background: #ef4444;
    }
    button.danger:hover { background: #dc2626; }
    .service-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: rgba(255,255,255,0.03);
      border-radius: 8px;
      margin-bottom: 8px;
    }
    .service-icon { font-size: 24px; }
    .service-info { flex: 1; }
    .service-name { font-weight: 500; }
    .service-status { font-size: 12px; color: #888; }
    .tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 24px;
      background: rgba(255,255,255,0.05);
      padding: 4px;
      border-radius: 8px;
      flex-wrap: wrap;
    }
    .tab {
      padding: 10px 20px;
      background: transparent;
      border: none;
      color: #888;
      cursor: pointer;
      border-radius: 6px;
      transition: all 0.2s;
    }
    .tab.active { background: #4f46e5; color: #fff; }
    .tab:hover:not(.active) { color: #fff; }
    .project-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: rgba(255,255,255,0.03);
      border-radius: 8px;
      margin-bottom: 8px;
      cursor: pointer;
      border: 2px solid transparent;
    }
    .project-item.active { border-color: #4f46e5; }
    .project-item:hover { background: rgba(255,255,255,0.08); }
    .token-input {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }
    .token-input input { margin-bottom: 0; }
    .provider-card {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 12px;
    }
    .provider-card.connected { border-color: #10b981; }
    .provider-header {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .provider-icon { font-size: 28px; }
    .provider-info { flex: 1; }
    .provider-name { font-weight: 600; }
    .provider-desc { color: #888; font-size: 13px; }
    .provider-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      border-radius: 16px;
      font-size: 12px;
    }
    .status-badge.connected { background: rgba(16, 185, 129, 0.2); color: #10b981; }
    .status-badge.pending { background: rgba(251, 191, 36, 0.2); color: #fbbf24; }
    .status-badge.disconnected { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
    .paste-input {
      display: none;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid rgba(255,255,255,0.1);
    }
    .paste-input.show { display: block; }
    .paste-input input { margin-bottom: 8px; }
    .model-picker {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    .model-btn {
      padding: 8px 16px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.2);
      color: #aaa;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.2s;
    }
    .model-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
    .model-btn.active { background: #4f46e5; border-color: #4f46e5; color: #fff; }
    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <nav class="navbar">
    <h1>🤖 ${settings.botName}</h1>
    <div class="nav-status">
      <span class="status-dot ${pairingState.isPaired ? '' : 'offline'}"></span>
      <span>${pairingState.isPaired ? `${pairingState.name || pairingState.phoneNumber}` : 'מנותק'}</span>
    </div>
  </nav>

  <div class="container">
    <div class="tabs">
      <button class="tab active" onclick="showTab('dashboard')">לוח בקרה</button>
      <button class="tab" onclick="showTab('settings')">הגדרות</button>
      <button class="tab" onclick="showTab('ai')">מנויי AI</button>
      <button class="tab" onclick="showTab('projects')">פרויקטים</button>
      <button class="tab" onclick="showTab('services')">שירותים</button>
    </div>

    <div id="dashboard" class="tab-content">
      <div class="grid">
        <div class="card">
          <h2>📱 WhatsApp</h2>
          <div class="stat">${pairingState.isPaired ? '✅' : '❌'}</div>
          <div class="stat-label">${pairingState.isPaired ? 'מחובר' : 'מנותק'}</div>
          ${pairingState.phoneNumber ? `<p style="margin-top: 12px; color: #888;">${pairingState.phoneNumber}</p>` : ''}
        </div>
        <div class="card">
          <h2>🧠 מודל AI</h2>
          <div class="stat" style="font-size: 20px;">${currentModelAlias || 'claude'}</div>
          <div class="stat-label">${settings.model}</div>
        </div>
        <div class="card">
          <h2>🔌 Open Connector</h2>
          <div id="connectorStatus">בודק...</div>
        </div>
      </div>

      <div class="card" style="margin-top: 20px;">
        <h2>📖 איך להשתמש</h2>
        <ol style="color: #aaa; line-height: 2; padding-right: 20px;">
          <li>פתח את WhatsApp בטלפון שחיברת</li>
          <li>שלח הודעה לעצמך (לשיחה שלך)</li>
          <li>הסוכן יענה לך בצ'אט הפרטי</li>
          <li>השתמש ב-/help לראות פקודות זמינות</li>
        </ol>
      </div>
    </div>

    <div id="settings" class="tab-content" style="display: none;">
      <div class="card">
        <h2>⚙️ הגדרות כלליות</h2>
        <form id="settingsForm">
          <label>שם הבוט</label>
          <input type="text" name="botName" value="${settings.botName}">
          
          <label>שם הבעלים</label>
          <input type="text" name="ownerName" value="${settings.ownerName}">
          
          <label>אזור זמן</label>
          <select name="timezone">
            <option value="Asia/Jerusalem" ${settings.timezone === 'Asia/Jerusalem' ? 'selected' : ''}>ישראל</option>
            <option value="UTC" ${settings.timezone === 'UTC' ? 'selected' : ''}>UTC</option>
            <option value="America/New_York" ${settings.timezone === 'America/New_York' ? 'selected' : ''}>ניו יורק</option>
            <option value="Europe/London" ${settings.timezone === 'Europe/London' ? 'selected' : ''}>לונדון</option>
          </select>
          
          <label>מודל AI</label>
          <div class="model-picker">
            <button type="button" class="model-btn ${currentModelAlias === 'claude' || currentModelAlias === 'claude-sonnet' ? 'active' : ''}" onclick="selectModel('claude')">Claude</button>
            <button type="button" class="model-btn ${currentModelAlias === 'claude-opus' ? 'active' : ''}" onclick="selectModel('claude-opus')">Claude Opus</button>
            <button type="button" class="model-btn ${currentModelAlias === 'gpt' || currentModelAlias === 'chatgpt' ? 'active' : ''}" onclick="selectModel('gpt')">GPT</button>
          </div>
          <input type="text" name="model" id="modelInput" value="${settings.model}" style="font-size: 12px;">
          
          <label>מצב מפתחות API</label>
          <select name="apiKeyMode">
            <option value="shared" ${settings.apiKeyMode === 'shared' ? 'selected' : ''}>משותף - טוקן אחד לכל הפרויקטים</option>
            <option value="per-project" ${settings.apiKeyMode === 'per-project' ? 'selected' : ''}>לפי פרויקט - טוקן נפרד לכל פרויקט</option>
          </select>
          
          <button type="submit" style="margin-top: 12px;">שמור</button>
        </form>
      </div>

      <div class="card" style="margin-top: 20px;">
        <h2>🔑 טוקן Open Connector (משותף)</h2>
        <p style="color: #888; margin-bottom: 12px;">משמש כברירת מחדל אם לא הוגדר טוקן ספציפי לפרויקט</p>
        <input type="password" id="sharedToken" placeholder="הזן טוקן משותף" value="${settings.sharedConnectorToken ? '********' : ''}">
        <button onclick="saveSharedToken()">שמור טוקן</button>
      </div>
    </div>

    <div id="ai" class="tab-content" style="display: none;">
      <div class="card">
        <h2>🧠 מנויי AI</h2>
        <p style="color: #aaa; margin-bottom: 20px;">התחבר עם מנוי ה-Claude או ChatGPT שלך. הסוכן ישתמש במנוי שלך לתשובות.</p>
        
        <div id="ai-providers">
          ${providers.map(p => `
            <div class="provider-card ${p.connected ? 'connected' : ''}" id="${p.id}-card">
              <div class="provider-header">
                <span class="provider-icon">${p.id === 'anthropic' ? '🟣' : '🟢'}</span>
                <div class="provider-info">
                  <div class="provider-name">${p.name}</div>
                  <div class="provider-desc">${p.description}</div>
                </div>
                <div class="provider-actions">
                  ${p.connected 
                    ? `<span class="status-badge connected">✓ מחובר</span>
                       <button class="secondary danger" onclick="logoutProvider('${p.id}')">התנתק</button>`
                    : `<span class="status-badge disconnected" id="${p.id}-status">לא מחובר</span>
                       <button id="${p.id}-btn" onclick="startLogin('${p.id}')">התחבר</button>`
                  }
                </div>
              </div>
              <div class="paste-input" id="${p.id}-paste">
                <p style="font-size: 13px; color: #aaa; margin-bottom: 8px;">
                  אם הדפדפן לא באותו מחשב, העתק את כתובת ה-callback והדבק כאן:
                </p>
                <input type="text" id="${p.id}-code" placeholder="הדבק כתובת callback או קוד...">
                <button onclick="completeLogin('${p.id}')" class="secondary">אשר</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>

    <div id="projects" class="tab-content" style="display: none;">
      <div class="card">
        <h2>📁 פרויקטים</h2>
        <p style="color: #888; margin-bottom: 16px;">ניהול פרויקטים וטוקנים לכל פרויקט</p>
        <div id="projectsList">טוען...</div>
        <hr style="border-color: rgba(255,255,255,0.1); margin: 20px 0;">
        <h3 style="margin-bottom: 12px;">צור פרויקט חדש</h3>
        <input type="text" id="newProjectName" placeholder="שם הפרויקט">
        <button onclick="createProject()">צור</button>
      </div>
    </div>

    <div id="services" class="tab-content" style="display: none;">
      <div class="card">
        <h2>🔌 שירותים מחוברים</h2>
        <p style="color: #888; margin-bottom: 16px;">
          ניהול חיבורים ל-Open Connector
          <a href="/connector/" target="_blank" style="color: #4f46e5;">פתח קונסול ←</a>
        </p>
        <div id="servicesList">טוען...</div>
      </div>
    </div>
  </div>

  <script>
    const modelAliases = ${JSON.stringify(modelAliases)};
    
    function selectModel(alias) {
      const config = modelAliases[alias];
      if (config) {
        document.getElementById('modelInput').value = config.provider + '/' + config.model;
        document.querySelectorAll('.model-btn').forEach(btn => btn.classList.remove('active'));
        event.target.classList.add('active');
      }
    }
    
    function showTab(name) {
      document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
      document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
      document.getElementById(name).style.display = 'block';
      document.querySelector(\`[onclick="showTab('\${name}')"]\`).classList.add('active');
      
      if (name === 'projects') loadProjects();
      if (name === 'services') loadServices();
    }

    async function loadConnectorStatus() {
      try {
        const res = await fetch('/api/connector/status');
        const { data } = await res.json();
        document.getElementById('connectorStatus').innerHTML = \`
          <div class="stat">\${data.healthy ? '✅' : '❌'}</div>
          <div class="stat-label">\${data.healthy ? \`\${data.connectionCount} חיבורים\` : 'לא זמין'}</div>
          <p style="margin-top: 12px; color: #888; font-size: 12px;">\${data.url}</p>
        \`;
      } catch {
        document.getElementById('connectorStatus').innerHTML = '<div class="stat">❌</div><div class="stat-label">שגיאה</div>';
      }
    }

    async function loadProjects() {
      try {
        const res = await fetch('/api/projects');
        const { data } = await res.json();
        document.getElementById('projectsList').innerHTML = data.map(p => \`
          <div class="project-item \${p.isActive ? 'active' : ''}" onclick="activateProject('\${p.id}')">
            <div style="flex: 1;">
              <div class="service-name">\${p.name}</div>
              <div class="service-status">\${p.hasToken ? '🔑 יש טוקן' : '⚪ ללא טוקן'}</div>
            </div>
            \${p.isActive ? '<span style="color: #4f46e5;">פעיל</span>' : ''}
          </div>
          <div class="token-input" style="margin-bottom: 16px;">
            <input type="password" id="token-\${p.id}" placeholder="טוקן Open Connector לפרויקט">
            <button onclick="saveProjectToken('\${p.id}')">שמור</button>
          </div>
        \`).join('');
      } catch {
        document.getElementById('projectsList').innerHTML = '<p style="color: #f87171;">שגיאה בטעינת פרויקטים</p>';
      }
    }

    async function loadServices() {
      try {
        const res = await fetch('/api/services');
        const { data } = await res.json();
        document.getElementById('servicesList').innerHTML = data.map(s => \`
          <div class="service-item">
            <span class="service-icon">\${s.isConnected ? '✅' : '⚪'}</span>
            <div class="service-info">
              <div class="service-name">\${s.name}</div>
              <div class="service-status">\${s.identity || (s.isConnected ? 'מחובר' : 'לא מחובר')}</div>
            </div>
          </div>
        \`).join('') || '<p style="color: #888;">לא נמצאו שירותים</p>';
      } catch {
        document.getElementById('servicesList').innerHTML = '<p style="color: #f87171;">שגיאה בטעינת שירותים</p>';
      }
    }

    async function activateProject(id) {
      await fetch(\`/api/projects/\${id}/activate\`, { method: 'PUT' });
      loadProjects();
    }

    async function saveProjectToken(id) {
      const token = document.getElementById(\`token-\${id}\`).value;
      await fetch(\`/api/projects/\${id}/token\`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      loadProjects();
    }

    async function createProject() {
      const name = document.getElementById('newProjectName').value;
      if (!name) return;
      await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      document.getElementById('newProjectName').value = '';
      loadProjects();
    }

    async function saveSharedToken() {
      const token = document.getElementById('sharedToken').value;
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sharedConnectorToken: token })
      });
      alert('נשמר!');
    }

    async function startLogin(provider) {
      const btn = document.getElementById(provider + '-btn');
      const status = document.getElementById(provider + '-status');
      const pasteDiv = document.getElementById(provider + '-paste');
      
      if (!btn) return;
      
      btn.disabled = true;
      btn.innerHTML = '<div class="spinner"></div>';
      if (status) {
        status.className = 'status-badge pending';
        status.textContent = 'מתחבר...';
      }
      
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider })
        });
        const { success, data, error } = await res.json();
        
        if (!success) {
          throw new Error(error || 'Login failed');
        }
        
        window.open(data.authorizeUrl, '_blank');
        pasteDiv.classList.add('show');
        btn.textContent = 'ממתין...';
        
        pollLoginStatus(provider);
      } catch (err) {
        if (status) {
          status.className = 'status-badge disconnected';
          status.textContent = 'שגיאה';
        }
        btn.textContent = 'נסה שוב';
        btn.disabled = false;
        console.error('Login error:', err);
      }
    }
    
    async function completeLogin(provider) {
      const codeInput = document.getElementById(provider + '-code');
      const code = codeInput?.value.trim();
      
      if (!code) {
        alert('הזן קוד או כתובת callback');
        return;
      }
      
      try {
        const res = await fetch('/api/auth/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, codeOrRedirectUrl: code })
        });
        const { success, error } = await res.json();
        
        if (success) {
          location.reload();
        } else {
          alert('שגיאה: ' + (error || 'Unknown error'));
        }
      } catch (err) {
        alert('שגיאה בהתחברות');
        console.error('Complete login error:', err);
      }
    }
    
    async function pollLoginStatus(provider) {
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 3000));
        
        try {
          const res = await fetch('/api/auth/login/' + provider + '/status');
          const { data } = await res.json();
          
          if (data.status === 'connected') {
            location.reload();
            return;
          }
        } catch (err) {
          console.error('Poll error:', err);
        }
      }
    }
    
    async function logoutProvider(provider) {
      if (!confirm('האם אתה בטוח שברצונך להתנתק?')) return;
      
      try {
        const res = await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider })
        });
        const { success, error } = await res.json();
        
        if (success) {
          location.reload();
        } else {
          alert('שגיאה: ' + (error || 'Unknown error'));
        }
      } catch (err) {
        alert('שגיאה בהתנתקות');
        console.error('Logout error:', err);
      }
    }

    document.getElementById('settingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(form.entries()))
      });
      alert('נשמר!');
    });

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
