import { createChildLogger } from '../core/logger.ts';
import { loadSettings, updateSettings, getActiveConnectorToken } from '../core/settings.ts';
import { saveMessage, listProjects, createProject, getProject } from '../core/memory.ts';
import { config } from '../core/config.ts';
import type { Message, MessageKey, Settings } from '../core/types.ts';
import { getWhatsAppClient } from './client.ts';
import { OpenConnectorClient } from '../open-connector/client.ts';
import { 
  runPromptWithCallbacks, 
  clearSession, 
  getOrCreateSession, 
  setSessionModel,
  getPendingConfirmation,
  getLatestPendingConfirmation,
  confirmAction,
  cancelConfirmation,
  cleanupOldConfirmations,
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

const log = createChildLogger('handler');

const COMMAND_PREFIX = '/';

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

const CONFIRM_PATTERNS = [
  /^(yes|כן|אשר|confirm|ok|אוקיי|בסדר)$/i,
];

const CANCEL_PATTERNS = [
  /^(no|לא|בטל|cancel|ביטול)$/i,
];

interface CommandResult {
  handled: boolean;
  response?: string;
}

async function executePendingAction(pending: {
  actionId: string;
  input: Record<string, unknown>;
  connectionName?: string;
}): Promise<CommandResult> {
  const client = new OpenConnectorClient();
  try {
    const result = await client.executeAction({
      actionId: pending.actionId,
      input: pending.input,
      connectionName: pending.connectionName,
    });

    if (!result.success) {
      return {
        handled: true,
        response: `❌ Action failed: ${result.message}`,
      };
    }

    return {
      handled: true,
      response: `✅ Action "${pending.actionId}" executed successfully.\n\nResult:\n${JSON.stringify(result.data, null, 2)}`,
    };
  } catch (err) {
    return {
      handled: true,
      response: `❌ Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkForConfirmationResponse(text: string): Promise<CommandResult> {
  cleanupOldConfirmations();

  const confirmIdMatch = text.match(/confirm_\d+_[a-z0-9]+/);
  if (confirmIdMatch) {
    const confirmId = confirmIdMatch[0];
    const pending = getPendingConfirmation(confirmId);

    if (pending) {
      const isConfirm = CONFIRM_PATTERNS.some((p) => p.test(text.replace(confirmId, '').trim()));
      const isCancel = CANCEL_PATTERNS.some((p) => p.test(text.replace(confirmId, '').trim())) ||
                       text.toLowerCase().includes('cancel') || text.includes('בטל');

      if (isCancel) {
        cancelConfirmation(confirmId);
        return {
          handled: true,
          response: `❌ Action "${pending.actionId}" cancelled.`,
        };
      }

      if (isConfirm || text.trim() === confirmId) {
        confirmAction(confirmId);
        return executePendingAction(pending);
      }
    }
  }

  // The confirmation prompt tells the user to reply a plain "yes"/"אשר" —
  // resolve that against the most recent pending confirmation.
  const isSimpleConfirm = CONFIRM_PATTERNS.some((p) => p.test(text.trim()));
  const isSimpleCancel = CANCEL_PATTERNS.some((p) => p.test(text.trim()));

  if (isSimpleConfirm || isSimpleCancel) {
    const latest = getLatestPendingConfirmation();
    if (!latest) {
      return { handled: false };
    }
    if (isSimpleCancel) {
      cancelConfirmation(latest.confirmationId);
      return {
        handled: true,
        response: `❌ Action "${latest.actionId}" cancelled.`,
      };
    }
    confirmAction(latest.confirmationId);
    return executePendingAction(latest);
  }

  return { handled: false };
}

function isSelfChat(message: Message): boolean {
  // The self-chat may be addressed by phone JID or by LID — the client knows both.
  const wa = getWhatsAppClient();
  return message.isFromMe && wa.isSelfJid(message.to);
}

export async function handleMessage(message: Message): Promise<void> {
  const settings = loadSettings();
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

  // Reply into the chat the message arrived in (LID self-chat and phone-JID
  // self-chat are different conversations on the phone).
  const chatJid = message.messageKey?.remoteJid ?? ownerJid;

  const projectId = settings.activeProject;
  message.projectId = projectId;
  saveMessage(message);

  const tracker = message.messageKey ? createReactionTracker(message.messageKey) : null;

  if (message.body.startsWith(COMMAND_PREFIX)) {
    if (tracker) {
      await updateReaction(tracker, 'reading');
    }
    try {
      const result = await handleCommand(message.body, settings);
      if (result.handled && result.response) {
        if (tracker) {
          await updateReaction(tracker, 'finished');
        }
        await wa.sendMessage(chatJid, result.response);
      } else if (!result.handled) {
        await updateReaction(tracker, 'error');
        await wa.sendMessage(chatJid, 'פקודה לא מוכרת. שלח /help לרשימת הפקודות.');
      }
    } catch (err) {
      log.error({ err, command: message.body }, 'Command failed');
      await updateReaction(tracker, 'error');
      await wa.sendMessage(chatJid, `שגיאה בפקודה: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    return;
  }

  const confirmResponse = await checkForConfirmationResponse(message.body);
  if (confirmResponse.handled) {
    if (tracker) {
      await updateReaction(tracker, 'reading');
    }
    if (confirmResponse.response) {
      if (tracker) {
        await updateReaction(tracker, 'finished');
      }
      await wa.sendMessage(chatJid, confirmResponse.response);
    }
    return;
  }

  await updateReaction(tracker, 'reading');
  
  try {
    const response = await processWithPi(message, settings, tracker);
    if (response) {
      await updateReaction(tracker, 'finished');
      await sendSplitMessage(chatJid, response, message.id);
    } else {
      // Never fail silently — the user is staring at a chat with no reply.
      await updateReaction(tracker, 'error');
      await wa.sendMessage(chatJid, '⚠️ לא התקבלה תשובה מהמודל. נסה שוב, ואם זה חוזר — בדוק את חיבור ה-AI בהגדרות.');
    }
  } catch (err) {
    log.error({ err }, 'Error processing message');
    await updateReaction(tracker, 'error');
    await wa.sendMessage(chatJid, `שגיאה: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }
}

async function sendSplitMessage(jid: string, text: string, _replyToId?: string): Promise<void> {
  const wa = getWhatsAppClient();
  const MAX_LENGTH = 4000;
  
  if (text.length <= MAX_LENGTH) {
    await wa.sendMessage(jid, text);
    return;
  }

  const parts = splitMessage(text, MAX_LENGTH);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const prefix = parts.length > 1 ? `[${i + 1}/${parts.length}]\n\n` : '';
    await wa.sendMessage(jid, prefix + (part ?? ''));
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
/project [name] - החלף/צור פרויקט (מחליף Pi session)
/projects - רשימת פרויקטים
/services - רשימת שירותים מחוברים
/settings - הצג הגדרות
/model [name] - החלף מודל

*פעולות Open Connector:*
שאל "מה אני יכול לעשות עם Gmail?" או "שלח מייל ל..."
הסוכן יחפש, יציג מידע, ויבקש אישור לפני פעולות.

_שלח הודעה לעצמך כדי לדבר עם הסוכן_`,
      };

    case 'status': {
      const wa = getWhatsAppClient();
      const token = getActiveConnectorToken(settings);
      const connectorHealth = await checkConnectorHealth();
      
      const credentials = await listRuntimeCredentials();
      const modelResolution = await resolveActiveModel(settings.model);
      
      const aiProviders = credentials.length > 0 
        ? credentials.map(c => `${c.providerId} (${c.type})`).join(', ')
        : 'לא מחובר';
      
      const modelStatus = modelResolution.valid 
        ? `✅ ${modelResolution.modelId}` 
        : modelResolution.model
          ? `⚠️ ${modelResolution.modelId} (התאמה אוטומטית)`
          : `❌ ${settings.model} (חסר ספק)`;
      
      return {
        handled: true,
        response: `*סטטוס מערכת*

📱 WhatsApp: ${wa.isConnected() ? '✅ מחובר' : '❌ מנותק'}
🤖 ספקי AI: ${credentials.length > 0 ? '✅ ' + aiProviders : '❌ לא מחובר'}
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
      const projectId = projectName.toLowerCase().replace(/\s+/g, '-');
      
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
      } catch (err) {
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
🧠 מודל: ${settings.model}
🔑 מצב מפתחות: ${settings.apiKeyMode}
📁 פרויקט פעיל: ${settings.activeProject}

_היכנס לממשק הניהול לשינוי הגדרות_`,
      };
    }

    case 'model': {
      if (args.length === 0) {
        return {
          handled: true,
          response: `מודל נוכחי: *${settings.model}*\n\nלהחלפה: /model <שם-מודל>\n\nדוגמאות:\n- /model claude-3-5-sonnet-20241022\n- /model claude-sonnet-4-5\n- /model gpt-4o`,
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

async function checkConnectorHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${config.openConnectorUrl}/v1/health`);
    return response.ok;
  } catch {
    return false;
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
    const response = await runClaudeCodePrompt(settings.activeProject, message.body, {
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
      message.body,
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
