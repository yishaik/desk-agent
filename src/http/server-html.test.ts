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

    it('device_code flow: shows deviceUserCode element for openai-codex', () => {
      expect(serverCode).toContain('id="deviceUserCode"');
      expect(serverCode).toContain('id="deviceCodeModal"');
      expect(serverCode).toContain('deviceVerificationUrl');
    });

    it('device_code flow: checks loginMethod or userCode from response', () => {
      expect(serverCode).toContain("json.loginMethod === 'device_code'");
      expect(serverCode).toContain('json.userCode');
    });

    it('device_code flow: does not open popup for openai-codex', () => {
      expect(serverCode).toContain("if (providerId === 'anthropic')");
      expect(serverCode).toContain("popup = window.open('about:blank'");
    });

    it('device_code flow: shows verificationUri link only when present', () => {
      expect(serverCode).toContain('json.verificationUri');
      expect(serverCode).toContain('verificationUri');
      expect(serverCode).not.toContain('chatgpt.com');
    });

    it('browser flow: Claude uses about:blank popup then sets location', () => {
      expect(serverCode).toContain("window.open('about:blank', '_blank')");
      expect(serverCode).toContain('popup.location = json.authorizeUrl');
    });

    it('handles alreadyConnected response', () => {
      expect(serverCode).toContain('json.alreadyConnected');
      expect(serverCode).toContain('location.reload()');
    });

    it('poll timeout ~90s keeps UI available with hint text', () => {
      expect(serverCode).toContain('POLL_TIMEOUT_MS = 90000');
      expect(serverCode).toContain('showPollTimeoutHint');
      expect(serverCode).not.toContain("alert('timeout')");
    });

    it('polls openai-codex status endpoint', () => {
      expect(serverCode).toContain("/api/auth/login/' + providerId + '/status");
    });

    it('paste fallback posts to /api/auth/complete', () => {
      expect(serverCode).toContain("fetch('/api/auth/complete'");
      expect(serverCode).toContain('codeOrRedirectUrl');
    });

    it('no fake /api/auth/callback endpoint', () => {
      expect(serverCode).not.toContain('/api/auth/callback');
    });

    it('no /login or API key form in wizard', () => {
      expect(serverCode).not.toMatch(/fetch\(['"]\/login['"]/);
      expect(serverCode).not.toContain('MODEL_API_KEY');
      expect(serverCode).not.toMatch(/placeholder=['"].*api.?key/i);
      expect(serverCode).not.toMatch(/<label[^>]*>.*api.?key/i);
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
