import { createChildLogger } from '../core/logger.ts';
import { loadSettings, updateSettings, getActiveConnectorToken } from '../core/settings.ts';
import { saveMessage, listProjects, createProject, getProject, getMessage } from '../core/memory.ts';
import { slugifyProjectName, ProjectIdValidationError } from '../core/projects.ts';
import { recordExecutedAction, consumeExecutedActionNotes } from '../core/confirmations.ts';
import type { Message, MessageKey, Settings } from '../core/types.ts';
import { getWhatsAppClient, WhatsAppClient } from './client.ts';
import { OpenConnectorClient } from '../open-connector/client.ts';
import {
  runPromptWithCallbacks,
  clearSession,
  getOrCreateSession,
  setSessionModel,
  getPendingConfirmation,
  confirmAction,
  cancelConfirmation,
  cleanupOldConfirmations,
  getAllPendingConfirmations,
  cancelAllPendingConfirmations,
  formatPendingForUser,
  markPayloadPresented,
  isPayloadPresented,
  checkCredentialsBeforePrompt,
  recreateSessionAfterCredentialChange,
  CredentialError,
} from '../agent/session.ts';
import {
  listRuntimeCredentials,
  resolveActiveModel,
} from '../http/auth.ts';
import {
  isClaudeCodeConnected,
  runClaudeCodePrompt,
  clearClaudeCodeSession,
} from '../agent/claude-code.ts';
import { 
  type ReactionState, 
  createReactionTracker, 
  recordTransition, 
  getReactionEmoji,
  shouldUpdateReaction,
  type ReactionTracker,
} from './reaction-state.ts';
import { isSelfChatJid, resolveReplyJid } from './self-chat.ts';
import { enqueue } from './queue.ts';
import {
  MEDIA_WITHOUT_TEXT_BODY,
  isStaleInbound,
  shouldQuoteInbound,
} from './inbound.ts';

const log = createChildLogger('handler');

const COMMAND_PREFIX = '/';

const MEDIA_NEED_TEXT_HE = 'צריך טקסט (או כיתוב לתמונה)';
const STALE_SKIP_HE = 'דילגתי על הודעה ישנה (מעל 10 דקות).';

function quoteArg(message: Message, force = false): MessageKey | undefined {
  if (!message.messageKey) return undefined;
  if (force || shouldQuoteInbound(message.timestamp)) return message.messageKey;
  return undefined;
}

/**
 * Serial queue for non-bypass work. One chain so /project finishes before the
 * next prompt (#77) and so two prompts cannot share a Pi session (#33).
 */

/**
 * Track which projects are currently processing — used to send ⏳ to messages
 * that arrive while the model is working.
 */
const activeProcessing = new Set<string>();

/**
 * Commands that can run outside the queue (status queries, help, etc.).
 * Confirmation replies must NOT be in this list — they interact with the
 * pending-confirmation state that may be mid-update.
 */
const QUEUE_BYPASS_COMMANDS = new Set(['help', 'status', 'projects', 'services', 'settings']);

async function safeReaction(messageKey: MessageKey, state: ReactionState): Promise<void> {
  try {
    const wa = getWhatsAppClient();
    const emoji = getReactionEmoji(state);
    await wa.sendReaction(messageKey, emoji);
    log.debug({ messageId: messageKey.id, state, emoji }, 'Reaction sent');
  } catch (err) {
    log.error({ err, messageId: messageKey.id, state }, 'Failed to send reaction');
  }
}

async function updateReaction(
  tracker: ReactionTracker | null,
  newState: ReactionState
): Promise<void> {
  if (!tracker || !tracker.messageKey) {
    return;
  }

  if (!shouldUpdateReaction(tracker, newState)) {
    return;
  }

  recordTransition(tracker, newState);
  await safeReaction(tracker.messageKey, newState);
}

function describeSelfChat(mode: 'lid' | 'phone' | 'none' | undefined): string {
  if (mode === 'phone') return ' (⚠️ ללא LID — תשובות דרך מספר הטלפון)';
  if (mode === 'none') return ' (⚠️ אין יעד לצ׳אט עצמי)';
  return '';
}

const CONFIRM_PATTERNS = [
  /^(yes|כן|אשר|confirm)$/i,
];

const CANCEL_PATTERNS = [
  /^(no|לא|בטל|cancel|ביטול)$/i,
];

interface CommandResult {
  handled: boolean;
  response?: string;
}

// The only place a mutating action is ever executed: after the owner's "yes".
// The model never sees this tool result, so a note is recorded and prefixed to
// the next prompt (withExecutedActionNotes).
async function executePendingAction(
  pending: { actionId: string; input: Record<string, unknown>; connectionName?: string },
  projectId: string
): Promise<CommandResult> {
  const client = new OpenConnectorClient(projectId);
  try {
    const result = await client.executeAction({
      actionId: pending.actionId,
      input: pending.input,
      connectionName: pending.connectionName,
    });

    if (!result.success) {
      recordExecutedAction({ projectId, actionId: pending.actionId, success: false, summary: String(result.message ?? 'unknown error') });
      return {
        handled: true,
        response: `❌ Action failed: ${result.message}`,
      };
    }

    recordExecutedAction({ projectId, actionId: pending.actionId, success: true, summary: JSON.stringify(result.data ?? null) });
    return {
      handled: true,
      response: `✅ Action "${pending.actionId}" executed successfully.\n\nResult:\n${JSON.stringify(result.data, null, 2)}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordExecutedAction({ projectId, actionId: pending.actionId, success: false, summary: message });
    return {
      handled: true,
      response: `❌ Error: ${message}`,
    };
  }
}

/** Prefix the prompt with what ran since the model's last turn, so it never re-executes or denies it. */
export function withExecutedActionNotes(projectId: string, text: string): string {
  const notes = consumeExecutedActionNotes(projectId);
  if (notes.length === 0) return text;
  const lines = notes.map((n) => `- ${n.actionId}: ${n.success ? 'executed successfully' : 'FAILED'} — ${n.summary}`);
  return [
    '[System note — not written by the user. Since your last turn the user approved these actions and they were executed outside the model:',
    ...lines,
    'Do not execute them again; you may refer to the results.]',
    '',
    text,
  ].join('\n');
}

/**
 * S-04 (#108): Helper to show the structured payload for a pending item.
 * Marks the item as presented so subsequent confirms can execute.
 */
function showPayloadAndMarkPresented(
  pending: { confirmationId: string; actionId: string; input: Record<string, unknown>; createdAt: number },
  isSingleItem: boolean
): string {
  markPayloadPresented(pending.confirmationId);
  
  const lines = ['⚠️ לפני אישור, וודא שזה מה שרצית:'];
  lines.push(`\n${formatPendingForUser(pending)}`);
  
  if (isSingleItem) {
    lines.push('\nהשב *כן* או *אשר* לאישור, או "לא" לביטול.');
  } else {
    lines.push('\nהשב *כן* לאישור פעולה זו, או "לא" לביטול.');
  }
  
  return lines.join('\n');
}

async function checkForConfirmationResponse(text: string, projectId: string): Promise<CommandResult> {
  cleanupOldConfirmations();

  const allPending = getAllPendingConfirmations(projectId);
  if (allPending.length === 0) {
    return { handled: false };
  }

  const trimmedText = text.trim();
  const confirmIdMatch = trimmedText.match(/confirm_\d+_[a-z0-9]+/);

  // --- Cancel handling (always allowed) ---
  const isSimpleCancel = CANCEL_PATTERNS.some((p) => p.test(trimmedText));

  if (confirmIdMatch) {
    const confirmId = confirmIdMatch[0];
    const pending = getPendingConfirmation(confirmId);

    if (pending && pending.projectId === projectId) {
      const textWithoutId = trimmedText.replace(confirmId, '').trim();
      const isCancel = CANCEL_PATTERNS.some((p) => p.test(textWithoutId)) ||
                       textWithoutId.toLowerCase().includes('cancel') || textWithoutId.includes('בטל');

      if (isCancel) {
        cancelConfirmation(confirmId);
        return {
          handled: true,
          response: `❌ הפעולה "${pending.actionId}" בוטלה.`,
        };
      }

      const isConfirm = CONFIRM_PATTERNS.some((p) => p.test(textWithoutId));
      if (isConfirm || textWithoutId === '') {
        // S-04 (#108): Only execute if the handler has shown the payload.
        // If not shown, show it now and ask for confirmation again.
        if (!isPayloadPresented(confirmId)) {
          return {
            handled: true,
            response: showPayloadAndMarkPresented(
              { confirmationId: confirmId, ...pending },
              allPending.length === 1
            ),
          };
        }
        confirmAction(confirmId);
        return executePendingAction(pending, projectId);
      }
    }
  }

  const isSimpleConfirm = CONFIRM_PATTERNS.some((p) => p.test(trimmedText));
  const numberMatch = trimmedText.match(/^(\d+)$/);

  // --- Number pick for multi-pending ---
  if (allPending.length > 1 && numberMatch && numberMatch[1]) {
    const idx = parseInt(numberMatch[1], 10) - 1;
    if (idx >= 0 && idx < allPending.length) {
      const selected = allPending[idx];
      if (selected) {
        // S-04 (#108): Only execute if the handler has shown the payload.
        if (!isPayloadPresented(selected.confirmationId)) {
          return {
            handled: true,
            response: showPayloadAndMarkPresented(selected, false),
          };
        }
        confirmAction(selected.confirmationId);
        return executePendingAction(selected, projectId);
      }
    }
    return {
      handled: true,
      response: `❌ מספר לא תקין. בחר מספר בין 1 ל-${allPending.length}, או השב "לא" לביטול הכל.`,
    };
  }

  if (isSimpleCancel) {
    const count = cancelAllPendingConfirmations(projectId);
    const actionNames = allPending.map((p) => p.actionId).join(', ');
    return {
      handled: true,
      response: count === 1
        ? `❌ הפעולה "${actionNames}" בוטלה.`
        : `❌ ${count} פעולות בוטלו: ${actionNames}`,
    };
  }

  if (isSimpleConfirm) {
    // S-04 (#108): Simple כן/אשר handling
    if (allPending.length === 1) {
      const single = allPending[0]!;
      
      // If payload was already shown by handler, execute on כן
      if (isPayloadPresented(single.confirmationId)) {
        confirmAction(single.confirmationId);
        return executePendingAction(single, projectId);
      }
      
      // First כן: show the payload and mark as presented
      return {
        handled: true,
        response: showPayloadAndMarkPresented(single, true),
      };
    }

    // Multiple pending: show the list and mark all as presented
    const lines = ['⚠️ יש מספר פעולות ממתינות לאישור. בחר מספר:'];
    allPending.forEach((p, i) => {
      markPayloadPresented(p.confirmationId);
      lines.push(`\n*${i + 1}.* ${formatPendingForUser(p)}`);
    });
    lines.push('\nהשב עם מספר (1, 2...) לאישור, או "לא" לביטול הכל.');

    return {
      handled: true,
      response: lines.join('\n'),
    };
  }

  const count = cancelAllPendingConfirmations(projectId);
  const actionNames = allPending.map((p) => p.actionId).join(', ');
  return {
    handled: true,
    response: count === 1
      ? `⚠️ הפעולה "${actionNames}" בוטלה (לא התקבל אישור/ביטול).`
      : `⚠️ ${count} פעולות בוטלו (לא התקבל אישור/ביטול): ${actionNames}`,
  };
}

/**
 * Handler-level self-chat check. Combines isFromMe with JID verification.
 * 
 * This is the ONLY authorization gate for the agent. Only self-chat messages
 * are processed; all other messages are ignored for security.
 * 
 * Note: The client's isOwnerMessage has a known bug (if (isFromMe) return true)
 * that lets fromMe messages to other chats reach the handler. This function
 * MUST drop them. fromMe alone is NOT authorization.
 * 
 * Uses the canonical isSelfChatJid from self-chat.ts for testability.
 */
export function isSelfChat(message: Message): boolean {
  if (!message.isFromMe) {
    return false;
  }
  const wa = getWhatsAppClient();
  return isSelfChatJid(message.to, wa.getOwnerPhone(), wa.getOwnerLid());
}

export async function handleMessage(message: Message): Promise<void> {
  const wa = getWhatsAppClient();
  const ownerJid = wa.getOwnerJid();

  if (!ownerJid) {
    log.warn('No owner JID, skipping message');
    return;
  }

  if (!isSelfChat(message)) {
    log.debug({ from: message.from, to: message.to, isFromMe: message.isFromMe }, 'Ignoring non-self-chat message');
    return;
  }

  // Reply into the owner's own chat: the inbound chat when it is the self-chat
  // (LID or phone JID), otherwise the client's preferred self-chat JID (#73).
  const chatJid = resolveReplyJid(message.messageKey?.remoteJid, (jid) => wa.isSelfJid(jid), wa.getSelfChatJid());
  if (!chatJid) {
    log.warn({ inboundJid: message.messageKey?.remoteJid }, 'No self-chat JID available (not connected?), skipping message');
    return;
  }

  // Snapshot only for enqueue bookkeeping (dedupe + queue-wait reaction).
  // processMessageQueued reloads settings so /project is visible to the next prompt (#77).
  const enqueueSettings = loadSettings();
  const projectId = enqueueSettings.activeProject;
  message.projectId = projectId;

  if (getMessage(message.id)) {
    log.debug({ messageId: message.id }, 'Duplicate message, skipping');
    return;
  }

  const saved = saveMessage(message);
  if (!saved) {
    log.debug({ messageId: message.id }, 'Message already processed, skipping');
    return;
  }

  if (isStaleInbound(message.timestamp)) {
    log.info({ messageId: message.id, timestamp: message.timestamp }, 'Skipping stale inbound message');
    await wa.sendMessage(chatJid, STALE_SKIP_HE, quoteArg(message, true));
    return;
  }

  if (message.body === MEDIA_WITHOUT_TEXT_BODY) {
    await wa.sendMessage(chatJid, MEDIA_NEED_TEXT_HE, quoteArg(message, true));
    return;
  }

  const tracker = message.messageKey ? createReactionTracker(message.messageKey) : null;

  // Queue-bypass commands (/status, /help, etc.) can run immediately without
  // waiting for a queued model prompt to finish — they're read-only.
  if (message.body.startsWith(COMMAND_PREFIX)) {
    const commandName = message.body.slice(COMMAND_PREFIX.length).split(' ')[0]?.toLowerCase();
    if (commandName && QUEUE_BYPASS_COMMANDS.has(commandName)) {
      const handled = await handleCommandDirect(message, loadSettings(), wa, chatJid, tracker);
      if (handled) return;
    }
  }

  // Everything else (model prompts, confirmations, /project) goes through the
  // serial queue so a project switch finishes before the next prompt (#77).
  const wasActive = activeProcessing.size > 0;

  // If the model is already working on this project, send ⏳ immediately so
  // the user knows their message is queued, not lost.
  if (wasActive && tracker) {
    await safeReaction(tracker.messageKey!, 'queued');
    log.debug({ projectId, messageId: message.id }, 'Message queued behind active processing');
  }

  const currentTask = enqueue(() => processMessageQueued(message, wa, chatJid, tracker));

  await currentTask;
}

async function handleCommandDirect(
  message: Message,
  settings: Settings,
  wa: WhatsAppClient,
  chatJid: string,
  tracker: ReactionTracker | null
): Promise<boolean> {
  if (tracker) {
    await updateReaction(tracker, 'reading');
  }
  try {
    const result = await handleCommand(message.body, settings);
    if (result.handled) {
      if (result.response) {
        if (tracker) {
          await updateReaction(tracker, 'finished');
        }
        await wa.sendMessage(chatJid, result.response, quoteArg(message));
      }
      return true;
    }
    return false;
  } catch (err) {
    log.error({ err, command: message.body }, 'Command failed');
    await updateReaction(tracker, 'error');
    await wa.sendMessage(
      chatJid,
      `שגיאה בפקודה: ${err instanceof Error ? err.message : 'Unknown error'}`,
      quoteArg(message)
    );
    return true;
  }
}

async function processMessageQueued(
  message: Message,
  wa: WhatsAppClient,
  chatJid: string,
  tracker: ReactionTracker | null
): Promise<void> {
  const settings = loadSettings();
  const projectId = settings.activeProject;
  message.projectId = projectId;
  activeProcessing.add(projectId);

  try {
    // Non-bypass commands (like /project, /model) need the queue.
    // Unknown /commands are not an error — fall through to the model prompt (#141).
    if (message.body.startsWith(COMMAND_PREFIX)) {
      const handled = await handleCommandDirect(message, settings, wa, chatJid, tracker);
      if (handled) return;
    }

    // Confirmations ("yes", "כן") must be in the queue — they interact with
    // pending-confirmation state that may be mid-update by a model prompt.
    const confirmResponse = await checkForConfirmationResponse(message.body, projectId);
    if (confirmResponse.handled) {
      if (tracker) {
        await updateReaction(tracker, 'reading');
      }
      if (confirmResponse.response) {
        if (tracker) {
          await updateReaction(tracker, 'finished');
        }
        await wa.sendMessage(chatJid, confirmResponse.response, quoteArg(message));
      }
      return;
    }

    await updateReaction(tracker, 'reading');

    try {
      const response = await processWithPi(message, settings, tracker);
      if (response) {
        await updateReaction(tracker, 'finished');
        await sendSplitMessage(chatJid, response, quoteArg(message));
      } else {
        // Never fail silently — the user is staring at a chat with no reply.
        await updateReaction(tracker, 'error');
        await wa.sendMessage(chatJid, '⚠️ לא התקבלה תשובה מהמודל. נסה שוב, ואם זה חוזר — בדוק את חיבור ה-AI בהגדרות.', quoteArg(message));
      }
    } catch (err) {
      log.error({ err }, 'Error processing message');
      await updateReaction(tracker, 'error');
      await wa.sendMessage(chatJid, `שגיאה: ${err instanceof Error ? err.message : 'Unknown error'}`, quoteArg(message));
    }
  } finally {
    activeProcessing.delete(projectId);
  }
}

async function sendSplitMessage(jid: string, text: string, quoted?: MessageKey): Promise<void> {
  const wa = getWhatsAppClient();
  const MAX_LENGTH = 4000;
  
  if (text.length <= MAX_LENGTH) {
    await wa.sendMessage(jid, text, quoted);
    return;
  }

  const parts = splitMessage(text, MAX_LENGTH);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const prefix = parts.length > 1 ? `[${i + 1}/${parts.length}]\n\n` : '';
    await wa.sendMessage(jid, prefix + (part ?? ''), i === 0 ? quoted : undefined);
    if (i < parts.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      parts.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf('\n\n', maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = maxLength;
    }

    parts.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return parts;
}

async function handleCommand(text: string, settings: Settings): Promise<CommandResult> {
  const parts = text.slice(COMMAND_PREFIX.length).split(' ');
  const command = parts[0]?.toLowerCase();
  const args = parts.slice(1);

  switch (command) {
    case 'help':
      return {
        handled: true,
        response: `*${settings.botName} - פקודות זמינות*

/help - הצג עזרה
/status - סטטוס חיבור
/project [name] - החלף/צור פרויקט (שיחה נפרדת לכל פרויקט)
/projects - רשימת פרויקטים
/services - רשימת שירותים מחוברים
/settings - הצג הגדרות
/model [name] - החלף מודל

*אישור פעולות:*
כן / אשר — אישור · לא / בטל — ביטול

*פעולות Open Connector:*
שאל "מה אני יכול לעשות עם Gmail?" או "שלח מייל ל..."
הסוכן יחפש, יציג מידע, ויבקש אישור לפני פעולות.

_שלח הודעה לעצמך כדי לדבר עם הסוכן_`,
      };

    case 'status': {
      const wa = getWhatsAppClient();
      const token = getActiveConnectorToken(settings);
      const client = new OpenConnectorClient(settings.activeProject);
      const connectorHealth = await client.checkHealth();
      
      const claudeCode = isClaudeCodeConnected();
      const credentials = await listRuntimeCredentials();

      const providerList = [
        claudeCode ? 'Claude Code (מנוי)' : null,
        ...credentials.map((c) => `${c.providerId} (${c.type})`),
      ].filter(Boolean).join(', ');
      const hasAnyProvider = claudeCode || credentials.length > 0;

      // Claude Code is the active engine whenever it's connected; the pi
      // model resolution is only relevant otherwise.
      let modelStatus: string;
      if (claudeCode) {
        modelStatus = '✅ Claude Code — מנוע פעיל (מכסת המנוי)';
      } else {
        const modelResolution = await resolveActiveModel(settings.model);
        modelStatus = modelResolution.valid
          ? `✅ ${modelResolution.modelId}`
          : modelResolution.model
            ? `⚠️ ${modelResolution.modelId} (התאמה אוטומטית)`
            : `❌ ${settings.model} (חסר ספק)`;
      }

      return {
        handled: true,
        response: `*סטטוס מערכת*

📱 WhatsApp: ${wa.isConnected() ? '✅ מחובר' : '❌ מנותק'}${describeSelfChat(wa.getPairingState().selfChat)}
🤖 ספקי AI: ${hasAnyProvider ? '✅ ' + providerList : '❌ לא מחובר'}
🧠 מודל: ${modelStatus}
🔌 Open Connector: ${connectorHealth ? '✅ תקין' : '❌ לא זמין'}
📁 פרויקט פעיל: ${settings.activeProject}
🔐 טוקן OC: ${token ? '✅ מוגדר' : '❌ חסר'}`,
      };
    }

    case 'project': {
      if (args.length === 0) {
        return {
          handled: true,
          response: `פרויקט פעיל: *${settings.activeProject}*\n\nלהחלפה: /project <שם>\n\n_החלפת פרויקט מחליפה את ה-Pi session, cwd, ו-AGENTS.md_`,
        };
      }
      
      const projectName = args.join(' ');
      
      let projectId: string;
      try {
        projectId = slugifyProjectName(projectName);
      } catch (err) {
        if (err instanceof ProjectIdValidationError) {
          return {
            handled: true,
            response: `❌ שם פרויקט לא תקין: ${err.message}`,
          };
        }
        throw err;
      }
      
      let project = getProject(projectId);
      if (!project) {
        project = createProject({ id: projectId, name: projectName });
      }
      
      clearSession(settings.activeProject);
      clearClaudeCodeSession(settings.activeProject);
      
      updateSettings({ activeProject: projectId });
      
      await getOrCreateSession(projectId);
      
      return {
        handled: true,
        response: `✅ הוחלף לפרויקט: *${project.name}*\n\n_Pi session חדש נוצר עם cwd ו-AGENTS.md נפרדים._`,
      };
    }

    case 'projects': {
      const projects = listProjects();
      const list = projects
        .map((p) => {
          const hasToken = !!settings.projectTokens[p.id];
          const isActive = p.id === settings.activeProject;
          return `${isActive ? '▶️' : '  '} ${p.name} ${hasToken ? '🔑' : ''}`;
        })
        .join('\n');
      
      return {
        handled: true,
        response: `*פרויקטים*\n\n${list}\n\n🔑 = יש טוקן Open Connector לפרויקט`,
      };
    }

    case 'services': {
      const client = new OpenConnectorClient(settings.activeProject);
      try {
        const connections = await client.listConnections();
        
        if (connections.length === 0) {
          return {
            handled: true,
            response: 'אין שירותים מחוברים.\n\nהיכנס לממשק Open Connector כדי לחבר שירותים.',
          };
        }
        
        const list = connections
          .map((c) => `✅ ${c.service} (${c.identity?.label ?? c.connectionName})`)
          .join('\n');
        
        return {
          handled: true,
          response: `*שירותים מחוברים*\n\n${list}`,
        };
      } catch {
        return {
          handled: true,
          response: '❌ לא ניתן לטעון רשימת שירותים. ודא ש-Open Connector פועל.',
        };
      }
    }

    case 'settings': {
      return {
        handled: true,
        response: `*הגדרות*

🤖 שם הבוט: ${settings.botName}
👤 שם הבעלים: ${settings.ownerName || '(לא הוגדר)'}
🌍 אזור זמן: ${settings.timezone}
🧠 מנוע: ${isClaudeCodeConnected() ? 'Claude Code — מכסת המנוי' : settings.model}
🔑 מצב מפתחות: ${settings.apiKeyMode}
📁 פרויקט פעיל: ${settings.activeProject}

_היכנס לממשק הניהול לשינוי הגדרות_`,
      };
    }

    case 'model': {
      if (args.length === 0) {
        if (isClaudeCodeConnected()) {
          return {
            handled: true,
            response: `המנוע הפעיל: *Claude Code* (מודל ברירת המחדל של המנוי)\n\nלהחלפת מודל בתוך Claude Code: /model claude-code/<שם>\nלמשל: /model claude-code/opus`,
          };
        }
        return {
          handled: true,
          response: `מודל נוכחי: *${settings.model}*\n\nלהחלפה: /model <שם-מודל>\n\nדוגמאות:\n- /model claude-code/opus\n- /model gpt-5.3-codex`,
        };
      }
      
      const model = args.join(' ');
      
      const success = await setSessionModel(settings.activeProject, model);
      
      if (success) {
        return {
          handled: true,
          response: `✅ מודל שונה ל: *${model}*\n\n_Pi session נוצר מחדש עם המודל החדש._`,
        };
      } else {
        updateSettings({ model });
        return {
          handled: true,
          response: `✅ מודל שונה ל: *${model}* (ישתנה בהודעה הבאה)`,
        };
      }
    }

    case 'login': {
      const credentials = await listRuntimeCredentials();
      
      if (credentials.length > 0) {
        const providers = credentials.map(c => `✅ ${c.providerId} (${c.type})`).join('\n');
        return {
          handled: true,
          response: `*ספקי AI מחוברים*

${providers}

_לניהול חיבורים - היכנס להגדרות ב-Web UI_`,
        };
      }
      
      return {
        handled: true,
        response: `*לא מחובר ספק AI*

היכנס להגדרות ב-Web UI וחבר ספק:
- Anthropic (Claude Pro/Max)
- OpenAI (ChatGPT Plus/Pro)

_ההתחברות מתבצעת דרך OAuth - ללא צורך ב-API key_`,
      };
    }

    default:
      return { handled: false };
  }
}


async function processWithPi(
  message: Message, 
  settings: Settings,
  tracker: ReactionTracker | null
): Promise<string | null> {
  await updateReaction(tracker, 'processing');

  // Claude Code (customer's own subscription login) takes precedence — it is
  // the only path that draws on Pro/Max plan limits.
  if (isClaudeCodeConnected()) {
    log.info({ projectId: settings.activeProject, message: message.body.slice(0, 50) }, 'Processing with Claude Code');
    const response = await runClaudeCodePrompt(settings.activeProject, withExecutedActionNotes(settings.activeProject, message.body), {
      onToolStart: (toolName) => {
        log.debug({ toolName }, 'Claude Code tool started');
        updateReaction(tracker, 'using_tools').catch(() => {});
      },
      onThinking: () => {
        updateReaction(tracker, 'thinking').catch(() => {});
      },
    });
    if (response) {
      saveMessage({
        id: `bot_${Date.now()}`,
        from: 'bot',
        to: message.from,
        body: response,
        timestamp: Math.floor(Date.now() / 1000),
        isFromMe: false,
        projectId: settings.activeProject,
      });
    }
    return response;
  }

  const credentialCheck = await checkCredentialsBeforePrompt();
  
  if (!credentialCheck.model) {
    log.warn({ error: credentialCheck.error }, 'No AI provider connected');
    return `❌ לא מחובר ספק AI.\n\nהיכנס להגדרות ב-Web UI וחבר ספק AI (Claude, ChatGPT).\n\n_ההתחברות מתבצעת דרך OAuth - ללא צורך ב-API key_`;
  }
  
  if (!credentialCheck.valid) {
    log.info(
      { 
        originalModel: settings.model, 
        resolvedModel: credentialCheck.modelId,
        error: credentialCheck.error 
      },
      'Model auto-adjusted due to credential mismatch'
    );
    
    try {
      await recreateSessionAfterCredentialChange(settings.activeProject);
    } catch (err) {
      log.error({ err }, 'Failed to recreate session after model adjustment');
    }
  }

  log.info({ projectId: settings.activeProject, message: message.body.slice(0, 50), model: credentialCheck.modelId }, 'Processing with Pi session');

  try {
    const response = await runPromptWithCallbacks(
      settings.activeProject,
      withExecutedActionNotes(settings.activeProject, message.body),
      {
        onTurnStart: () => {
          updateReaction(tracker, 'processing').catch(() => {});
        },
        onToolStart: (toolName) => {
          log.debug({ toolName }, 'Tool started');
          updateReaction(tracker, 'using_tools').catch(() => {});
        },
        onToolEnd: (toolName) => {
          log.debug({ toolName }, 'Tool ended');
        },
        onThinking: () => {
          updateReaction(tracker, 'thinking').catch(() => {});
        },
        onMessageStart: () => {
          updateReaction(tracker, 'thinking').catch(() => {});
        },
      }
    );
    
    if (response) {
      const botMessage: Message = {
        id: `bot_${Date.now()}`,
        from: 'bot',
        to: message.from,
        body: response,
        timestamp: Math.floor(Date.now() / 1000),
        isFromMe: false,
        projectId: settings.activeProject,
      };
      saveMessage(botMessage);
    }

    return response;
  } catch (err) {
    log.error({ err }, 'Pi session error');
    
    if (err instanceof CredentialError) {
      return `❌ ${err.message}\n\nהיכנס להגדרות ב-Web UI לחיבור מחדש.`;
    }
    
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (errorMessage.includes('No API key') || errorMessage.includes('auth') || errorMessage.includes('credential')) {
      return `❌ בעיית אימות ספק AI.\n\nהיכנס להגדרות ב-Web UI לחיבור מחדש.\n\n_שגיאה: ${errorMessage}_`;
    }
    
    throw err;
  }
}
