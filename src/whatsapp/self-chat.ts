/**
 * Pure self-chat verification — the canonical gate for Message-yourself.
 *
 * This module contains the core logic for determining if a message is a self-chat,
 * extracted for testability. The WhatsApp client and handler use these functions.
 */

/**
 * Extracts the bare phone number or LID identifier from a JID.
 *
 * Examples:
 * - "1234567890:123@s.whatsapp.net" → "1234567890"
 * - "1234567890@s.whatsapp.net" → "1234567890"
 * - "ABC123XYZ@lid" → "ABC123XYZ"
 */
export function bareJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  return jid.split(':')[0]?.split('@')[0] ?? null;
}

/**
 * Determines if a JID belongs to the owner — matches phone OR LID.
 *
 * @param remoteJid - The JID to check (e.g., "1234567890@s.whatsapp.net" or "ABC123@lid")
 * @param ownerPhone - The owner's phone number (e.g., "1234567890")
 * @param ownerLid - The owner's LID (e.g., "ABC123XYZ@lid" or just "ABC123XYZ")
 *
 * Note: fromMe is NOT a parameter and is NOT authorization.
 * Groups (@g.us) and broadcasts (@broadcast) always return false.
 */
export function isSelfChatJid(
  remoteJid: string | null | undefined,
  ownerPhone: string | null | undefined,
  ownerLid: string | null | undefined
): boolean {
  if (!remoteJid) return false;

  // Groups and broadcasts are never self-chat
  if (remoteJid.endsWith('@g.us') || remoteJid.includes('@broadcast')) {
    return false;
  }

  const target = bareJid(remoteJid);
  if (!target) return false;

  // Match against owner phone
  if (ownerPhone && target === ownerPhone) {
    return true;
  }

  // Match against owner LID
  const lidBare = bareJid(ownerLid);
  if (lidBare && target === lidBare) {
    return true;
  }

  return false;
}
