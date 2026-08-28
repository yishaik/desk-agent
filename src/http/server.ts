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
  const url = parseUrl(req.url ?? '', true);
  const queryToken = url.query['token'] as string | undefined;
  
  if (!isAuthenticated(req)) {
    const loginHtml = getLoginHtml();
    sendHtml(res, loginHtml);
    return;
  }

  if (queryToken === config.pairToken) {
    const isHttps = req.headers['x-forwarded-proto'] === 'https' || 
                    req.headers.host?.startsWith('https') ||
                    config.isProduction;
    const securePart = isHttps ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `PAIR_TOKEN=${queryToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${securePart}`
    );
  }

  const settings = loadSettings();
  const wa = getWhatsAppClient();
  const pairingState = wa.getPairingState();
  const hasAuth = await hasAnyAuthConfigured();

  if (isSetupRequired() || !hasAuth) {
    const onboardingHtml = await getOnboardingHtml(settings, pairingState);
    sendHtml(res, onboardingHtml);
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

const SHARED_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;600;700&family=Inter:wght@400;500;600&display=swap');
  
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  
  :root {
    --bg-primary: #0a0a0f;
    --bg-secondary: #12121a;
    --bg-elevated: #1a1a24;
    --bg-hover: #22222e;
    --border-subtle: rgba(255,255,255,0.06);
    --border-default: rgba(255,255,255,0.1);
    --border-focus: #6366f1;
    --text-primary: #fafafa;
    --text-secondary: #a1a1aa;
    --text-tertiary: #71717a;
    --accent: #6366f1;
    --accent-hover: #818cf8;
    --accent-muted: rgba(99,102,241,0.15);
    --success: #22c55e;
    --success-muted: rgba(34,197,94,0.15);
    --error: #ef4444;
    --error-muted: rgba(239,68,68,0.15);
    --warning: #f59e0b;
    --radius-sm: 6px;
    --radius-md: 10px;
    --radius-lg: 16px;
    --radius-xl: 24px;
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.4);
    --shadow-md: 0 4px 12px rgba(0,0,0,0.5);
    --shadow-lg: 0 8px 24px rgba(0,0,0,0.6);
    --transition-fast: 150ms cubic-bezier(0.4, 0, 0.2, 1);
    --transition-normal: 200ms cubic-bezier(0.4, 0, 0.2, 1);
    --transition-slow: 300ms cubic-bezier(0.4, 0, 0.2, 1);
    --font-sans: 'Heebo', 'Inter', -apple-system, sans-serif;
  }
  
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
  
  html { font-size: 16px; }
  
  body {
    font-family: var(--font-sans);
    background: var(--bg-primary);
    color: var(--text-primary);
    line-height: 1.5;
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  
  ::selection {
    background: var(--accent);
    color: white;
  }
  
  :focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
  
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px 24px;
    font-family: var(--font-sans);
    font-size: 15px;
    font-weight: 500;
    border: none;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }
  
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  
  .btn-primary {
    background: var(--accent);
    color: white;
  }
  
  .btn-primary:hover:not(:disabled) {
    background: var(--accent-hover);
    transform: translateY(-1px);
  }
  
  .btn-primary:active:not(:disabled) {
    transform: translateY(0);
  }
  
  .btn-secondary {
    background: var(--bg-elevated);
    color: var(--text-primary);
    border: 1px solid var(--border-default);
  }
  
  .btn-secondary:hover:not(:disabled) {
    background: var(--bg-hover);
    border-color: var(--border-focus);
  }
  
  .btn-ghost {
    background: transparent;
    color: var(--text-secondary);
  }
  
  .btn-ghost:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  
  .input {
    width: 100%;
    padding: 12px 16px;
    font-family: var(--font-sans);
    font-size: 15px;
    color: var(--text-primary);
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  }
  
  .input::placeholder {
    color: var(--text-tertiary);
  }
  
  .input:hover {
    border-color: var(--border-focus);
  }
  
  .input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-muted);
  }
  
  .label {
    display: block;
    font-size: 14px;
    font-weight: 500;
    color: var(--text-secondary);
    margin-bottom: 8px;
  }
  
  .card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    padding: 24px;
  }
  
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  
  .animate-in {
    animation: fadeIn var(--transition-slow) ease-out;
  }
  
  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--border-default);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
`;

function getLoginHtml(): string {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Desk Agent</title>
  <style>
    ${SHARED_STYLES}
    
    .gate {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: 
        radial-gradient(ellipse at 50% 0%, rgba(99,102,241,0.08) 0%, transparent 50%),
        var(--bg-primary);
    }
    
    .gate-card {
      width: 100%;
      max-width: 400px;
      animation: fadeIn var(--transition-slow) ease-out;
    }
    
    .gate-header {
      text-align: center;
      margin-bottom: 32px;
    }
    
    .gate-logo {
      width: 56px;
      height: 56px;
      background: linear-gradient(135deg, var(--accent) 0%, #8b5cf6 100%);
      border-radius: var(--radius-lg);
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 20px;
      box-shadow: var(--shadow-lg);
    }
    
    .gate-logo svg {
      width: 28px;
      height: 28px;
      color: white;
    }
    
    .gate-title {
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 8px;
      letter-spacing: -0.02em;
    }
    
    .gate-subtitle {
      color: var(--text-secondary);
      font-size: 15px;
    }
    
    .gate-form {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    
    .gate-field {
      position: relative;
    }
    
    .gate-input {
      padding-inline-start: 44px;
    }
    
    .gate-icon {
      position: absolute;
      top: 50%;
      inset-inline-start: 14px;
      transform: translateY(-50%);
      color: var(--text-tertiary);
      pointer-events: none;
    }
    
    .gate-error {
      display: none;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      background: var(--error-muted);
      border: 1px solid rgba(239,68,68,0.2);
      border-radius: var(--radius-md);
      color: var(--error);
      font-size: 14px;
    }
    
    .gate-error.show {
      display: flex;
      animation: fadeIn var(--transition-fast) ease-out;
    }
  </style>
</head>
<body>
  <div class="gate">
    <div class="gate-card card">
      <div class="gate-header">
        <div class="gate-logo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
        </div>
        <h1 class="gate-title">Desk Agent</h1>
        <p class="gate-subtitle">הזן את טוקן הגישה כדי להמשיך</p>
      </div>
      
      <form id="loginForm" class="gate-form">
        <div class="gate-field">
          <label for="token" class="label">טוקן גישה</label>
          <div style="position: relative;">
            <svg class="gate-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            <input 
              type="password" 
              id="token" 
              name="token" 
              class="input gate-input" 
              placeholder="הדבק כאן את הטוקן"
              autocomplete="current-password"
              required
            >
          </div>
        </div>
        
        <div id="error" class="gate-error">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span>טוקן שגוי. בדוק ונסה שוב.</span>
        </div>
        
        <button type="submit" id="submitBtn" class="btn btn-primary" style="width: 100%;">
          <span id="btnText">כניסה</span>
          <div id="btnSpinner" class="spinner" style="display: none;"></div>
        </button>
      </form>
    </div>
  </div>
  
  <script>
    const form = document.getElementById('loginForm');
    const errorEl = document.getElementById('error');
    const submitBtn = document.getElementById('submitBtn');
    const btnText = document.getElementById('btnText');
    const btnSpinner = document.getElementById('btnSpinner');
    
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.classList.remove('show');
      submitBtn.disabled = true;
      btnText.style.display = 'none';
      btnSpinner.style.display = 'block';
      
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
          errorEl.classList.add('show');
          submitBtn.disabled = false;
          btnText.style.display = 'inline';
          btnSpinner.style.display = 'none';
        }
      } catch {
        errorEl.classList.add('show');
        submitBtn.disabled = false;
        btnText.style.display = 'inline';
        btnSpinner.style.display = 'none';
      }
    });
  </script>
</body>
</html>`;
}

async function getOnboardingHtml(settings: ReturnType<typeof loadSettings>, pairingState: { isPaired: boolean; qrCode?: string; phoneNumber?: string; name?: string }): Promise<string> {
  const providers = await listProviders();
  const anthropicConnected = providers.find(p => p.id === 'anthropic')?.connected ?? false;
  const openaiConnected = providers.find(p => p.id === 'openai-codex')?.connected ?? false;
  
  const ownerName = settings.ownerName || pairingState.name || '';
  
  let qrDataUrl = '';
  if (!pairingState.isPaired && pairingState.qrCode) {
    try {
      qrDataUrl = await QRCode.toDataURL(pairingState.qrCode, {
        width: 200,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
    } catch (err) {
      log.error({ err }, 'Failed to generate QR code');
    }
  }
  
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Desk Agent — הגדרה</title>
  <style>
    ${SHARED_STYLES}
    
    .onboard {
      min-height: 100vh;
      padding: 32px 20px;
      background: 
        radial-gradient(ellipse at 30% 0%, rgba(99,102,241,0.06) 0%, transparent 40%),
        radial-gradient(ellipse at 70% 100%, rgba(139,92,246,0.04) 0%, transparent 40%),
        var(--bg-primary);
    }
    
    .onboard-container {
      max-width: 600px;
      margin: 0 auto;
    }
    
    .onboard-header {
      text-align: center;
      margin-bottom: 40px;
      animation: fadeIn var(--transition-slow) ease-out;
    }
    
    .onboard-logo {
      width: 48px;
      height: 48px;
      background: linear-gradient(135deg, var(--accent) 0%, #8b5cf6 100%);
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 16px;
      box-shadow: var(--shadow-lg);
    }
    
    .onboard-logo svg {
      width: 24px;
      height: 24px;
      color: white;
    }
    
    .onboard-title {
      font-size: 26px;
      font-weight: 600;
      letter-spacing: -0.02em;
      margin-bottom: 6px;
    }
    
    .onboard-subtitle {
      color: var(--text-secondary);
      font-size: 15px;
    }
    
    .section {
      margin-bottom: 24px;
      animation: fadeIn var(--transition-slow) ease-out;
      animation-fill-mode: both;
    }
    
    .section:nth-child(2) { animation-delay: 50ms; }
    .section:nth-child(3) { animation-delay: 100ms; }
    .section:nth-child(4) { animation-delay: 150ms; }
    
    .section-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    }
    
    .section-icon {
      width: 36px;
      height: 36px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-secondary);
      flex-shrink: 0;
    }
    
    .section-icon.done {
      background: var(--success-muted);
      border-color: var(--success);
      color: var(--success);
    }
    
    .section-title {
      font-size: 16px;
      font-weight: 600;
    }
    
    .section-desc {
      font-size: 14px;
      color: var(--text-secondary);
    }
    
    /* WhatsApp Section */
    .wa-status {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 16px 20px;
      background: var(--success-muted);
      border: 1px solid rgba(34,197,94,0.2);
      border-radius: var(--radius-md);
    }
    
    .wa-status-icon {
      width: 40px;
      height: 40px;
      background: var(--success);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
    }
    
    .wa-status-text {
      flex: 1;
    }
    
    .wa-status-name {
      font-weight: 600;
      font-size: 15px;
    }
    
    .wa-status-phone {
      color: var(--text-secondary);
      font-size: 14px;
    }
    
    .qr-section {
      text-align: center;
      padding: 24px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
    }
    
    .qr-box {
      display: inline-block;
      background: white;
      padding: 12px;
      border-radius: var(--radius-md);
      margin: 16px 0;
    }
    
    .qr-box img {
      display: block;
      width: 180px;
      height: 180px;
    }
    
    .qr-hint {
      color: var(--text-secondary);
      font-size: 14px;
      line-height: 1.6;
    }
    
    .qr-loading {
      padding: 60px 0;
    }
    
    /* Identity Section */
    .identity-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    
    @media (max-width: 500px) {
      .identity-grid { grid-template-columns: 1fr; }
    }
    
    .identity-field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    
    .identity-field.full {
      grid-column: 1 / -1;
    }
    
    .select {
      width: 100%;
      padding: 12px 16px;
      padding-inline-end: 40px;
      font-family: var(--font-sans);
      font-size: 15px;
      color: var(--text-primary);
      background: var(--bg-secondary);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='%2371717a' viewBox='0 0 16 16'%3E%3Cpath d='M8 10.5l-4-4h8l-4 4z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: left 12px center;
      cursor: pointer;
      transition: border-color var(--transition-fast);
    }
    
    .select:hover { border-color: var(--border-focus); }
    .select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-muted); }
    .select option { background: var(--bg-secondary); }
    
    /* Provider Cards */
    .providers {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    
    .provider {
      display: flex;
      align-items: flex-start;
      gap: 16px;
      padding: 20px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
    }
    
    .provider.connected {
      border-color: var(--success);
      box-shadow: 0 0 0 1px var(--success);
    }
    
    .provider-icon {
      width: 44px;
      height: 44px;
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    
    .provider-icon.claude {
      background: linear-gradient(135deg, #d97706 0%, #c2410c 100%);
    }
    
    .provider-icon.openai {
      background: linear-gradient(135deg, #059669 0%, #047857 100%);
    }
    
    .provider-icon svg {
      width: 22px;
      height: 22px;
      color: white;
    }
    
    .provider-body {
      flex: 1;
      min-width: 0;
    }
    
    .provider-name {
      font-weight: 600;
      font-size: 15px;
      margin-bottom: 2px;
    }
    
    .provider-desc {
      font-size: 13px;
      color: var(--text-secondary);
      margin-bottom: 12px;
    }
    
    .provider-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    
    .provider-error {
      display: none;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      color: var(--error);
      margin-top: 10px;
    }
    
    .provider-error.show {
      display: flex;
    }
    
    .status-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      font-size: 13px;
      font-weight: 500;
      border-radius: 100px;
      background: var(--success-muted);
      color: var(--success);
    }
    
    .paste-section {
      display: none;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border-subtle);
    }
    
    .paste-section.show {
      display: block;
      animation: fadeIn var(--transition-fast) ease-out;
    }
    
    .paste-hint {
      font-size: 13px;
      color: var(--text-tertiary);
      margin-bottom: 8px;
    }
    
    .paste-row {
      display: flex;
      gap: 8px;
    }
    
    .paste-row .input {
      flex: 1;
    }
    
    /* Footer */
    .onboard-footer {
      margin-top: 32px;
      padding-top: 24px;
      border-top: 1px solid var(--border-subtle);
      animation: fadeIn var(--transition-slow) ease-out;
      animation-delay: 200ms;
      animation-fill-mode: both;
    }
    
    .finish-btn {
      width: 100%;
      padding: 16px 24px;
      font-size: 16px;
    }
    
    .finish-hint {
      text-align: center;
      font-size: 13px;
      color: var(--text-tertiary);
      margin-top: 12px;
    }
    
    .error-banner {
      display: none;
      align-items: center;
      gap: 10px;
      padding: 14px 16px;
      background: var(--error-muted);
      border: 1px solid rgba(239,68,68,0.2);
      border-radius: var(--radius-md);
      color: var(--error);
      font-size: 14px;
      margin-bottom: 20px;
    }
    
    .error-banner.show {
      display: flex;
      animation: fadeIn var(--transition-fast) ease-out;
    }
  </style>
</head>
<body>
  <div class="onboard">
    <div class="onboard-container">
      <header class="onboard-header">
        <div class="onboard-logo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
        </div>
        <h1 class="onboard-title">ברוכים הבאים ל-Desk Agent</h1>
        <p class="onboard-subtitle">בואו נגדיר את הסוכן האישי שלכם</p>
      </header>
      
      <div id="errorBanner" class="error-banner">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span id="errorText"></span>
      </div>

      <!-- WhatsApp Section -->
      <section class="section">
        <div class="section-header">
          <div class="section-icon ${pairingState.isPaired ? 'done' : ''}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              ${pairingState.isPaired 
                ? '<polyline points="20 6 9 17 4 12"/>'
                : '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'
              }
            </svg>
          </div>
          <div>
            <div class="section-title">WhatsApp</div>
            <div class="section-desc">${pairingState.isPaired ? 'מחובר ומוכן' : 'חברו את הטלפון שלכם'}</div>
          </div>
        </div>
        
        ${pairingState.isPaired ? `
          <div class="wa-status">
            <div class="wa-status-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
            <div class="wa-status-text">
              <div class="wa-status-name">${pairingState.name || 'WhatsApp מחובר'}</div>
              ${pairingState.phoneNumber ? `<div class="wa-status-phone">${pairingState.phoneNumber}</div>` : ''}
            </div>
          </div>
        ` : `
          <div class="qr-section" id="qrSection">
            ${qrDataUrl ? `
              <div class="qr-box">
                <img id="qrImg" src="${qrDataUrl}" alt="QR Code">
              </div>
              <p class="qr-hint">
                פתחו WhatsApp בטלפון<br>
                הגדרות ← מכשירים מקושרים ← קשר מכשיר
              </p>
            ` : `
              <div class="qr-loading">
                <div class="spinner" style="margin: 0 auto 12px;"></div>
                <p style="color: var(--text-secondary); font-size: 14px;">מחכה ל-QR...</p>
              </div>
            `}
          </div>
        `}
      </section>

      <!-- Identity Section -->
      <section class="section">
        <div class="section-header">
          <div class="section-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
              <circle cx="12" cy="7" r="4"/>
            </svg>
          </div>
          <div>
            <div class="section-title">פרטים</div>
            <div class="section-desc">איך לקרוא לכם ואיפה אתם</div>
          </div>
        </div>
        
        <div class="card">
          <div class="identity-grid">
            <div class="identity-field">
              <label class="label" for="ownerName">שם</label>
              <input type="text" id="ownerName" class="input" value="${ownerName}" placeholder="השם שלכם">
            </div>
            <div class="identity-field">
              <label class="label" for="timezone">אזור זמן</label>
              <select id="timezone" class="select">
                <option value="Asia/Jerusalem" ${settings.timezone === 'Asia/Jerusalem' || !settings.timezone ? 'selected' : ''}>ישראל</option>
                <option value="America/New_York" ${settings.timezone === 'America/New_York' ? 'selected' : ''}>ניו יורק</option>
                <option value="Europe/London" ${settings.timezone === 'Europe/London' ? 'selected' : ''}>לונדון</option>
                <option value="UTC" ${settings.timezone === 'UTC' ? 'selected' : ''}>UTC</option>
              </select>
            </div>
          </div>
        </div>
      </section>

      <!-- AI Subscriptions Section -->
      <section class="section">
        <div class="section-header">
          <div class="section-icon ${anthropicConnected || openaiConnected ? 'done' : ''}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              ${anthropicConnected || openaiConnected 
                ? '<polyline points="20 6 9 17 4 12"/>'
                : '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>'
              }
            </svg>
          </div>
          <div>
            <div class="section-title">מנוי AI</div>
            <div class="section-desc">חברו לפחות מנוי אחד</div>
          </div>
        </div>
        
        <div class="providers">
          <!-- Claude -->
          <div class="provider ${anthropicConnected ? 'connected' : ''}" id="anthropicCard">
            <div class="provider-icon claude">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
              </svg>
            </div>
            <div class="provider-body">
              <div class="provider-name">Claude Pro / Max</div>
              <div class="provider-desc">Anthropic — מתאים לשיחות ארוכות ומשימות מורכבות</div>
              <div class="provider-actions">
                ${anthropicConnected 
                  ? `<span class="status-chip"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> מחובר</span>`
                  : `<button class="btn btn-secondary" id="anthropicBtn" onclick="startLogin('anthropic')">התחברות</button>`
                }
              </div>
              <div class="provider-error" id="anthropicError">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <span id="anthropicErrorText"></span>
              </div>
              <div class="paste-section" id="anthropicPaste">
                <p class="paste-hint">אם הדפדפן לא על אותו מחשב, הדביקו את כתובת ה-callback:</p>
                <div class="paste-row">
                  <input type="text" id="anthropicCode" class="input" placeholder="http://localhost:53692/callback?code=...">
                  <button class="btn btn-secondary" onclick="completePaste('anthropic')">אישור</button>
                </div>
              </div>
            </div>
          </div>
          
          <!-- ChatGPT -->
          <div class="provider ${openaiConnected ? 'connected' : ''}" id="openaiCard">
            <div class="provider-icon openai">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/>
              </svg>
            </div>
            <div class="provider-body">
              <div class="provider-name">ChatGPT Plus / Pro</div>
              <div class="provider-desc">OpenAI — מודל GPT מהיר ויעיל</div>
              <div class="provider-actions">
                ${openaiConnected 
                  ? `<span class="status-chip"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> מחובר</span>`
                  : `<button class="btn btn-secondary" id="openaiBtn" onclick="startLogin('openai-codex')">התחברות</button>`
                }
              </div>
              <div class="provider-error" id="openaiError">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <span id="openaiErrorText"></span>
              </div>
              <div class="paste-section" id="openaiPaste">
                <p class="paste-hint">אם הדפדפן לא על אותו מחשב, הדביקו את הקוד או כתובת ה-callback:</p>
                <div class="paste-row">
                  <input type="text" id="openaiCode" class="input" placeholder="http://127.0.0.1:1455/callback?code=...">
                  <button class="btn btn-secondary" onclick="completePaste('openai-codex')">אישור</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <footer class="onboard-footer">
        <button class="btn btn-primary finish-btn" id="finishBtn" onclick="finishSetup()" ${!anthropicConnected && !openaiConnected ? 'disabled' : ''}>
          <span id="finishText">סיום והמשך</span>
          <div id="finishSpinner" class="spinner" style="display: none;"></div>
        </button>
        <p class="finish-hint" id="finishHint">
          ${!anthropicConnected && !openaiConnected ? 'חברו לפחות מנוי AI אחד כדי להמשיך' : 'הסוכן יהיה מוכן לשימוש'}
        </p>
      </footer>
    </div>
  </div>
  
  <script>
    const state = {
      anthropic: ${anthropicConnected},
      'openai-codex': ${openaiConnected},
      isPaired: ${pairingState.isPaired}
    };
    
    function showError(msg) {
      const banner = document.getElementById('errorBanner');
      document.getElementById('errorText').textContent = msg;
      banner.classList.add('show');
      setTimeout(() => banner.classList.remove('show'), 5000);
    }
    
    function updateFinishButton() {
      const canFinish = state.anthropic || state['openai-codex'];
      const btn = document.getElementById('finishBtn');
      const hint = document.getElementById('finishHint');
      btn.disabled = !canFinish;
      hint.textContent = canFinish ? 'הסוכן יהיה מוכן לשימוש' : 'חברו לפחות מנוי AI אחד כדי להמשיך';
    }
    
    function setProviderConnected(provider) {
      state[provider] = true;
      const card = document.getElementById(provider === 'anthropic' ? 'anthropicCard' : 'openaiCard');
      const paste = document.getElementById(provider === 'anthropic' ? 'anthropicPaste' : 'openaiPaste');
      
      card.classList.add('connected');
      paste.classList.remove('show');
      
      const actionsHtml = \`<span class="status-chip"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> מחובר</span>\`;
      card.querySelector('.provider-actions').innerHTML = actionsHtml;
      
      updateFinishButton();
    }
    
    async function startLogin(provider) {
      const btn = document.getElementById(provider === 'anthropic' ? 'anthropicBtn' : 'openaiBtn');
      const errDiv = document.getElementById(provider === 'anthropic' ? 'anthropicError' : 'openaiError');
      const errText = document.getElementById(provider === 'anthropic' ? 'anthropicErrorText' : 'openaiErrorText');
      const paste = document.getElementById(provider === 'anthropic' ? 'anthropicPaste' : 'openaiPaste');
      
      if (!btn) return;
      
      btn.disabled = true;
      btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;"></div>';
      errDiv.classList.remove('show');
      
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ provider })
        });
        
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'בקשה נכשלה');
        }
        
        const { success, data, error } = await res.json();
        if (!success) throw new Error(error || 'התחברות נכשלה');
        
        window.open(data.authorizeUrl, '_blank');
        paste.classList.add('show');
        btn.textContent = 'ממתין...';
        
        pollStatus(provider);
      } catch (err) {
        errText.textContent = err.message;
        errDiv.classList.add('show');
        btn.textContent = 'נסו שוב';
        btn.disabled = false;
      }
    }
    
    async function completePaste(provider) {
      const input = document.getElementById(provider === 'anthropic' ? 'anthropicCode' : 'openaiCode');
      const errDiv = document.getElementById(provider === 'anthropic' ? 'anthropicError' : 'openaiError');
      const errText = document.getElementById(provider === 'anthropic' ? 'anthropicErrorText' : 'openaiErrorText');
      const code = input.value.trim();
      
      if (!code) {
        errText.textContent = 'הזינו את הקוד או הכתובת';
        errDiv.classList.add('show');
        return;
      }
      
      errDiv.classList.remove('show');
      
      try {
        const res = await fetch('/api/auth/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ provider, codeOrRedirectUrl: code })
        });
        
        const { success, error } = await res.json();
        if (success) {
          setProviderConnected(provider);
        } else {
          errText.textContent = error || 'אישור נכשל';
          errDiv.classList.add('show');
        }
      } catch (err) {
        errText.textContent = 'שגיאת רשת';
        errDiv.classList.add('show');
      }
    }
    
    async function pollStatus(provider) {
      for (let i = 0; i < 90; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const res = await fetch('/api/auth/login/' + provider + '/status', { credentials: 'same-origin' });
          const { data } = await res.json();
          if (data.status === 'connected') {
            setProviderConnected(provider);
            return;
          }
        } catch {}
      }
    }
    
    async function finishSetup() {
      const btn = document.getElementById('finishBtn');
      const text = document.getElementById('finishText');
      const spinner = document.getElementById('finishSpinner');
      
      btn.disabled = true;
      text.style.display = 'none';
      spinner.style.display = 'block';
      
      const ownerName = document.getElementById('ownerName').value.trim();
      const timezone = document.getElementById('timezone').value;
      
      try {
        const settingsRes = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ ownerName, timezone })
        });
        
        if (!settingsRes.ok) throw new Error('שמירת הגדרות נכשלה');
        
        const completeRes = await fetch('/api/setup/complete', {
          method: 'POST',
          credentials: 'same-origin'
        });
        
        if (!completeRes.ok) throw new Error('סיום הגדרה נכשל');
        
        window.location.href = '/';
      } catch (err) {
        showError(err.message);
        btn.disabled = false;
        text.style.display = 'inline';
        spinner.style.display = 'none';
      }
    }
    
    ${!pairingState.isPaired ? `
    async function pollPairing() {
      try {
        const res = await fetch('/api/pairing', { credentials: 'same-origin' });
        if (!res.ok) return setTimeout(pollPairing, 1500);
        
        const { data } = await res.json();
        if (data.isPaired) {
          state.isPaired = true;
          const section = document.querySelector('.qr-section');
          if (section) {
            section.innerHTML = \`
              <div class="wa-status" style="margin: 0;">
                <div class="wa-status-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>
                <div class="wa-status-text">
                  <div class="wa-status-name">\${data.name || 'WhatsApp מחובר'}</div>
                  \${data.phoneNumber ? \`<div class="wa-status-phone">\${data.phoneNumber}</div>\` : ''}
                </div>
              </div>
            \`;
            document.querySelector('.section-icon').classList.add('done');
            document.querySelector('.section-icon').innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
            document.querySelector('.section-desc').textContent = 'מחובר ומוכן';
            
            if (data.name && !document.getElementById('ownerName').value) {
              document.getElementById('ownerName').value = data.name;
            }
          }
          return;
        }
        
        const qrRes = await fetch('/api/pairing/qr', { credentials: 'same-origin' });
        if (qrRes.ok) {
          const { data: qrData } = await qrRes.json();
          if (qrData.qrDataUrl) {
            const img = document.getElementById('qrImg');
            if (img) img.src = qrData.qrDataUrl;
          }
        }
      } catch {}
      setTimeout(pollPairing, 1500);
    }
    pollPairing();
    ` : ''}
  </script>
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
  <title>${settings.botName} — לוח בקרה</title>
  <style>
    ${SHARED_STYLES}
    
    .dashboard {
      min-height: 100vh;
      background: var(--bg-primary);
    }
    
    .nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-subtle);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    
    .nav-brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .nav-logo {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, var(--accent) 0%, #8b5cf6 100%);
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .nav-logo svg {
      width: 18px;
      height: 18px;
      color: white;
    }
    
    .nav-title {
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    
    .nav-status {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      background: var(--bg-elevated);
      border-radius: 100px;
      font-size: 14px;
    }
    
    .status-indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
    }
    
    .status-indicator.offline {
      background: var(--error);
    }
    
    .main {
      max-width: 1100px;
      margin: 0 auto;
      padding: 24px;
    }
    
    .tabs {
      display: flex;
      gap: 4px;
      padding: 4px;
      background: var(--bg-secondary);
      border-radius: var(--radius-md);
      margin-bottom: 24px;
      overflow-x: auto;
    }
    
    .tab {
      padding: 10px 18px;
      font-family: var(--font-sans);
      font-size: 14px;
      font-weight: 500;
      color: var(--text-secondary);
      background: transparent;
      border: none;
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all var(--transition-fast);
      white-space: nowrap;
    }
    
    .tab:hover {
      color: var(--text-primary);
      background: var(--bg-hover);
    }
    
    .tab.active {
      color: white;
      background: var(--accent);
    }
    
    .tab-content {
      animation: fadeIn var(--transition-normal) ease-out;
    }
    
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    
    .stat-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 20px;
      transition: border-color var(--transition-fast);
    }
    
    .stat-card:hover {
      border-color: var(--border-default);
    }
    
    .stat-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 14px;
    }
    
    .stat-icon {
      width: 40px;
      height: 40px;
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
    }
    
    .stat-icon.whatsapp { background: linear-gradient(135deg, #25D366 0%, #128C7E 100%); }
    .stat-icon.ai { background: linear-gradient(135deg, var(--accent) 0%, #8b5cf6 100%); }
    .stat-icon.connector { background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); }
    
    .stat-icon svg {
      width: 20px;
      height: 20px;
    }
    
    .stat-title {
      font-size: 14px;
      color: var(--text-secondary);
    }
    
    .stat-value {
      font-size: 28px;
      font-weight: 600;
      letter-spacing: -0.02em;
      margin-bottom: 4px;
    }
    
    .stat-label {
      font-size: 13px;
      color: var(--text-tertiary);
    }
    
    .section-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 24px;
      margin-bottom: 20px;
    }
    
    .section-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    
    .section-title svg {
      color: var(--text-secondary);
    }
    
    .help-list {
      list-style: none;
      counter-reset: step;
    }
    
    .help-list li {
      counter-increment: step;
      display: flex;
      align-items: flex-start;
      gap: 14px;
      padding: 12px 0;
      border-bottom: 1px solid var(--border-subtle);
      color: var(--text-secondary);
      font-size: 14px;
      line-height: 1.6;
    }
    
    .help-list li:last-child {
      border-bottom: none;
    }
    
    .help-list li::before {
      content: counter(step);
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 50%;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
      flex-shrink: 0;
    }
    
    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
    }
    
    @media (max-width: 600px) {
      .form-grid { grid-template-columns: 1fr; }
    }
    
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    
    .form-group.full {
      grid-column: 1 / -1;
    }
    
    .model-picker {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    
    .model-btn {
      padding: 10px 18px;
      font-family: var(--font-sans);
      font-size: 14px;
      font-weight: 500;
      color: var(--text-secondary);
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      cursor: pointer;
      transition: all var(--transition-fast);
    }
    
    .model-btn:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
    }
    
    .model-btn.active {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }
    
    .provider-card {
      display: flex;
      align-items: flex-start;
      gap: 16px;
      padding: 20px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      margin-bottom: 12px;
      transition: border-color var(--transition-fast);
    }
    
    .provider-card.connected {
      border-color: var(--success);
    }
    
    .provider-icon {
      width: 44px;
      height: 44px;
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    
    .provider-icon.claude {
      background: linear-gradient(135deg, #d97706 0%, #c2410c 100%);
    }
    
    .provider-icon.openai {
      background: linear-gradient(135deg, #059669 0%, #047857 100%);
    }
    
    .provider-icon svg {
      width: 22px;
      height: 22px;
      color: white;
    }
    
    .provider-body {
      flex: 1;
      min-width: 0;
    }
    
    .provider-name {
      font-weight: 600;
      font-size: 15px;
      margin-bottom: 2px;
    }
    
    .provider-desc {
      font-size: 13px;
      color: var(--text-secondary);
      margin-bottom: 12px;
    }
    
    .provider-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    
    .status-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      font-size: 13px;
      font-weight: 500;
      border-radius: 100px;
    }
    
    .status-chip.connected {
      background: var(--success-muted);
      color: var(--success);
    }
    
    .status-chip.disconnected {
      background: var(--error-muted);
      color: var(--error);
    }
    
    .status-chip.pending {
      background: rgba(245,158,11,0.15);
      color: var(--warning);
    }
    
    .btn-danger {
      background: var(--error);
      color: white;
    }
    
    .btn-danger:hover:not(:disabled) {
      background: #dc2626;
    }
    
    .paste-section {
      display: none;
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid var(--border-subtle);
    }
    
    .paste-section.show {
      display: block;
      animation: fadeIn var(--transition-fast) ease-out;
    }
    
    .paste-hint {
      font-size: 13px;
      color: var(--text-tertiary);
      margin-bottom: 8px;
    }
    
    .paste-row {
      display: flex;
      gap: 8px;
    }
    
    .paste-row .input { flex: 1; }
    
    .project-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    
    .project-item {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 14px 16px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      cursor: pointer;
      transition: all var(--transition-fast);
    }
    
    .project-item:hover {
      background: var(--bg-hover);
    }
    
    .project-item.active {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }
    
    .project-info { flex: 1; }
    .project-name { font-weight: 500; font-size: 14px; }
    .project-meta { font-size: 12px; color: var(--text-tertiary); }
    
    .project-badge {
      padding: 4px 10px;
      font-size: 12px;
      font-weight: 500;
      background: var(--accent-muted);
      color: var(--accent);
      border-radius: 100px;
    }
    
    .token-row {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }
    
    .token-row .input {
      flex: 1;
      margin-bottom: 0;
    }
    
    .service-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    
    .service-item {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 14px 16px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
    }
    
    .service-icon {
      width: 36px;
      height: 36px;
      border-radius: var(--radius-sm);
      background: var(--bg-hover);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-secondary);
    }
    
    .service-icon.connected {
      background: var(--success-muted);
      color: var(--success);
    }
    
    .service-info { flex: 1; }
    .service-name { font-weight: 500; font-size: 14px; }
    .service-status { font-size: 12px; color: var(--text-tertiary); }
    
    .external-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--accent);
      font-size: 14px;
      text-decoration: none;
      transition: color var(--transition-fast);
    }
    
    .external-link:hover {
      color: var(--accent-hover);
    }
    
    .divider {
      height: 1px;
      background: var(--border-subtle);
      margin: 20px 0;
    }
    
    .toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%) translateY(100px);
      padding: 12px 20px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-lg);
      font-size: 14px;
      opacity: 0;
      transition: all var(--transition-normal);
      z-index: 1000;
    }
    
    .toast.show {
      transform: translateX(-50%) translateY(0);
      opacity: 1;
    }
  </style>
</head>
<body>
  <div class="dashboard">
    <nav class="nav">
      <div class="nav-brand">
        <div class="nav-logo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
        </div>
        <span class="nav-title">${settings.botName}</span>
      </div>
      <div class="nav-status">
        <span class="status-indicator ${pairingState.isPaired ? '' : 'offline'}"></span>
        <span>${pairingState.isPaired ? (pairingState.name || pairingState.phoneNumber || 'מחובר') : 'מנותק'}</span>
      </div>
    </nav>
    
    <main class="main">
      <div class="tabs">
        <button class="tab active" onclick="showTab('overview')">סקירה</button>
        <button class="tab" onclick="showTab('settings')">הגדרות</button>
        <button class="tab" onclick="showTab('ai')">מנויי AI</button>
        <button class="tab" onclick="showTab('projects')">פרויקטים</button>
        <button class="tab" onclick="showTab('services')">שירותים</button>
      </div>
      
      <!-- Overview Tab -->
      <div id="overview" class="tab-content">
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-header">
              <div class="stat-icon whatsapp">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
                </svg>
              </div>
              <span class="stat-title">WhatsApp</span>
            </div>
            <div class="stat-value">${pairingState.isPaired ? 'מחובר' : 'מנותק'}</div>
            <div class="stat-label">${pairingState.phoneNumber || (pairingState.isPaired ? 'פעיל' : 'לא מקושר')}</div>
          </div>
          
          <div class="stat-card">
            <div class="stat-header">
              <div class="stat-icon ai">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
                  <line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
              </div>
              <span class="stat-title">מודל AI</span>
            </div>
            <div class="stat-value">${currentModelAlias || 'Claude'}</div>
            <div class="stat-label">${settings.model}</div>
          </div>
          
          <div class="stat-card">
            <div class="stat-header">
              <div class="stat-icon connector">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                  <polyline points="15 3 21 3 21 9"/>
                  <line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
              </div>
              <span class="stat-title">Open Connector</span>
            </div>
            <div id="connectorStatus">
              <div class="stat-value">בודק...</div>
            </div>
          </div>
        </div>
        
        <div class="section-card">
          <h2 class="section-title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            איך להשתמש
          </h2>
          <ol class="help-list">
            <li>פתחו את WhatsApp בטלפון שחיברתם</li>
            <li>שלחו הודעה לעצמכם (לשיחה הפרטית שלכם)</li>
            <li>הסוכן יענה לכם אוטומטית בצ'אט</li>
            <li>השתמשו ב-<code style="background:var(--bg-elevated);padding:2px 6px;border-radius:4px;">/help</code> לראות פקודות זמינות</li>
          </ol>
        </div>
      </div>
      
      <!-- Settings Tab -->
      <div id="settings" class="tab-content" style="display: none;">
        <div class="section-card">
          <h2 class="section-title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            הגדרות כלליות
          </h2>
          <form id="settingsForm">
            <div class="form-grid">
              <div class="form-group">
                <label class="label" for="botName">שם הבוט</label>
                <input type="text" id="botName" name="botName" class="input" value="${settings.botName}">
              </div>
              <div class="form-group">
                <label class="label" for="ownerName">שם הבעלים</label>
                <input type="text" id="ownerName" name="ownerName" class="input" value="${settings.ownerName}">
              </div>
              <div class="form-group">
                <label class="label" for="timezone">אזור זמן</label>
                <select id="timezone" name="timezone" class="input" style="padding-inline-end: 40px; background-image: url(\\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='%2371717a' viewBox='0 0 16 16'%3E%3Cpath d='M8 10.5l-4-4h8l-4 4z'/%3E%3C/svg%3E\\"); background-repeat: no-repeat; background-position: left 12px center; appearance: none;">
                  <option value="Asia/Jerusalem" ${settings.timezone === 'Asia/Jerusalem' ? 'selected' : ''}>ישראל</option>
                  <option value="America/New_York" ${settings.timezone === 'America/New_York' ? 'selected' : ''}>ניו יורק</option>
                  <option value="Europe/London" ${settings.timezone === 'Europe/London' ? 'selected' : ''}>לונדון</option>
                  <option value="UTC" ${settings.timezone === 'UTC' ? 'selected' : ''}>UTC</option>
                </select>
              </div>
              <div class="form-group">
                <label class="label" for="apiKeyMode">מצב טוקנים</label>
                <select id="apiKeyMode" name="apiKeyMode" class="input" style="padding-inline-end: 40px; background-image: url(\\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='%2371717a' viewBox='0 0 16 16'%3E%3Cpath d='M8 10.5l-4-4h8l-4 4z'/%3E%3C/svg%3E\\"); background-repeat: no-repeat; background-position: left 12px center; appearance: none;">
                  <option value="shared" ${settings.apiKeyMode === 'shared' ? 'selected' : ''}>משותף</option>
                  <option value="per-project" ${settings.apiKeyMode === 'per-project' ? 'selected' : ''}>לפי פרויקט</option>
                </select>
              </div>
              <div class="form-group full">
                <label class="label">מודל AI</label>
                <div class="model-picker">
                  <button type="button" class="model-btn ${currentModelAlias === 'claude' || currentModelAlias === 'claude-sonnet' ? 'active' : ''}" onclick="selectModel('claude')">Claude</button>
                  <button type="button" class="model-btn ${currentModelAlias === 'claude-opus' ? 'active' : ''}" onclick="selectModel('claude-opus')">Claude Opus</button>
                  <button type="button" class="model-btn ${currentModelAlias === 'gpt' || currentModelAlias === 'chatgpt' ? 'active' : ''}" onclick="selectModel('gpt')">GPT</button>
                </div>
                <input type="text" id="modelInput" name="model" class="input" value="${settings.model}" style="font-size: 13px; color: var(--text-secondary);">
              </div>
            </div>
            <button type="submit" class="btn btn-primary" style="margin-top: 8px;">שמור שינויים</button>
          </form>
        </div>
        
        <div class="section-card">
          <h2 class="section-title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            טוקן Open Connector
          </h2>
          <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 16px;">טוקן משותף לכל הפרויקטים (ניתן להגדיר טוקן נפרד לכל פרויקט)</p>
          <div class="token-row">
            <input type="password" id="sharedToken" class="input" placeholder="הזינו טוקן משותף" value="${settings.sharedConnectorToken ? '••••••••' : ''}">
            <button class="btn btn-secondary" onclick="saveSharedToken()">שמור</button>
          </div>
        </div>
      </div>
      
      <!-- AI Tab -->
      <div id="ai" class="tab-content" style="display: none;">
        <div class="section-card">
          <h2 class="section-title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            מנויי AI
          </h2>
          <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 20px;">חברו את המנוי שלכם ל-Claude או ChatGPT. הסוכן ישתמש במנוי שלכם.</p>
          
          ${providers.map(p => `
          <div class="provider-card ${p.connected ? 'connected' : ''}" id="${p.id}-card">
            <div class="provider-icon ${p.id === 'anthropic' ? 'claude' : 'openai'}">
              <svg viewBox="0 0 24 24" fill="currentColor">
                ${p.id === 'anthropic' 
                  ? '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>'
                  : '<path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073z"/>'
                }
              </svg>
            </div>
            <div class="provider-body">
              <div class="provider-name">${p.name}</div>
              <div class="provider-desc">${p.description}</div>
              <div class="provider-actions">
                ${p.connected 
                  ? `<span class="status-chip connected">
                       <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                       מחובר
                     </span>
                     <button class="btn btn-danger" onclick="logoutProvider('${p.id}')">התנתק</button>`
                  : `<span class="status-chip disconnected" id="${p.id}-status">לא מחובר</span>
                     <button class="btn btn-secondary" id="${p.id}-btn" onclick="startLogin('${p.id}')">התחברות</button>`
                }
              </div>
              <div class="paste-section" id="${p.id}-paste">
                <p class="paste-hint">אם הדפדפן לא על אותו מחשב, הדביקו את כתובת ה-callback:</p>
                <div class="paste-row">
                  <input type="text" id="${p.id}-code" class="input" placeholder="http://localhost:.../callback?code=...">
                  <button class="btn btn-secondary" onclick="completeLogin('${p.id}')">אישור</button>
                </div>
              </div>
            </div>
          </div>
          `).join('')}
        </div>
      </div>
      
      <!-- Projects Tab -->
      <div id="projects" class="tab-content" style="display: none;">
        <div class="section-card">
          <h2 class="section-title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            פרויקטים
          </h2>
          <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 16px;">ניהול פרויקטים וטוקנים</p>
          <div id="projectsList" class="project-list">טוען...</div>
          
          <div class="divider"></div>
          
          <h3 style="font-size: 15px; font-weight: 600; margin-bottom: 12px;">פרויקט חדש</h3>
          <div class="token-row">
            <input type="text" id="newProjectName" class="input" placeholder="שם הפרויקט">
            <button class="btn btn-primary" onclick="createNewProject()">צור</button>
          </div>
        </div>
      </div>
      
      <!-- Services Tab -->
      <div id="services" class="tab-content" style="display: none;">
        <div class="section-card">
          <h2 class="section-title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/>
              <line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            שירותים מחוברים
          </h2>
          <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 16px;">
            שירותים מחוברים דרך Open Connector
            <a href="/connector/" target="_blank" class="external-link" style="margin-inline-start: 12px;">
              פתח קונסול
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
            </a>
          </p>
          <div id="servicesList" class="service-list">טוען...</div>
        </div>
      </div>
    </main>
    
    <div id="toast" class="toast"></div>
  </div>
  
  <script>
    const modelAliases = ${JSON.stringify(modelAliases)};
    
    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 3000);
    }
    
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
      event.target.classList.add('active');
      
      if (name === 'projects') loadProjects();
      if (name === 'services') loadServices();
    }
    
    async function loadConnectorStatus() {
      try {
        const res = await fetch('/api/connector/status', { credentials: 'same-origin' });
        const { data } = await res.json();
        document.getElementById('connectorStatus').innerHTML = \`
          <div class="stat-value">\${data.healthy ? 'פעיל' : 'לא זמין'}</div>
          <div class="stat-label">\${data.healthy ? \`\${data.connectionCount} חיבורים\` : 'בדוק הגדרות'}</div>
        \`;
      } catch {
        document.getElementById('connectorStatus').innerHTML = '<div class="stat-value">שגיאה</div>';
      }
    }
    
    async function loadProjects() {
      try {
        const res = await fetch('/api/projects', { credentials: 'same-origin' });
        const { data } = await res.json();
        document.getElementById('projectsList').innerHTML = data.length > 0 
          ? data.map(p => \`
              <div class="project-item \${p.isActive ? 'active' : ''}" onclick="activateProject('\${p.id}')">
                <div class="project-info">
                  <div class="project-name">\${p.name}</div>
                  <div class="project-meta">\${p.hasToken ? 'יש טוקן' : 'ללא טוקן'}</div>
                </div>
                \${p.isActive ? '<span class="project-badge">פעיל</span>' : ''}
              </div>
              <div class="token-row" style="margin-bottom: 12px;">
                <input type="password" id="token-\${p.id}" class="input" placeholder="טוקן Open Connector">
                <button class="btn btn-secondary" onclick="event.stopPropagation(); saveProjectToken('\${p.id}')">שמור</button>
              </div>
            \`).join('')
          : '<p style="color: var(--text-tertiary);">אין פרויקטים</p>';
      } catch {
        document.getElementById('projectsList').innerHTML = '<p style="color: var(--error);">שגיאה בטעינה</p>';
      }
    }
    
    async function loadServices() {
      try {
        const res = await fetch('/api/services', { credentials: 'same-origin' });
        const { data } = await res.json();
        document.getElementById('servicesList').innerHTML = data.length > 0
          ? data.map(s => \`
              <div class="service-item">
                <div class="service-icon \${s.isConnected ? 'connected' : ''}">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    \${s.isConnected 
                      ? '<polyline points="20 6 9 17 4 12"/>'
                      : '<circle cx="12" cy="12" r="10"/>'
                    }
                  </svg>
                </div>
                <div class="service-info">
                  <div class="service-name">\${s.name}</div>
                  <div class="service-status">\${s.identity || (s.isConnected ? 'מחובר' : 'לא מחובר')}</div>
                </div>
              </div>
            \`).join('')
          : '<p style="color: var(--text-tertiary);">לא נמצאו שירותים</p>';
      } catch {
        document.getElementById('servicesList').innerHTML = '<p style="color: var(--error);">שגיאה בטעינה</p>';
      }
    }
    
    async function activateProject(id) {
      await fetch(\`/api/projects/\${id}/activate\`, { method: 'PUT', credentials: 'same-origin' });
      loadProjects();
    }
    
    async function saveProjectToken(id) {
      const token = document.getElementById('token-' + id).value;
      await fetch(\`/api/projects/\${id}/token\`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ token })
      });
      showToast('נשמר!');
      loadProjects();
    }
    
    async function createNewProject() {
      const name = document.getElementById('newProjectName').value.trim();
      if (!name) return;
      await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name })
      });
      document.getElementById('newProjectName').value = '';
      showToast('נוצר!');
      loadProjects();
    }
    
    async function saveSharedToken() {
      const token = document.getElementById('sharedToken').value;
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ sharedConnectorToken: token })
      });
      showToast('נשמר!');
    }
    
    async function startLogin(provider) {
      const btn = document.getElementById(provider + '-btn');
      const status = document.getElementById(provider + '-status');
      const paste = document.getElementById(provider + '-paste');
      
      if (!btn) return;
      
      btn.disabled = true;
      btn.innerHTML = '<div class="spinner"></div>';
      if (status) {
        status.className = 'status-chip pending';
        status.textContent = 'מתחבר...';
      }
      
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ provider })
        });
        const { success, data, error } = await res.json();
        
        if (!success) throw new Error(error || 'Login failed');
        
        window.open(data.authorizeUrl, '_blank');
        paste.classList.add('show');
        btn.textContent = 'ממתין...';
        
        pollLoginStatus(provider);
      } catch (err) {
        if (status) {
          status.className = 'status-chip disconnected';
          status.textContent = 'שגיאה';
        }
        btn.textContent = 'נסו שוב';
        btn.disabled = false;
      }
    }
    
    async function completeLogin(provider) {
      const code = document.getElementById(provider + '-code')?.value.trim();
      if (!code) {
        showToast('הזינו קוד או כתובת callback');
        return;
      }
      
      try {
        const res = await fetch('/api/auth/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ provider, codeOrRedirectUrl: code })
        });
        const { success, error } = await res.json();
        
        if (success) {
          location.reload();
        } else {
          showToast('שגיאה: ' + (error || 'נכשל'));
        }
      } catch {
        showToast('שגיאת רשת');
      }
    }
    
    async function pollLoginStatus(provider) {
      for (let i = 0; i < 90; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const res = await fetch('/api/auth/login/' + provider + '/status', { credentials: 'same-origin' });
          const { data } = await res.json();
          if (data.status === 'connected') {
            location.reload();
            return;
          }
        } catch {}
      }
    }
    
    async function logoutProvider(provider) {
      if (!confirm('להתנתק מהמנוי?')) return;
      
      try {
        const res = await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ provider })
        });
        const { success, error } = await res.json();
        
        if (success) {
          location.reload();
        } else {
          showToast('שגיאה: ' + (error || 'נכשל'));
        }
      } catch {
        showToast('שגיאת רשת');
      }
    }
    
    document.getElementById('settingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(Object.fromEntries(form.entries()))
      });
      showToast('נשמר!');
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
