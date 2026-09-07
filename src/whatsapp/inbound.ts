/**
 * Pure inbound-message helpers — extract text, detect captionless media,
 * and decide whether a WhatsApp timestamp is too old to process.
 */

export const MEDIA_WITHOUT_TEXT_BODY = '__WA_MEDIA_WITHOUT_TEXT__';

export const MAX_INBOUND_AGE_MS = 10 * 60 * 1000;
export const QUOTE_AFTER_MS = 30 * 1000;

/** Structural subset of Baileys proto.IMessage used for body extraction. */
export interface InboundContextInfo {
  isForwarded?: boolean | null;
  forwardingScore?: number | null;
}

export interface InboundProtoMessage {
  conversation?: string | null;
  extendedTextMessage?: { text?: string | null; contextInfo?: InboundContextInfo | null } | null;
  imageMessage?: { caption?: string | null; contextInfo?: InboundContextInfo | null } | null;
  videoMessage?: { caption?: string | null; contextInfo?: InboundContextInfo | null } | null;
  documentMessage?: { caption?: string | null; contextInfo?: InboundContextInfo | null } | null;
  deviceSentMessage?: { destinationJid?: string | null; message?: InboundProtoMessage | null } | null;
  audioMessage?: object | null;
  stickerMessage?: object | null;
  locationMessage?: object | null;
  liveLocationMessage?: object | null;
  contactMessage?: object | null;
  contactsArrayMessage?: object | null;
  viewOnceMessage?: { message?: InboundProtoMessage | null } | null;
  viewOnceMessageV2?: { message?: InboundProtoMessage | null } | null;
  viewOnceMessageV2Extension?: { message?: InboundProtoMessage | null } | null;
}

/**
 * WhatsApp timestamps are unix seconds; some tests/callers pass milliseconds.
 */
export function inboundTimestampMs(timestamp: number): number {
  return timestamp > 1e12 ? timestamp : timestamp * 1000;
}

export function isStaleInbound(timestamp: number, nowMs: number = Date.now()): boolean {
  const tsMs = inboundTimestampMs(timestamp);
  if (tsMs > nowMs + 60_000) return false;
  return nowMs - tsMs > MAX_INBOUND_AGE_MS;
}

export function shouldQuoteInbound(timestamp: number, nowMs: number = Date.now()): boolean {
  const tsMs = inboundTimestampMs(timestamp);
  return nowMs - tsMs >= QUOTE_AFTER_MS;
}

/**
 * Pull a usable text body out of a WhatsApp message.
 * Captionless media (voice, sticker, location, image/video/document without
 * caption) returns MEDIA_WITHOUT_TEXT_BODY so the handler can reply instead
 * of silent-dropping.
 */
export function extractMessageBody(message: InboundProtoMessage): string | null {
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;

  const viewOnce = message.viewOnceMessage?.message
    ?? message.viewOnceMessageV2?.message
    ?? message.viewOnceMessageV2Extension?.message;
  if (viewOnce) return extractMessageBody(viewOnce);

  if (
    message.imageMessage ||
    message.videoMessage ||
    message.documentMessage ||
    message.audioMessage ||
    message.stickerMessage ||
    message.locationMessage ||
    message.liveLocationMessage ||
    message.contactMessage ||
    message.contactsArrayMessage
  ) {
    return MEDIA_WITHOUT_TEXT_BODY;
  }

  return null;
}

/**
 * Forwarded notepad / third-party bubbles (#191).
 * Checks conversation-less extended text and media contextInfo.
 */
export function isInboundForwarded(message: InboundProtoMessage): boolean {
  const contexts: Array<InboundContextInfo | null | undefined> = [
    message.extendedTextMessage?.contextInfo,
    message.imageMessage?.contextInfo,
    message.videoMessage?.contextInfo,
    message.documentMessage?.contextInfo,
  ];
  const viewOnce = message.viewOnceMessage?.message
    ?? message.viewOnceMessageV2?.message
    ?? message.viewOnceMessageV2Extension?.message;
  if (viewOnce) {
    return isInboundForwarded(viewOnce);
  }
  for (const ctx of contexts) {
    if (!ctx) continue;
    if (ctx.isForwarded) return true;
    if ((ctx.forwardingScore ?? 0) > 0) return true;
  }
  return false;
}

/** Body is solely an image/video/document caption (not conversation/extended text). */
export function isInboundMediaCaption(message: InboundProtoMessage): boolean {
  if (message.conversation || message.extendedTextMessage?.text) return false;
  if (message.imageMessage?.caption) return true;
  if (message.videoMessage?.caption) return true;
  if (message.documentMessage?.caption) return true;
  const viewOnce = message.viewOnceMessage?.message
    ?? message.viewOnceMessageV2?.message
    ?? message.viewOnceMessageV2Extension?.message;
  if (viewOnce) return isInboundMediaCaption(viewOnce);
  return false;
}

/**
 * #187: Baileys maps fromMe→@bot so remoteJid becomes the owner JID.
 * If we still know the real destination and it is not self-chat, drop for the
 * full handler path (model + tools + confirm).
 */
export function shouldDropMappedNonSelfDestination(
  remoteJid: string | null | undefined,
  destinationJid: string | null | undefined,
  isSelf: (jid: string) => boolean,
): boolean {
  if (!destinationJid) return false;
  if (destinationJid.endsWith('@bot')) return true;
  if (remoteJid && isSelf(remoteJid) && !isSelf(destinationJid)) return true;
  return false;
}
