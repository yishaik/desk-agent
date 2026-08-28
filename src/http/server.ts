import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { parse as parseUrl } from 'node:url';
import { config } from '../core/config.ts';
import { createChildLogger } from '../core/logger.ts';
import {
  loadSettings,
  updateSettings,
  setProjectToken,
  removeProjectToken,
  markSetupComplete,
  isSetupRequired,
} from '../core/settings.ts';
import { listProjects, createProject, getProject } from '../core/memory.ts';
import { getWhatsAppClient } from '../whatsapp/client.ts';
import { createClient } from '../open-connector/client.ts';
import { CUSTOMER_TOOLS } from '../core/types.ts';
import type { CustomerTool } from '../core/types.ts';

const log = createChildLogger('http');

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

function extractToken(req: IncomingMessage): string | undefined {
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

  return queryToken ?? cookieToken ?? bearerToken;
}

function isAuthenticated(req: IncomingMessage): boolean {
  const token = extractToken(req);
  return token === config.pairToken;
}

function isHttpsRequest(req: IncomingMessage): boolean {
  return req.headers['x-forwarded-proto'] === 'https' || 
         (req.headers.host?.startsWith('https') ?? false) ||
         config.isProduction;
}

function setAuthCookie(res: ServerResponse, token: string, isHttps: boolean): void {
  const securePart = isHttps ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `PAIR_TOKEN=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${securePart}`
  );
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

// Health check (no auth required)
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

// Main entry point - handles token from URL, shows appropriate page
addRoute('GET', '/', async (req, res) => {
  const url = parseUrl(req.url ?? '', true);
  const queryToken = url.query['token'] as string | undefined;
  
  // If token in URL matches, set cookie and redirect to clean URL
  if (queryToken === config.pairToken) {
    setAuthCookie(res, queryToken, isHttpsRequest(req));
    redirect(res, '/');
    return;
  }

  if (!isAuthenticated(req)) {
    sendHtml(res, getInviteGateHtml());
    return;
  }

  const settings = loadSettings();
  const wa = getWhatsAppClient();
  const pairingState = wa.getPairingState();

  // If setup complete and WhatsApp paired, show home
  if (settings.setupComplete && pairingState.isPaired) {
    sendHtml(res, getHomeHtml(settings, pairingState));
    return;
  }

  // Otherwise show first-run onboarding
  sendHtml(res, getFirstRunHtml(settings, pairingState));
});

// Auth endpoint - validates invite code and sets cookie
addRoute('POST', '/auth', async (req, res) => {
  const body = await parseBody<{ code?: string }>(req).catch(() => ({ code: undefined }));
  const code = body.code;

  if (code === config.pairToken) {
    setAuthCookie(res, code, isHttpsRequest(req));
    sendJson(res, { success: true });
  } else {
    sendError(res, 'קוד הזמנה שגוי', 401);
  }
});

// Customer API: Get pairing state (for polling)
addRoute('GET', '/api/pairing', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const wa = getWhatsAppClient();
  const state = wa.getPairingState();
  
  sendJson(res, { 
    success: true, 
    data: {
      isPaired: state.isPaired,
      qrCode: state.qrCode,
      phoneNumber: state.phoneNumber,
      name: state.name,
    }
  });
});

// Customer API: Get settings (safe subset for customer)
addRoute('GET', '/api/settings', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const settings = loadSettings();
  const wa = getWhatsAppClient();
  const pairingState = wa.getPairingState();
  
  // Return only customer-safe settings
  sendJson(res, { 
    success: true, 
    data: {
      ownerName: settings.ownerName,
      businessName: settings.businessName,
      timezone: settings.timezone,
      setupComplete: settings.setupComplete,
      whatsappPaired: pairingState.isPaired,
      whatsappName: pairingState.name,
      whatsappPhone: pairingState.phoneNumber,
    }
  });
});

// Customer API: Update settings (customer-safe fields only)
addRoute('PUT', '/api/settings', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const body = await parseBody<Partial<{
    ownerName: string;
    businessName: string;
    timezone: string;
  }>>(req);

  const updates: Partial<typeof body> = {};
  if (body.ownerName !== undefined) updates.ownerName = body.ownerName;
  if (body.businessName !== undefined) updates.businessName = body.businessName;
  if (body.timezone !== undefined) updates.timezone = body.timezone;

  const settings = updateSettings(updates);
  sendJson(res, { 
    success: true, 
    data: {
      ownerName: settings.ownerName,
      businessName: settings.businessName,
      timezone: settings.timezone,
    }
  });
});

// Customer API: Get tools with Hebrew names and connection status
addRoute('GET', '/api/tools', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const settings = loadSettings();
  const connector = createClient(settings.activeProject);

  try {
    const connections = await connector.listConnections().catch(() => []);
    const connectedServices = new Set(connections.map(c => c.service));
    
    const tools: CustomerTool[] = CUSTOMER_TOOLS.map(tool => {
      const connection = connections.find(c => c.service === tool.serviceId);
      return {
        ...tool,
        isConnected: connectedServices.has(tool.serviceId),
        identity: connection?.identity?.label,
      };
    });

    sendJson(res, { success: true, data: tools });
  } catch {
    // Return tools with unknown connection status if connector is down
    const tools: CustomerTool[] = CUSTOMER_TOOLS.map(tool => ({
      ...tool,
      isConnected: false,
    }));
    sendJson(res, { success: true, data: tools, connectorAvailable: false });
  }
});

// Customer API: Get connector status
addRoute('GET', '/api/connector/status', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const settings = loadSettings();
  const connector = createClient(settings.activeProject);

  try {
    const healthy = await connector.checkHealth();
    sendJson(res, {
      success: true,
      data: { available: healthy },
    });
  } catch {
    sendJson(res, {
      success: true,
      data: { available: false },
    });
  }
});

// Customer API: Connect a tool (redirects to OAuth)
addRoute('POST', '/api/tools/:id/connect', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const url = parseUrl(req.url ?? '', true);
  const toolId = url.pathname?.split('/')[3];
  const tool = CUSTOMER_TOOLS.find(t => t.id === toolId);
  
  if (!tool) {
    sendError(res, 'כלי לא נמצא', 404);
    return;
  }

  // Return the OAuth URL for the connector
  const oauthUrl = `${config.openConnectorUrl}/connect/${tool.serviceId}`;
  sendJson(res, { 
    success: true, 
    data: { 
      connectUrl: oauthUrl,
      serviceId: tool.serviceId,
    }
  });
});

// Customer API: Complete setup
addRoute('POST', '/api/setup/complete', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const settings = loadSettings();
  const wa = getWhatsAppClient();
  const pairingState = wa.getPairingState();

  // Require WhatsApp paired and name filled
  if (!pairingState.isPaired) {
    sendError(res, 'יש לחבר WhatsApp קודם', 400);
    return;
  }

  if (!settings.ownerName.trim()) {
    sendError(res, 'יש למלא שם', 400);
    return;
  }

  markSetupComplete();
  sendJson(res, { success: true });
});

// ============================================
// OPERATOR ROUTES (hidden from first-run)
// ============================================

// Operator settings page
addRoute('GET', '/setup/operator', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  sendHtml(res, getOperatorHtml());
});

// Operator API: Get full settings
addRoute('GET', '/api/operator/settings', async (req, res) => {
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

// Operator API: Update full settings
addRoute('PUT', '/api/operator/settings', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  const body = await parseBody<Partial<{
    botName: string;
    ownerName: string;
    businessName: string;
    timezone: string;
    model: string;
    apiKeyMode: 'shared' | 'per-project';
    sharedConnectorToken: string;
  }>>(req);

  const settings = updateSettings(body);
  sendJson(res, { success: true, data: { ...settings, sharedConnectorToken: '***' } });
});

// Operator API: Projects
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

// Operator API: Services
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

// ============================================
// HTML TEMPLATES
// ============================================

function getInviteGateHtml(): string {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ברוכים הבאים</title>
  <style>
${getBaseStyles()}
    .gate-card {
      background: rgba(255,255,255,0.08);
      backdrop-filter: blur(20px);
      border-radius: 24px;
      padding: 48px 40px;
      width: 100%;
      max-width: 380px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.4);
      border: 1px solid rgba(255,255,255,0.1);
    }
    .logo {
      width: 80px;
      height: 80px;
      background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
      border-radius: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 36px;
      margin: 0 auto 24px;
      box-shadow: 0 8px 24px rgba(37, 211, 102, 0.3);
    }
    h1 {
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 8px;
      color: #fff;
    }
    .subtitle {
      color: rgba(255,255,255,0.6);
      margin-bottom: 32px;
      font-size: 15px;
    }
    .input-group { margin-bottom: 24px; }
    .input-group label {
      display: block;
      margin-bottom: 8px;
      font-weight: 500;
      font-size: 14px;
      color: rgba(255,255,255,0.8);
    }
    .input-group input {
      width: 100%;
      padding: 14px 18px;
      border: 2px solid rgba(255,255,255,0.15);
      border-radius: 12px;
      background: rgba(255,255,255,0.05);
      color: #fff;
      font-size: 16px;
      transition: all 200ms ease;
      text-align: center;
      letter-spacing: 2px;
    }
    .input-group input:focus {
      outline: none;
      border-color: #25D366;
      background: rgba(255,255,255,0.08);
    }
    .input-group input::placeholder {
      color: rgba(255,255,255,0.3);
      letter-spacing: normal;
    }
    .submit-btn {
      width: 100%;
      padding: 16px;
      background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
      color: #fff;
      border: none;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 200ms ease;
      position: relative;
    }
    .submit-btn:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(37, 211, 102, 0.4);
    }
    .submit-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .error-msg {
      color: #ff6b6b;
      font-size: 14px;
      margin-top: 16px;
      display: none;
      padding: 12px;
      background: rgba(255, 107, 107, 0.1);
      border-radius: 8px;
      border: 1px solid rgba(255, 107, 107, 0.2);
    }
    .error-msg.visible { display: block; }
  </style>
</head>
<body>
  <div class="gate-card">
    <div class="logo">💬</div>
    <h1>ברוכים הבאים</h1>
    <p class="subtitle">הזינו את קוד ההזמנה שקיבלתם</p>
    
    <form id="inviteForm">
      <div class="input-group">
        <label for="code">קוד הזמנה</label>
        <input 
          type="text" 
          id="code" 
          name="code" 
          placeholder="הזינו כאן" 
          autocomplete="off"
          required
        >
      </div>
      <button type="submit" class="submit-btn" id="submitBtn">כניסה</button>
    </form>
    
    <div class="error-msg" id="error">קוד הזמנה שגוי</div>
  </div>

  <script>
    const form = document.getElementById('inviteForm');
    const btn = document.getElementById('submitBtn');
    const error = document.getElementById('error');
    const codeInput = document.getElementById('code');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.classList.remove('visible');
      btn.disabled = true;
      btn.textContent = 'מתחבר...';

      try {
        const res = await fetch('/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ code: codeInput.value.trim() })
        });
        
        if (res.ok) {
          window.location.href = '/';
        } else {
          error.classList.add('visible');
          btn.disabled = false;
          btn.textContent = 'כניסה';
        }
      } catch {
        error.textContent = 'שגיאת חיבור';
        error.classList.add('visible');
        btn.disabled = false;
        btn.textContent = 'כניסה';
      }
    });

    codeInput.addEventListener('input', () => {
      error.classList.remove('visible');
    });
  </script>
</body>
</html>`;
}

function getFirstRunHtml(settings: ReturnType<typeof loadSettings>, pairingState: { isPaired: boolean; qrCode?: string; phoneNumber?: string; name?: string }): string {
  const waName = pairingState.name || settings.ownerName || '';
  
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>הגדרה ראשונית</title>
  <style>
${getBaseStyles()}
    .container {
      max-width: 520px;
      width: 100%;
      padding: 24px;
    }
    .header {
      text-align: center;
      margin-bottom: 32px;
    }
    .logo {
      width: 72px;
      height: 72px;
      background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
      border-radius: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
      margin: 0 auto 16px;
      box-shadow: 0 8px 24px rgba(37, 211, 102, 0.3);
    }
    h1 {
      font-size: 26px;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .subtitle {
      color: rgba(255,255,255,0.5);
      font-size: 14px;
    }
    
    .card {
      background: rgba(255,255,255,0.06);
      backdrop-filter: blur(20px);
      border-radius: 20px;
      padding: 24px;
      margin-bottom: 16px;
      border: 1px solid rgba(255,255,255,0.08);
      transition: all 200ms ease;
    }
    .card-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .card-title .icon {
      width: 32px;
      height: 32px;
      background: rgba(255,255,255,0.1);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
    }
    
    /* WhatsApp Section */
    .wa-connected {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px;
      background: rgba(37, 211, 102, 0.15);
      border-radius: 12px;
      border: 1px solid rgba(37, 211, 102, 0.3);
    }
    .wa-connected .check {
      width: 40px;
      height: 40px;
      background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      flex-shrink: 0;
    }
    .wa-connected .info { flex: 1; }
    .wa-connected .name { font-weight: 600; font-size: 15px; }
    .wa-connected .phone { color: rgba(255,255,255,0.5); font-size: 13px; direction: ltr; text-align: right; }
    
    .qr-section { text-align: center; }
    .qr-wrapper {
      background: #fff;
      padding: 16px;
      border-radius: 12px;
      display: inline-block;
      margin: 16px 0;
    }
    #qrCanvas { display: block; }
    .qr-hint {
      color: rgba(255,255,255,0.5);
      font-size: 13px;
      line-height: 1.6;
    }
    .qr-loading {
      padding: 40px;
      color: rgba(255,255,255,0.5);
    }
    
    /* Identity Section */
    .form-row {
      margin-bottom: 16px;
    }
    .form-row:last-child { margin-bottom: 0; }
    .form-row label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: rgba(255,255,255,0.6);
      margin-bottom: 6px;
    }
    .form-row input, .form-row select {
      width: 100%;
      padding: 12px 16px;
      border: 2px solid rgba(255,255,255,0.1);
      border-radius: 10px;
      background: rgba(255,255,255,0.05);
      color: #fff;
      font-size: 15px;
      transition: all 150ms ease;
    }
    .form-row input:focus, .form-row select:focus {
      outline: none;
      border-color: #25D366;
      background: rgba(255,255,255,0.08);
    }
    .form-row input::placeholder {
      color: rgba(255,255,255,0.3);
    }
    .form-row select {
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='white'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: left 12px center;
      background-size: 16px;
      padding-left: 40px;
    }
    .form-row select option {
      background: #1a1a2e;
    }
    
    /* Tools Section */
    .tools-grid {
      display: grid;
      gap: 10px;
    }
    .tool-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px;
      background: rgba(255,255,255,0.03);
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.06);
      cursor: pointer;
      transition: all 150ms ease;
    }
    .tool-item:hover {
      background: rgba(255,255,255,0.06);
      border-color: rgba(255,255,255,0.1);
    }
    .tool-item.connected {
      border-color: rgba(37, 211, 102, 0.3);
      background: rgba(37, 211, 102, 0.08);
    }
    .tool-icon {
      width: 36px;
      height: 36px;
      background: rgba(255,255,255,0.1);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
    }
    .tool-info { flex: 1; }
    .tool-name { font-weight: 500; font-size: 14px; }
    .tool-desc { color: rgba(255,255,255,0.4); font-size: 12px; }
    .tool-status {
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 20px;
      font-weight: 500;
    }
    .tool-status.connected {
      background: rgba(37, 211, 102, 0.2);
      color: #25D366;
    }
    .tool-status.connect {
      background: rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.6);
    }
    .tools-note {
      color: rgba(255,255,255,0.4);
      font-size: 12px;
      margin-top: 12px;
      text-align: center;
    }
    .tools-unavailable {
      color: rgba(255,255,255,0.4);
      font-size: 13px;
      text-align: center;
      padding: 16px;
    }
    
    /* Finish Button */
    .finish-section {
      margin-top: 24px;
    }
    .finish-btn {
      width: 100%;
      padding: 18px;
      background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
      color: #fff;
      border: none;
      border-radius: 14px;
      font-size: 17px;
      font-weight: 600;
      cursor: pointer;
      transition: all 200ms ease;
      position: relative;
    }
    .finish-btn:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 12px 32px rgba(37, 211, 102, 0.4);
    }
    .finish-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      background: rgba(255,255,255,0.1);
    }
    .finish-hint {
      color: rgba(255,255,255,0.4);
      font-size: 12px;
      text-align: center;
      margin-top: 12px;
    }
    
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        transition-duration: 0.01ms !important;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">💬</div>
      <h1>בואו נתחיל</h1>
      <p class="subtitle">הגדרת הסוכן האישי שלכם</p>
    </div>

    <!-- WhatsApp Card -->
    <div class="card" id="waCard">
      <div class="card-title">
        <div class="icon">📱</div>
        <span>חיבור WhatsApp</span>
      </div>
      <div id="waContent">
        ${pairingState.isPaired ? `
        <div class="wa-connected">
          <div class="check">✓</div>
          <div class="info">
            <div class="name">${pairingState.name || 'מחובר'}</div>
            <div class="phone">${pairingState.phoneNumber || ''}</div>
          </div>
        </div>
        ` : `
        <div class="qr-section">
          <div class="qr-wrapper">
            <div id="qrContainer" class="qr-loading">טוען...</div>
          </div>
          <p class="qr-hint">
            פתחו WhatsApp בטלפון<br>
            הגדרות ← מכשירים מקושרים ← קישור מכשיר
          </p>
        </div>
        `}
      </div>
    </div>

    <!-- Identity Card -->
    <div class="card">
      <div class="card-title">
        <div class="icon">👤</div>
        <span>פרטים</span>
      </div>
      <form id="identityForm">
        <div class="form-row">
          <label for="ownerName">שם</label>
          <input 
            type="text" 
            id="ownerName" 
            name="ownerName" 
            value="${escapeHtml(waName)}"
            placeholder="השם שלכם"
            required
          >
        </div>
        <div class="form-row">
          <label for="businessName">שם העסק</label>
          <input 
            type="text" 
            id="businessName" 
            name="businessName" 
            value="${escapeHtml(settings.businessName)}"
            placeholder="אופציונלי"
          >
        </div>
        <div class="form-row">
          <label for="timezone">אזור זמן</label>
          <select id="timezone" name="timezone">
            <option value="Asia/Jerusalem" ${settings.timezone === 'Asia/Jerusalem' ? 'selected' : ''}>ישראל</option>
            <option value="UTC" ${settings.timezone === 'UTC' ? 'selected' : ''}>UTC</option>
            <option value="America/New_York" ${settings.timezone === 'America/New_York' ? 'selected' : ''}>ניו יורק</option>
            <option value="Europe/London" ${settings.timezone === 'Europe/London' ? 'selected' : ''}>לונדון</option>
          </select>
        </div>
      </form>
    </div>

    <!-- Tools Card -->
    <div class="card">
      <div class="card-title">
        <div class="icon">🔧</div>
        <span>כלים</span>
      </div>
      <div id="toolsContent" class="tools-grid">
        <div class="tools-unavailable">טוען...</div>
      </div>
      <p class="tools-note">אפשר לחבר כלים גם אחרי ההגדרה</p>
    </div>

    <!-- Finish Section -->
    <div class="finish-section">
      <button type="button" class="finish-btn" id="finishBtn" disabled>סיום</button>
      <p class="finish-hint" id="finishHint">יש לחבר WhatsApp ולמלא שם</p>
    </div>
  </div>

  <script>
    let waConnected = ${pairingState.isPaired};
    let pollInterval = null;
    
    // QR Code rendering (simple text-based for now, real implementation would use qrcode.js)
    function renderQR(qrData) {
      const container = document.getElementById('qrContainer');
      if (!container) return;
      
      // Using a simple QR library loaded from CDN would be better,
      // but for now we'll create a canvas with the data URL approach
      const canvas = document.createElement('canvas');
      canvas.id = 'qrCanvas';
      canvas.width = 200;
      canvas.height = 200;
      container.innerHTML = '';
      container.appendChild(canvas);
      
      // For actual QR rendering, we'd use a library like qrcode
      // This is a placeholder that shows we have QR data
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 200, 200);
      ctx.fillStyle = '#000';
      ctx.font = '10px monospace';
      
      // Simple visual representation - in production use qrcode-generator
      const size = 200;
      const moduleSize = 4;
      let x = 10, y = 10;
      for (let i = 0; i < qrData.length && y < size - 10; i++) {
        const charCode = qrData.charCodeAt(i);
        for (let bit = 7; bit >= 0; bit--) {
          if ((charCode >> bit) & 1) {
            ctx.fillRect(x, y, moduleSize - 1, moduleSize - 1);
          }
          x += moduleSize;
          if (x >= size - 10) {
            x = 10;
            y += moduleSize;
          }
        }
      }
    }

    async function pollPairingState() {
      try {
        const res = await fetch('/api/pairing', { credentials: 'same-origin' });
        if (!res.ok) {
          if (res.status === 401) {
            window.location.href = '/';
            return;
          }
          return;
        }
        
        const { data } = await res.json();
        
        if (data.isPaired && !waConnected) {
          waConnected = true;
          clearInterval(pollInterval);
          
          // Update UI to show connected state
          const waContent = document.getElementById('waContent');
          waContent.innerHTML = \`
            <div class="wa-connected">
              <div class="check">✓</div>
              <div class="info">
                <div class="name">\${data.name || 'מחובר'}</div>
                <div class="phone">\${data.phoneNumber || ''}</div>
              </div>
            </div>
          \`;
          
          // Pre-fill name if empty
          const nameInput = document.getElementById('ownerName');
          if (!nameInput.value && data.name) {
            nameInput.value = data.name;
          }
          
          updateFinishState();
        } else if (!data.isPaired && data.qrCode) {
          renderQR(data.qrCode);
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }

    async function loadTools() {
      const container = document.getElementById('toolsContent');
      
      try {
        const res = await fetch('/api/tools', { credentials: 'same-origin' });
        if (!res.ok) throw new Error('Failed to load tools');
        
        const { data, connectorAvailable } = await res.json();
        
        if (connectorAvailable === false) {
          container.innerHTML = '<div class="tools-unavailable">שירות הכלים לא זמין כרגע</div>';
          return;
        }
        
        container.innerHTML = data.map(tool => \`
          <div class="tool-item \${tool.isConnected ? 'connected' : ''}" data-tool-id="\${tool.id}">
            <div class="tool-icon">\${tool.icon}</div>
            <div class="tool-info">
              <div class="tool-name">\${tool.hebrewName}</div>
              <div class="tool-desc">\${tool.isConnected && tool.identity ? tool.identity : tool.hebrewDescription}</div>
            </div>
            <div class="tool-status \${tool.isConnected ? 'connected' : 'connect'}">
              \${tool.isConnected ? 'מחובר' : 'חבר'}
            </div>
          </div>
        \`).join('');
        
        // Add click handlers for connecting tools
        container.querySelectorAll('.tool-item:not(.connected)').forEach(el => {
          el.addEventListener('click', () => connectTool(el.dataset.toolId));
        });
      } catch (err) {
        container.innerHTML = '<div class="tools-unavailable">שירות הכלים לא זמין כרגע</div>';
      }
    }

    async function connectTool(toolId) {
      try {
        const res = await fetch(\`/api/tools/\${toolId}/connect\`, {
          method: 'POST',
          credentials: 'same-origin',
        });
        
        if (res.ok) {
          const { data } = await res.json();
          if (data.connectUrl) {
            window.open(data.connectUrl, '_blank');
          }
        }
      } catch (err) {
        console.error('Connect tool error:', err);
      }
    }

    function updateFinishState() {
      const btn = document.getElementById('finishBtn');
      const hint = document.getElementById('finishHint');
      const nameInput = document.getElementById('ownerName');
      
      const hasName = nameInput.value.trim().length > 0;
      const canFinish = waConnected && hasName;
      
      btn.disabled = !canFinish;
      
      if (!waConnected && !hasName) {
        hint.textContent = 'יש לחבר WhatsApp ולמלא שם';
      } else if (!waConnected) {
        hint.textContent = 'יש לחבר WhatsApp';
      } else if (!hasName) {
        hint.textContent = 'יש למלא שם';
      } else {
        hint.textContent = 'הכל מוכן!';
      }
    }

    async function saveSettings() {
      const data = {
        ownerName: document.getElementById('ownerName').value.trim(),
        businessName: document.getElementById('businessName').value.trim(),
        timezone: document.getElementById('timezone').value,
      };
      
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(data),
      });
    }

    async function finishSetup() {
      const btn = document.getElementById('finishBtn');
      btn.disabled = true;
      btn.textContent = 'שומר...';
      
      try {
        await saveSettings();
        
        const res = await fetch('/api/setup/complete', {
          method: 'POST',
          credentials: 'same-origin',
        });
        
        if (res.ok) {
          window.location.href = '/';
        } else {
          const { error } = await res.json();
          alert(error || 'שגיאה בסיום ההגדרה');
          btn.disabled = false;
          btn.textContent = 'סיום';
        }
      } catch (err) {
        alert('שגיאת חיבור');
        btn.disabled = false;
        btn.textContent = 'סיום';
      }
    }

    // Initialize
    document.getElementById('ownerName').addEventListener('input', updateFinishState);
    document.getElementById('finishBtn').addEventListener('click', finishSetup);
    
    // Auto-save on field blur
    ['ownerName', 'businessName', 'timezone'].forEach(id => {
      document.getElementById(id).addEventListener('blur', saveSettings);
    });
    
    // Start polling if not connected
    if (!waConnected) {
      pollPairingState();
      pollInterval = setInterval(pollPairingState, 1500);
    }
    
    // Load tools
    loadTools();
    
    // Update finish state on load
    updateFinishState();
  </script>
</body>
</html>`;
}

function getHomeHtml(settings: ReturnType<typeof loadSettings>, pairingState: { isPaired: boolean; phoneNumber?: string; name?: string }): string {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(settings.botName)}</title>
  <style>
${getBaseStyles()}
    .container {
      max-width: 480px;
      width: 100%;
      padding: 24px;
    }
    .header {
      text-align: center;
      margin-bottom: 32px;
    }
    .logo {
      width: 80px;
      height: 80px;
      background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
      border-radius: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 36px;
      margin: 0 auto 20px;
      box-shadow: 0 8px 24px rgba(37, 211, 102, 0.3);
    }
    h1 {
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .subtitle {
      color: rgba(255,255,255,0.5);
      font-size: 15px;
    }
    
    .status-card {
      background: rgba(37, 211, 102, 0.12);
      border: 1px solid rgba(37, 211, 102, 0.25);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 24px;
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .status-icon {
      width: 48px;
      height: 48px;
      background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      flex-shrink: 0;
    }
    .status-info h2 {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 2px;
    }
    .status-info p {
      color: rgba(255,255,255,0.6);
      font-size: 14px;
    }
    
    .card {
      background: rgba(255,255,255,0.06);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 16px;
      border: 1px solid rgba(255,255,255,0.08);
    }
    .card h3 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .instructions {
      list-style: none;
      counter-reset: steps;
    }
    .instructions li {
      counter-increment: steps;
      padding: 12px 0;
      padding-right: 40px;
      position: relative;
      color: rgba(255,255,255,0.8);
      font-size: 15px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .instructions li:last-child { border-bottom: none; }
    .instructions li::before {
      content: counter(steps);
      position: absolute;
      right: 0;
      top: 12px;
      width: 24px;
      height: 24px;
      background: rgba(255,255,255,0.1);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 600;
      color: rgba(255,255,255,0.5);
    }
    
    .tools-section {
      display: grid;
      gap: 10px;
    }
    .tool-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: rgba(255,255,255,0.03);
      border-radius: 10px;
    }
    .tool-row.connected { background: rgba(37, 211, 102, 0.08); }
    .tool-icon { font-size: 20px; }
    .tool-name { flex: 1; font-size: 14px; }
    .tool-badge {
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 10px;
    }
    .tool-badge.connected {
      background: rgba(37, 211, 102, 0.2);
      color: #25D366;
    }
    .tool-badge.not-connected {
      background: rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.5);
    }
    
    .footer-link {
      text-align: center;
      margin-top: 24px;
    }
    .footer-link a {
      color: rgba(255,255,255,0.4);
      font-size: 13px;
      text-decoration: none;
    }
    .footer-link a:hover {
      color: rgba(255,255,255,0.6);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">💬</div>
      <h1>${escapeHtml(settings.businessName || 'הסוכן שלי')}</h1>
      <p class="subtitle">שלום ${escapeHtml(settings.ownerName || '')}</p>
    </div>

    <div class="status-card">
      <div class="status-icon">✓</div>
      <div class="status-info">
        <h2>הסוכן פעיל</h2>
        <p>${pairingState.name || pairingState.phoneNumber || 'מחובר'}</p>
      </div>
    </div>

    <div class="card">
      <h3>📖 איך להשתמש</h3>
      <ol class="instructions">
        <li>פתחו את WhatsApp בטלפון</li>
        <li>שלחו הודעה לעצמכם (לשיחה שלכם)</li>
        <li>הסוכן יענה לכם בצ'אט</li>
        <li>שלחו /עזרה לראות פקודות</li>
      </ol>
    </div>

    <div class="card">
      <h3>🔧 כלים מחוברים</h3>
      <div id="toolsSection" class="tools-section">
        <div style="color: rgba(255,255,255,0.5); text-align: center; padding: 12px;">טוען...</div>
      </div>
    </div>

    <div class="footer-link">
      <a href="/setup/operator">מתקדם</a>
    </div>
  </div>

  <script>
    async function loadTools() {
      const container = document.getElementById('toolsSection');
      
      try {
        const res = await fetch('/api/tools', { credentials: 'same-origin' });
        if (!res.ok) throw new Error();
        
        const { data, connectorAvailable } = await res.json();
        
        if (connectorAvailable === false) {
          container.innerHTML = '<div style="color: rgba(255,255,255,0.5); text-align: center; padding: 12px;">שירות הכלים לא זמין</div>';
          return;
        }
        
        container.innerHTML = data.map(tool => \`
          <div class="tool-row \${tool.isConnected ? 'connected' : ''}">
            <span class="tool-icon">\${tool.icon}</span>
            <span class="tool-name">\${tool.hebrewName}</span>
            <span class="tool-badge \${tool.isConnected ? 'connected' : 'not-connected'}">
              \${tool.isConnected ? 'מחובר' : 'לא מחובר'}
            </span>
          </div>
        \`).join('');
      } catch {
        container.innerHTML = '<div style="color: rgba(255,255,255,0.5); text-align: center; padding: 12px;">שגיאה בטעינת כלים</div>';
      }
    }
    
    loadTools();
  </script>
</body>
</html>`;
}

function getOperatorHtml(): string {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>הגדרות מתקדמות</title>
  <style>
${getBaseStyles()}
    .container {
      max-width: 600px;
      width: 100%;
      padding: 24px;
    }
    .header {
      margin-bottom: 32px;
    }
    .back-link {
      color: rgba(255,255,255,0.5);
      text-decoration: none;
      font-size: 14px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 16px;
    }
    .back-link:hover { color: rgba(255,255,255,0.8); }
    h1 {
      font-size: 24px;
      font-weight: 700;
    }
    .subtitle {
      color: rgba(255,255,255,0.5);
      font-size: 14px;
      margin-top: 4px;
    }
    
    .card {
      background: rgba(255,255,255,0.06);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 16px;
      border: 1px solid rgba(255,255,255,0.08);
    }
    .card h2 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 16px;
    }
    
    .form-row {
      margin-bottom: 16px;
    }
    .form-row:last-child { margin-bottom: 0; }
    .form-row label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: rgba(255,255,255,0.6);
      margin-bottom: 6px;
    }
    .form-row input, .form-row select {
      width: 100%;
      padding: 12px 16px;
      border: 2px solid rgba(255,255,255,0.1);
      border-radius: 10px;
      background: rgba(255,255,255,0.05);
      color: #fff;
      font-size: 15px;
      transition: all 150ms ease;
    }
    .form-row input:focus, .form-row select:focus {
      outline: none;
      border-color: #4f46e5;
      background: rgba(255,255,255,0.08);
    }
    .form-row select option { background: #1a1a2e; }
    .form-row .hint {
      color: rgba(255,255,255,0.4);
      font-size: 12px;
      margin-top: 6px;
    }
    
    .save-btn {
      width: 100%;
      padding: 14px;
      background: #4f46e5;
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: all 150ms ease;
      margin-top: 8px;
    }
    .save-btn:hover { background: #4338ca; }
    .save-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    .status-msg {
      text-align: center;
      margin-top: 12px;
      font-size: 14px;
    }
    .status-msg.success { color: #10b981; }
    .status-msg.error { color: #ef4444; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <a href="/" class="back-link">← חזרה</a>
      <h1>הגדרות מתקדמות</h1>
      <p class="subtitle">הגדרות אופרטור למפעיל המערכת</p>
    </div>

    <div class="card">
      <h2>⚙️ הגדרות כלליות</h2>
      <form id="settingsForm">
        <div class="form-row">
          <label for="botName">שם הבוט</label>
          <input type="text" id="botName" name="botName" placeholder="Desk Agent">
        </div>
        <div class="form-row">
          <label for="model">מודל AI</label>
          <input type="text" id="model" name="model" placeholder="claude-3-5-sonnet-20241022">
        </div>
        <div class="form-row">
          <label for="apiKeyMode">מצב מפתחות API</label>
          <select id="apiKeyMode" name="apiKeyMode">
            <option value="shared">משותף</option>
            <option value="per-project">לפי פרויקט</option>
          </select>
          <p class="hint">קובע אם להשתמש בטוקן משותף או טוקן נפרד לכל פרויקט</p>
        </div>
        <button type="submit" class="save-btn" id="saveBtn">שמור</button>
        <p class="status-msg" id="statusMsg"></p>
      </form>
    </div>

    <div class="card">
      <h2>🔑 טוקן Connector</h2>
      <div class="form-row">
        <label for="connectorToken">טוקן משותף</label>
        <input type="password" id="connectorToken" placeholder="הזן טוקן">
        <p class="hint">טוקן גישה ל-Open Connector</p>
      </div>
      <button type="button" class="save-btn" id="saveTokenBtn">שמור טוקן</button>
    </div>

    <div class="card">
      <h2>📊 סטטוס</h2>
      <div id="statusSection" style="color: rgba(255,255,255,0.6);">טוען...</div>
    </div>
  </div>

  <script>
    let settings = {};

    async function loadSettings() {
      try {
        const res = await fetch('/api/operator/settings', { credentials: 'same-origin' });
        if (!res.ok) throw new Error();
        
        const { data } = await res.json();
        settings = data;
        
        document.getElementById('botName').value = data.botName || '';
        document.getElementById('model').value = data.model || '';
        document.getElementById('apiKeyMode').value = data.apiKeyMode || 'shared';
        
        if (data.sharedConnectorToken === '***') {
          document.getElementById('connectorToken').placeholder = '********';
        }
      } catch (err) {
        console.error('Failed to load settings:', err);
      }
    }

    async function loadStatus() {
      const container = document.getElementById('statusSection');
      try {
        const [healthRes, connectorRes] = await Promise.all([
          fetch('/health'),
          fetch('/api/connector/status', { credentials: 'same-origin' })
        ]);
        
        const health = await healthRes.json();
        const connector = await connectorRes.json();
        
        container.innerHTML = \`
          <p>WhatsApp: \${health.whatsapp === 'connected' ? '✅ מחובר' : '❌ מנותק'}</p>
          <p>Connector: \${connector.data?.available ? '✅ זמין' : '❌ לא זמין'}</p>
        \`;
      } catch {
        container.innerHTML = '<p>שגיאה בטעינת סטטוס</p>';
      }
    }

    document.getElementById('settingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('saveBtn');
      const msg = document.getElementById('statusMsg');
      
      btn.disabled = true;
      msg.className = 'status-msg';
      msg.textContent = '';
      
      try {
        const res = await fetch('/api/operator/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            botName: document.getElementById('botName').value,
            model: document.getElementById('model').value,
            apiKeyMode: document.getElementById('apiKeyMode').value,
          })
        });
        
        if (res.ok) {
          msg.className = 'status-msg success';
          msg.textContent = 'נשמר בהצלחה';
        } else {
          throw new Error();
        }
      } catch {
        msg.className = 'status-msg error';
        msg.textContent = 'שגיאה בשמירה';
      }
      
      btn.disabled = false;
    });

    document.getElementById('saveTokenBtn').addEventListener('click', async () => {
      const token = document.getElementById('connectorToken').value;
      if (!token) return;
      
      try {
        await fetch('/api/operator/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ sharedConnectorToken: token })
        });
        
        document.getElementById('connectorToken').value = '';
        document.getElementById('connectorToken').placeholder = '********';
        alert('נשמר!');
      } catch {
        alert('שגיאה בשמירה');
      }
    });

    loadSettings();
    loadStatus();
  </script>
</body>
</html>`;
}

function getBaseStyles(): string {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
      background: linear-gradient(135deg, #0a0a14 0%, #1a1a2e 50%, #0f1922 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    :focus-visible {
      outline: 2px solid #25D366;
      outline-offset: 2px;
    }
  `;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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
    console.log(`\n🌐 Web UI: http://${config.host}:${config.port}/`);
  });
}
