import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { getThemeCss } from './theme.ts';

describe('Shared Theme CSS', () => {
  it('includes zinc/indigo color palette', () => {
    const css = getThemeCss();
    
    expect(css).toContain('--bg-primary: #09090b');
    expect(css).toContain('--bg-secondary: #18181b');
    expect(css).toContain('--accent: #6366f1');
    expect(css).toContain('--accent-hover: #4f46e5');
    expect(css).toContain('--success: #22c55e');
    expect(css).toContain('--error: #ef4444');
  });

  it('includes border variables', () => {
    const css = getThemeCss();
    
    expect(css).toContain('--border: #3f3f46');
    expect(css).toContain('--border-subtle: #27272a');
  });

  it('sets system font', () => {
    const css = getThemeCss();
    
    expect(css).toContain("font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif");
  });
});

describe('HTML Escape Security', () => {
  it('escapeHtml escapes all dangerous characters', async () => {
    const { escapeHtml } = await import('./html.ts');
    
    expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(escapeHtml("'onclick='evil'")).toBe("&#39;onclick=&#39;evil&#39;");
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('escapeHtml handles null and undefined', async () => {
    const { escapeHtml } = await import('./html.ts');
    
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml('')).toBe('');
  });

  it('SECURITY: XSS in botName is escaped in dashboard', async () => {
    const fs = await import('node:fs');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    expect(serverCode).toContain("const safeBotName = escapeHtml(settings.botName)");
    expect(serverCode).toContain("<title>${safeBotName}");
    expect(serverCode).toContain("<h1>🤖 ${safeBotName}");
  });

  it('SECURITY: XSS in pairingState values is escaped', async () => {
    const fs = await import('node:fs');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    expect(serverCode).toContain("const safeName = escapeHtml(pairingState.name)");
    expect(serverCode).toContain("const safePhone = escapeHtml(pairingState.phoneNumber)");
  });

  it('SECURITY: XSS in wizard form values is escaped', async () => {
    const fs = await import('node:fs');
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    
    expect(serverCode).toContain('escapeHtml(settings.ownerName)');
    expect(serverCode).toContain('escapeHtml(settings.businessName)');
    expect(serverCode).toContain('escapeHtml(settings.businessDescription)');
  });
});

describe('S-03: Pairing API returns boundOwnerPhone', () => {
  let serverCode: string;

  beforeAll(() => {
    serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
  });

  it('pairing API response includes boundOwnerPhone when owner is set', () => {
    expect(serverCode).toContain('boundOwnerPhone: settings.ownerPhone');
  });

  it('pairing API loads settings to check ownerPhone', () => {
    const pairingRouteMatch = serverCode.match(/addRoute\('GET',\s*'\/api\/pairing'[\s\S]*?^\}\);/m);
    const pairingRoute = pairingRouteMatch?.[0] || '';
    expect(pairingRoute).toContain('loadSettings()');
    expect(pairingRoute).toContain('boundOwnerPhone');
  });

  it('POST /api/pairing/repair endpoint exists for explicit owner change', () => {
    expect(serverCode).toContain("addRoute('POST', '/api/pairing/repair'");
  });

  it('repair endpoint clears ownerPhone before calling repair()', () => {
    expect(serverCode).toContain('updateSettings({ ownerPhone: undefined })');
    expect(serverCode).toContain('wa.repair()');
  });

  it('repair endpoint requires authentication', () => {
    const repairRouteMatch = serverCode.match(/addRoute\('POST',\s*'\/api\/pairing\/repair'[\s\S]*?^\}\);/m);
    const repairRoute = repairRouteMatch?.[0] || '';
    expect(repairRoute).toContain('isAuthenticated(req)');
  });
});

describe('Server HTML Source Code Requirements', () => {
  let serverCode: string;

  beforeAll(() => {
    serverCode = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
  });

  describe('getWizardHtml requirements', () => {
    it('wizard uses <img> for QR, not <pre>', () => {
      expect(serverCode).toContain('<img id="qr-img"');
      expect(serverCode).not.toMatch(/<pre id="qr"[^>]*>.*סורק/);
    });

    it('wizard polls /api/pairing for qrDataUrl', () => {
      expect(serverCode).toContain("fetch('/api/pairing')");
      expect(serverCode).toContain('qrDataUrl');
      expect(serverCode).toContain('pollPairing');
    });

    it('wizard steps include WhatsApp, AI, and Identity (no Open Connector)', () => {
      expect(serverCode).toContain('>AI<');
      expect(serverCode).toContain('>WhatsApp<');
      expect(serverCode).toContain('>זהות<');
    });

    it('wizard does NOT show Open Connector step (admin token not required)', () => {
      const wizardStepsMatch = serverCode.match(/<div class="steps">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/);
      const stepsHtml = wizardStepsMatch?.[0] || '';
      expect(stepsHtml).not.toContain('>Open Connector<');
    });

    it('wizard does NOT require admin token acknowledgment', () => {
      expect(serverCode).not.toContain('id="adminTokenSection"');
      expect(serverCode).not.toContain('id="ackCheckbox"');
      expect(serverCode).not.toContain('needsConnectorAck');
    });

    it('imports getThemeCss from theme.ts', () => {
      expect(serverCode).toContain("import { getThemeCss } from './theme.ts'");
    });

    it('getWizardHtml calls getThemeCss()', () => {
      expect(serverCode).toContain('getThemeCss()');
    });

    it('ChatGPT Connect uses openai-codex provider ID', () => {
      expect(serverCode).toContain("connectProvider('openai-codex')");
      expect(serverCode).not.toMatch(/connectProvider\('openai'\)/);
    });

    it('Claude card uses claude-code provider ID', () => {
      expect(serverCode).toContain("connectProvider('claude-code')");
      expect(serverCode).not.toMatch(/onclick="connectProvider\('anthropic'\)"/);
    });

    it('anthropic extra-usage card is hidden from wizard', () => {
      expect(serverCode).not.toContain('id="anthropic-card"');
      expect(serverCode).not.toContain('id="anthropic-status"');
      expect(serverCode).not.toContain('id="anthropic-btn"');
      expect(serverCode).not.toContain('Claude (Anthropic · extra usage)');
    });

    it('claude-code provider elements exist in wizard', () => {
      expect(serverCode).toContain('id="claude-code-status"');
      expect(serverCode).toContain('id="claude-code-btn"');
      expect(serverCode).toContain('id="claude-code-card"');
    });

    it('provider element IDs match API provider IDs', () => {
      expect(serverCode).toContain('id="openai-codex-status"');
      expect(serverCode).toContain('id="openai-codex-btn"');
      expect(serverCode).toContain('id="claude-code-status"');
      expect(serverCode).toContain('id="claude-code-btn"');
    });

    it('wizard does NOT offer anthropic extra-usage provider', () => {
      // Pi extra-usage anthropic path is hidden per issue #52
      expect(serverCode).not.toContain("connectProvider('anthropic')");
      expect(serverCode).not.toContain('extra usage');
    });

    it('claude-code uses popup-first pattern with about:blank', () => {
      expect(serverCode).toContain("window.open('about:blank'");
      expect(serverCode).toContain("providerId === 'claude-code'");
      expect(serverCode).toContain('currentPopup.location = json.authorizeUrl');
    });

    it('claude-code paste fallback shows קוד not callback URL', () => {
      expect(serverCode).toContain('הדבק את הקוד שקיבלת מ-Claude');
      expect(serverCode).toContain("callbackUrl.placeholder = 'הדבק קוד כאן...'");
    });

    it('poll checks for both success and connected status', () => {
      expect(serverCode).toContain("data.status === 'success' || data.status === 'connected'");
    });

    it('openai-codex shows device code modal with userCode and verificationUri', () => {
      expect(serverCode).toContain('id="deviceCodeModal"');
      expect(serverCode).toContain('id="userCodeDisplay"');
      expect(serverCode).toContain('id="verificationLink"');
      expect(serverCode).toContain('json.userCode');
      expect(serverCode).toContain('json.verificationUri');
    });

    it('loadProviders skips anthropic provider when updating UI', () => {
      expect(serverCode).toContain("if (p.id === 'anthropic') continue");
    });

    it('step 2 uses hasAiProvider from listProviders, not settings.model', () => {
      expect(serverCode).toContain('hasAiProvider');
      expect(serverCode).toContain('listProviders()');
      expect(serverCode).not.toContain("settings.model === 'claude-3-5-sonnet");
    });

    it('wizard loginPoll has timeout with maxPollTicks and clearInterval', () => {
      expect(serverCode).toContain('maxPollTicks');
      expect(serverCode).toContain('clearInterval(loginPollInterval)');
      expect(serverCode).toContain('loginPollTicks');
      expect(serverCode).toContain('loginPollTicks >= maxPollTicks');
    });

    it('wizard timeout shows hint for paste callback, not error banner', () => {
      expect(serverCode).toContain('pasteHint');
      expect(serverCode).toContain('הדבק את ה-callback URL');
      expect(serverCode).not.toContain('poll-timeout-error');
    });

    it('wizard openai-codex timeout shows paste hint not failure', () => {
      expect(serverCode).toContain("hint.textContent = 'הזמן עבר. נסה להזין את הקוד שוב או הדבק callback URL למטה.'");
      expect(serverCode).not.toContain("alert('timeout')");
    });

    it('wizard shows device code modal for openai-codex', () => {
      expect(serverCode).toContain("providerId === 'openai-codex'");
      expect(serverCode).toContain("document.getElementById('deviceCodeModal').style.display = 'block'");
    });

    it('wizard allows reconnect for already-connected providers', () => {
      expect(serverCode).toContain("btnEl.textContent = 'התחבר מחדש'");
      expect(serverCode).toContain('connectedProviders.has(providerId)');
    });
  });

  describe('getDashboardHtml requirements', () => {
    it('dashboard links to /settings', () => {
      expect(serverCode).toContain('href="/settings"');
    });

    it('S-07: dashboard does NOT expose admin token UI (#111)', () => {
      // Admin token display was removed - customer never sees it
      expect(serverCode).not.toContain('dashboardAdminToken');
      expect(serverCode).not.toContain('שמרתי את הטוקן');
    });

    it('dashboard does NOT have alert נשמר', () => {
      expect(serverCode).not.toContain("alert('נשמר!')");
    });

    it('SECURITY: dashboard does NOT show admin token card (S-01)', () => {
      expect(serverCode).not.toContain('id="connectorAdminToken"');
      expect(serverCode).not.toContain('id="dashboardAdminToken"');
      expect(serverCode).not.toContain('copyDashboardToken');
      expect(serverCode).not.toContain('ackDashboardToken');
      expect(serverCode).not.toContain('טוקן ניהול (חד-פעמי)');
    });

    it('SECURITY: dashboard JavaScript does not fetch or display admin token (S-01)', () => {
      expect(serverCode).not.toContain('data.adminToken');
    });
  });

  describe('getLoginHtml requirements', () => {
    it('login function exists and is exported', () => {
      expect(serverCode).toContain('export function getLoginHtml');
    });
  });

  describe('no old theme remnants', () => {
    it('no navy gradient background', () => {
      expect(serverCode).not.toContain('#1a1a2e');
      expect(serverCode).not.toContain('#16213e');
    });

    it('no old #0f0f1a background', () => {
      expect(serverCode).not.toContain('#0f0f1a');
    });

    it('uses var(--accent) not hardcoded #4f46e5', () => {
      const countHardcoded4f46e5 = (serverCode.match(/#4f46e5/g) || []).length;
      expect(countHardcoded4f46e5).toBeLessThanOrEqual(1);
    });
  });
});
