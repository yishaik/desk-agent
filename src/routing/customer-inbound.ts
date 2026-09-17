import type { Message } from '../core/types.ts';
import { config } from '../core/config.ts';
import { createChildLogger } from '../core/logger.ts';
import { createHumanHandoff } from '../core/memory.ts';
import type { IntentRouter, RouteDecision } from './typesafe-router.ts';
import { TypeSafeIntentRouter } from './typesafe-router.ts';

const log = createChildLogger('customer-routing');

export interface CustomerInboundSender {
  sendCustomer(jid: string, text: string): Promise<void>;
  notifyOwner(text: string): Promise<void>;
}

export function customerHandleFromJid(jid: string): string | null {
  if (!jid.endsWith('@s.whatsapp.net')) return null;
  return jid.split('@')[0]?.split(':')[0] ?? null;
}

export function isAllowedCustomerMessage(message: Message): boolean {
  if (!config.customerInboundEnabled || message.isFromMe) return false;
  const handle = customerHandleFromJid(message.from);
  if (!handle) return false; // excludes groups, broadcasts, LIDs and system chats
  return config.customerAllowlist.has('*') || config.customerAllowlist.has(handle);
}

function customerReply(decision: RouteDecision): string | null {
  if (decision.disposition === 'human_handoff') {
    return 'קיבלנו את ההודעה. העברנו אותה לאדם מהצוות שיחזור אליך.';
  }
  switch (decision.intent) {
    case 'booking': return 'קיבלנו את בקשת התור. נחזור אליך עם הפרטים.';
    case 'question': return 'קיבלנו את השאלה. נחזור אליך עם תשובה.';
    case 'other': return 'קיבלנו את ההודעה ונחזור אליך.';
    case 'spam': return null;
    case 'complaint': return 'קיבלנו את ההודעה. העברנו אותה לאדם מהצוות שיחזור אליך.';
  }
}

function ownerNotice(message: Message, decision: RouteDecision, handoffId?: number): string {
  const handle = customerHandleFromJid(message.from) ?? message.from;
  const pct = Math.round(decision.confidence * 100);
  const prefix = decision.disposition === 'human_handoff' ? '🙋 handoff' : '📥 לקוח';
  const handoff = handoffId ? ` · #${handoffId}` : '';
  return `${prefix}${handoff} · ${handle} · ${decision.intent} (${pct}%)\n${message.body}`;
}

export async function processCustomerInbound(
  message: Message,
  sender: CustomerInboundSender,
  router: IntentRouter = new TypeSafeIntentRouter(),
): Promise<RouteDecision> {
  const decision = await router.route(message.body);
  let handoffId: number | undefined;
  if (decision.disposition === 'human_handoff') {
    handoffId = createHumanHandoff(message, decision);
  }

  await sender.notifyOwner(ownerNotice(message, decision, handoffId));
  const reply = customerReply(decision);
  if (reply) await sender.sendCustomer(message.from, reply);
  log.info({ messageId: message.id, intent: decision.intent, confidence: decision.confidence, disposition: decision.disposition }, 'Customer message routed');
  return decision;
}
