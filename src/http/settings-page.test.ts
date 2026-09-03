import { describe, it, expect } from 'vitest';
import { getSettingsHtml, type SettingsPageData } from './settings-page.ts';
import { DEFAULT_SETTINGS } from '../core/types.ts';

describe('getSettingsHtml', () => {
  const createTestData = (overrides?: Partial<SettingsPageData>): SettingsPageData => ({
    settings: {
      ...DEFAULT_SETTINGS,
      botName: 'Test Bot',
      ownerName: 'Test Owner',
      businessName: 'Test Business',
      businessDescription: 'A test business',
      agentVoice: 'Professional',
      agentBoundaries: 'No spam',
      timezone: 'Asia/Jerusalem',
    },
    pairingState: {
      isPaired: true,
      phoneNumber: '972501234567',
      name: 'Test User',
    },
    connectorStatus: {
      healthy: true,
      connectionCount: 5,
      consoleUrl: 'http://localhost:3000',
    },
    ...overrides,
  });

  it('includes הגדרות in the page title', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('הגדרות');
  });

  it('includes identity form fields', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('name="ownerName"');
    expect(html).toContain('name="businessName"');
    expect(html).toContain('name="botName"');
    expect(html).toContain('name="timezone"');
    expect(html).toContain('name="businessDescription"');
    expect(html).toContain('name="agentVoice"');
    expect(html).toContain('name="agentBoundaries"');
  });

  it('populates form fields with settings values', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('value="Test Owner"');
    expect(html).toContain('value="Test Business"');
    expect(html).toContain('value="Test Bot"');
    expect(html).toContain('A test business');
    expect(html).toContain('Professional');
    expect(html).toContain('No spam');
  });

  it('does not display PAIR_TOKEN secret', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).not.toContain('PAIR_TOKEN=');
    expect(html).not.toMatch(/PAIR_TOKEN.*value/i);
    expect(html).not.toContain('test-token');
  });

  it('includes back link to home', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('href="/"');
    expect(html).toContain('חזרה');
  });

  it('shows WhatsApp connected status when paired', () => {
    const html = getSettingsHtml(createTestData({
      pairingState: {
        isPaired: true,
        phoneNumber: '972501234567',
        name: 'Test User',
      },
    }));
    
    expect(html).toContain('מחובר');
    expect(html).toContain('Test User');
    expect(html).toContain('972501234567');
  });

  it('shows WhatsApp disconnected status when not paired', () => {
    const html = getSettingsHtml(createTestData({
      pairingState: {
        isPaired: false,
      },
    }));
    
    expect(html).toContain('מנותק');
    expect(html).toContain('חבר מחדש');
  });

  it('shows connector health status', () => {
    const html = getSettingsHtml(createTestData({
      connectorStatus: {
        healthy: true,
        connectionCount: 3,
        consoleUrl: 'http://localhost:3000',
      },
    }));
    
    expect(html).toContain('תקין');
    expect(html).toContain('3');
  });

  it('shows connector unhealthy status', () => {
    const html = getSettingsHtml(createTestData({
      connectorStatus: {
        healthy: false,
        connectionCount: 0,
        consoleUrl: 'http://localhost:3000',
      },
    }));
    
    expect(html).toContain('לא זמין');
  });

  it('does not hardcode console URL in href - loads from API', () => {
    const html = getSettingsHtml(createTestData({
      connectorStatus: {
        healthy: true,
        connectionCount: 1,
        consoleUrl: 'http://connector:3000',
      },
    }));
    
    expect(html).not.toContain('href="http://connector:3000"');
    expect(html).not.toContain('href="http://localhost:3000"');
    expect(html).toContain('פתח את הקונסול');
    expect(html).toContain('id="consoleLinkContainer"');
    expect(html).toContain('style="display: none;"');
  });

  it('validates console URL is public via isPublicConsoleUrl', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('isPublicConsoleUrl');
    expect(html).toContain("host === 'connector'");
    expect(html).toContain("host === 'localhost'");
    expect(html).toContain("host === '127.0.0.1'");
  });

  it('loads console URL from /api/connector/status via JavaScript', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain("fetch('/api/connector/status')");
    expect(html).toContain('loadConnectorConsoleLink');
    expect(html).toContain('data.consoleUrl');
  });

  it('escapes HTML in user-provided content', () => {
    const html = getSettingsHtml(createTestData({
      settings: {
        ...DEFAULT_SETTINGS,
        botName: '<script>alert("xss")</script>',
        ownerName: '<img src=x onerror=alert(1)>',
        businessDescription: '&<>"\'',
      },
    }));
    
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;&lt;&gt;&quot;');
  });

  it('has correct HTML lang and dir attributes', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('lang="he"');
    expect(html).toContain('dir="rtl"');
  });

  it('includes AI providers section', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('ספקי AI');
    expect(html).toContain('providersContainer');
  });

  it('filters out anthropic provider from the provider list', () => {
    const html = getSettingsHtml(createTestData());
    
    // The JavaScript filters out anthropic from the provider list
    expect(html).toContain("data.filter(p => p.id !== 'anthropic')");
  });

  it('does not offer anthropic extra-usage connect', () => {
    const html = getSettingsHtml(createTestData());
    
    // No references to anthropic extra usage or ToS-violating path
    expect(html).not.toContain('extra usage');
    expect(html).not.toContain('extra-usage');
  });

  it('does not display PAIR_TOKEN in provider connection', () => {
    const html = getSettingsHtml(createTestData());
    
    // No PAIR_TOKEN in the provider connection flow
    expect(html).not.toContain("PAIR_TOKEN=");
    expect(html).not.toMatch(/body:.*PAIR_TOKEN/);
  });

  it('does not offer npx pi /login path', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).not.toContain('npx pi');
    expect(html).not.toContain('npx @');
  });

  it('does not contain API key input form for providers', () => {
    const html = getSettingsHtml(createTestData());
    
    // Provider section should not have API key input
    expect(html).not.toMatch(/api[_-]?key.*input/i);
    expect(html).not.toContain('sk-ant-');
    expect(html).not.toContain('sk-proj-');
  });

  it('shows provider-specific instructions for Claude Code paste modal', () => {
    const html = getSettingsHtml(createTestData());
    
    // Claude Code specific instruction about copying the code Claude shows
    expect(html).toContain("providerId === 'claude-code'");
    expect(html).toContain('קוד ש-Claude מציג');
  });

  it('includes zinc/indigo theme colors', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('--bg-primary: #09090b');
    expect(html).toContain('--accent: #818cf8');
  });

  it('includes connected tools section', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('כלים מחוברים');
    expect(html).toContain('toolsContainer');
    expect(html).toContain('loadTools');
  });

  it('includes disconnectTool function', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('async function disconnectTool(serviceId, serviceName)');
  });

  it('fetches tools from /api/connector/tools only (no catalog fallback)', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain("fetch('/api/connector/tools')");
    expect(html).not.toContain("fetch('/api/connector/services')");
  });

  it('shows empty state for no connected tools with console link', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('אין כלים מחוברים');
    expect(html).toContain('פתח את הקונסול');
  });

  it('maps tools from API response (connected-only from API)', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('tools.map(t =>');
  });

  it('normalizes tool fields from API response', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('t.id || t.serviceId');
    expect(html).toContain('t.hebrewName || t.name');
    expect(html).toContain('t.hebrewDescription || t.description');
  });

  it('uses DELETE method for disconnecting tools', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain("method: 'DELETE'");
  });

  it('fetches actions for connected tools', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('/api/connector/actions?service=');
    expect(html).toContain('loadToolActions');
  });

  it('humanizes action names', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('function humanizeAction');
    expect(html).toContain('action.displayName');
  });

  it('shows tool logo with colored monogram fallback', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('function getToolLogo');
    expect(html).toContain('tool-logo');
  });

  it('includes canDisconnect logic for no_auth/virtual tools', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('function canDisconnect');
    expect(html).toContain('virtual !== true');
    expect(html).toContain("authType !== 'no_auth'");
  });

  it('conditionally shows ניתוק button based on canDisconnect', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('showDisconnect = canDisconnect(tool)');
    expect(html).toContain('showDisconnect ?');
    expect(html).toContain('ניתוק');
  });

  it('maps virtual and authType fields from tool response', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('t.virtual');
    expect(html).toContain('t.authType');
  });

  it('includes enabled toggle switch with Hebrew labels', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('tool-switch');
    expect(html).toContain('מופעל');
    expect(html).toContain('כבוי');
    expect(html).toContain("role=\"switch\"");
  });

  it('includes toggleToolEnabled function', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('async function toggleToolEnabled');
    expect(html).toContain('/api/connector/tools/');
    expect(html).toContain('/enabled');
    expect(html).toContain("method: 'PATCH'");
  });

  it('maps enabled field from tool response with default true', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('t.enabled !== false');
  });

  it('applies disabled class to tool card when not enabled', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain("tool-card${tool.enabled ? '' : ' disabled'}");
  });

  it('includes action switch with Hebrew labels', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('action-switch');
    expect(html).toContain('action-switch-track');
    expect(html).toContain('action-switch-label');
  });

  it('includes toggleActionEnabled function', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('async function toggleActionEnabled');
    expect(html).toContain('/actions/');
    expect(html).toContain('/enabled');
  });

  it('maps action enabled field from response', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('action.enabled !== false');
  });

  it('disables action switches when tool is disabled', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain("!tool.enabled ? 'style=\"pointer-events: none;\"' : ''");
  });

  it('caps actions at 40 per tool card', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('MAX_ACTIONS = 40');
  });

  describe('Gmail and Google Calendar Connect buttons', () => {
    it('includes Gmail Connect button', () => {
      const html = getSettingsHtml(createTestData());
      
      expect(html).toContain('id="gmail-connect-btn"');
      expect(html).toContain("onclick=\"connectService('gmail')\"");
      expect(html).toContain('Gmail');
    });

    it('includes Google Calendar Connect button', () => {
      const html = getSettingsHtml(createTestData());
      
      expect(html).toContain('id="googlecalendar-connect-btn"');
      expect(html).toContain("onclick=\"connectService('googlecalendar')\"");
      expect(html).toContain('Google Calendar');
    });

    it('includes connectService function that calls /api/connector/services/:service/connect', () => {
      const html = getSettingsHtml(createTestData());
      
      expect(html).toContain('async function connectService(serviceId)');
      expect(html).toContain('/api/connector/services/${encodeURIComponent(serviceId)}/connect');
      expect(html).toContain("method: 'POST'");
    });

    it('opens OAuth popup with authorization URL', () => {
      const html = getSettingsHtml(createTestData());
      
      expect(html).toContain("window.open('about:blank'");
      expect(html).toContain('serviceConnectPopup.location = json.data.authorizationUrl');
    });

    it('polls /api/connector/tools for service connection', () => {
      const html = getSettingsHtml(createTestData());
      
      expect(html).toContain('startServiceConnectPoll');
      expect(html).toContain("fetch('/api/connector/tools')");
      expect(html).toContain('isConnected');
    });

    it('shows success toast and reloads tools on connection', () => {
      const html = getSettingsHtml(createTestData());
      
      expect(html).toContain("showToast(serviceId === 'gmail' ? 'Gmail חובר בהצלחה!'");
      expect(html).toContain('loadServiceConnectionStatus()');
      expect(html).toContain('loadTools()');
    });

    it('hides connect row when service is already connected', () => {
      const html = getSettingsHtml(createTestData());
      
      expect(html).toContain("rowEl.style.display = 'none'");
    });

    it('does not render unused OC catalog picker', () => {
      const html = getSettingsHtml(createTestData());
      
      expect(html).not.toContain("onclick=\"connectService('slack')\"");
      expect(html).not.toContain("onclick=\"connectService('notion')\"");
      expect(html).not.toContain("onclick=\"connectService('github')\"");
    });

    it('replaces console error messages with Hebrew retry copy', () => {
      const html = getSettingsHtml(createTestData());
      
      expect(html).toContain("errorMsg.toLowerCase().includes('console')");
      expect(html).toContain("errorMsg.toLowerCase().includes('connector')");
      expect(html).toContain("errorMsg = 'לא ניתן להתחבר כעת. נסה שוב מאוחר יותר.'");
    });

    it('includes retry button for connection errors', () => {
      const html = getSettingsHtml(createTestData());
      
      expect(html).toContain('id="serviceConnectError"');
      expect(html).toContain('retryServiceConnect()');
      expect(html).toContain('נסה שוב');
    });

    it('checks service connection status on page load', () => {
      const html = getSettingsHtml(createTestData());
      
      expect(html).toContain('loadServiceConnectionStatus()');
      expect(html).toContain('async function loadServiceConnectionStatus()');
    });
  });

  describe('Console link (כלים נוספים)', () => {
    it('shows console link as כלים נוספים (extra tools)', () => {
      const html = getSettingsHtml(createTestData());
      
      expect(html).toContain('כלים נוספים');
      expect(html).not.toContain('פתח את הקונסול</button>');
    });

    it('console link is hidden by default', () => {
      const html = getSettingsHtml(createTestData());
      
      expect(html).toContain('id="consoleLinkContainer"');
      expect(html).toContain('style="display: none;"');
    });

    it('does not hardcode console URL', () => {
      const html = getSettingsHtml(createTestData());
      
      expect(html).not.toContain('href="http://connector:3000"');
      expect(html).not.toContain('href="/connector/"');
      expect(html).not.toContain('connector:3000');
    });

    it('does not require admin token in Settings page', () => {
      const html = getSettingsHtml(createTestData());
      
      expect(html).not.toContain('adminToken');
      expect(html).not.toContain('טוקן ניהול');
    });
  });

  describe('No PAIR_TOKEN, API key, or npx pi in Settings', () => {
    it('does not contain PAIR_TOKEN reference', () => {
      const html = getSettingsHtml(createTestData());
      
      expect(html).not.toContain('PAIR_TOKEN=');
      expect(html).not.toMatch(/PAIR_TOKEN.*value/i);
    });

    it('does not contain npx pi login reference', () => {
      const html = getSettingsHtml(createTestData());
      
      expect(html).not.toContain('npx pi');
      expect(html).not.toContain('npx @');
    });
  });
});
