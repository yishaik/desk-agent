import { createChildLogger } from '../core/logger.ts';
import { loadSettings, updateSettings, getActiveConnectorToken } from '../core/settings.ts';
import { saveMessage, getConversationContext, listProjects, createProject, getProject } from '../core/memory.ts';
import { config } from '../core/config.ts';
import type { Message, Settings } from '../core/types.ts';
import { getWhatsAppClient } from './client.ts';
import { OpenConnectorClient } from '../open-connector/client.ts';

const log = createChildLogger('handler');

const COMMAND_PREFIX = '/';

interface CommandResult {
  handled: boolean;
  response?: string;
}

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

interface ToolResult {
  success: boolean;
  content: string;
  needsConfirmation?: boolean;
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
        await sendSplitMessage(ownerJid, response, message.id);
      }
    } catch (err) {
      log.error({ err }, 'Error processing message');
      await wa.sendReaction(ownerJid, message.id, '❌');
      await wa.sendMessage(ownerJid, `שגיאה: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
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
/project [name] - החלף/צור פרויקט
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
          response: `פרויקט פעיל: *${settings.activeProject}*\n\nלהחלפה: /project <שם>\n\n_החלפת פרויקט מחליפה את טוקן Open Connector (במצב per-project)_`,
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
      
      return {
        handled: true,
        response: `✅ מצב מפתחות שונה ל: *${mode}*`,
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
          response: `מודל נוכחי: *${settings.model}*\n\nלהחלפה: /model <שם-מודל>\n\nדוגמאות:\n- /model claude-3-5-sonnet-20241022\n- /model gpt-4o`,
        };
      }
      
      const model = args.join(' ');
      updateSettings({ model });
      return {
        handled: true,
        response: `✅ מודל שונה ל: *${model}*`,
      };
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

const CONFIRMATION_PATTERNS = [
  /\.send_/i,
  /\.create_/i,
  /\.update_/i,
  /\.delete_/i,
  /\.remove_/i,
  /\.post_/i,
  /\.publish_/i,
];

function requiresConfirmation(actionId: string): boolean {
  return CONFIRMATION_PATTERNS.some((pattern) => pattern.test(actionId));
}

async function executeOpenConnectorTool(
  toolName: string,
  input: Record<string, unknown>,
  settings: Settings
): Promise<ToolResult> {
  const client = new OpenConnectorClient(settings.activeProject);

  switch (toolName) {
    case 'oc_search_actions': {
      const query = input['query'] as string;
      const service = input['service'] as string | undefined;
      
      try {
        const actions = await client.searchActions(query);
        const filtered = service 
          ? actions.filter(a => a.service === service)
          : actions;
        
        if (filtered.length === 0) {
          return {
            success: true,
            content: 'No actions found matching your query. Try different keywords or check connected services.',
          };
        }

        const list = filtered.slice(0, 10).map((a) => 
          `- **${a.id}**: ${a.displayName}\n  ${a.description}`
        ).join('\n\n');

        return {
          success: true,
          content: `Found ${filtered.length} action(s):\n\n${list}\n\nUse oc_get_action_guide for details before executing.`,
        };
      } catch (err) {
        return {
          success: false,
          content: `Error searching actions: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    case 'oc_get_action_guide': {
      const actionId = input['actionId'] as string;
      
      try {
        const guide = await client.getActionGuide(actionId);
        return {
          success: true,
          content: guide,
        };
      } catch (err) {
        return {
          success: false,
          content: `Error fetching action guide: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    case 'oc_execute_action': {
      const actionId = input['actionId'] as string;
      const actionInput = input['input'] as Record<string, unknown>;
      const connectionName = input['connectionName'] as string | undefined;
      const confirmed = input['confirmed'] as boolean | undefined;

      if (requiresConfirmation(actionId) && !confirmed) {
        return {
          success: true,
          needsConfirmation: true,
          content: `⚠️ Action "${actionId}" requires confirmation before execution.\n\nPlanned action:\n- Action: ${actionId}\n- Input: ${JSON.stringify(actionInput, null, 2)}\n\nPlease confirm to execute.`,
        };
      }

      try {
        const result = await client.executeAction({
          actionId,
          input: actionInput,
          connectionName,
        });

        if (!result.success) {
          return {
            success: false,
            content: `❌ Action failed: ${result.message}`,
          };
        }

        return {
          success: true,
          content: `✅ Action executed successfully.\n\nResult:\n${JSON.stringify(result.data, null, 2)}`,
        };
      } catch (err) {
        return {
          success: false,
          content: `Error executing action: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    case 'oc_list_connections': {
      try {
        const connections = await client.listConnections();
        
        if (connections.length === 0) {
          return {
            success: true,
            content: 'No services connected yet. Configure connections in the Open Connector console.',
          };
        }

        const list = connections.map((c) => 
          `- **${c.service}** (${c.connectionName}): ${c.identity?.label ?? c.authType}`
        ).join('\n');

        return {
          success: true,
          content: `Connected services:\n\n${list}`,
        };
      } catch (err) {
        return {
          success: false,
          content: `Error listing connections: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    default:
      return {
        success: false,
        content: `Unknown tool: ${toolName}`,
      };
  }
}

async function processWithAI(message: Message, settings: Settings): Promise<string | null> {
  const wa = getWhatsAppClient();
  const ownerJid = wa.getOwnerJid();
  const apiKey = process.env['MODEL_API_KEY'];
  const apiUrl = process.env['MODEL_API_URL'] ?? 'https://api.anthropic.com/v1/messages';

  if (!apiKey) {
    log.warn('No MODEL_API_KEY configured');
    return `שגיאה: לא הוגדר מפתח API למודל.\n\nהגדר MODEL_API_KEY בקובץ .env או השתמש ב-/login לפרטים.`;
  }

  const context = getConversationContext(settings.activeProject);
  
  const tools = [
    {
      name: 'oc_search_actions',
      description: 'Search for available actions across connected services. Use this to discover what you can do.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: "Search query (e.g., 'send email', 'calendar events')" },
          service: { type: 'string', description: "Optional: filter to specific service (e.g., 'gmail', 'notion')" },
        },
        required: ['query'],
      },
    },
    {
      name: 'oc_get_action_guide',
      description: 'Get detailed documentation and input schema for an action before executing it.',
      input_schema: {
        type: 'object',
        properties: {
          actionId: { type: 'string', description: "The action ID (e.g., 'gmail.send_email')" },
        },
        required: ['actionId'],
      },
    },
    {
      name: 'oc_execute_action',
      description: 'Execute an Open Connector action. For send/create/delete actions, you MUST ask for user confirmation first.',
      input_schema: {
        type: 'object',
        properties: {
          actionId: { type: 'string', description: 'The action ID to execute' },
          input: { type: 'object', description: 'Input parameters for the action' },
          connectionName: { type: 'string', description: 'Optional connection alias' },
          confirmed: { type: 'boolean', description: 'Set to true only after user explicitly confirmed' },
        },
        required: ['actionId', 'input'],
      },
    },
    {
      name: 'oc_list_connections',
      description: 'List all connected services and their status.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
  ];

  const systemPrompt = `You are ${settings.botName}, a personal AI assistant for ${settings.ownerName || 'the user'}.

Current context:
- Timezone: ${settings.timezone}
- Active project: ${settings.activeProject}

You have access to Open Connector tools to interact with external services:
1. oc_search_actions - Find available actions
2. oc_get_action_guide - Get action documentation
3. oc_execute_action - Execute an action (ALWAYS confirm first for send/create/delete)
4. oc_list_connections - List connected services

IMPORTANT WORKFLOW:
1. Search for actions to discover what you can do
2. Get the action guide to understand input requirements
3. For actions that modify data (send, create, update, delete), describe what you're about to do and ASK FOR CONFIRMATION
4. Only execute with confirmed:true AFTER the user explicitly says yes/כן/אשר

Respond in the same language as the user (Hebrew or English).`;

  const messages: Array<{role: 'user' | 'assistant'; content: string | Array<{type: string; tool_use_id?: string; content?: string; id?: string; name?: string; input?: unknown}>}> = [];

  const recentMessages = context.messages.slice(-10);
  for (const m of recentMessages) {
    if (m.id === message.id) continue;
    messages.push({
      role: m.isFromMe ? 'user' : 'assistant',
      content: m.body,
    });
  }

  messages.push({ role: 'user', content: message.body });

  let iterations = 0;
  const maxIterations = 5;

  while (iterations < maxIterations) {
    iterations++;

    if (ownerJid && iterations > 1) {
      await wa.sendReaction(ownerJid, message.id, '🔧');
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
          max_tokens: 4096,
          system: systemPrompt,
          tools,
          messages,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        log.error({ status: response.status, error: errorText }, 'Model API error');
        return `שגיאה בקריאה למודל: ${response.status}`;
      }

      const result = await response.json() as {
        content: Array<{type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>}>;
        stop_reason: string;
      };

      const textContent = result.content.find((c) => c.type === 'text');
      const toolUses = result.content.filter((c) => c.type === 'tool_use');

      if (toolUses.length === 0 || result.stop_reason === 'end_turn') {
        const finalResponse = textContent?.text ?? null;
        if (finalResponse) {
          const botMessage: Message = {
            id: `bot_${Date.now()}`,
            from: 'bot',
            to: message.from,
            body: finalResponse,
            timestamp: Math.floor(Date.now() / 1000),
            isFromMe: false,
            projectId: settings.activeProject,
          };
          saveMessage(botMessage);
        }
        return finalResponse;
      }

      messages.push({
        role: 'assistant',
        content: result.content,
      });

      const toolResults: Array<{type: 'tool_result'; tool_use_id: string; content: string}> = [];

      for (const toolUse of toolUses) {
        if (toolUse.type !== 'tool_use' || !toolUse.id || !toolUse.name) continue;

        log.info({ tool: toolUse.name, input: toolUse.input }, 'Executing tool');

        const toolResult = await executeOpenConnectorTool(
          toolUse.name,
          toolUse.input ?? {},
          settings
        );

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: toolResult.content,
        });
      }

      messages.push({
        role: 'user',
        content: toolResults,
      });

    } catch (err) {
      log.error({ err }, 'Error in AI loop');
      return `שגיאה: ${err instanceof Error ? err.message : 'Unknown error'}`;
    }
  }

  return 'הגעתי למקסימום איטרציות. נסה שוב עם בקשה פשוטה יותר.';
}
