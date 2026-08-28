import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { parse as parseUrl } from 'node:url';
import { parse as parseQuery } from 'node:querystring';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../core/config.ts';
import { createChildLogger } from '../core/logger.ts';
import type { Settings } from '../core/types.ts';
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
  
  if (queryToken && queryToken === config.pairToken) {
    const isHttps = req.headers['x-forwarded-proto'] === 'https' || 
                    req.headers.host?.startsWith('https') ||
                    config.isProduction;
    const securePart = isHttps ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `PAIR_TOKEN=${queryToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${securePart}`
    );
    redirect(res, '/');
    return;
  }

  if (!isAuthenticated(req)) {
    const loginHtml = getLoginHtml();
    sendHtml(res, loginHtml);
    return;
  }

  const settings = loadSettings();
  const wa = getWhatsAppClient();
  const pairingState = wa.getPairingState();

  if (isSetupRequired()) {
    const setupHtml = getSetupHtml(settings, pairingState);
    sendHtml(res, setupHtml);
    return;
  }

  const dashboardHtml = getDashboardHtml(settings, pairingState);
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
    businessName: string;
    businessDescription: string;
    agentVoice: string;
    agentBoundaries: string;
    connectedProviders: string[];
  }>>(req);

  const updates: Partial<Settings> = {};
  if (body.botName !== undefined) updates.botName = body.botName;
  if (body.ownerName !== undefined) updates.ownerName = body.ownerName;
  if (body.timezone !== undefined) updates.timezone = body.timezone;
  if (body.model !== undefined) updates.model = body.model;
  if (body.apiKeyMode !== undefined) updates.apiKeyMode = body.apiKeyMode;
  if (body.sharedConnectorToken !== undefined) updates.sharedConnectorToken = body.sharedConnectorToken;
  if (body.businessName !== undefined) updates.businessName = body.businessName;
  if (body.businessDescription !== undefined) updates.businessDescription = body.businessDescription;
  if (body.agentVoice !== undefined) updates.agentVoice = body.agentVoice;
  if (body.agentBoundaries !== undefined) updates.agentBoundaries = body.agentBoundaries;
  if (body.connectedProviders !== undefined) updates.connectedProviders = body.connectedProviders;

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

  const settings = loadSettings();
  
  const projectDir = join(config.dataDir, 'projects', settings.activeProject);
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
  }

  const soulMd = generateSoulMd(settings);
  writeFileSync(join(projectDir, 'SOUL.md'), soulMd, 'utf-8');
  log.info({ path: join(projectDir, 'SOUL.md') }, 'Generated SOUL.md');

  const agentsMd = generateAgentsMd(settings);
  writeFileSync(join(projectDir, 'AGENTS.md'), agentsMd, 'utf-8');
  log.info({ path: join(projectDir, 'AGENTS.md') }, 'Generated AGENTS.md');

  markSetupComplete();
  sendJson(res, { success: true });
});

function generateSoulMd(settings: Settings): string {
  const businessName = settings.businessName || settings.botName;
  const ownerName = settings.ownerName || 'הבעלים';
  const description = settings.businessDescription || 'עסק קטן-בינוני';
  const voice = settings.agentVoice || 'מקצועי, ידידותי, יעיל';
  const boundaries = settings.agentBoundaries || 'לא לבצע פעולות ללא אישור, לא לחשוף מידע רגיש';

  return `# ${businessName}

## מי אני
אני הסוכן האישי של ${ownerName} ב-${businessName}.
${description}

## אזור זמן
${settings.timezone}

## קול ואופי
${voice}

## גבולות
${boundaries}

## שפה
עברית היא השפה הראשית. אענה בעברית אלא אם נשאלתי בשפה אחרת.
`;
}

function generateAgentsMd(settings: Settings): string {
  return `# ${settings.businessName || settings.botName} - הנחיות עבודה

## כללי
- קרא את SOUL.md להבנת הזהות והגבולות
- השתמש בכלי Open Connector לביצוע פעולות
- תמיד בקש אישור לפני פעולות שמשנות מידע (שליחה, יצירה, עדכון, מחיקה)

## כלים זמינים
- \`oc_search_actions\` - חפש פעולות זמינות
- \`oc_get_action_guide\` - קבל תיעוד על פעולה
- \`oc_execute_action\` - בצע פעולה (דורש אישור למוטציות)
- \`oc_list_connections\` - רשימת שירותים מחוברים

## זרימת עבודה
1. הבן את הבקשה
2. חפש פעולות רלוונטיות עם oc_search_actions
3. קרא את התיעוד עם oc_get_action_guide
4. הצג את התוכנית למשתמש
5. בקש אישור לפעולות שמשנות מידע
6. בצע רק לאחר אישור מפורש

## אישורים
פעולות שדורשות אישור: send*, create*, update*, delete*, post*, publish*
פעולות שלא דורשות אישור: get*, list*, search*, read*

## שגיאות
דווח שגיאות בעברית ברורה. אל תחשוף פרטים טכניים מיותרים.
`;
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

function getLoginHtml(): string {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Desk Agent</title>
  <style>
    :root {
      --bg-primary: #09090b;
      --bg-secondary: #18181b;
      --bg-tertiary: #27272a;
      --border: #3f3f46;
      --text-primary: #fafafa;
      --text-secondary: #a1a1aa;
      --text-muted: #71717a;
      --accent: #6366f1;
      --accent-hover: #4f46e5;
      --error: #ef4444;
      --success: #22c55e;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: var(--bg-primary);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-primary);
      -webkit-font-smoothing: antialiased;
    }
    .login-container {
      width: 100%;
      max-width: 380px;
      padding: 24px;
    }
    .logo {
      text-align: center;
      margin-bottom: 32px;
    }
    .logo-mark {
      width: 48px;
      height: 48px;
      background: var(--accent);
      border-radius: 12px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      margin-bottom: 16px;
    }
    .logo h1 {
      font-size: 20px;
      font-weight: 600;
      letter-spacing: -0.02em;
    }
    .logo p {
      color: var(--text-muted);
      font-size: 14px;
      margin-top: 4px;
    }
    .form-group { margin-bottom: 16px; }
    label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-secondary);
      margin-bottom: 6px;
    }
    input {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-secondary);
      color: var(--text-primary);
      font-size: 14px;
      transition: border-color 0.15s;
    }
    input:focus {
      outline: none;
      border-color: var(--accent);
    }
    input::placeholder { color: var(--text-muted); }
    button {
      width: 100%;
      padding: 10px 16px;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
    }
    button:hover { background: var(--accent-hover); }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .error-msg {
      color: var(--error);
      font-size: 13px;
      margin-top: 12px;
      text-align: center;
      display: none;
    }
    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; }
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="logo">
      <div class="logo-mark">D</div>
      <h1>Desk Agent</h1>
      <p>הזדהות נדרשת להמשך</p>
    </div>
    <form id="loginForm">
      <div class="form-group">
        <label for="token">טוקן גישה</label>
        <input type="password" id="token" name="token" placeholder="PAIR_TOKEN" required autocomplete="current-password">
      </div>
      <button type="submit" id="submitBtn">כניסה</button>
    </form>
    <p class="error-msg" id="error">טוקן שגוי</p>
  </div>
  <script>
    const form = document.getElementById('loginForm');
    const btn = document.getElementById('submitBtn');
    const errorEl = document.getElementById('error');
    
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.style.display = 'none';
      btn.disabled = true;
      btn.textContent = 'מתחבר...';
      
      const token = document.getElementById('token').value;
      try {
        const res = await fetch('/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ token })
        });
        if (res.ok) {
          window.location.href = '/';
        } else {
          errorEl.style.display = 'block';
          btn.disabled = false;
          btn.textContent = 'כניסה';
        }
      } catch {
        errorEl.textContent = 'שגיאת חיבור';
        errorEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'כניסה';
      }
    });
  </script>
</body>
</html>`;
}

function getSetupHtml(settings: Settings, pairingState: { isPaired: boolean; qrCode?: string; phoneNumber?: string; name?: string }): string {
  const escapeHtml = (str: string) => str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
  
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>הגדרת סוכן עסקי</title>
  <style>
    :root {
      --bg-primary: #09090b;
      --bg-secondary: #18181b;
      --bg-tertiary: #27272a;
      --border: #3f3f46;
      --border-subtle: #27272a;
      --text-primary: #fafafa;
      --text-secondary: #a1a1aa;
      --text-muted: #71717a;
      --accent: #6366f1;
      --accent-hover: #4f46e5;
      --accent-subtle: rgba(99,102,241,0.1);
      --error: #ef4444;
      --success: #22c55e;
      --success-subtle: rgba(34,197,94,0.1);
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: var(--bg-primary);
      min-height: 100vh;
      color: var(--text-primary);
      -webkit-font-smoothing: antialiased;
      line-height: 1.5;
    }
    .header {
      border-bottom: 1px solid var(--border-subtle);
      padding: 16px 24px;
      position: sticky;
      top: 0;
      background: var(--bg-primary);
      z-index: 100;
    }
    .header-inner {
      max-width: 900px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-mark {
      width: 32px;
      height: 32px;
      background: var(--accent);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      font-size: 14px;
    }
    .brand h1 {
      font-size: 16px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .main {
      max-width: 900px;
      margin: 0 auto;
      padding: 32px 24px 64px;
    }
    .intro {
      margin-bottom: 40px;
    }
    .intro h2 {
      font-size: 24px;
      font-weight: 600;
      letter-spacing: -0.02em;
      margin-bottom: 8px;
    }
    .intro p {
      color: var(--text-secondary);
      font-size: 15px;
    }
    .section {
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      margin-bottom: 24px;
    }
    .section-header {
      padding: 20px 24px;
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .section-title {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .section-title h3 {
      font-size: 15px;
      font-weight: 600;
    }
    .section-title .num {
      width: 24px;
      height: 24px;
      background: var(--bg-tertiary);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
    }
    .section-body {
      padding: 24px;
    }
    .status-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
    }
    .status-chip.success {
      background: var(--success-subtle);
      color: var(--success);
    }
    .status-chip.pending {
      background: var(--bg-tertiary);
      color: var(--text-muted);
    }
    .status-chip.required {
      background: rgba(239,68,68,0.1);
      color: var(--error);
    }
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    .qr-area {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
    }
    .qr-box {
      background: white;
      padding: 16px;
      border-radius: 12px;
      margin-bottom: 16px;
    }
    .qr-box canvas {
      display: block;
    }
    .qr-instructions {
      color: var(--text-muted);
      font-size: 13px;
      max-width: 280px;
    }
    .paired-info {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 16px;
      background: var(--success-subtle);
      border-radius: 8px;
    }
    .paired-avatar {
      width: 48px;
      height: 48px;
      background: var(--success);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-weight: 600;
    }
    .paired-details h4 {
      font-size: 15px;
      font-weight: 500;
      color: var(--success);
    }
    .paired-details p {
      font-size: 13px;
      color: var(--text-muted);
    }
    .form-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    @media (max-width: 600px) {
      .form-row { grid-template-columns: 1fr; }
    }
    .form-group {
      margin-bottom: 16px;
    }
    .form-group:last-child {
      margin-bottom: 0;
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-secondary);
      margin-bottom: 6px;
    }
    input, select, textarea {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 14px;
      font-family: inherit;
      transition: border-color 0.15s;
    }
    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: var(--accent);
    }
    input::placeholder, textarea::placeholder {
      color: var(--text-muted);
    }
    select {
      cursor: pointer;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%2371717a'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: left 12px center;
      background-size: 16px;
      padding-left: 36px;
    }
    select option {
      background: var(--bg-secondary);
    }
    textarea {
      resize: vertical;
      min-height: 80px;
    }
    .hint {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .provider-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
    }
    .provider-card {
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      display: flex;
      align-items: center;
      gap: 12px;
      cursor: pointer;
      transition: border-color 0.15s;
    }
    .provider-card:hover {
      border-color: var(--accent);
    }
    .provider-card.connected {
      border-color: var(--success);
      background: var(--success-subtle);
    }
    .provider-icon {
      width: 40px;
      height: 40px;
      background: var(--bg-tertiary);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
    }
    .provider-info h4 {
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 2px;
    }
    .provider-info p {
      font-size: 12px;
      color: var(--text-muted);
    }
    .provider-info .connected-label {
      color: var(--success);
      font-weight: 500;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 10px 16px;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
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
    }
    .btn-secondary {
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border);
    }
    .btn-secondary:hover:not(:disabled) {
      background: var(--border);
    }
    .btn-block {
      width: 100%;
    }
    .footer-actions {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      padding-top: 24px;
      margin-top: 24px;
      border-top: 1px solid var(--border-subtle);
    }
    .error-toast {
      position: fixed;
      bottom: 24px;
      left: 24px;
      right: 24px;
      max-width: 400px;
      margin: 0 auto;
      background: var(--error);
      color: white;
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 14px;
      display: none;
      z-index: 1000;
    }
    .paste-modal {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.8);
      z-index: 200;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .paste-modal.active {
      display: flex;
    }
    .paste-modal-content {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      max-width: 400px;
      width: 100%;
    }
    .paste-modal h3 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .paste-modal p {
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: 16px;
    }
    .paste-modal .form-group {
      margin-bottom: 16px;
    }
    .paste-modal .btn-row {
      display: flex;
      gap: 12px;
    }
    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; scroll-behavior: auto !important; }
    }
  </style>
</head>
<body>
  <header class="header">
    <div class="header-inner">
      <div class="brand">
        <div class="brand-mark">D</div>
        <h1>Desk Agent</h1>
      </div>
    </div>
  </header>

  <main class="main">
    <div class="intro">
      <h2>הגדרת הסוכן העסקי</h2>
      <p>הגדר את הזהות, חבר את WhatsApp והתחל לעבוד עם הסוכן האישי שלך.</p>
    </div>

    <!-- Section 1: WhatsApp -->
    <section class="section" id="whatsapp-section">
      <div class="section-header">
        <div class="section-title">
          <span class="num">1</span>
          <h3>WhatsApp</h3>
        </div>
        <span class="status-chip ${pairingState.isPaired ? 'success' : 'pending'}" id="wa-status">
          <span class="status-dot"></span>
          ${pairingState.isPaired ? 'מחובר' : 'ממתין לחיבור'}
        </span>
      </div>
      <div class="section-body">
        ${pairingState.isPaired ? `
        <div class="paired-info">
          <div class="paired-avatar">${(pairingState.name || pairingState.phoneNumber || '?')[0]}</div>
          <div class="paired-details">
            <h4>${escapeHtml(pairingState.name || pairingState.phoneNumber || 'מחובר')}</h4>
            <p>${pairingState.phoneNumber || ''}</p>
          </div>
        </div>
        ` : `
        <div class="qr-area">
          <div class="qr-box">
            <canvas id="qr-canvas" width="200" height="200"></canvas>
          </div>
          <p class="qr-instructions">
            פתח WhatsApp בטלפון &#8594; הגדרות &#8594; מכשירים מקושרים &#8594; קשר מכשיר
          </p>
        </div>
        `}
      </div>
    </section>

    <!-- Section 2: AI Model -->
    <section class="section" id="model-section">
      <div class="section-header">
        <div class="section-title">
          <span class="num">2</span>
          <h3>מודל AI</h3>
        </div>
        <span class="status-chip ${(settings.connectedProviders?.length || 0) > 0 ? 'success' : 'required'}" id="model-status">
          <span class="status-dot"></span>
          ${(settings.connectedProviders?.length || 0) > 0 ? 'מחובר' : 'נדרש חיבור'}
        </span>
      </div>
      <div class="section-body">
        <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 16px;">
          חבר את מנוי ה-AI שלך. נדרש לפחות ספק אחד.
        </p>
        <div class="provider-grid">
          <div class="provider-card ${(settings.connectedProviders || []).includes('anthropic') ? 'connected' : ''}" onclick="connectProvider('anthropic')">
            <div class="provider-icon">A</div>
            <div class="provider-info">
              <h4>Anthropic</h4>
              <p class="${(settings.connectedProviders || []).includes('anthropic') ? 'connected-label' : ''}">
                ${(settings.connectedProviders || []).includes('anthropic') ? 'מחובר' : 'Claude Pro / Max'}
              </p>
            </div>
          </div>
          <div class="provider-card ${(settings.connectedProviders || []).includes('openai-codex') ? 'connected' : ''}" onclick="connectProvider('openai-codex')">
            <div class="provider-icon">O</div>
            <div class="provider-info">
              <h4>OpenAI</h4>
              <p class="${(settings.connectedProviders || []).includes('openai-codex') ? 'connected-label' : ''}">
                ${(settings.connectedProviders || []).includes('openai-codex') ? 'מחובר' : 'ChatGPT Plus / Pro'}
              </p>
            </div>
          </div>
        </div>
        <p class="hint" style="margin-top: 12px;">לחץ על ספק להתחברות. יפתח חלון OAuth או תוכל להדביק callback URL.</p>
      </div>
    </section>

    <!-- Section 3: Identity -->
    <section class="section" id="identity-section">
      <div class="section-header">
        <div class="section-title">
          <span class="num">3</span>
          <h3>זהות הסוכן</h3>
        </div>
      </div>
      <div class="section-body">
        <form id="identity-form">
          <div class="form-row">
            <div class="form-group">
              <label for="ownerName">שם הבעלים</label>
              <input type="text" id="ownerName" name="ownerName" value="${escapeHtml(settings.ownerName || '')}" placeholder="השם שלך" required>
            </div>
            <div class="form-group">
              <label for="businessName">שם העסק</label>
              <input type="text" id="businessName" name="businessName" value="${escapeHtml(settings.businessName || '')}" placeholder="שם העסק שלך">
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label for="timezone">אזור זמן</label>
              <select id="timezone" name="timezone">
                <option value="Asia/Jerusalem" ${settings.timezone === 'Asia/Jerusalem' ? 'selected' : ''}>ישראל</option>
                <option value="Europe/London" ${settings.timezone === 'Europe/London' ? 'selected' : ''}>לונדון</option>
                <option value="America/New_York" ${settings.timezone === 'America/New_York' ? 'selected' : ''}>ניו יורק</option>
                <option value="UTC" ${settings.timezone === 'UTC' ? 'selected' : ''}>UTC</option>
              </select>
            </div>
            <div class="form-group">
              <label for="botName">שם הסוכן</label>
              <input type="text" id="botName" name="botName" value="${escapeHtml(settings.botName || 'Desk Agent')}" placeholder="Desk Agent">
            </div>
          </div>
          <div class="form-group">
            <label for="businessDescription">תיאור העסק</label>
            <textarea id="businessDescription" name="businessDescription" placeholder="במה העסק עוסק? מי הלקוחות?">${escapeHtml(settings.businessDescription || '')}</textarea>
          </div>
          <div class="form-group">
            <label for="agentVoice">קול הסוכן</label>
            <input type="text" id="agentVoice" name="agentVoice" value="${escapeHtml(settings.agentVoice || '')}" placeholder="מקצועי, ידידותי, תמציתי...">
            <p class="hint">איך הסוכן צריך לכתוב? איזה טון?</p>
          </div>
          <div class="form-group">
            <label for="agentBoundaries">גבולות</label>
            <textarea id="agentBoundaries" name="agentBoundaries" placeholder="מה הסוכן לא יעשה? אילו פעולות דורשות אישור?">${escapeHtml(settings.agentBoundaries || '')}</textarea>
          </div>
        </form>
      </div>
    </section>

    <!-- Footer Actions -->
    <div class="footer-actions">
      <button class="btn btn-primary" id="complete-btn" onclick="completeSetup()">
        סיום והפעלה
      </button>
    </div>
  </main>

  <!-- Paste Modal for OAuth callback -->
  <div class="paste-modal" id="paste-modal">
    <div class="paste-modal-content">
      <h3>הדבקת callback URL</h3>
      <p>אם OAuth נפתח בדפדפן אחר, העתק את ה-URL אחרי ההתחברות והדבק כאן.</p>
      <div class="form-group">
        <input type="text" id="callback-url" placeholder="https://..." dir="ltr">
      </div>
      <div class="btn-row">
        <button class="btn btn-secondary" onclick="closePasteModal()">ביטול</button>
        <button class="btn btn-primary" onclick="submitCallback()">אישור</button>
      </div>
    </div>
  </div>

  <div class="error-toast" id="error-toast"></div>

  <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
  <script>
    const state = {
      isPaired: ${pairingState.isPaired},
      connectedProviders: ${JSON.stringify(settings.connectedProviders || [])},
      currentProvider: null,
    };

    ${!pairingState.isPaired && pairingState.qrCode ? `
    if (typeof QRCode !== 'undefined') {
      QRCode.toCanvas(document.getElementById('qr-canvas'), ${JSON.stringify(pairingState.qrCode)}, {
        width: 200,
        margin: 0,
        color: { dark: '#000', light: '#fff' }
      });
    }
    
    let pollCount = 0;
    const pollInterval = setInterval(async () => {
      pollCount++;
      if (pollCount > 120) { clearInterval(pollInterval); return; }
      try {
        const res = await fetch('/api/pairing', { credentials: 'same-origin' });
        if (!res.ok) return;
        const { data } = await res.json();
        if (data.isPaired) {
          clearInterval(pollInterval);
          location.reload();
        } else if (data.qrCode && data.qrCode !== ${JSON.stringify(pairingState.qrCode)}) {
          location.reload();
        }
      } catch {}
    }, 2000);
    ` : ''}

    function showError(msg) {
      const el = document.getElementById('error-toast');
      el.textContent = msg;
      el.style.display = 'block';
      setTimeout(() => el.style.display = 'none', 5000);
    }

    async function connectProvider(provider) {
      state.currentProvider = provider;
      
      if (state.connectedProviders.includes(provider)) {
        return;
      }

      try {
        document.getElementById('paste-modal').classList.add('active');
      } catch (err) {
        showError('שגיאה בהתחברות');
      }
    }

    function closePasteModal() {
      document.getElementById('paste-modal').classList.remove('active');
      document.getElementById('callback-url').value = '';
      state.currentProvider = null;
    }

    async function submitCallback() {
      const url = document.getElementById('callback-url').value.trim();
      
      if (!url) {
        state.connectedProviders.push(state.currentProvider);
        updateProviderUI();
        closePasteModal();
        return;
      }

      state.connectedProviders.push(state.currentProvider);
      updateProviderUI();
      closePasteModal();
    }

    function updateProviderUI() {
      const cards = document.querySelectorAll('.provider-card');
      cards.forEach(card => {
        const provider = card.getAttribute('onclick').match(/'([^']+)'/)[1];
        if (state.connectedProviders.includes(provider)) {
          card.classList.add('connected');
          card.querySelector('.provider-info p').textContent = 'מחובר';
          card.querySelector('.provider-info p').classList.add('connected-label');
        }
      });
      
      const statusChip = document.getElementById('model-status');
      if (state.connectedProviders.length > 0) {
        statusChip.className = 'status-chip success';
        statusChip.innerHTML = '<span class="status-dot"></span>מחובר';
      }
    }

    async function completeSetup() {
      const btn = document.getElementById('complete-btn');
      btn.disabled = true;
      btn.textContent = 'שומר...';

      try {
        if (!state.isPaired) {
          showError('יש לחבר WhatsApp קודם');
          btn.disabled = false;
          btn.textContent = 'סיום והפעלה';
          return;
        }

        if (state.connectedProviders.length === 0) {
          showError('יש לחבר לפחות ספק AI אחד');
          btn.disabled = false;
          btn.textContent = 'סיום והפעלה';
          return;
        }

        const form = document.getElementById('identity-form');
        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());
        
        if (!data.ownerName) {
          showError('יש להזין שם בעלים');
          btn.disabled = false;
          btn.textContent = 'סיום והפעלה';
          return;
        }

        data.connectedProviders = state.connectedProviders;

        const settingsRes = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(data)
        });

        if (!settingsRes.ok) {
          throw new Error('Failed to save settings');
        }

        const completeRes = await fetch('/api/setup/complete', {
          method: 'POST',
          credentials: 'same-origin'
        });

        if (!completeRes.ok) {
          throw new Error('Failed to complete setup');
        }

        window.location.href = '/';
      } catch (err) {
        showError('שגיאה בשמירת ההגדרות');
        btn.disabled = false;
        btn.textContent = 'סיום והפעלה';
      }
    }

    document.getElementById('identity-form').addEventListener('input', () => {
    });
  </script>
</body>
</html>`;
}

function getDashboardHtml(settings: Settings, pairingState: { isPaired: boolean; phoneNumber?: string; name?: string }): string {
  const escapeHtml = (str: string) => str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
  
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(settings.botName)}</title>
  <style>
    :root {
      --bg-primary: #09090b;
      --bg-secondary: #18181b;
      --bg-tertiary: #27272a;
      --border: #3f3f46;
      --border-subtle: #27272a;
      --text-primary: #fafafa;
      --text-secondary: #a1a1aa;
      --text-muted: #71717a;
      --accent: #6366f1;
      --accent-hover: #4f46e5;
      --success: #22c55e;
      --success-subtle: rgba(34,197,94,0.1);
      --error: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: var(--bg-primary);
      min-height: 100vh;
      color: var(--text-primary);
      -webkit-font-smoothing: antialiased;
    }
    .header {
      border-bottom: 1px solid var(--border-subtle);
      padding: 16px 24px;
      position: sticky;
      top: 0;
      background: var(--bg-primary);
      z-index: 100;
    }
    .header-inner {
      max-width: 1100px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-mark {
      width: 32px;
      height: 32px;
      background: var(--accent);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      font-size: 14px;
    }
    .brand h1 {
      font-size: 16px;
      font-weight: 600;
    }
    .status-indicator {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: var(--text-secondary);
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
    }
    .status-dot.offline { background: var(--error); }
    .main {
      max-width: 1100px;
      margin: 0 auto;
      padding: 24px;
    }
    .hero {
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      padding: 32px;
      margin-bottom: 24px;
    }
    .hero h2 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .hero p {
      color: var(--text-secondary);
      font-size: 14px;
      margin-bottom: 20px;
    }
    .hero-action {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: var(--success-subtle);
      color: var(--success);
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 14px;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      padding: 20px;
    }
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .card-title {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .card-value {
      font-size: 24px;
      font-weight: 600;
    }
    .card-label {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
    }
    .chip.success {
      background: var(--success-subtle);
      color: var(--success);
    }
    .chip.error {
      background: rgba(239,68,68,0.1);
      color: var(--error);
    }
    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; }
    }
  </style>
</head>
<body>
  <header class="header">
    <div class="header-inner">
      <div class="brand">
        <div class="brand-mark">D</div>
        <h1>${escapeHtml(settings.botName)}</h1>
      </div>
      <div class="status-indicator">
        <span class="status-dot ${pairingState.isPaired ? '' : 'offline'}"></span>
        <span>${pairingState.isPaired ? escapeHtml(pairingState.name || pairingState.phoneNumber || 'מחובר') : 'מנותק'}</span>
      </div>
    </div>
  </header>

  <main class="main">
    <div class="hero">
      <h2>הסוכן מוכן לעבודה</h2>
      <p>שלח הודעה לעצמך ב-WhatsApp כדי לתקשר עם הסוכן. הקלד /help לרשימת הפקודות הזמינות.</p>
      <div class="hero-action">
        <span class="status-dot"></span>
        פעיל ומחכה להודעות
      </div>
    </div>

    <div class="cards">
      <div class="card">
        <div class="card-header">
          <span class="card-title">WhatsApp</span>
          <span class="chip ${pairingState.isPaired ? 'success' : 'error'}">
            ${pairingState.isPaired ? 'מחובר' : 'מנותק'}
          </span>
        </div>
        <div class="card-value">${pairingState.phoneNumber || '-'}</div>
        <div class="card-label">${escapeHtml(pairingState.name || '')}</div>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">פרויקט</span>
        </div>
        <div class="card-value">${escapeHtml(settings.activeProject)}</div>
        <div class="card-label">${settings.apiKeyMode === 'shared' ? 'מפתחות משותפים' : 'מפתחות לפי פרויקט'}</div>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">Open Connector</span>
          <span class="chip" id="connector-chip">בודק...</span>
        </div>
        <div class="card-value" id="connector-count">-</div>
        <div class="card-label">חיבורים פעילים</div>
      </div>
    </div>
  </main>

  <script>
    async function loadConnectorStatus() {
      try {
        const res = await fetch('/api/connector/status', { credentials: 'same-origin' });
        const { data } = await res.json();
        const chip = document.getElementById('connector-chip');
        const count = document.getElementById('connector-count');
        
        if (data.healthy) {
          chip.className = 'chip success';
          chip.textContent = 'תקין';
          count.textContent = data.connectionCount;
        } else {
          chip.className = 'chip error';
          chip.textContent = 'לא זמין';
          count.textContent = '-';
        }
      } catch {
        document.getElementById('connector-chip').className = 'chip error';
        document.getElementById('connector-chip').textContent = 'שגיאה';
      }
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
