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

  it('includes console URL link', () => {
    const html = getSettingsHtml(createTestData({
      connectorStatus: {
        healthy: true,
        connectionCount: 1,
        consoleUrl: 'http://custom-connector:3000',
      },
    }));
    
    expect(html).toContain('href="http://custom-connector:3000"');
    expect(html).toContain('פתח את הקונסול');
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

  it('includes zinc/indigo theme colors', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('--bg-primary: #09090b');
    expect(html).toContain('--accent: #6366f1');
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

  it('shows נשמר והוחל toast on successful save', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain("showToast('נשמר והוחל')");
  });

  it('shows admin token card when requiresAck is true', () => {
    const html = getSettingsHtml(createTestData({
      connectorStatus: {
        healthy: true,
        connectionCount: 1,
        consoleUrl: 'http://localhost:3000',
        adminToken: 'test-admin-token-123',
        requiresAck: true,
      },
    }));
    
    expect(html).toContain('adminTokenCard');
    expect(html).toContain('טוקן ניהול');
    expect(html).toContain('שמרתי את הטוקן');
    expect(html).toContain('test-admin-token-123');
  });

  it('hides admin token card when requiresAck is false', () => {
    const html = getSettingsHtml(createTestData({
      connectorStatus: {
        healthy: true,
        connectionCount: 1,
        consoleUrl: 'http://localhost:3000',
        requiresAck: false,
      },
    }));
    
    expect(html).not.toContain('id="adminTokenCard"');
    expect(html).not.toContain('🔑 טוקן ניהול');
  });

  it('uses טוקן terminology not אסימון', () => {
    const html = getSettingsHtml(createTestData({
      connectorStatus: {
        healthy: true,
        connectionCount: 1,
        consoleUrl: 'http://localhost:3000',
        adminToken: 'test-token',
        requiresAck: true,
      },
    }));
    
    expect(html).toContain('טוקן ניהול');
    expect(html).toContain('שמרתי את הטוקן');
    expect(html).toContain('שגיאה באישור הטוקן');
    expect(html).not.toContain('אסימון');
  });

  it('includes copyAdminToken and ackAdminToken functions', () => {
    const html = getSettingsHtml(createTestData({
      connectorStatus: {
        healthy: true,
        connectionCount: 1,
        consoleUrl: 'http://localhost:3000',
        adminToken: 'test-token',
        requiresAck: true,
      },
    }));
    
    expect(html).toContain('function copyAdminToken');
    expect(html).toContain('function ackAdminToken');
    expect(html).toContain('/api/connector/ack-admin-token');
  });
});
