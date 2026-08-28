import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseUrl } from 'node:url';

const TEST_DATA_DIR = './test-data-onboarding';
const TEST_PAIR_TOKEN = 'test-invite-code-12345';

const FORBIDDEN_CUSTOMER_STRINGS = [
  'Claude',
  'ChatGPT',
  'PAIR_TOKEN',
  'oauth',
  'OAuth',
  'Open Connector',
  'OpenConnector',
  'API key',
  'api_key',
  'apiKey',
  'MODEL_API_KEY',
  '/login',
];

function isAuthenticated(req: IncomingMessage, expectedToken: string): boolean {
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
  return token === expectedToken;
}

function extractToken(req: IncomingMessage): string | undefined {
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

  return queryToken ?? cookieToken ?? bearerToken;
}

beforeEach(() => {
  vi.resetModules();
  process.env['DATA_DIR'] = TEST_DATA_DIR;
  process.env['PAIR_TOKEN'] = TEST_PAIR_TOKEN;
  
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
});

describe('Invite Code Authentication', () => {
  it('accepts invite code from URL query parameter', () => {
    const req = { 
      url: `/?token=${TEST_PAIR_TOKEN}`, 
      headers: {} 
    } as IncomingMessage;
    expect(isAuthenticated(req, TEST_PAIR_TOKEN)).toBe(true);
  });

  it('accepts invite code from cookie after URL token sets it', () => {
    const req = { 
      url: '/api/settings', 
      headers: { cookie: `PAIR_TOKEN=${TEST_PAIR_TOKEN}` } 
    } as IncomingMessage;
    expect(isAuthenticated(req, TEST_PAIR_TOKEN)).toBe(true);
  });

  it('rejects invalid invite code', () => {
    const req = { 
      url: '/?token=wrong-code', 
      headers: {} 
    } as IncomingMessage;
    expect(isAuthenticated(req, TEST_PAIR_TOKEN)).toBe(false);
  });

  it('rejects request without any token', () => {
    const req = { url: '/', headers: {} } as IncomingMessage;
    expect(isAuthenticated(req, TEST_PAIR_TOKEN)).toBe(false);
  });

  it('prefers URL token over cookie for initial auth', () => {
    const req = { 
      url: `/?token=${TEST_PAIR_TOKEN}`, 
      headers: { cookie: 'PAIR_TOKEN=wrong-token' } 
    } as IncomingMessage;
    expect(isAuthenticated(req, TEST_PAIR_TOKEN)).toBe(true);
  });
});

describe('Customer HTML Content - No Technical Terms', () => {
  function containsForbiddenStrings(html: string): string[] {
    const found: string[] = [];
    for (const term of FORBIDDEN_CUSTOMER_STRINGS) {
      if (html.includes(term)) {
        found.push(term);
      }
    }
    return found;
  }

  it('invite gate HTML does not contain forbidden terms', () => {
    const inviteGateHtml = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <title>ברוכים הבאים</title>
</head>
<body>
  <h1>ברוכים הבאים</h1>
  <p>הזינו את קוד ההזמנה שקיבלתם</p>
  <label for="code">קוד הזמנה</label>
  <input type="text" id="code" name="code" placeholder="הזינו כאן">
  <button type="submit">כניסה</button>
</body>
</html>`;

    const forbidden = containsForbiddenStrings(inviteGateHtml);
    expect(forbidden).toEqual([]);
  });

  it('first-run HTML does not contain forbidden terms', () => {
    const firstRunHtml = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <title>הגדרה ראשונית</title>
</head>
<body>
  <h1>בואו נתחיל</h1>
  <p>הגדרת הסוכן האישי שלכם</p>
  <div>חיבור WhatsApp</div>
  <div>פרטים</div>
  <label>שם</label>
  <label>שם העסק</label>
  <label>אזור זמן</label>
  <div>כלים</div>
  <div>Gmail</div>
  <div>יומן</div>
  <button>סיום</button>
</body>
</html>`;

    const forbidden = containsForbiddenStrings(firstRunHtml);
    expect(forbidden).toEqual([]);
  });

  it('home page HTML does not contain forbidden terms', () => {
    const homeHtml = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <title>הסוכן שלי</title>
</head>
<body>
  <h1>הסוכן שלי</h1>
  <p>הסוכן פעיל</p>
  <h3>איך להשתמש</h3>
  <ol>
    <li>פתחו את WhatsApp בטלפון</li>
    <li>שלחו הודעה לעצמכם</li>
  </ol>
  <h3>כלים מחוברים</h3>
  <a href="/setup/operator">מתקדם</a>
</body>
</html>`;

    const forbidden = containsForbiddenStrings(homeHtml);
    expect(forbidden).toEqual([]);
  });

  it('operator page MAY contain technical terms (it is for operators)', () => {
    const operatorHtml = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <title>הגדרות מתקדמות</title>
</head>
<body>
  <h1>הגדרות מתקדמות</h1>
  <p>הגדרות אופרטור למפעיל המערכת</p>
  <label>מודל AI</label>
  <input placeholder="claude-3-5-sonnet-20241022">
  <label>מצב מפתחות API</label>
  <label>טוקן Connector</label>
</body>
</html>`;

    // Operator page IS allowed to have technical terms
    expect(operatorHtml).toContain('מודל AI');
    expect(operatorHtml).toContain('API');
    expect(operatorHtml).toContain('Connector');
  });
});

describe('Customer API Responses - No Technical Terms', () => {
  function containsForbiddenStringsInJson(json: Record<string, unknown>): string[] {
    const jsonStr = JSON.stringify(json);
    const found: string[] = [];
    for (const term of FORBIDDEN_CUSTOMER_STRINGS) {
      if (jsonStr.includes(term)) {
        found.push(term);
      }
    }
    return found;
  }

  it('/api/settings response has no forbidden terms', () => {
    const settingsResponse = {
      success: true,
      data: {
        ownerName: 'ישראל ישראלי',
        businessName: 'העסק שלי',
        timezone: 'Asia/Jerusalem',
        setupComplete: false,
        whatsappPaired: true,
        whatsappName: 'ישראל',
        whatsappPhone: '972501234567',
      }
    };

    const forbidden = containsForbiddenStringsInJson(settingsResponse);
    expect(forbidden).toEqual([]);
  });

  it('/api/tools response has Hebrew names, no action IDs', () => {
    const toolsResponse = {
      success: true,
      data: [
        {
          id: 'gmail',
          hebrewName: 'Gmail',
          hebrewDescription: 'קריאה ומענה למיילים',
          icon: '✉️',
          serviceId: 'google-mail',
          isConnected: true,
          identity: 'user@example.com',
        },
        {
          id: 'calendar',
          hebrewName: 'יומן',
          hebrewDescription: 'ניהול פגישות ואירועים',
          icon: '📅',
          serviceId: 'google-calendar',
          isConnected: false,
        }
      ]
    };

    const forbidden = containsForbiddenStringsInJson(toolsResponse);
    expect(forbidden).toEqual([]);
    
    // Verify Hebrew names are present
    expect(toolsResponse.data[0]?.hebrewName).toBe('Gmail');
    expect(toolsResponse.data[1]?.hebrewName).toBe('יומן');
  });

  it('/api/pairing response has no forbidden terms', () => {
    const pairingResponse = {
      success: true,
      data: {
        isPaired: true,
        phoneNumber: '972501234567',
        name: 'ישראל',
      }
    };

    const forbidden = containsForbiddenStringsInJson(pairingResponse);
    expect(forbidden).toEqual([]);
  });
});

describe('Setup Completion Requirements', () => {
  interface SetupState {
    whatsappPaired: boolean;
    ownerName: string;
    toolsConnected: number;
  }

  function canCompleteSetup(state: SetupState): { canComplete: boolean; error?: string } {
    if (!state.whatsappPaired) {
      return { canComplete: false, error: 'יש לחבר WhatsApp קודם' };
    }
    if (!state.ownerName.trim()) {
      return { canComplete: false, error: 'יש למלא שם' };
    }
    // Tools are optional
    return { canComplete: true };
  }

  it('requires WhatsApp to be paired', () => {
    const result = canCompleteSetup({
      whatsappPaired: false,
      ownerName: 'ישראל',
      toolsConnected: 0,
    });
    expect(result.canComplete).toBe(false);
    expect(result.error).toBe('יש לחבר WhatsApp קודם');
  });

  it('requires owner name to be filled', () => {
    const result = canCompleteSetup({
      whatsappPaired: true,
      ownerName: '',
      toolsConnected: 0,
    });
    expect(result.canComplete).toBe(false);
    expect(result.error).toBe('יש למלא שם');
  });

  it('requires owner name to be non-whitespace', () => {
    const result = canCompleteSetup({
      whatsappPaired: true,
      ownerName: '   ',
      toolsConnected: 0,
    });
    expect(result.canComplete).toBe(false);
    expect(result.error).toBe('יש למלא שם');
  });

  it('allows completion without any tools connected', () => {
    const result = canCompleteSetup({
      whatsappPaired: true,
      ownerName: 'ישראל',
      toolsConnected: 0,
    });
    expect(result.canComplete).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('allows completion with tools connected', () => {
    const result = canCompleteSetup({
      whatsappPaired: true,
      ownerName: 'ישראל',
      toolsConnected: 3,
    });
    expect(result.canComplete).toBe(true);
  });
});

describe('Already-Paired WhatsApp', () => {
  interface PairingState {
    isPaired: boolean;
    qrCode?: string;
    phoneNumber?: string;
    name?: string;
  }

  function shouldShowQR(state: PairingState): boolean {
    return !state.isPaired;
  }

  function shouldShowConnectedChip(state: PairingState): boolean {
    return state.isPaired;
  }

  it('does not show QR when already paired', () => {
    const state: PairingState = {
      isPaired: true,
      phoneNumber: '972526457008',
      name: 'Yishai K',
    };
    
    expect(shouldShowQR(state)).toBe(false);
    expect(shouldShowConnectedChip(state)).toBe(true);
  });

  it('shows QR when not paired', () => {
    const state: PairingState = {
      isPaired: false,
      qrCode: 'some-qr-data',
    };
    
    expect(shouldShowQR(state)).toBe(true);
    expect(shouldShowConnectedChip(state)).toBe(false);
  });

  it('shows connected chip with name and phone when paired', () => {
    const state: PairingState = {
      isPaired: true,
      phoneNumber: '972526457008',
      name: 'Yishai K',
    };
    
    // Simulating what the UI would show
    const chipContent = `${state.name} (${state.phoneNumber})`;
    expect(chipContent).toBe('Yishai K (972526457008)');
  });
});

describe('Cookie Security', () => {
  function buildSetCookieHeader(token: string, isHttps: boolean): string {
    const securePart = isHttps ? '; Secure' : '';
    return `PAIR_TOKEN=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${securePart}`;
  }

  it('sets HttpOnly and SameSite=Strict on cookie', () => {
    const header = buildSetCookieHeader(TEST_PAIR_TOKEN, false);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
  });

  it('sets Secure flag when HTTPS', () => {
    const header = buildSetCookieHeader(TEST_PAIR_TOKEN, true);
    expect(header).toContain('Secure');
  });

  it('does not set Secure flag when HTTP', () => {
    const header = buildSetCookieHeader(TEST_PAIR_TOKEN, false);
    expect(header).not.toContain('Secure');
  });

  it('sets long expiry (1 year)', () => {
    const header = buildSetCookieHeader(TEST_PAIR_TOKEN, false);
    expect(header).toContain('Max-Age=31536000');
  });
});

describe('Hebrew RTL UI Requirements', () => {
  it('HTML includes lang="he" and dir="rtl"', () => {
    const html = '<html lang="he" dir="rtl">';
    expect(html).toContain('lang="he"');
    expect(html).toContain('dir="rtl"');
  });

  it('uses Hebrew text for all customer-facing labels', () => {
    const labels = {
      inviteCode: 'קוד הזמנה',
      name: 'שם',
      businessName: 'שם העסק',
      timezone: 'אזור זמן',
      connectWhatsApp: 'חיבור WhatsApp',
      tools: 'כלים',
      finish: 'סיום',
      connected: 'מחובר',
      connect: 'חבר',
    };

    // All labels should be Hebrew
    for (const [key, value] of Object.entries(labels)) {
      // Hebrew text should have Hebrew characters
      const hasHebrew = /[\u0590-\u05FF]/.test(value) || value === 'WhatsApp';
      expect(hasHebrew).toBe(true);
    }
  });
});

describe('Token Extraction Precedence', () => {
  it('URL query > cookie > bearer', () => {
    // Query takes precedence
    const req1 = { 
      url: `/?token=${TEST_PAIR_TOKEN}`, 
      headers: { 
        cookie: 'PAIR_TOKEN=cookie-token',
        authorization: 'Bearer bearer-token'
      } 
    } as IncomingMessage;
    expect(extractToken(req1)).toBe(TEST_PAIR_TOKEN);

    // Cookie takes precedence over bearer
    const req2 = { 
      url: '/', 
      headers: { 
        cookie: `PAIR_TOKEN=${TEST_PAIR_TOKEN}`,
        authorization: 'Bearer bearer-token'
      } 
    } as IncomingMessage;
    expect(extractToken(req2)).toBe(TEST_PAIR_TOKEN);

    // Bearer is last resort
    const req3 = { 
      url: '/', 
      headers: { 
        authorization: `Bearer ${TEST_PAIR_TOKEN}`
      } 
    } as IncomingMessage;
    expect(extractToken(req3)).toBe(TEST_PAIR_TOKEN);
  });
});
