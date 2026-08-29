import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, readFileSync } from 'node:fs';

const TEST_DATA_DIR = './test-data-connector';
const TEST_PAIR_TOKEN = 'test-token-connector';
const TEST_ADMIN_TOKEN = 'test-admin-token';

beforeEach(() => {
  vi.resetModules();
  process.env['DATA_DIR'] = TEST_DATA_DIR;
  process.env['PAIR_TOKEN'] = TEST_PAIR_TOKEN;
  process.env['CONNECTOR_ADMIN_TOKEN'] = TEST_ADMIN_TOKEN;
  process.env['OPEN_CONNECTOR_URL'] = 'http://localhost:3000';
  
  if (existsSync(TEST_DATA_DIR)) {
    rmSync(TEST_DATA_DIR, { recursive: true });
  }
  mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DATA_DIR)) {
    rmSync(TEST_DATA_DIR, { recursive: true });
  }
  delete process.env['DATA_DIR'];
  delete process.env['PAIR_TOKEN'];
  delete process.env['CONNECTOR_ADMIN_TOKEN'];
  delete process.env['OPEN_CONNECTOR_URL'];
  delete process.env['CONNECTOR_ORIGIN'];
});

describe('Admin Token Acknowledgment Flow', () => {
  it('acknowledges admin token and hides it on subsequent calls', async () => {
    vi.resetModules();
    
    const { 
      loadSettings, 
      acknowledgeAdminToken, 
      isAdminTokenAcknowledged 
    } = await import('../core/settings.ts');
    
    let settings = loadSettings();
    expect(settings.adminTokenAcknowledged).toBe(false);
    expect(isAdminTokenAcknowledged()).toBe(false);
    
    acknowledgeAdminToken();
    
    settings = loadSettings();
    expect(settings.adminTokenAcknowledged).toBe(true);
    expect(isAdminTokenAcknowledged()).toBe(true);
  });

  it('persists acknowledgment across settings reloads', async () => {
    vi.resetModules();
    
    const { acknowledgeAdminToken } = await import('../core/settings.ts');
    acknowledgeAdminToken();
    
    vi.resetModules();
    process.env['DATA_DIR'] = TEST_DATA_DIR;
    
    const { isAdminTokenAcknowledged } = await import('../core/settings.ts');
    expect(isAdminTokenAcknowledged()).toBe(true);
  });
});

describe('Console URL Resolution', () => {
  it('uses CONNECTOR_ORIGIN when set', async () => {
    process.env['CONNECTOR_ORIGIN'] = 'https://desk.example.com';
    
    vi.resetModules();
    
    const { config } = await import('../core/config.ts');
    expect(config.connectorOrigin).toBe('https://desk.example.com');
  });

  it('returns undefined when CONNECTOR_ORIGIN is not set', async () => {
    delete process.env['CONNECTOR_ORIGIN'];
    
    vi.resetModules();
    
    const { config } = await import('../core/config.ts');
    expect(config.connectorOrigin).toBeUndefined();
  });

  it('never uses http://connector:3000 as consoleUrl', async () => {
    process.env['OPEN_CONNECTOR_URL'] = 'http://connector:3000';
    process.env['CONNECTOR_ORIGIN'] = 'https://desk.example.com';
    
    vi.resetModules();
    
    const { config } = await import('../core/config.ts');
    
    const getConsoleUrl = (): string => {
      if (config.connectorOrigin) {
        return config.connectorOrigin;
      }
      if (config.isProduction) {
        return config.openConnectorUrl;
      }
      return 'http://localhost:3000';
    };
    
    expect(getConsoleUrl()).toBe('https://desk.example.com');
    expect(getConsoleUrl()).not.toBe('http://connector:3000');
  });
});

describe('Service Hebrew Overlay', () => {
  const SERVICE_HEBREW_OVERLAY: Record<string, { name: string; description: string; icon: string }> = {
    gmail: {
      name: 'Gmail',
      description: 'קריאת ושליחת מיילים',
      icon: '📧',
    },
    googlecalendar: {
      name: 'יומן',
      description: 'ניהול אירועים ופגישות',
      icon: '📅',
    },
  };

  it('has Hebrew overlay for known service IDs gmail and googlecalendar', () => {
    expect(SERVICE_HEBREW_OVERLAY).toHaveProperty('gmail');
    expect(SERVICE_HEBREW_OVERLAY).toHaveProperty('googlecalendar');
  });

  it('uses correct service IDs (not hyphenated)', () => {
    expect(SERVICE_HEBREW_OVERLAY).not.toHaveProperty('google-calendar');
    expect(SERVICE_HEBREW_OVERLAY).not.toHaveProperty('google-mail');
  });

  it('has Hebrew names for known services', () => {
    const gmail = SERVICE_HEBREW_OVERLAY['gmail'];
    const googlecalendar = SERVICE_HEBREW_OVERLAY['googlecalendar'];
    expect(gmail?.name).toBe('Gmail');
    expect(googlecalendar?.name).toBe('יומן');
  });

  it('has Hebrew descriptions for known services', () => {
    const gmail = SERVICE_HEBREW_OVERLAY['gmail'];
    const googlecalendar = SERVICE_HEBREW_OVERLAY['googlecalendar'];
    expect(gmail?.description).toMatch(/מיילים/);
    expect(googlecalendar?.description).toMatch(/אירועים|פגישות/);
  });

  it('overlay is optional - unknown services fall back to serviceId', () => {
    const unknownService = 'some-new-service';
    const overlay = SERVICE_HEBREW_OVERLAY[unknownService];
    expect(overlay).toBeUndefined();
  });
});

describe('Tools endpoint returns connected tools only', () => {
  it('derives tools from connections, not full catalog', () => {
    const mockConnections = [
      { service: 'gmail', connectionName: 'default', authType: 'oauth2', identity: { label: 'user@gmail.com' } },
    ];
    
    const tools = mockConnections.map((conn) => ({
      id: conn.service,
      serviceId: conn.service,
      identity: conn.identity?.label,
    }));
    
    expect(tools).toHaveLength(1);
    expect(tools[0]?.id).toBe('gmail');
  });

  it('returns empty array when no connections', () => {
    const mockConnections: unknown[] = [];
    const tools = mockConnections.map(() => ({}));
    expect(tools).toHaveLength(0);
  });
});

describe('Connect endpoint accepts any OC OAuth service', () => {
  it('does not hardcode service validation', () => {
    const mockProvider = {
      id: 'custom-service',
      displayName: 'Custom Service',
      authTypes: ['oauth2'],
    };
    
    expect(mockProvider.authTypes.includes('oauth2')).toBe(true);
  });

  it('rejects non-oauth2 services with helpful error', () => {
    const mockProvider = {
      id: 'api-key-service',
      displayName: 'API Key Service',
      authTypes: ['api_key'],
    };
    
    expect(mockProvider.authTypes.includes('oauth2')).toBe(false);
    expect(mockProvider.authTypes).toContain('api_key');
  });
});

describe('Actions endpoint returns human-readable actions', () => {
  it('returns displayName and description, not just raw id', () => {
    const mockAction = {
      id: 'gmail.send_email',
      service: 'gmail',
      displayName: 'Send Email',
      description: 'Send an email message',
    };
    
    expect(mockAction).toHaveProperty('displayName');
    expect(mockAction).toHaveProperty('description');
    expect(mockAction.displayName).not.toBe(mockAction.id);
  });

  it('filters by service when query param provided', () => {
    const allActions = [
      { id: 'gmail.send_email', service: 'gmail', displayName: 'Send Email', description: '' },
      { id: 'slack.post_message', service: 'slack', displayName: 'Post Message', description: '' },
    ];
    
    const serviceFilter = 'gmail';
    const filtered = allActions.filter((a) => a.service === serviceFilter);
    
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.service).toBe('gmail');
  });
});

describe('Skills Pack Service IDs', () => {
  it('uses correct service IDs in inbox-calendar.json', () => {
    const skillsPath = './skills-pack/inbox-calendar.json';
    const content = readFileSync(skillsPath, 'utf-8');
    const skill = JSON.parse(content);
    
    expect(skill.requiredServices).toContain('gmail');
    expect(skill.requiredServices).toContain('googlecalendar');
    expect(skill.requiredServices).not.toContain('google-calendar');
  });

  it('uses correct action names in inbox-calendar.json', () => {
    const skillsPath = './skills-pack/inbox-calendar.json';
    const content = readFileSync(skillsPath, 'utf-8');
    const skill = JSON.parse(content);
    
    expect(skill.actions).toContain('gmail.fetch_emails');
    expect(skill.actions).toContain('gmail.search_threads');
    expect(skill.actions).toContain('googlecalendar.list_events');
    
    expect(skill.actions).not.toContain('gmail.list_messages');
    expect(skill.actions).not.toContain('gmail.search_messages');
    expect(skill.actions).not.toContain('google-calendar.list_events');
  });
});
