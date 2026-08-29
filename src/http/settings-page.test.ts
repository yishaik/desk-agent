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

  it('includes tools section', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('כלים');
    expect(html).toContain('toolsContainer');
    expect(html).toContain('loadTools');
  });

  it('includes connectTool and disconnectTool functions', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('async function connectTool(serviceId)');
    expect(html).toContain('async function disconnectTool(serviceId, serviceName)');
  });

  it('uses about:blank pattern for tool connection popup', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain("window.open('about:blank'");
  });

  it('fetches tools from /api/connector/tools with fallback to /api/connector/services', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('/api/connector/tools');
    expect(html).toContain('/api/connector/services');
  });

  it('handles empty tools catalog state', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('קטלוג הכלים לא זמין עדיין');
    expect(html).toContain('אין כלים זמינים');
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

  it('uses POST for connecting tools with authorizationUrl', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('/connect');
    expect(html).toContain("method: 'POST'");
    expect(html).toContain('authorizationUrl');
  });

  it('extracts authorizationUrl from nested data or top-level', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('json.data && json.data.authorizationUrl');
    expect(html).toContain('authorizeUrl');
  });

  it('handles 400 error with consoleUrl by updating console link', () => {
    const html = getSettingsHtml(createTestData());
    
    expect(html).toContain('json.consoleUrl');
    expect(html).toContain('querySelectorAll');
    expect(html).toContain('setAttribute');
    expect(html).toContain('פתח את הקונסול להגדרה');
  });
});
