import { describe, it, expect, vi, beforeAll } from 'vitest';
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

    it('wizard steps include AI and Identity', () => {
      expect(serverCode).toContain('>AI<');
      expect(serverCode).toContain('>WhatsApp<');
      expect(serverCode).toContain('>Open Connector<');
      expect(serverCode).toContain('>זהות<');
    });

    it('wizard uses טוקן not אסימון for admin token', () => {
      expect(serverCode).toContain('שמרתי את הטוקן');
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

    it('provider element IDs match API provider IDs', () => {
      expect(serverCode).toContain('id="anthropic-status"');
      expect(serverCode).toContain('id="anthropic-btn"');
      expect(serverCode).toContain('id="openai-codex-status"');
      expect(serverCode).toContain('id="openai-codex-btn"');
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

    it('wizard shows paste modal for openai-codex only after authorize URL opens', () => {
      expect(serverCode).toContain("providerId === 'openai-codex'");
      expect(serverCode).toContain("document.getElementById('pasteModal').style.display = 'block'");
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

    it('dashboard uses טוקן not אסימון', () => {
      expect(serverCode).toContain('שמרתי את הטוקן');
    });

    it('dashboard does NOT have alert נשמר', () => {
      expect(serverCode).not.toContain("alert('נשמר!')");
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
