import { describe, it, expect } from 'vitest';
import {
  type ReactionState,
  REACTION_EMOJIS,
  createReactionTracker,
  getReactionEmoji,
  recordTransition,
  isValidTransition,
  isTerminalState,
  shouldUpdateReaction,
} from './reaction-state.ts';

describe('Reaction Emojis', () => {
  it('defines all reaction states with emojis', () => {
    expect(REACTION_EMOJIS.reading).toBe('👀');
    expect(REACTION_EMOJIS.processing).toBe('⏳');
    expect(REACTION_EMOJIS.using_tools).toBe('🔧');
    expect(REACTION_EMOJIS.thinking).toBe('🤔');
    expect(REACTION_EMOJIS.finished).toBe('✅');
    expect(REACTION_EMOJIS.error).toBe('❌');
  });

  it('getReactionEmoji returns correct emoji for each state', () => {
    const states: ReactionState[] = ['reading', 'processing', 'using_tools', 'thinking', 'finished', 'error'];
    for (const state of states) {
      expect(getReactionEmoji(state)).toBe(REACTION_EMOJIS[state]);
    }
  });
});

describe('Reaction Tracker', () => {
  const mockMessageKey = {
    remoteJid: '1234567890@s.whatsapp.net',
    id: 'msg_123',
    fromMe: true,
  };

  it('creates tracker with initial null state', () => {
    const tracker = createReactionTracker(mockMessageKey);
    
    expect(tracker.messageKey).toBe(mockMessageKey);
    expect(tracker.currentState).toBeNull();
    expect(tracker.transitions).toHaveLength(0);
    expect(tracker.createdAt).toBeLessThanOrEqual(Date.now());
  });

  it('records transitions correctly', () => {
    const tracker = createReactionTracker(mockMessageKey);
    
    const changed = recordTransition(tracker, 'reading');
    
    expect(changed).toBe(true);
    expect(tracker.currentState).toBe('reading');
    expect(tracker.transitions).toHaveLength(1);
    expect(tracker.transitions[0]?.from).toBeNull();
    expect(tracker.transitions[0]?.to).toBe('reading');
  });

  it('does not record same state twice', () => {
    const tracker = createReactionTracker(mockMessageKey);
    
    recordTransition(tracker, 'reading');
    const changed = recordTransition(tracker, 'reading');
    
    expect(changed).toBe(false);
    expect(tracker.transitions).toHaveLength(1);
  });

  it('records full processing lifecycle', () => {
    const tracker = createReactionTracker(mockMessageKey);
    
    recordTransition(tracker, 'reading');
    recordTransition(tracker, 'processing');
    recordTransition(tracker, 'thinking');
    recordTransition(tracker, 'using_tools');
    recordTransition(tracker, 'thinking');
    recordTransition(tracker, 'finished');
    
    expect(tracker.currentState).toBe('finished');
    expect(tracker.transitions).toHaveLength(6);
  });
});

describe('State Transitions', () => {
  it('allows reading as first state', () => {
    expect(isValidTransition(null, 'reading')).toBe(true);
  });

  it('does not allow non-reading as first state', () => {
    expect(isValidTransition(null, 'processing')).toBe(false);
    expect(isValidTransition(null, 'thinking')).toBe(false);
    expect(isValidTransition(null, 'finished')).toBe(false);
  });

  it('allows reading to processing or finished', () => {
    expect(isValidTransition('reading', 'processing')).toBe(true);
    expect(isValidTransition('reading', 'finished')).toBe(true);
    expect(isValidTransition('reading', 'error')).toBe(true);
  });

  it('allows processing to thinking, tools, or finished', () => {
    expect(isValidTransition('processing', 'thinking')).toBe(true);
    expect(isValidTransition('processing', 'using_tools')).toBe(true);
    expect(isValidTransition('processing', 'finished')).toBe(true);
    expect(isValidTransition('processing', 'error')).toBe(true);
  });

  it('allows thinking to tools, processing, or finished', () => {
    expect(isValidTransition('thinking', 'using_tools')).toBe(true);
    expect(isValidTransition('thinking', 'processing')).toBe(true);
    expect(isValidTransition('thinking', 'finished')).toBe(true);
    expect(isValidTransition('thinking', 'error')).toBe(true);
  });

  it('allows using_tools to thinking, processing, or finished', () => {
    expect(isValidTransition('using_tools', 'thinking')).toBe(true);
    expect(isValidTransition('using_tools', 'processing')).toBe(true);
    expect(isValidTransition('using_tools', 'finished')).toBe(true);
    expect(isValidTransition('using_tools', 'error')).toBe(true);
  });

  it('does not allow transitions from finished', () => {
    expect(isValidTransition('finished', 'reading')).toBe(false);
    expect(isValidTransition('finished', 'processing')).toBe(false);
    expect(isValidTransition('finished', 'error')).toBe(false);
  });

  it('does not allow transitions from error', () => {
    expect(isValidTransition('error', 'reading')).toBe(false);
    expect(isValidTransition('error', 'finished')).toBe(false);
  });
});

describe('Terminal States', () => {
  it('identifies finished as terminal', () => {
    expect(isTerminalState('finished')).toBe(true);
  });

  it('identifies error as terminal', () => {
    expect(isTerminalState('error')).toBe(true);
  });

  it('identifies non-terminal states correctly', () => {
    expect(isTerminalState('reading')).toBe(false);
    expect(isTerminalState('processing')).toBe(false);
    expect(isTerminalState('thinking')).toBe(false);
    expect(isTerminalState('using_tools')).toBe(false);
  });
});

describe('shouldUpdateReaction', () => {
  const mockMessageKey = {
    remoteJid: '1234567890@s.whatsapp.net',
    id: 'msg_123',
    fromMe: true,
  };

  it('allows update to different state', () => {
    const tracker = createReactionTracker(mockMessageKey);
    recordTransition(tracker, 'reading');
    
    expect(shouldUpdateReaction(tracker, 'processing')).toBe(true);
  });

  it('does not allow update to same state', () => {
    const tracker = createReactionTracker(mockMessageKey);
    recordTransition(tracker, 'reading');
    
    expect(shouldUpdateReaction(tracker, 'reading')).toBe(false);
  });

  it('does not allow update from terminal states', () => {
    const tracker = createReactionTracker(mockMessageKey);
    recordTransition(tracker, 'reading');
    recordTransition(tracker, 'finished');
    
    expect(shouldUpdateReaction(tracker, 'processing')).toBe(false);
    expect(shouldUpdateReaction(tracker, 'error')).toBe(false);
  });

  it('does not allow update from error state', () => {
    const tracker = createReactionTracker(mockMessageKey);
    recordTransition(tracker, 'reading');
    recordTransition(tracker, 'error');
    
    expect(shouldUpdateReaction(tracker, 'finished')).toBe(false);
  });
});
