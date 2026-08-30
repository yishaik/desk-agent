import {
  createAgentSession,
  SessionManager,
  ModelRuntime,
  DefaultResourceLoader,
  type AgentSession,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { createChildLogger } from '../core/logger.ts';
import { loadSettings, updateSettings, isActionDisabled } from '../core/settings.ts';
import { config } from '../core/config.ts';
import { OpenConnectorClient } from '../open-connector/client.ts';
import { join } from 'node:path';
import { 
  resolveActiveModel, 
  listRuntimeCredentials,
  clearRuntimeCache,
  type ModelResolution,
} from '../http/auth.ts';

const log = createChildLogger('pi-session');

interface ProjectSession {
  session: AgentSession;
  projectId: string;
  cwd: string;
  modelRuntime: ModelRuntime;
}

const activeSessions = new Map<string, ProjectSession>();

let sharedModelRuntime: ModelRuntime | null = null;

const pendingConfirmations = new Map<string, {
  actionId: string;
  input: Record<string, unknown>;
  connectionName?: string;
  createdAt: number;
}>();

const MUTATING_ACTION_PATTERNS = [
  /\.send[A-Z_]/i,
  /\.create[A-Z_]/i,
  /\.update[A-Z_]/i,
  /\.delete[A-Z_]/i,
  /\.remove[A-Z_]/i,
  /\.post[A-Z_]/i,
  /\.publish[A-Z_]/i,
  /send[A-Z]/i,
  /create[A-Z]/i,
  /update[A-Z]/i,
  /delete[A-Z]/i,
  /remove[A-Z]/i,
  /post[A-Z]/i,
  /publish[A-Z]/i,
];

function requiresConfirmation(actionId: string): boolean {
  return MUTATING_ACTION_PATTERNS.some((pattern) => pattern.test(actionId));
}

function generateConfirmationId(): string {
  return `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getPendingConfirmation(confirmationId: string) {
  return pendingConfirmations.get(confirmationId);
}

export function confirmAction(confirmationId: string): boolean {
  const pending = pendingConfirmations.get(confirmationId);
  if (pending) {
    pendingConfirmations.delete(confirmationId);
    return true;
  }
  return false;
}

export function cancelConfirmation(confirmationId: string): boolean {
  return pendingConfirmations.delete(confirmationId);
}

/** Most recently created pending confirmation — the one a plain "yes" refers to. */
export function getLatestPendingConfirmation():
  | { confirmationId: string; actionId: string; input: Record<string, unknown>; connectionName?: string }
  | null {
  let latest: { confirmationId: string; actionId: string; input: Record<string, unknown>; connectionName?: string; createdAt: number } | null = null;
  for (const [confirmationId, pending] of pendingConfirmations) {
    if (!latest || pending.createdAt > latest.createdAt) {
      latest = { confirmationId, ...pending };
    }
  }
  return latest;
}

export function cleanupOldConfirmations(): void {
  const MAX_AGE_MS = 10 * 60 * 1000;
  const now = Date.now();
  for (const [id, pending] of pendingConfirmations) {
    if (now - pending.createdAt > MAX_AGE_MS) {
      pendingConfirmations.delete(id);
    }
  }
}

async function getOrCreateModelRuntime(): Promise<ModelRuntime> {
  if (sharedModelRuntime) {
    return sharedModelRuntime;
  }

  const piAgentDir = join(config.dataDir, 'pi-agent');
  const { existsSync, mkdirSync } = await import('node:fs');
  if (!existsSync(piAgentDir)) {
    mkdirSync(piAgentDir, { recursive: true });
  }

  const authPath = join(piAgentDir, 'auth.json');
  const modelsPath = join(piAgentDir, 'models.json');

  log.info({ piAgentDir, authPath }, 'Creating ModelRuntime');

  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath,
    allowModelNetwork: true,
  });

  if (config.modelApiKey) {
    try {
      await runtime.setRuntimeApiKey('anthropic', config.modelApiKey);
      log.info('Set Anthropic API key from MODEL_API_KEY env var');
    } catch (err) {
      log.warn({ err }, 'Failed to set runtime API key - will use stored credentials or ANTHROPIC_API_KEY env var');
    }
  }

  sharedModelRuntime = runtime;
  return runtime;
}

const SearchActionsSchema = Type.Object({
  query: Type.String({ description: "Search query (e.g., 'send email', 'calendar events')" }),
  service: Type.Optional(Type.String({ description: "Optional: filter to specific service (e.g., 'gmail', 'notion')" })),
});
type SearchActionsParams = Static<typeof SearchActionsSchema>;

const GetActionGuideSchema = Type.Object({
  actionId: Type.String({ description: "The action ID (e.g., 'gmail.send_email')" }),
});
type GetActionGuideParams = Static<typeof GetActionGuideSchema>;

const ExecuteActionSchema = Type.Object({
  actionId: Type.String({ description: 'The action ID to execute' }),
  input: Type.Record(Type.String(), Type.Unknown(), { description: 'Input parameters for the action' }),
  connectionName: Type.Optional(Type.String({ description: 'Optional connection alias' })),
  confirmed: Type.Optional(Type.Boolean({ description: 'Set to true only after user explicitly confirmed' })),
});
type ExecuteActionParams = Static<typeof ExecuteActionSchema>;

const ListConnectionsSchema = Type.Object({});
type ListConnectionsParams = Static<typeof ListConnectionsSchema>;

function getDisabledServices(): Set<string> {
  const settings = loadSettings();
  const disabled = new Set<string>();
  for (const svc of settings.services) {
    if (svc.enabled === false) {
      disabled.add(svc.id);
    }
  }
  return disabled;
}

function getDisabledActions(): Map<string, Set<string>> {
  const settings = loadSettings();
  const disabledMap = new Map<string, Set<string>>();
  for (const svc of settings.services) {
    if (svc.disabledActions && svc.disabledActions.length > 0) {
      disabledMap.set(svc.id, new Set(svc.disabledActions));
    }
  }
  return disabledMap;
}

function isServiceEnabled(serviceId: string): boolean {
  const settings = loadSettings();
  const svc = settings.services.find((s) => s.id === serviceId);
  return svc?.enabled !== false;
}

function isActionEnabled(actionId: string): boolean {
  const serviceId = actionId.split('.')[0];
  if (!serviceId) return true;
  
  if (!isServiceEnabled(serviceId)) {
    return false;
  }
  
  return !isActionDisabled(serviceId, actionId);
}

function createOpenConnectorTools(projectId: string): ToolDefinition[] {
  const getClient = () => new OpenConnectorClient(projectId);

  const searchActionsTool: ToolDefinition<typeof SearchActionsSchema> = {
    name: 'oc_search_actions',
    label: 'Search Actions',
    description: 'Search for available actions across connected services. Use this to discover what you can do.',
    parameters: SearchActionsSchema,
    async execute(toolCallId, params: SearchActionsParams, signal, onUpdate, ctx) {
      const client = getClient();
      const disabledServices = getDisabledServices();
      const disabledActions = getDisabledActions();
      try {
        const actions = await client.searchActions(params.query);
        let filtered = actions.filter((a) => {
          if (disabledServices.has(a.service)) return false;
          const svcDisabled = disabledActions.get(a.service);
          if (svcDisabled?.has(a.id)) return false;
          return true;
        });
        
        if (params.service) {
          if (disabledServices.has(params.service)) {
            return {
              content: [{ type: 'text' as const, text: `Service "${params.service}" is currently disabled.` }],
              details: { query: params.query, resultCount: 0, disabled: true },
            };
          }
          filtered = filtered.filter((a) => a.service === params.service);
        }

        if (filtered.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No actions found matching your query. Try different keywords or check connected services.' }],
            details: { query: params.query, resultCount: 0 },
          };
        }

        const list = filtered.slice(0, 10).map((a) =>
          `- **${a.id}**: ${a.displayName}\n  ${a.description}`
        ).join('\n\n');

        return {
          content: [{
            type: 'text' as const,
            text: `Found ${filtered.length} action(s):\n\n${list}\n\nUse oc_get_action_guide for details before executing.`,
          }],
          details: { query: params.query, resultCount: filtered.length },
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error searching actions: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: true },
        };
      }
    },
  };

  const getActionGuideTool: ToolDefinition<typeof GetActionGuideSchema> = {
    name: 'oc_get_action_guide',
    label: 'Get Action Guide',
    description: 'Get detailed documentation and input schema for an action before executing it.',
    parameters: GetActionGuideSchema,
    async execute(toolCallId, params: GetActionGuideParams, signal, onUpdate, ctx) {
      if (!isActionEnabled(params.actionId)) {
        const serviceId = params.actionId.split('.')[0];
        const isServiceDisabled = serviceId && !isServiceEnabled(serviceId);
        const msg = isServiceDisabled
          ? `Service "${serviceId}" is currently disabled.`
          : `Action "${params.actionId}" is currently disabled.`;
        return {
          content: [{ type: 'text' as const, text: msg }],
          details: { actionId: params.actionId, disabled: true },
        };
      }

      const client = getClient();
      try {
        const guide = await client.getActionGuide(params.actionId);
        return {
          content: [{ type: 'text' as const, text: guide }],
          details: { actionId: params.actionId },
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error fetching action guide: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: true },
        };
      }
    },
  };

  const executeActionTool: ToolDefinition<typeof ExecuteActionSchema> = {
    name: 'oc_execute_action',
    label: 'Execute Action',
    description: 'Execute an Open Connector action. For send/create/delete actions, user must reply to confirm the action first.',
    parameters: ExecuteActionSchema,
    async execute(toolCallId, params: ExecuteActionParams, signal, onUpdate, ctx) {
      if (!isActionEnabled(params.actionId)) {
        const serviceId = params.actionId.split('.')[0];
        const isServiceDisabled = serviceId && !isServiceEnabled(serviceId);
        const msg = isServiceDisabled
          ? `❌ Service "${serviceId}" is currently disabled. Enable it in Settings to use this action.`
          : `❌ Action "${params.actionId}" is currently disabled. Enable it in Settings to use this action.`;
        return {
          content: [{ type: 'text' as const, text: msg }],
          details: { actionId: params.actionId, disabled: true },
        };
      }

      if (requiresConfirmation(params.actionId)) {
        if (!params.confirmed) {
          const confirmationId = generateConfirmationId();
          pendingConfirmations.set(confirmationId, {
            actionId: params.actionId,
            input: params.input as Record<string, unknown>,
            connectionName: params.connectionName,
            createdAt: Date.now(),
          });

          return {
            content: [{
              type: 'text' as const,
              text: `⚠️ Action "${params.actionId}" requires your confirmation.\n\n**Planned action:**\n- Action: ${params.actionId}\n- Input: ${JSON.stringify(params.input, null, 2)}\n\n**To approve:** Reply "yes" or "אשר" or "confirm"\n**To cancel:** Reply "no" or "בטל" or "cancel"\n\n_Confirmation ID: ${confirmationId}_`,
            }],
            details: { 
              needsConfirmation: true, 
              actionId: params.actionId,
              confirmationId,
            },
          };
        }

        // Only a confirmation ID that actually exists in the pending map counts —
        // the model cannot self-confirm with `confirmed: true`. (The normal path
        // is the WhatsApp handler resolving a plain "yes" before it reaches here.)
        const confirmationIdMatch = String(params.confirmed).match(/confirm_\d+_[a-z0-9]+/);
        if (!confirmationIdMatch || !confirmAction(confirmationIdMatch[0])) {
          return {
            content: [{
              type: 'text' as const,
              text: `❌ Invalid confirmation. The model cannot self-confirm actions. Tell the user to reply "yes" (or "אשר") to the confirmation message — the reply is handled outside the model.`,
            }],
            details: { error: true, actionId: params.actionId, reason: 'invalid_confirmation' },
          };
        }
      }

      const client = getClient();
      try {
        const result = await client.executeAction({
          actionId: params.actionId,
          input: params.input as Record<string, unknown>,
          connectionName: params.connectionName,
        });

        if (!result.success) {
          return {
            content: [{ type: 'text' as const, text: `❌ Action failed: ${result.message}` }],
            details: { error: true, actionId: params.actionId },
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: `✅ Action executed successfully.\n\nResult:\n${JSON.stringify(result.data, null, 2)}`,
          }],
          details: { actionId: params.actionId, success: true },
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error executing action: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: true, actionId: params.actionId },
        };
      }
    },
  };

  const listConnectionsTool: ToolDefinition<typeof ListConnectionsSchema> = {
    name: 'oc_list_connections',
    label: 'List Connections',
    description: 'List all connected services and their status.',
    parameters: ListConnectionsSchema,
    async execute(toolCallId, params: ListConnectionsParams, signal, onUpdate, ctx) {
      const client = getClient();
      const disabledServices = getDisabledServices();
      try {
        const connections = await client.listConnections();
        const enabledConnections = connections.filter((c) => !disabledServices.has(c.service));

        if (enabledConnections.length === 0) {
          const hasDisabled = connections.length > 0;
          const msg = hasDisabled
            ? 'No enabled services connected. Some services are disabled in Settings.'
            : 'No services connected yet. Configure connections in the Open Connector console.';
          return {
            content: [{ type: 'text' as const, text: msg }],
            details: { connectionCount: 0, disabledCount: connections.length - enabledConnections.length },
          };
        }

        const list = enabledConnections.map((c) =>
          `- **${c.service}** (${c.connectionName}): ${c.identity?.label ?? c.authType}`
        ).join('\n');

        const disabledNote = disabledServices.size > 0 
          ? `\n\n_${disabledServices.size} service(s) disabled in Settings._`
          : '';

        return {
          content: [{ type: 'text' as const, text: `Connected services:\n\n${list}${disabledNote}` }],
          details: { connectionCount: enabledConnections.length, disabledCount: disabledServices.size },
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error listing connections: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: true },
        };
      }
    },
  };

  return [searchActionsTool, getActionGuideTool, executeActionTool, listConnectionsTool] as ToolDefinition[];
}

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

export async function checkCredentialsBeforePrompt(): Promise<ModelResolution> {
  const settings = loadSettings();
  return resolveActiveModel(settings.model);
}

export async function getOrCreateSession(projectId: string): Promise<ProjectSession> {
  const existing = activeSessions.get(projectId);
  if (existing) {
    return existing;
  }

  const settings = loadSettings();
  const projectCwd = `${config.dataDir}/projects/${projectId}`;

  const { existsSync, mkdirSync } = await import('node:fs');
  if (!existsSync(projectCwd)) {
    mkdirSync(projectCwd, { recursive: true });
  }

  const agentsmdPath = `${projectCwd}/AGENTS.md`;
  if (!existsSync(agentsmdPath)) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(agentsmdPath, `# ${projectId}

Project context for ${settings.botName}.

## Owner
${settings.ownerName || 'Not specified'}

## Timezone
${settings.timezone}

## Open Connector
Use the oc_* tools to interact with connected services:
- oc_search_actions: Find available actions
- oc_get_action_guide: Get action documentation  
- oc_execute_action: Execute (requires user confirmation for mutating actions)
- oc_list_connections: List connected services

For send/create/update/delete actions, always wait for the user to confirm before executing.
`);
  }

  const modelRuntime = await getOrCreateModelRuntime();
  const customTools = createOpenConnectorTools(projectId);
  const piAgentDir = join(config.dataDir, 'pi-agent');

  const modelResolution = await resolveActiveModel(settings.model);
  
  if (!modelResolution.model) {
    log.error({ error: modelResolution.error }, 'No valid model available');
    throw new CredentialError(modelResolution.error || 'No AI provider connected. Please connect in Settings.');
  }
  
  if (!modelResolution.valid && modelResolution.modelId !== settings.model) {
    log.info(
      { 
        originalModel: settings.model, 
        resolvedModel: modelResolution.modelId,
        providerId: modelResolution.providerId 
      },
      'Model auto-adjusted to match available credentials'
    );
    updateSettings({ model: modelResolution.modelId });
  }
  
  log.info({ projectId, cwd: projectCwd, model: modelResolution.modelId }, 'Creating Pi session');

  const workspaceRoot = process.cwd();
  const resourceLoader = new DefaultResourceLoader({
    cwd: projectCwd,
    agentDir: piAgentDir,
    additionalSkillPaths: [
      join(workspaceRoot, '.pi', 'skills'),
      join(workspaceRoot, 'skills-pack'),
    ],
    additionalExtensionPaths: [
      join(workspaceRoot, '.pi', 'extensions'),
    ],
  });

  const { session } = await createAgentSession({
    cwd: projectCwd,
    agentDir: piAgentDir,
    modelRuntime,
    model: modelResolution.model,
    sessionManager: SessionManager.inMemory(projectCwd),
    customTools,
    resourceLoader,
    tools: ['read', 'oc_search_actions', 'oc_get_action_guide', 'oc_execute_action', 'oc_list_connections'],
  });

  const projectSession: ProjectSession = {
    session,
    projectId,
    cwd: projectCwd,
    modelRuntime,
  };

  activeSessions.set(projectId, projectSession);
  log.info({ projectId, model: modelResolution.modelId }, 'Pi session created');

  return projectSession;
}

export async function setSessionModel(projectId: string, modelName: string): Promise<boolean> {
  const existing = activeSessions.get(projectId);
  if (!existing) {
    log.warn({ projectId }, 'No session found to change model');
    return false;
  }

  clearSession(projectId);
  
  updateSettings({ model: modelName });
  
  await getOrCreateSession(projectId);
  
  log.info({ projectId, model: modelName }, 'Model changed, session recreated');
  return true;
}

export function clearSession(projectId: string): void {
  const existing = activeSessions.get(projectId);
  if (existing) {
    existing.session.dispose();
    activeSessions.delete(projectId);
    log.info({ projectId }, 'Pi session cleared');
  }
}

export function clearAllSessions(): void {
  for (const [projectId, projectSession] of activeSessions) {
    projectSession.session.dispose();
    log.debug({ projectId }, 'Pi session disposed');
  }
  activeSessions.clear();
  sharedModelRuntime = null;
  clearRuntimeCache();
  log.info('All Pi sessions and runtime cleared');
}

export async function recreateSessionAfterCredentialChange(projectId: string): Promise<void> {
  clearAllSessions();
  await getOrCreateSession(projectId);
  log.info({ projectId }, 'Session recreated after credential change');
}

export function getSession(projectId: string): ProjectSession | undefined {
  return activeSessions.get(projectId);
}

export function extractTextFromMessages(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown[] };
    if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
      const textParts: string[] = [];
      for (const part of msg.content) {
        const p = part as { type?: string; text?: string };
        if (p?.type === 'text' && p?.text) {
          textParts.push(p.text);
        }
      }
      if (textParts.length > 0) {
        return textParts.join('\n');
      }
    }
  }
  return null;
}

export type AgentEventType = 
  | 'turn_start'
  | 'turn_end'
  | 'tool_execution_start'
  | 'tool_execution_end'
  | 'message_start'
  | 'message_end';

export interface RunPromptCallbacks {
  onTurnStart?: () => void;
  onToolStart?: (toolName: string) => void;
  onToolEnd?: (toolName: string) => void;
  onThinking?: () => void;
  onMessageStart?: () => void;
  onMessageEnd?: () => void;
}

export async function runPrompt(projectId: string, text: string): Promise<string | null> {
  const { session } = await getOrCreateSession(projectId);

  await session.prompt(text);
  await session.waitForIdle();

  const messages = session.state.messages;
  return extractTextFromMessages(messages);
}

export async function runPromptWithCallbacks(
  projectId: string,
  text: string,
  callbacks: RunPromptCallbacks
): Promise<string | null> {
  const { session } = await getOrCreateSession(projectId);

  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case 'turn_start':
        callbacks.onTurnStart?.();
        break;
      case 'tool_execution_start':
        if ('toolName' in event) {
          callbacks.onToolStart?.(event.toolName);
        }
        break;
      case 'tool_execution_end':
        if ('toolName' in event) {
          callbacks.onToolEnd?.(event.toolName);
        }
        break;
      case 'message_start':
        callbacks.onMessageStart?.();
        callbacks.onThinking?.();
        break;
      case 'message_end':
        callbacks.onMessageEnd?.();
        break;
      default:
        log.debug({ event: JSON.stringify(event).slice(0, 500) }, 'Pi event');
    }
    const anyEvent = event as { type?: string };
    if (anyEvent.type && anyEvent.type.toLowerCase().includes('error')) {
      log.error({ event: JSON.stringify(event).slice(0, 2000) }, 'Pi session error event');
    }
  });

  try {
    await session.prompt(text);
    await session.waitForIdle();

    const messages = session.state.messages;
    const result = extractTextFromMessages(messages);
    if (!result) {
      const last = messages[messages.length - 1] as { errorMessage?: string } | undefined;
      log.error(
        { lastMessage: JSON.stringify(last)?.slice(0, 2000), count: messages.length },
        'Pi turn produced no assistant text'
      );
      // Surface the provider's actual error to the user instead of a generic
      // "no answer" — quota/auth problems are actionable, silence is not.
      if (last?.errorMessage) {
        throw new Error(`המודל החזיר שגיאה: ${last.errorMessage.slice(0, 300)}`);
      }
    }
    return result;
  } finally {
    unsubscribe();
  }
}
