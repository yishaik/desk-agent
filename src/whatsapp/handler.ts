import { createChildLogger } from '../core/logger.ts';
import { loadSettings, updateSettings, getActiveConnectorToken } from '../core/settings.ts';
import { saveMessage, getConversationContext, listProjects, createProject, getProject } from '../core/memory.ts';
import { config } from '../core/config.ts';
import type { Message, Settings } from '../core/types.ts';
import { getWhatsAppClient } from './client.ts';
import { OpenConnectorClient } from '../open-connector/client.ts';
import { 
  runPrompt, 
  clearSession, 
  getOrCreateSession, 
  setSessionModel,
  getPendingConfirmation,
  confirmAction,
  cancelConfirmation,
  cleanupOldConfirmations,
} from '../agent/session.ts';
import { isSelfChatJid, validateSelfChatMessage } from './self-chat.ts';

const log = createChildLogger('handler');

const COMMAND_PREFIX = '/';

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
    }
  }
  
  const isSimpleConfirm = CONFIRM_PATTERNS.some((p) => p.test(text.trim()));
  const isSimpleCancel = CANCEL_PATTERNS.some((p) => p.test(text.trim()));
  
  if (isSimpleConfirm || isSimpleCancel) {
    return { handled: false };
  }
  
  return { handled: false };
}

/**
 * SECURITY: Validates that a message is in a self-chat conversation.
 * 
 * This is a critical security gate. The bot must NEVER respond to:
 * - Messages in chats with other people
 * - Messages in group chats
 * - Messages in broadcast lists
 * 
 * The production incident occurred because this check was insufficient.
 * Now we use the validated isSelfChatJid function.
 */
function isSelfChat(message: Message, ownerJid: string, ownerLid: string | null): boolean {
  const ownerPhone = ownerJid.split(':')[0]?.split('@')[0] ?? null;
  const targetJid = message.isFromMe ? message.to : message.from;
  
  return isSelfChatJid(targetJid, ownerPhone, ownerLid);
}

export async function handleMessage(message: Message): Promise<void> {
  const settings = loadSettings();
  const wa = getWhatsAppClient();
  const ownerJid = wa.getOwnerJid();
  const ownerLid = wa.getOwnerLid();

  if (!ownerJid) {
    log.warn('No owner JID, skipping message');
    return;
  }

  if (!isSelfChat(message, ownerJid, ownerLid)) {
    log.debug(
      { from: message.from, to: message.to, isFromMe: message.isFromMe },
      'SECURITY: Ignoring non-self-chat message - bot will NOT respond'
    );
    return;
  }

  const projectId = settings.activeProject;
  message.projectId = projectId;
  saveMessage(message);

  if (message.body.startsWith(COMMAND_PREFIX)) {
    const result = await handleCommand(message.body, settings);
    if (result.handled && result.response) {
      await wa.sendMessage(ownerJid, result.response);
    }
    return;
  }

  const confirmResponse = await checkForConfirmationResponse(message.body);
  if (confirmResponse.handled) {
    if (confirmResponse.response) {
      await wa.sendMessage(ownerJid, confirmResponse.response);
    }
    return;
  }

  await wa.sendReaction(ownerJid, message.id, '👀');
  
  try {
    const response = await processWithPi(message, settings);
    if (response) {
      await wa.sendReaction(ownerJid, message.id, '✅');
      await sendSplitMessage(ownerJid, response, message.id);
    }
  } catch (err) {
    log.error({ err }, 'Error processing message');
    await wa.sendReaction(ownerJid, message.id, '❌');
    await wa.sendMessage(ownerJid, `שגיאה: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }
}

async function sendSplitMessage(jid: string, text: string, replyToId?: string): Promise<void> {
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
/mode [shared|per-project] - מצב מפתחות API
/services - רשימת שירותים מחוברים
/settings - הצג הגדרות
/model [name] - החלף מודל
/login - התחברות לספק AI

*פעולות Open Connector:*
שאל "מה אני יכול לעשות עם Gmail?" או "שלח מייל ל..."
הסוכן יחפש, יציג מידע, ויבקש אישור לפני פעולות.

_שלח הודעה לעצמך כדי לדבר עם הסוכן_`,
      };

    case 'status': {
      const wa = getWhatsAppClient();
      const token = getActiveConnectorToken(settings);
      const connectorHealth = await checkConnectorHealth();
      
      return {
        handled: true,
        response: `*סטטוס מערכת*

📱 WhatsApp: ${wa.isConnected() ? '✅ מחובר' : '❌ מנותק'}
🔌 Open Connector: ${connectorHealth ? '✅ תקין' : '❌ לא זמין'}
📁 פרויקט פעיל: ${settings.activeProject}
🔑 מצב מפתחות: ${settings.apiKeyMode === 'shared' ? 'משותף' : 'לפי פרויקט'}
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

    case 'mode': {
      if (args.length === 0) {
        return {
          handled: true,
          response: `מצב מפתחות API: *${settings.apiKeyMode}*\n\nלשינוי: /mode shared או /mode per-project\n\n*shared* - טוקן אחד לכל הפרויקטים\n*per-project* - טוקן נפרד לכל פרויקט`,
        };
      }
      
      const mode = args[0] as 'shared' | 'per-project';
      if (mode !== 'shared' && mode !== 'per-project') {
        return {
          handled: true,
          response: '❌ מצב לא תקין. השתמש ב: shared או per-project',
        };
      }
      
      updateSettings({ apiKeyMode: mode });
      
      clearSession(settings.activeProject);
      
      return {
        handled: true,
        response: `✅ מצב מפתחות שונה ל: *${mode}*\n\n_Pi session יאותחל מחדש בהודעה הבאה._`,
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
          response: `מודל נוכחי: *${settings.model}*\n\nלהחלפה: /model <שם-מודל>\n\nדוגמאות:\n- /model claude-3-5-sonnet-20241022\n- /model claude-sonnet-4-5\n- /model gpt-4o\n\n_או השתמש ב-pi /login ו-/model בטרמינל_`,
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
      return {
        handled: true,
        response: `*התחברות לספק AI*

1. פתח טרמינל בשרת
2. הרץ: \`npx pi /login\`
3. בחר ספק (Anthropic, OpenAI, וכו')
4. עקוב אחרי ההוראות

_או הגדר API key בקובץ .env:_
\`MODEL_API_KEY=sk-ant-...\`

ספקים נתמכים:
- Anthropic (Claude Pro/Max subscription)
- OpenAI (ChatGPT Plus/Pro)
- GitHub Copilot
- Google Gemini
- ועוד...`,
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

async function processWithPi(message: Message, settings: Settings): Promise<string | null> {
  const wa = getWhatsAppClient();
  const ownerJid = wa.getOwnerJid();
  
  if (ownerJid) {
    await wa.sendReaction(ownerJid, message.id, '🤔');
  }

  log.info({ projectId: settings.activeProject, message: message.body.slice(0, 50) }, 'Processing with Pi session');

  try {
    const response = await runPrompt(settings.activeProject, message.body);
    
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
    throw err;
  }
}
