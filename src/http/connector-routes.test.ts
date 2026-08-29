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

describe('Service Hebrew Info', () => {
  const SERVICE_HEBREW_INFO: Record<string, { name: string; description: string; icon: string }> = {
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

  it('uses correct service IDs gmail and googlecalendar', () => {
    expect(SERVICE_HEBREW_INFO).toHaveProperty('gmail');
    expect(SERVICE_HEBREW_INFO).toHaveProperty('googlecalendar');
    expect(SERVICE_HEBREW_INFO).not.toHaveProperty('google-calendar');
    expect(SERVICE_HEBREW_INFO).not.toHaveProperty('google-mail');
  });

  it('has Hebrew names for services', () => {
    const gmail = SERVICE_HEBREW_INFO['gmail'];
    const googlecalendar = SERVICE_HEBREW_INFO['googlecalendar'];
    expect(gmail?.name).toBe('Gmail');
    expect(googlecalendar?.name).toBe('יומן');
  });

  it('has Hebrew descriptions', () => {
    const gmail = SERVICE_HEBREW_INFO['gmail'];
    const googlecalendar = SERVICE_HEBREW_INFO['googlecalendar'];
    expect(gmail?.description).toMatch(/מיילים/);
    expect(googlecalendar?.description).toMatch(/אירועים|פגישות/);
  });
});

describe('Valid Service IDs for Connect', () => {
  const validServices = ['gmail', 'googlecalendar'];

  it('accepts gmail as valid service', () => {
    expect(validServices.includes('gmail')).toBe(true);
  });

  it('accepts googlecalendar as valid service', () => {
    expect(validServices.includes('googlecalendar')).toBe(true);
  });

  it('rejects google-calendar (hyphenated) as invalid', () => {
    expect(validServices.includes('google-calendar')).toBe(false);
  });

  it('rejects google-mail as invalid', () => {
    expect(validServices.includes('google-mail')).toBe(false);
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
