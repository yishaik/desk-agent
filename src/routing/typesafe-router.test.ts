import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  process.env['TYPESAFE_CONFIDENCE_THRESHOLD'] = '0.75';
  process.env['TYPESAFE_TIMEOUT_MS'] = '5000';
});

describe('TypeSafeIntentRouter', () => {
  it('routes a confident supported intent and preserves probabilities', async () => {
    const { TypeSafeIntentRouter } = await import('./typesafe-router.ts');
    const client = { systemOne: vi.fn().mockResolvedValue({ answers: { intent: {
      choice: 'booking', confidence: 0.91,
      probabilities: { booking: 0.91, question: 0.04, complaint: 0.01, spam: 0.01, other: 0.03 },
    } } }) };
    const result = await new TypeSafeIntentRouter(client as never).route('אפשר לקבוע למחר?');
    expect(result).toMatchObject({ intent: 'booking', confidence: 0.91, disposition: 'route' });
    expect(result.probabilities.booking).toBe(0.91);
  });

  it('fails closed to handoff below threshold', async () => {
    const { TypeSafeIntentRouter } = await import('./typesafe-router.ts');
    const client = { systemOne: vi.fn().mockResolvedValue({ answers: { intent: {
      choice: 'question', confidence: 0.62,
      probabilities: { booking: 0.1, question: 0.4, complaint: 0.2, spam: 0.08, other: 0.22 },
    } } }) };
    const result = await new TypeSafeIntentRouter(client as never).route('היי');
    expect(result).toMatchObject({ disposition: 'human_handoff', reason: 'low_confidence' });
  });

  it('always hands complaints to a person', async () => {
    const { TypeSafeIntentRouter } = await import('./typesafe-router.ts');
    const client = { systemOne: vi.fn().mockResolvedValue({ answers: { intent: {
      choice: 'complaint', confidence: 0.98,
      probabilities: { booking: 0, question: 0.01, complaint: 0.98, spam: 0, other: 0.01 },
    } } }) };
    const result = await new TypeSafeIntentRouter(client as never).route('אני רוצה מנהל');
    expect(result).toMatchObject({ disposition: 'human_handoff', reason: 'complaint' });
  });

  it('hands unsupported or unclear intents to a person even at high confidence', async () => {
    const { TypeSafeIntentRouter } = await import('./typesafe-router.ts');
    const client = { systemOne: vi.fn().mockResolvedValue({ answers: { intent: {
      choice: 'other', confidence: 1,
      probabilities: { booking: 0, question: 0, complaint: 0, spam: 0, other: 1 },
    } } }) };
    const result = await new TypeSafeIntentRouter(client as never).route('היי');
    expect(result).toMatchObject({ disposition: 'human_handoff', reason: 'unsupported_intent' });
  });

  it('fails closed when TypeSafe is unavailable', async () => {
    const { TypeSafeIntentRouter } = await import('./typesafe-router.ts');
    const client = { systemOne: vi.fn().mockRejectedValue(new Error('offline')) };
    const result = await new TypeSafeIntentRouter(client as never).route('message');
    expect(result).toMatchObject({ disposition: 'human_handoff', reason: 'service_error', confidence: 0 });
  });
});
