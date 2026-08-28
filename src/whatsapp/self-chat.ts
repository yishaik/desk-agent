/**
 * Self-chat validation for WhatsApp message-yourself feature.
 * 
 * SECURITY CRITICAL: This module ensures the bot ONLY responds to messages
 * in the user's "message yourself" chat. The bot must NEVER respond in:
 * - Chats with other people (even when fromMe=true)
 * - Group chats
 * - Broadcast lists
 * 
 * WhatsApp has two identifiers for the same user:
 * 1. Phone JID: 972501234567@s.whatsapp.net (phone number based)
 * 2. LID JID: 123456789012345@lid (WhatsApp internal ID)
 * 
 * A self-chat is when remoteJid matches either the owner's phone JID or LID.
 */

import { createChildLogger } from '../core/logger.ts';

const log = createChildLogger('self-chat');

/**
 * Normalizes a phone number by removing non-digit characters.
 */
export function normalizePhone(phone: string | undefined | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits || null;
}

/**
 * Extracts the phone number from a WhatsApp JID.
 * Examples:
 * - "972501234567@s.whatsapp.net" -> "972501234567"
 * - "972501234567:0@s.whatsapp.net" -> "972501234567"
 */
export function extractPhoneFromJid(jid: string | undefined | null): string | null {
  if (!jid) return null;
  
  const beforeAt = jid.split('@')[0];
  if (!beforeAt) return null;
  
  const beforeColon = beforeAt.split(':')[0];
  return normalizePhone(beforeColon);
}

/**
 * Extracts the LID from a WhatsApp LID JID.
 * Example: "123456789012345@lid" -> "123456789012345"
 */
export function extractLidFromJid(jid: string | undefined | null): string | null {
  if (!jid || !jid.endsWith('@lid')) return null;
  
  const lidPart = jid.split('@')[0];
  return lidPart || null;
}

/**
 * Checks if a JID is a group chat.
 */
export function isGroupJid(jid: string | undefined | null): boolean {
  if (!jid) return false;
  return jid.endsWith('@g.us');
}

/**
 * Checks if a JID is a broadcast list.
 */
export function isBroadcastJid(jid: string | undefined | null): boolean {
  if (!jid) return false;
  return jid.endsWith('@broadcast') || jid.includes('status@broadcast');
}

/**
 * Checks if remoteJid represents a self-chat (message-yourself) conversation.
 * 
 * SECURITY: This is the ONLY function that determines if the bot should respond.
 * 
 * A self-chat is when:
 * 1. remoteJid is NOT a group or broadcast
 * 2. remoteJid matches either:
 *    - The owner's phone JID (972501234567@s.whatsapp.net)
 *    - The owner's LID JID (123456789012345@lid)
 * 
 * @param remoteJid - The JID of the chat where the message was sent
 * @param ownerPhone - The owner's phone number (without @s.whatsapp.net)
 * @param ownerLid - The owner's LID (without @lid), if known
 * @returns true if this is a self-chat, false otherwise
 */
export function isSelfChatJid(
  remoteJid: string | undefined | null,
  ownerPhone: string | undefined | null,
  ownerLid: string | undefined | null
): boolean {
  if (!remoteJid) {
    log.debug({ remoteJid }, 'Self-chat check: no remoteJid');
    return false;
  }

  if (isGroupJid(remoteJid)) {
    log.debug({ remoteJid }, 'Self-chat check: group chat rejected');
    return false;
  }

  if (isBroadcastJid(remoteJid)) {
    log.debug({ remoteJid }, 'Self-chat check: broadcast rejected');
    return false;
  }

  const normalizedOwnerPhone = normalizePhone(ownerPhone);
  const remotePhone = extractPhoneFromJid(remoteJid);

  if (normalizedOwnerPhone && remotePhone && normalizedOwnerPhone === remotePhone) {
    log.debug({ remoteJid, ownerPhone: normalizedOwnerPhone }, 'Self-chat check: phone match');
    return true;
  }

  if (remoteJid.endsWith('@lid') && ownerLid) {
    const remoteLid = extractLidFromJid(remoteJid);
    if (remoteLid && remoteLid === ownerLid) {
      log.debug({ remoteJid, ownerLid }, 'Self-chat check: LID match');
      return true;
    }
  }

  log.debug(
    { remoteJid, ownerPhone: normalizedOwnerPhone, ownerLid },
    'Self-chat check: no match - NOT a self-chat'
  );
  return false;
}

/**
 * Validates that a message is safe to respond to.
 * 
 * SECURITY: This enforces the message-yourself-only policy.
 * The bot will NEVER respond to:
 * - Messages in chats with other people
 * - Messages in group chats
 * - Messages in broadcast lists
 * 
 * @param remoteJid - The JID of the chat
 * @param isFromMe - Whether the message was sent by the owner
 * @param ownerPhone - The owner's phone number
 * @param ownerLid - The owner's LID (if known)
 * @returns object with allowed boolean and reason string
 */
export function validateSelfChatMessage(
  remoteJid: string | undefined | null,
  isFromMe: boolean,
  ownerPhone: string | undefined | null,
  ownerLid: string | undefined | null
): { allowed: boolean; reason: string } {
  if (!remoteJid) {
    return { allowed: false, reason: 'no_remote_jid' };
  }

  if (isGroupJid(remoteJid)) {
    return { allowed: false, reason: 'group_chat' };
  }

  if (isBroadcastJid(remoteJid)) {
    return { allowed: false, reason: 'broadcast' };
  }

  if (!isSelfChatJid(remoteJid, ownerPhone, ownerLid)) {
    return { allowed: false, reason: 'not_self_chat' };
  }

  return { allowed: true, reason: 'self_chat' };
}
