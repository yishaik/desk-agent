import { createChildLogger } from '../core/logger.ts';
import type { MessageKey } from '../core/types.ts';

const log = createChildLogger('reaction-state');

export type ReactionState = 
  | 'reading'
  | 'processing'
  | 'using_tools'
  | 'thinking'
  | 'finished'
  | 'error';

export const REACTION_EMOJIS: Record<ReactionState, string> = {
  reading: '👀',
  processing: '⏳',
  using_tools: '🔧',
  thinking: '🤔',
  finished: '✅',
  error: '❌',
};

export interface ReactionStateTransition {
  from: ReactionState | null;
  to: ReactionState;
  timestamp: number;
}

export interface ReactionTracker {
  messageKey: MessageKey;
  currentState: ReactionState | null;
  transitions: ReactionStateTransition[];
  createdAt: number;
}

export function createReactionTracker(messageKey: MessageKey): ReactionTracker {
  return {
    messageKey,
    currentState: null,
    transitions: [],
    createdAt: Date.now(),
  };
}

export function getReactionEmoji(state: ReactionState): string {
  return REACTION_EMOJIS[state];
}

export function recordTransition(
  tracker: ReactionTracker,
  newState: ReactionState
): boolean {
  if (tracker.currentState === newState) {
    return false;
  }

  const transition: ReactionStateTransition = {
    from: tracker.currentState,
    to: newState,
    timestamp: Date.now(),
  };

  tracker.transitions.push(transition);
  tracker.currentState = newState;

  log.debug(
    { 
      messageId: tracker.messageKey.id, 
      from: transition.from, 
      to: transition.to 
    },
    'Reaction state transition'
  );

  return true;
}

export function isValidTransition(
  from: ReactionState | null,
  to: ReactionState
): boolean {
  if (from === null) {
    return to === 'reading';
  }

  if (from === 'finished' || from === 'error') {
    return false;
  }

  const validTransitions: Record<ReactionState, ReactionState[]> = {
    reading: ['processing', 'finished', 'error'],
    processing: ['thinking', 'using_tools', 'finished', 'error'],
    thinking: ['using_tools', 'processing', 'finished', 'error'],
    using_tools: ['thinking', 'processing', 'finished', 'error'],
    finished: [],
    error: [],
  };

  return validTransitions[from]?.includes(to) ?? false;
}

export function isTerminalState(state: ReactionState): boolean {
  return state === 'finished' || state === 'error';
}

export function shouldUpdateReaction(
  tracker: ReactionTracker,
  newState: ReactionState
): boolean {
  if (tracker.currentState === newState) {
    return false;
  }

  if (tracker.currentState && isTerminalState(tracker.currentState)) {
    return false;
  }

  return true;
}
