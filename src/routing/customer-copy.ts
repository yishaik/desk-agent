import type { RouteDecision } from './typesafe-router.ts';

/** Final customer-facing acknowledgements. Keep these factual: routing never promises a time. */
export const CUSTOMER_ACKNOWLEDGEMENTS = {
  booking: 'קיבלנו את בקשת התור. נחזור אליך כדי להשלים את התיאום.',
  question: 'קיבלנו את השאלה. נחזור אליך עם תשובה.',
  other: 'קיבלנו את ההודעה, תודה. נחזור אליך.',
  humanHandoff: 'קיבלנו את ההודעה. העברנו אותה לנציג שיחזור אליך.',
} as const;

export function customerAcknowledgement(decision: RouteDecision): string | null {
  if (decision.disposition === 'human_handoff' || decision.intent === 'complaint') {
    return CUSTOMER_ACKNOWLEDGEMENTS.humanHandoff;
  }
  switch (decision.intent) {
    case 'booking': return CUSTOMER_ACKNOWLEDGEMENTS.booking;
    case 'question': return CUSTOMER_ACKNOWLEDGEMENTS.question;
    case 'other': return CUSTOMER_ACKNOWLEDGEMENTS.other;
    case 'spam': return null;
  }
}
