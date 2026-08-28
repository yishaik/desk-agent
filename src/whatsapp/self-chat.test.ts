import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  normalizePhone,
  extractPhoneFromJid,
  extractLidFromJid,
  isGroupJid,
  isBroadcastJid,
  isSelfChatJid,
  validateSelfChatMessage,
} from './self-chat.ts';

describe('normalizePhone', () => {
  it('returns null for null/undefined', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });

  it('removes non-digit characters', () => {
    expect(normalizePhone('+972-50-123-4567')).toBe('972501234567');
    expect(normalizePhone('(972) 50 123 4567')).toBe('972501234567');
    expect(normalizePhone('972501234567')).toBe('972501234567');
  });
});

describe('extractPhoneFromJid', () => {
  it('returns null for null/undefined', () => {
    expect(extractPhoneFromJid(null)).toBeNull();
    expect(extractPhoneFromJid(undefined)).toBeNull();
    expect(extractPhoneFromJid('')).toBeNull();
  });

  it('extracts phone from standard JID', () => {
    expect(extractPhoneFromJid('972501234567@s.whatsapp.net')).toBe('972501234567');
  });

  it('extracts phone from JID with device ID', () => {
    expect(extractPhoneFromJid('972501234567:0@s.whatsapp.net')).toBe('972501234567');
    expect(extractPhoneFromJid('972501234567:12@s.whatsapp.net')).toBe('972501234567');
  });

  it('handles LID JIDs (returns LID as is)', () => {
    expect(extractPhoneFromJid('123456789012345@lid')).toBe('123456789012345');
  });
});

describe('extractLidFromJid', () => {
  it('returns null for non-LID JIDs', () => {
    expect(extractLidFromJid(null)).toBeNull();
    expect(extractLidFromJid(undefined)).toBeNull();
    expect(extractLidFromJid('972501234567@s.whatsapp.net')).toBeNull();
    expect(extractLidFromJid('123456@g.us')).toBeNull();
  });

  it('extracts LID from LID JID', () => {
    expect(extractLidFromJid('123456789012345@lid')).toBe('123456789012345');
    expect(extractLidFromJid('987654321098765@lid')).toBe('987654321098765');
  });
});

describe('isGroupJid', () => {
  it('returns false for null/undefined', () => {
    expect(isGroupJid(null)).toBe(false);
    expect(isGroupJid(undefined)).toBe(false);
  });

  it('identifies group JIDs', () => {
    expect(isGroupJid('123456789012345-1234567890@g.us')).toBe(true);
  });

  it('rejects non-group JIDs', () => {
    expect(isGroupJid('972501234567@s.whatsapp.net')).toBe(false);
    expect(isGroupJid('123456789012345@lid')).toBe(false);
  });
});

describe('isBroadcastJid', () => {
  it('returns false for null/undefined', () => {
    expect(isBroadcastJid(null)).toBe(false);
    expect(isBroadcastJid(undefined)).toBe(false);
  });

  it('identifies broadcast JIDs', () => {
    expect(isBroadcastJid('status@broadcast')).toBe(true);
    expect(isBroadcastJid('123456@broadcast')).toBe(true);
  });

  it('rejects non-broadcast JIDs', () => {
    expect(isBroadcastJid('972501234567@s.whatsapp.net')).toBe(false);
    expect(isBroadcastJid('123456789012345@lid')).toBe(false);
  });
});

describe('isSelfChatJid', () => {
  const ownerPhone = '972501234567';
  const ownerLid = '123456789012345';

  describe('MUST ALLOW: Self-chat via phone JID', () => {
    it('allows self-chat with standard phone JID', () => {
      expect(isSelfChatJid('972501234567@s.whatsapp.net', ownerPhone, ownerLid)).toBe(true);
    });

    it('allows self-chat with phone JID including device ID', () => {
      expect(isSelfChatJid('972501234567:0@s.whatsapp.net', ownerPhone, ownerLid)).toBe(true);
    });
  });

  describe('MUST ALLOW: Self-chat via owner LID', () => {
    it('allows self-chat with owner LID JID', () => {
      expect(isSelfChatJid('123456789012345@lid', ownerPhone, ownerLid)).toBe(true);
    });
  });

  describe('MUST REJECT: Other peoples chats (CRITICAL SECURITY)', () => {
    it('rejects chat with different phone number', () => {
      expect(isSelfChatJid('972509876543@s.whatsapp.net', ownerPhone, ownerLid)).toBe(false);
    });

    it('rejects chat with different LID', () => {
      expect(isSelfChatJid('987654321098765@lid', ownerPhone, ownerLid)).toBe(false);
    });

    it('rejects chat even when no ownerLid is set', () => {
      expect(isSelfChatJid('972509876543@s.whatsapp.net', ownerPhone, null)).toBe(false);
    });
  });

  describe('MUST REJECT: Group chats', () => {
    it('rejects group chat JID', () => {
      expect(isSelfChatJid('123456789012345-1234567890@g.us', ownerPhone, ownerLid)).toBe(false);
    });

    it('rejects group even if phone appears in group ID', () => {
      expect(isSelfChatJid('972501234567-1234567890@g.us', ownerPhone, ownerLid)).toBe(false);
    });
  });

  describe('MUST REJECT: Broadcast lists', () => {
    it('rejects status broadcast', () => {
      expect(isSelfChatJid('status@broadcast', ownerPhone, ownerLid)).toBe(false);
    });

    it('rejects broadcast list', () => {
      expect(isSelfChatJid('123456@broadcast', ownerPhone, ownerLid)).toBe(false);
    });
  });

  describe('Edge cases', () => {
    it('rejects null/undefined remoteJid', () => {
      expect(isSelfChatJid(null, ownerPhone, ownerLid)).toBe(false);
      expect(isSelfChatJid(undefined, ownerPhone, ownerLid)).toBe(false);
    });

    it('handles missing ownerPhone', () => {
      expect(isSelfChatJid('972501234567@s.whatsapp.net', null, ownerLid)).toBe(false);
      expect(isSelfChatJid('123456789012345@lid', null, ownerLid)).toBe(true);
    });

    it('handles missing ownerLid', () => {
      expect(isSelfChatJid('972501234567@s.whatsapp.net', ownerPhone, null)).toBe(true);
      expect(isSelfChatJid('123456789012345@lid', ownerPhone, null)).toBe(false);
    });

    it('handles both missing (should reject everything)', () => {
      expect(isSelfChatJid('972501234567@s.whatsapp.net', null, null)).toBe(false);
      expect(isSelfChatJid('123456789012345@lid', null, null)).toBe(false);
    });
  });
});

describe('validateSelfChatMessage', () => {
  const ownerPhone = '972501234567';
  const ownerLid = '123456789012345';

  it('allows self-chat messages', () => {
    const result = validateSelfChatMessage(
      '972501234567@s.whatsapp.net',
      true,
      ownerPhone,
      ownerLid
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('self_chat');
  });

  it('rejects messages to other people', () => {
    const result = validateSelfChatMessage(
      '972509876543@s.whatsapp.net',
      true,
      ownerPhone,
      ownerLid
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not_self_chat');
  });

  it('rejects group messages', () => {
    const result = validateSelfChatMessage(
      '123456-1234567@g.us',
      true,
      ownerPhone,
      ownerLid
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('group_chat');
  });

  it('rejects broadcast messages', () => {
    const result = validateSelfChatMessage(
      'status@broadcast',
      true,
      ownerPhone,
      ownerLid
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('broadcast');
  });

  it('rejects when no remoteJid', () => {
    const result = validateSelfChatMessage(null, true, ownerPhone, ownerLid);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('no_remote_jid');
  });
});

describe('Production incident prevention', () => {
  /**
   * This test documents the exact production incident:
   * The bot replied in OTHER PEOPLE's chats because isOwnerMessage
   * returned true for ALL fromMe messages.
   * 
   * The fix: isSelfChatJid ONLY returns true if remoteJid matches
   * the owner's phone or LID, regardless of fromMe.
   */
  it('PREVENTS the production incident: fromMe does NOT grant access', () => {
    const ownerPhone = '972501234567';
    const ownerLid = '123456789012345';
    
    const otherPersonJid = '972509876543@s.whatsapp.net';
    expect(isSelfChatJid(otherPersonJid, ownerPhone, ownerLid)).toBe(false);
    
    const groupJid = '123456-7890@g.us';
    expect(isSelfChatJid(groupJid, ownerPhone, ownerLid)).toBe(false);
  });

  it('ALLOWS messaging yourself via phone JID', () => {
    const ownerPhone = '972501234567';
    const ownerLid = '123456789012345';
    
    const selfChatPhoneJid = '972501234567@s.whatsapp.net';
    expect(isSelfChatJid(selfChatPhoneJid, ownerPhone, ownerLid)).toBe(true);
  });

  it('ALLOWS messaging yourself via LID', () => {
    const ownerPhone = '972501234567';
    const ownerLid = '123456789012345';
    
    const selfChatLidJid = '123456789012345@lid';
    expect(isSelfChatJid(selfChatLidJid, ownerPhone, ownerLid)).toBe(true);
  });
});

describe('Error message safety', () => {
  /**
   * "No API key" or any error message must NEVER be sent
   * to non-self-chat JIDs.
   */
  it('verifies validateSelfChatMessage blocks non-self-chat for error scenarios', () => {
    const ownerPhone = '972501234567';
    
    const scenarios = [
      { jid: '972509876543@s.whatsapp.net', desc: 'other person' },
      { jid: '123456-7890@g.us', desc: 'group chat' },
      { jid: 'status@broadcast', desc: 'broadcast' },
    ];

    for (const { jid, desc } of scenarios) {
      const result = validateSelfChatMessage(jid, true, ownerPhone, null);
      expect(result.allowed).toBe(false);
    }
  });
});
