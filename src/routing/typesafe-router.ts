import { choice, TypeSafeClient } from '@typesafe-ai/sdk';
import { config } from '../core/config.ts';

export const CUSTOMER_INTENTS = ['booking', 'question', 'complaint', 'spam', 'other'] as const;
export type CustomerIntent = (typeof CUSTOMER_INTENTS)[number];

export interface RouteDecision {
  intent: CustomerIntent;
  confidence: number;
  probabilities: Record<CustomerIntent, number>;
  disposition: 'route' | 'human_handoff';
  reason?: 'low_confidence' | 'complaint' | 'unsupported_intent' | 'service_error';
}

export interface IntentRouter {
  route(text: string): Promise<RouteDecision>;
}

const criteria = {
  booking: 'The customer wants to book, reschedule, cancel, or check availability for an appointment.',
  question: 'The customer asks for factual business information such as hours, location, services, pricing, or policy.',
  complaint: 'The customer reports a bad experience, dispute, safety concern, refund issue, or asks for a manager or person.',
  spam: 'Unsolicited advertising, scams, irrelevant bulk content, or clearly automated junk.',
  other: 'A legitimate message that does not fit the other categories, including unclear greetings or mixed requests.',
} as const;

function serviceFailure(): RouteDecision {
  return {
    intent: 'other',
    confidence: 0,
    probabilities: { booking: 0, question: 0, complaint: 0, spam: 0, other: 1 },
    disposition: 'human_handoff',
    reason: 'service_error',
  };
}

export class TypeSafeIntentRouter implements IntentRouter {
  private readonly client: TypeSafeClient | null;

  constructor(client?: TypeSafeClient) {
    this.client = client ?? (config.typeSafeApiKey ? new TypeSafeClient({
      apiKey: config.typeSafeApiKey,
      timeout: config.typeSafeTimeoutMs,
      logLevel: 'warn',
    }) : null);
  }

  async route(text: string): Promise<RouteDecision> {
    if (!this.client) return serviceFailure();

    try {
      const response = await this.client.systemOne({
        state: { customer_message: text },
        questions: {
          intent: choice(
            'Choose the single best route for `customer_message`. Use other when the evidence is unclear. Do not invent context.',
            criteria,
          ),
        },
      }, { timeout: config.typeSafeTimeoutMs, retry: { maxRetries: 1 } });
      const answer = response.answers.intent;
      const intent = answer.choice as CustomerIntent;
      const probabilities = answer.probabilities as Record<CustomerIntent, number>;

      if (intent === 'complaint') {
        return { intent, confidence: answer.confidence, probabilities, disposition: 'human_handoff', reason: 'complaint' };
      }
      if (intent === 'other') {
        return { intent, confidence: answer.confidence, probabilities, disposition: 'human_handoff', reason: 'unsupported_intent' };
      }
      if (answer.confidence < config.typeSafeConfidenceThreshold) {
        return { intent, confidence: answer.confidence, probabilities, disposition: 'human_handoff', reason: 'low_confidence' };
      }
      return { intent, confidence: answer.confidence, probabilities, disposition: 'route' };
    } catch {
      return serviceFailure();
    }
  }
}
