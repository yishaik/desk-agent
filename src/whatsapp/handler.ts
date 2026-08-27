import { createChildLogger } from '../core/logger.ts';
import { loadSettings, updateSettings } from '../core/settings.ts';
import { saveMessage, getConversationContext, listProjects, createProject, getProject } from '../core/memory.ts';
import { createClient } from '../open-connector/client.ts';
import type { Message, Settings } from '../core/types.ts';
import { getWhatsAppClient } from './client.ts';

const log = createChildLogger('handler');

const COMMAND_PREFIX = '/';

interface CommandResult {
  handled: boolean;
  response?: string;
}

export async function handleMessage(message: Message): Promise<void> {
  const settings = loadSettings();
  const wa = getWhatsAppClient();
  const ownerJid = wa.getOwnerJid();

  if (!ownerJid) {
    log.warn('No owner JID, skipping message');
    return;
  }

  const projectId = settings.activeProject;
  message.projectId = projectId;
  saveMessage(message);

  if (message.isFromMe && message.body.startsWith(COMMAND_PREFIX)) {
    const result = await handleCommand(message.body, settings);
    if (result.handled && result.response) {
      await wa.sendMessage(ownerJid, result.response);
    }
    return;
  }

  if (message.isFromMe) {
    await wa.sendReaction(ownerJid, message.id, '👀');
    
    try {
      const response = await processWithAI(message, settings);
      if (response) {
        await wa.sendReaction(ownerJid, message.id, '✅');
        await wa.sendMessage(ownerJid, response);
      }
    } catch (err) {
      log.error({ err }, 'Error processing message with AI');
      await wa.sendReaction(ownerJid, message.id, '❌');
      await wa.sendMessage(ownerJid, `שגיאה: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }
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
/project [name] - החלף/צור פרויקט
/projects - רשימת פרויקטים
/mode [shared|per-project] - מצב מפתחות API
/services - רשימת שירותים מחוברים
/settings - הצג הגדרות

_שלח הודעה לעצמך כדי לדבר עם הסוכן_`,
      };

    case 'status': {
      const wa = getWhatsAppClient();
      const connector = createClient(settings.activeProject);
      const connectorHealth = await connector.checkHealth();
      
      return {
        handled: true,
        response: `*סטטוס מערכת*

📱 WhatsApp: ${wa.isConnected() ? '✅ מחובר' : '❌ מנותק'}
🔌 Open Connector: ${connectorHealth ? '✅ תקין' : '❌ לא זמין'}
📁 פרויקט פעיל: ${settings.activeProject}
🔑 מצב מפתחות: ${settings.apiKeyMode === 'shared' ? 'משותף' : 'לפי פרויקט'}`,
      };
    }

    case 'project': {
      if (args.length === 0) {
        return {
          handled: true,
          response: `פרויקט פעיל: *${settings.activeProject}*\n\nלהחלפה: /project <שם>`,
        };
      }
      
      const projectName = args.join(' ');
      const projectId = projectName.toLowerCase().replace(/\s+/g, '-');
      
      let project = getProject(projectId);
      if (!project) {
        project = createProject({ id: projectId, name: projectName });
      }
      
      updateSettings({ activeProject: projectId });
      return {
        handled: true,
        response: `✅ הוחלף לפרויקט: *${project.name}*`,
      };
    }

    case 'projects': {
      const projects = listProjects();
      const list = projects
        .map((p) => `${p.id === settings.activeProject ? '▶️' : '  '} ${p.name}`)
        .join('\n');
      
      return {
        handled: true,
        response: `*פרויקטים*\n\n${list}`,
      };
    }

    case 'mode': {
      if (args.length === 0) {
        return {
          handled: true,
          response: `מצב מפתחות API: *${settings.apiKeyMode}*\n\nלשינוי: /mode shared או /mode per-project`,
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
      return {
        handled: true,
        response: `✅ מצב מפתחות שונה ל: *${mode}*`,
      };
    }

    case 'services': {
      const connector = createClient(settings.activeProject);
      try {
        const connections = await connector.listConnections();
        if (connections.length === 0) {
          return {
            handled: true,
            response: 'אין שירותים מחוברים.\n\nהיכנס לממשק הניהול כדי לחבר שירותים.',
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
          response: '❌ לא ניתן לטעון רשימת שירותים',
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

    default:
      return { handled: false };
  }
}

async function processWithAI(message: Message, settings: Settings): Promise<string | null> {
  const context = getConversationContext(settings.activeProject);
  const connector = createClient(settings.activeProject);

  let connections: Awaited<ReturnType<typeof connector.listConnections>> = [];
  try {
    connections = await connector.listConnections();
  } catch {
    log.warn('Could not fetch connections for AI context');
  }

  const availableServices = connections.map((c) => c.service).join(', ') || 'None';

  const systemPrompt = buildSystemPrompt(settings, availableServices);
  const messages = buildConversationMessages(context, message);

  const response = await callModel(systemPrompt, messages, settings);
  
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
}

function buildSystemPrompt(settings: Settings, availableServices: string): string {
  return `You are ${settings.botName}, a personal AI assistant for ${settings.ownerName || 'the user'}.

Current context:
- Timezone: ${settings.timezone}
- Active project: ${settings.activeProject}
- Connected services: ${availableServices}

Guidelines:
- Respond in the same language as the user's message
- Be concise but helpful
- If asked to perform actions (send email, check calendar, etc.), describe what you would do
- For actions that modify data (send, delete, publish), ask for confirmation first
- Never expose API keys or secrets in your responses
- If you need to call an external service, indicate which action you would use

Available actions depend on connected services. Currently available services: ${availableServices}`;
}

function buildConversationMessages(
  context: { messages: Message[]; summary?: string },
  currentMessage: Message
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  if (context.summary) {
    messages.push({
      role: 'assistant',
      content: `[Previous conversation summary: ${context.summary}]`,
    });
  }

  const recentMessages = context.messages.slice(-10);
  for (const msg of recentMessages) {
    if (msg.id === currentMessage.id) continue;
    messages.push({
      role: msg.isFromMe ? 'user' : 'assistant',
      content: msg.body,
    });
  }

  messages.push({
    role: 'user',
    content: currentMessage.body,
  });

  return messages;
}

async function callModel(
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  settings: Settings
): Promise<string | null> {
  const apiKey = process.env['MODEL_API_KEY'];
  const apiUrl = process.env['MODEL_API_URL'] ?? 'https://api.anthropic.com/v1/messages';

  if (!apiKey) {
    log.warn('No MODEL_API_KEY configured');
    return 'שגיאה: לא הוגדר מפתח API למודל. הגדר MODEL_API_KEY.';
  }

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: 2048,
        system: systemPrompt,
        messages,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error({ status: response.status, error: errorText }, 'Model API error');
      return `שגיאה בקריאה למודל: ${response.status}`;
    }

    const result = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
    };

    const textContent = result.content.find((c) => c.type === 'text');
    return textContent?.text ?? null;
  } catch (err) {
    log.error({ err }, 'Error calling model');
    return `שגיאה: ${err instanceof Error ? err.message : 'Unknown error'}`;
  }
}
