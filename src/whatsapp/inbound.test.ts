import { describe, it, expect } from 'vitest';
import {
  extractMessageBody,
  isStaleInbound,
  shouldQuoteInbound,
  isInboundForwarded,
  isInboundMediaCaption,
  shouldDropMappedNonSelfDestination,
  MEDIA_WITHOUT_TEXT_BODY,
  MAX_INBOUND_AGE_MS,
} from './inbound.ts';

describe('extractMessageBody — captionless media is not silent-dropped (#141)', () => {
  it('returns conversation text', () => {
    expect(extractMessageBody({ conversation: 'hello' })).toBe('hello');
  });

  it('returns extended text', () => {
    expect(extractMessageBody({ extendedTextMessage: { text: 'hi' } })).toBe('hi');
  });

  it('returns image caption when present', () => {
    expect(extractMessageBody({ imageMessage: { caption: 'a photo' } })).toBe('a photo');
  });

  it('returns placeholder for image without caption', () => {
    expect(extractMessageBody({ imageMessage: { caption: null } })).toBe(MEDIA_WITHOUT_TEXT_BODY);
    expect(extractMessageBody({ imageMessage: {} })).toBe(MEDIA_WITHOUT_TEXT_BODY);
  });

  it('returns placeholder for voice/audio', () => {
    expect(extractMessageBody({ audioMessage: { ptt: true } })).toBe(MEDIA_WITHOUT_TEXT_BODY);
  });

  it('returns placeholder for sticker', () => {
    expect(extractMessageBody({ stickerMessage: {} })).toBe(MEDIA_WITHOUT_TEXT_BODY);
  });

  it('returns placeholder for location', () => {
    expect(extractMessageBody({ locationMessage: {} })).toBe(MEDIA_WITHOUT_TEXT_BODY);
  });

  it('returns placeholder for video/document without caption', () => {
    expect(extractMessageBody({ videoMessage: {} })).toBe(MEDIA_WITHOUT_TEXT_BODY);
    expect(extractMessageBody({ documentMessage: {} })).toBe(MEDIA_WITHOUT_TEXT_BODY);
  });

  it('returns video caption when present', () => {
    expect(extractMessageBody({ videoMessage: { caption: 'clip' } })).toBe('clip');
  });

  it('returns null for empty / reaction-like messages', () => {
    expect(extractMessageBody({})).toBeNull();
  });
});

describe('isStaleInbound (#155)', () => {
  it('skips unix-seconds timestamps older than ~10 minutes', () => {
    const now = Date.now();
    const elevenMinAgoSec = Math.floor(now / 1000) - 11 * 60;
    expect(isStaleInbound(elevenMinAgoSec, now)).toBe(true);
  });

  it('skips millisecond timestamps older than ~10 minutes', () => {
    const now = Date.now();
    expect(isStaleInbound(now - MAX_INBOUND_AGE_MS - 1000, now)).toBe(true);
  });

  it('does not skip recent timestamps (seconds or ms)', () => {
    const now = Date.now();
    expect(isStaleInbound(Math.floor(now / 1000), now)).toBe(false);
    expect(isStaleInbound(now, now)).toBe(false);
    expect(isStaleInbound(Math.floor(now / 1000) - 60, now)).toBe(false);
  });

  it('does not skip future timestamps (clock skew)', () => {
    const now = Date.now();
    expect(isStaleInbound(Math.floor(now / 1000) + 3600, now)).toBe(false);
  });
});

describe('shouldQuoteInbound', () => {
  it('quotes messages older than 30s', () => {
    const now = Date.now();
    expect(shouldQuoteInbound(Math.floor(now / 1000) - 45, now)).toBe(true);
    expect(shouldQuoteInbound(now, now)).toBe(false);
  });
});

describe('#191 forwarded / caption helpers', () => {
  it('detects isForwarded and forwardingScore on extended text', () => {
    expect(isInboundForwarded({
      extendedTextMessage: { text: 'ok', contextInfo: { isForwarded: true } },
    })).toBe(true);
    expect(isInboundForwarded({
      extendedTextMessage: { text: 'ok', contextInfo: { forwardingScore: 2 } },
    })).toBe(true);
    expect(isInboundForwarded({ extendedTextMessage: { text: 'ok' } })).toBe(false);
  });

  it('detects media captions vs typed conversation', () => {
    expect(isInboundMediaCaption({ imageMessage: { caption: '1' } })).toBe(true);
    expect(isInboundMediaCaption({ conversation: 'כן' })).toBe(false);
    expect(isInboundMediaCaption({
      extendedTextMessage: { text: 'ok' },
      imageMessage: { caption: '1' },
    })).toBe(false);
  });
});

describe('#187 mapped non-self destination', () => {
  const isSelf = (jid: string) => jid === '972501234567@s.whatsapp.net' || jid.endsWith('@lid') && jid.startsWith('OWN');

  it('drops @bot destinations even when remoteJid is the owner', () => {
    expect(shouldDropMappedNonSelfDestination(
      '972501234567@s.whatsapp.net',
      'meta-ai@bot',
      isSelf,
    )).toBe(true);
  });

  it('drops when remoteJid is self but destination is another person', () => {
    expect(shouldDropMappedNonSelfDestination(
      '972501234567@s.whatsapp.net',
      '972509999999@s.whatsapp.net',
      isSelf,
    )).toBe(true);
  });

  it('keeps real self-chat (no destination or destination is self)', () => {
    expect(shouldDropMappedNonSelfDestination(
      '972501234567@s.whatsapp.net',
      undefined,
      isSelf,
    )).toBe(false);
    expect(shouldDropMappedNonSelfDestination(
      '972501234567@s.whatsapp.net',
      '972501234567@s.whatsapp.net',
      isSelf,
    )).toBe(false);
  });
});
