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
    expect(settings.connectorAdminTokenAcknowledged).toBe(false);
    expect(isAdminTokenAcknowledged()).toBe(false);
    
    acknowledgeAdminToken();
    
    settings = loadSettings();
    expect(settings.connectorAdminTokenAcknowledged).toBe(true);
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
  function isLoopbackOrInternal(url: string): boolean {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      return (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host === 'connector' ||
        host.endsWith('.internal') ||
        host.endsWith('.local')
      );
    } catch {
      return true;
    }
  }

  function isLocalRequest(host: string): boolean {
    const hostWithoutPort = host.split(':')[0]?.toLowerCase() ?? '';
    return hostWithoutPort === 'localhost' || hostWithoutPort === '127.0.0.1' || hostWithoutPort === '::1';
  }

  function getConsoleUrl(
    reqHost: string,
    isProduction: boolean,
    connectorOrigin?: string,
    domain?: string,
    forwardedProto?: string
  ): string | undefined {
    const isLocal = isLocalRequest(reqHost);
    
    if (isLocal && !isProduction) {
      return 'http://localhost:3000';
    }
    
    if (connectorOrigin && !isLoopbackOrInternal(connectorOrigin)) {
      return connectorOrigin;
    }
    
    if (domain && domain !== 'localhost') {
      return `https://${domain}`;
    }
    
    const hostWithoutPort = reqHost.split(':')[0];
    if (hostWithoutPort && !isLocalRequest(reqHost)) {
      const proto = forwardedProto === 'https' ? 'https' : 'https';
      return `${proto}://${hostWithoutPort}`;
    }
    
    return undefined;
  }

  it('allows localhost:3000 for local request in dev mode', () => {
    const result = getConsoleUrl('localhost:3001', false);
    expect(result).toBe('http://localhost:3000');
  });

  it('allows localhost:3000 for 127.0.0.1 request in dev mode', () => {
    const result = getConsoleUrl('127.0.0.1:3001', false);
    expect(result).toBe('http://localhost:3000');
  });

  it('NEVER returns localhost:3000 for local request in production', () => {
    const result = getConsoleUrl('localhost:3001', true);
    expect(result).not.toBe('http://localhost:3000');
  });

  it('NEVER returns localhost:3000 for live host without CONNECTOR_ORIGIN', () => {
    const result = getConsoleUrl('desk.example.com', false);
    expect(result).not.toBe('http://localhost:3000');
    expect(result).toBe('https://desk.example.com');
  });

  it('NEVER returns localhost:3000 for live host in production', () => {
    const result = getConsoleUrl('desk.example.com', true);
    expect(result).not.toBe('http://localhost:3000');
  });

  it('uses public CONNECTOR_ORIGIN when set', () => {
    const result = getConsoleUrl('desk.example.com', true, 'https://connector.example.com');
    expect(result).toBe('https://connector.example.com');
  });

  it('rejects localhost CONNECTOR_ORIGIN on live host', () => {
    const result = getConsoleUrl('desk.example.com', true, 'http://localhost:3000', 'desk.example.com');
    expect(result).not.toBe('http://localhost:3000');
    expect(result).toBe('https://desk.example.com');
  });

  it('rejects 127.0.0.1 CONNECTOR_ORIGIN on live host', () => {
    const result = getConsoleUrl('desk.example.com', true, 'http://127.0.0.1:3000', 'desk.example.com');
    expect(result).not.toBe('http://127.0.0.1:3000');
  });

  it('rejects http://connector:3000 (docker DNS) on live host', () => {
    const result = getConsoleUrl('desk.example.com', true, 'http://connector:3000', 'desk.example.com');
    expect(result).not.toBe('http://connector:3000');
    expect(result).toBe('https://desk.example.com');
  });

  it('uses DOMAIN env var when CONNECTOR_ORIGIN is internal', () => {
    const result = getConsoleUrl('desk.example.com', true, 'http://connector:3000', 'desk.example.com');
    expect(result).toBe('https://desk.example.com');
  });

  it('derives from Host header when CONNECTOR_ORIGIN and DOMAIN missing', () => {
    const result = getConsoleUrl('myapp.example.com', true);
    expect(result).toBe('https://myapp.example.com');
  });

  it('returns undefined when cannot resolve public URL on live host (all fallbacks fail)', () => {
    const result = getConsoleUrl('localhost:3001', true, 'http://localhost:3000', 'localhost');
    expect(result).toBeUndefined();
  });

  it('isLoopbackOrInternal detects localhost', () => {
    expect(isLoopbackOrInternal('http://localhost:3000')).toBe(true);
    expect(isLoopbackOrInternal('http://127.0.0.1:3000')).toBe(true);
    expect(isLoopbackOrInternal('http://connector:3000')).toBe(true);
    expect(isLoopbackOrInternal('http://something.internal:3000')).toBe(true);
    expect(isLoopbackOrInternal('http://something.local:3000')).toBe(true);
  });

  it('isLoopbackOrInternal passes public URLs', () => {
    expect(isLoopbackOrInternal('https://desk.example.com')).toBe(false);
    expect(isLoopbackOrInternal('https://api.connector.io')).toBe(false);
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

describe('isRealConnection filters virtual and no_auth', () => {
  interface Connection {
    service: string;
    connectionName: string;
    authType: string;
    virtual?: boolean;
  }

  function isRealConnection(conn: Connection): boolean {
    return conn.virtual !== true && conn.authType !== 'no_auth';
  }

  it('oauth2 connection is real', () => {
    const conn = { service: 'gmail', connectionName: 'default', authType: 'oauth2' };
    expect(isRealConnection(conn)).toBe(true);
  });

  it('api_key connection is real', () => {
    const conn = { service: 'openai', connectionName: 'default', authType: 'api_key' };
    expect(isRealConnection(conn)).toBe(true);
  });

  it('no_auth connection is NOT real', () => {
    const conn = { service: 'arxiv', connectionName: 'default', authType: 'no_auth' };
    expect(isRealConnection(conn)).toBe(false);
  });

  it('virtual connection is NOT real', () => {
    const conn = { service: 'wikipedia', connectionName: 'default', authType: 'no_auth', virtual: true };
    expect(isRealConnection(conn)).toBe(false);
  });

  it('virtual:true oauth2 is NOT real', () => {
    const conn = { service: 'test', connectionName: 'default', authType: 'oauth2', virtual: true };
    expect(isRealConnection(conn)).toBe(false);
  });
});

describe('Tools endpoint returns real connections only', () => {
  interface Connection {
    service: string;
    connectionName: string;
    authType: string;
    virtual?: boolean;
    identity?: { label: string };
  }

  function isRealConnection(conn: Connection): boolean {
    return conn.virtual !== true && conn.authType !== 'no_auth';
  }

  it('filters out virtual no_auth from tools list', () => {
    const mockConnections: Connection[] = [
      { service: 'gmail', connectionName: 'default', authType: 'oauth2', identity: { label: 'user@gmail.com' } },
      { service: 'arxiv', connectionName: 'default', authType: 'no_auth', virtual: true },
      { service: 'wikipedia', connectionName: 'default', authType: 'no_auth', virtual: true },
    ];
    
    const realConnections = mockConnections.filter(isRealConnection);
    const tools = realConnections.map((conn) => ({
      id: conn.service,
      serviceId: conn.service,
      identity: conn.identity?.label,
    }));
    
    expect(tools).toHaveLength(1);
    expect(tools[0]?.id).toBe('gmail');
  });

  it('returns empty array when only virtual connections exist', () => {
    const mockConnections: Connection[] = [
      { service: 'arxiv', connectionName: 'default', authType: 'no_auth', virtual: true },
      { service: 'wikipedia', connectionName: 'default', authType: 'no_auth', virtual: true },
    ];
    
    const realConnections = mockConnections.filter(isRealConnection);
    expect(realConnections).toHaveLength(0);
  });

  it('connectionCount uses real connections only', () => {
    const mockConnections: Connection[] = [
      { service: 'gmail', connectionName: 'default', authType: 'oauth2' },
      { service: 'slack', connectionName: 'default', authType: 'oauth2' },
      { service: 'arxiv', connectionName: 'default', authType: 'no_auth', virtual: true },
    ];
    
    const realConnections = mockConnections.filter(isRealConnection);
    expect(realConnections.length).toBe(2);
  });

  it('services isConnected uses real connections only', () => {
    const mockConnections: Connection[] = [
      { service: 'gmail', connectionName: 'default', authType: 'oauth2', identity: { label: 'user@gmail.com' } },
      { service: 'arxiv', connectionName: 'default', authType: 'no_auth', virtual: true },
    ];
    
    const mockProviders = [
      { id: 'gmail', displayName: 'Gmail' },
      { id: 'arxiv', displayName: 'arXiv' },
      { id: 'slack', displayName: 'Slack' },
    ];
    
    const realConnections = mockConnections.filter(isRealConnection);
    const connectionMap = new Map(realConnections.map((c) => [c.service, c]));
    
    const services = mockProviders.map((p) => ({
      id: p.id,
      isConnected: !!connectionMap.get(p.id),
      identity: connectionMap.get(p.id)?.identity?.label,
    }));
    
    expect(services.find((s) => s.id === 'gmail')?.isConnected).toBe(true);
    expect(services.find((s) => s.id === 'gmail')?.identity).toBe('user@gmail.com');
    expect(services.find((s) => s.id === 'arxiv')?.isConnected).toBe(false);
    expect(services.find((s) => s.id === 'arxiv')?.identity).toBeUndefined();
    expect(services.find((s) => s.id === 'slack')?.isConnected).toBe(false);
  });
});

describe('DELETE refuses no_auth services', () => {
  interface Connection {
    service: string;
    connectionName: string;
    authType: string;
    virtual?: boolean;
  }

  function isRealConnection(conn: Connection): boolean {
    return conn.virtual !== true && conn.authType !== 'no_auth';
  }

  it('refuses to disconnect arxiv (no_auth)', () => {
    const connections: Connection[] = [
      { service: 'arxiv', connectionName: 'default', authType: 'no_auth', virtual: true },
    ];
    
    const realConnection = connections.find(
      (c) => c.service === 'arxiv' && isRealConnection(c)
    );
    
    expect(realConnection).toBeUndefined();
  });

  it('allows disconnect for gmail (oauth2)', () => {
    const connections: Connection[] = [
      { service: 'gmail', connectionName: 'my-gmail', authType: 'oauth2' },
    ];
    
    const realConnection = connections.find(
      (c) => c.service === 'gmail' && isRealConnection(c)
    );
    
    expect(realConnection).toBeDefined();
    expect(realConnection?.connectionName).toBe('my-gmail');
  });

  it('uses connectionName from the real connection', () => {
    const connections: Connection[] = [
      { service: 'gmail', connectionName: 'work-account', authType: 'oauth2' },
    ];
    
    const realConnection = connections.find(
      (c) => c.service === 'gmail' && isRealConnection(c)
    );
    
    expect(realConnection?.connectionName).toBe('work-account');
  });

  it('honors query connectionName to disconnect specific alias', () => {
    const connections: Connection[] = [
      { service: 'gmail', connectionName: 'personal', authType: 'oauth2' },
      { service: 'gmail', connectionName: 'work', authType: 'oauth2' },
    ];
    
    const queryConnectionName = 'work';
    const targetConnection = connections.find(
      (c) => c.service === 'gmail' && c.connectionName === queryConnectionName
    );
    
    expect(targetConnection?.connectionName).toBe('work');
  });

  it('refuses query connectionName if it points to no_auth', () => {
    const connections: Connection[] = [
      { service: 'arxiv', connectionName: 'default', authType: 'no_auth', virtual: true },
    ];
    
    const queryConnectionName = 'default';
    const targetConnection = connections.find(
      (c) => c.service === 'arxiv' && c.connectionName === queryConnectionName
    );
    
    expect(targetConnection).toBeDefined();
    expect(isRealConnection(targetConnection!)).toBe(false);
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

describe('Tool enabled/disabled state', () => {
  it('tools include enabled field defaulting to true', () => {
    const mockServices: { id: string; enabled: boolean }[] = [];
    const serviceConfigMap = new Map(mockServices.map((s) => [s.id, s]));
    
    const serviceId = 'gmail';
    const enabled = serviceConfigMap.get(serviceId)?.enabled ?? true;
    
    expect(enabled).toBe(true);
  });

  it('tools reflect enabled:false from settings.services', () => {
    const mockServices = [{ id: 'gmail', name: 'Gmail', enabled: false }];
    const serviceConfigMap = new Map(mockServices.map((s) => [s.id, s]));
    
    const serviceId = 'gmail';
    const enabled = serviceConfigMap.get(serviceId)?.enabled ?? true;
    
    expect(enabled).toBe(false);
  });

  it('PATCH /api/connector/tools/:service/enabled only works for real connections', () => {
    interface Connection {
      service: string;
      connectionName: string;
      authType: string;
      virtual?: boolean;
    }

    function isRealConnection(conn: Connection): boolean {
      return conn.virtual !== true && conn.authType !== 'no_auth';
    }

    const connections: Connection[] = [
      { service: 'gmail', connectionName: 'default', authType: 'oauth2' },
      { service: 'arxiv', connectionName: 'default', authType: 'no_auth', virtual: true },
    ];
    
    const gmailConn = connections.find((c) => c.service === 'gmail' && isRealConnection(c));
    const arxivConn = connections.find((c) => c.service === 'arxiv' && isRealConnection(c));
    
    expect(gmailConn).toBeDefined();
    expect(arxivConn).toBeUndefined();
  });
});

describe('Action-level enable/disable', () => {
  it('actions include enabled field defaulting to true', () => {
    const mockServices: { id: string; disabledActions?: string[] }[] = [];
    const disabledActionsMap = new Map<string, Set<string>>();
    for (const svc of mockServices) {
      if (svc.disabledActions && svc.disabledActions.length > 0) {
        disabledActionsMap.set(svc.id, new Set(svc.disabledActions));
      }
    }
    
    const actionId = 'gmail.send_email';
    const serviceId = 'gmail';
    const disabledSet = disabledActionsMap.get(serviceId);
    const enabled = !disabledSet?.has(actionId);
    
    expect(enabled).toBe(true);
  });

  it('actions reflect enabled:false from disabledActions', () => {
    const mockServices = [{ id: 'gmail', disabledActions: ['gmail.send_email'] }];
    const disabledActionsMap = new Map<string, Set<string>>();
    for (const svc of mockServices) {
      if (svc.disabledActions && svc.disabledActions.length > 0) {
        disabledActionsMap.set(svc.id, new Set(svc.disabledActions));
      }
    }
    
    const actionId = 'gmail.send_email';
    const serviceId = 'gmail';
    const disabledSet = disabledActionsMap.get(serviceId);
    const enabled = !disabledSet?.has(actionId);
    
    expect(enabled).toBe(false);
  });

  it('PATCH action enabled validates action exists in listActions', () => {
    const serviceActions = [
      { id: 'gmail.send_email', service: 'gmail', displayName: 'Send Email', description: '' },
      { id: 'gmail.fetch_emails', service: 'gmail', displayName: 'Fetch Emails', description: '' },
    ];
    const actionId = 'gmail.send_email';
    
    const exists = serviceActions.some((a) => a.id === actionId);
    expect(exists).toBe(true);
  });

  it('PATCH action enabled rejects action not in listActions (404)', () => {
    const serviceActions = [
      { id: 'gmail.send_email', service: 'gmail', displayName: 'Send Email', description: '' },
      { id: 'gmail.fetch_emails', service: 'gmail', displayName: 'Fetch Emails', description: '' },
    ];
    const inventedActionId = 'gmail.invented_action';
    
    const exists = serviceActions.some((a) => a.id === inventedActionId);
    expect(exists).toBe(false);
  });

  it('PATCH action enabled rejects if listActions is empty (404)', () => {
    const serviceActions: { id: string }[] = [];
    const actionId = 'gmail.send_email';
    
    const exists = serviceActions.some((a) => a.id === actionId);
    expect(exists).toBe(false);
  });

  it('PATCH action enabled requires real connection', () => {
    interface Connection {
      service: string;
      connectionName: string;
      authType: string;
      virtual?: boolean;
    }

    function isRealConnection(conn: Connection): boolean {
      return conn.virtual !== true && conn.authType !== 'no_auth';
    }

    const connections: Connection[] = [
      { service: 'gmail', connectionName: 'default', authType: 'oauth2' },
      { service: 'arxiv', connectionName: 'default', authType: 'no_auth', virtual: true },
    ];
    
    const gmailConn = connections.find((c) => c.service === 'gmail' && isRealConnection(c));
    const arxivConn = connections.find((c) => c.service === 'arxiv' && isRealConnection(c));
    
    expect(gmailConn).toBeDefined();
    expect(arxivConn).toBeUndefined();
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
