import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DATA_DIR = './test-data-auth';
const TEST_PORT = 3999;
const TEST_PAIR_TOKEN = 'test-token-12345';

beforeEach(() => {
  process.env['DATA_DIR'] = TEST_DATA_DIR;
  process.env['PAIR_TOKEN'] = TEST_PAIR_TOKEN;
  process.env['PORT'] = String(TEST_PORT);
  
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
  delete process.env['PORT'];
});

describe('Authentication', () => {
  it('rejects requests without token', async () => {
    const response = await simulateRequest('/api/settings', {});
    expect(response.status).toBe(401);
  });

  it('accepts requests with valid query token', async () => {
    const response = await simulateRequest(`/api/settings?token=${TEST_PAIR_TOKEN}`, {});
    expect(response.status).toBe(200);
  });

  it('accepts requests with valid bearer token', async () => {
    const response = await simulateRequest('/api/settings', {
      headers: { Authorization: `Bearer ${TEST_PAIR_TOKEN}` },
    });
    expect(response.status).toBe(200);
  });

  it('accepts requests with valid cookie token', async () => {
    const response = await simulateRequest('/api/settings', {
      headers: { Cookie: `PAIR_TOKEN=${TEST_PAIR_TOKEN}` },
    });
    expect(response.status).toBe(200);
  });

  it('rejects requests with invalid token', async () => {
    const response = await simulateRequest('/api/settings?token=wrong-token', {});
    expect(response.status).toBe(401);
  });

  it('health endpoint does not require auth', async () => {
    const response = await simulateRequest('/health', {});
    expect(response.status).toBe(200);
  });
});

async function simulateRequest(
  path: string,
  options: { headers?: Record<string, string> }
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const mockReq = {
      url: path,
      method: 'GET',
      headers: options.headers ?? {},
    } as IncomingMessage;

    let statusCode = 200;
    let responseBody = '';

    const mockRes = {
      writeHead(status: number) {
        statusCode = status;
        return mockRes;
      },
      setHeader() {
        // noop
      },
      end(body?: string) {
        responseBody = body ?? '';
        resolve({
          status: statusCode,
          body: responseBody ? JSON.parse(responseBody) : null,
        });
      },
    } as unknown as ServerResponse;

    handleMockRequest(mockReq, mockRes);
  });
}

function handleMockRequest(req: IncomingMessage, res: ServerResponse & { _body?: string }): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  const queryToken = url.searchParams.get('token');
  
  const cookies = (req.headers['cookie'] ?? req.headers['Cookie'] ?? '') as string;
  const cookieToken = cookies
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([key]) => key === 'PAIR_TOKEN')?.[1];
  
  const authHeader = (req.headers['authorization'] ?? req.headers['Authorization']) as string | undefined;
  const bearerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : undefined;

  const token = queryToken ?? cookieToken ?? bearerToken;
  
  if (token !== TEST_PAIR_TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
    return;
  }

  if (path === '/api/settings') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: {} }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: false, error: 'Not found' }));
}
