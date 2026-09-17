import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
const dir = './test-data-customer-routing';

beforeEach(() => {
  vi.resetModules();
  process.env['DATA_DIR'] = dir;
  process.env['CUSTOMER_INBOUND_ENABLED'] = 'true';
  process.env['CUSTOMER_ALLOWLIST'] = '972501234567';
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
});
afterEach(async () => {
  try { (await import('../core/memory.ts')).closeDatabase(); } catch {}
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  delete process.env['DATA_DIR']; delete process.env['CUSTOMER_INBOUND_ENABLED']; delete process.env['CUSTOMER_ALLOWLIST'];
});

const message = { id: 'c1', from: '972501234567@s.whatsapp.net', to: 'owner@s.whatsapp.net', body: 'אני צריך לדבר עם מנהל', timestamp: 1, isFromMe: false };

describe('customer ingress', () => {
  it('allows only explicit direct-phone allowlist entries', async () => {
    const { isAllowedCustomerMessage } = await import('./customer-inbound.ts');
    expect(isAllowedCustomerMessage(message)).toBe(true);
    expect(isAllowedCustomerMessage({ ...message, from: '1-2@g.us' })).toBe(false);
    expect(isAllowedCustomerMessage({ ...message, from: '972509999999@s.whatsapp.net' })).toBe(false);
    expect(isAllowedCustomerMessage({ ...message, isFromMe: true })).toBe(false);
  });

  it('persists a handoff before notifying owner and customer', async () => {
    const { processCustomerInbound } = await import('./customer-inbound.ts');
    const { listOpenHumanHandoffs } = await import('../core/memory.ts');
    const sender = { sendCustomer: vi.fn(), notifyOwner: vi.fn() };
    const router = { route: vi.fn().mockResolvedValue({ intent: 'complaint', confidence: 0.95, probabilities: { booking: 0, question: 0, complaint: 0.95, spam: 0, other: 0.05 }, disposition: 'human_handoff', reason: 'complaint' }) };
    await processCustomerInbound(message, sender, router as never);
    expect(listOpenHumanHandoffs()).toHaveLength(1);
    expect(sender.notifyOwner).toHaveBeenCalledWith(expect.stringContaining('handoff'));
    expect(sender.sendCustomer).toHaveBeenCalledTimes(1);
  });

  it('does not reply to confident spam but still notifies owner', async () => {
    const { processCustomerInbound } = await import('./customer-inbound.ts');
    const sender = { sendCustomer: vi.fn(), notifyOwner: vi.fn() };
    const router = { route: vi.fn().mockResolvedValue({ intent: 'spam', confidence: 0.97, probabilities: { booking: 0, question: 0, complaint: 0, spam: 0.97, other: 0.03 }, disposition: 'route' }) };
    await processCustomerInbound({ ...message, id: 'c2' }, sender, router as never);
    expect(sender.notifyOwner).toHaveBeenCalledTimes(1);
    expect(sender.sendCustomer).not.toHaveBeenCalled();
  });
});
