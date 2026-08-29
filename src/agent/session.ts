import {
  createAgentSession,
  SessionManager,
  ModelRuntime,
  type AgentSession,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { createChildLogger } from '../core/logger.ts';
import { loadSettings, getActiveConnectorToken, updateSettings } from '../core/settings.ts';
import { config } from '../core/config.ts';
import { OpenConnectorClient } from '../open-connector/client.ts';
import { join } from 'node:path';
import { 
  resolveValidModel, 
  clearRuntimeCache, 
  getDefaultModelForProvider,
  checkAuthStatus,
} from '../core/auth.ts';

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

function createOpenConnectorTools(projectId: string): ToolDefinition[] {
  const getClient = () => new OpenConnectorClient(projectId);

  const searchActionsTool: ToolDefinition<typeof SearchActionsSchema> = {
    name: 'oc_search_actions',
    label: 'Search Actions',
    description: 'Search for available actions across connected services. Use this to discover what you can do.',
    parameters: SearchActionsSchema,
    async execute(toolCallId, params: SearchActionsParams, signal, onUpdate, ctx) {
      const client = getClient();
      try {
        const actions = await client.searchActions(params.query);
        const filtered = params.service
          ? actions.filter((a) => a.service === params.service)
          : actions;

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

        const confirmationIdMatch = String(params.confirmed).match(/confirm_\d+_[a-z0-9]+/);
        if (!confirmationIdMatch) {
          return {
            content: [{
              type: 'text' as const,
              text: `❌ Invalid confirmation. The model cannot self-confirm actions. User must reply with "yes" or "confirm" to the confirmation message.`,
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
      try {
        const connections = await client.listConnections();

        if (connections.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No services connected yet. Configure connections in the Open Connector console.' }],
            details: { connectionCount: 0 },
          };
        }

        const list = connections.map((c) =>
          `- **${c.service}** (${c.connectionName}): ${c.identity?.label ?? c.authType}`
        ).join('\n');

        return {
          content: [{ type: 'text' as const, text: `Connected services:\n\n${list}` }],
          details: { connectionCount: connections.length },
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

interface ResolvedModelResult {
  model: string;
  providerId: string;
  isValid: boolean;
  fallbackReason?: string;
}

async function resolveActiveModel(
  requestedModel: string,
  runtime: ModelRuntime
): Promise<ResolvedModelResult> {
  const resolved = await resolveValidModel(requestedModel);
  
  if (resolved.isValid) {
    const model = runtime.getModel(resolved.providerId, resolved.model);
    if (model) {
      return resolved;
    }
    const modelIdOnly = resolved.model.split('/').pop() ?? resolved.model;
    const modelById = runtime.getModel(resolved.providerId, modelIdOnly);
    if (modelById) {
      return { ...resolved, model: modelIdOnly };
    }
  }
  
  return resolved;
}

export async function recreateSessionForProvider(
  projectId: string,
  providerId: string
): Promise<void> {
  clearSession(projectId);
  clearRuntimeCache();
  
  const defaultModel = getDefaultModelForProvider(providerId);
  updateSettings({ model: defaultModel });
  
  log.info({ projectId, providerId, model: defaultModel }, 'Recreating session for new provider');
  await getOrCreateSession(projectId);
}

export async function getAuthStatus(): Promise<{
  hasCredentials: boolean;
  configuredProviders: string[];
}> {
  const status = await checkAuthStatus();
  return {
    hasCredentials: status.hasAnyCredential,
    configuredProviders: status.configuredProviders,
  };
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

  log.info({ projectId, cwd: projectCwd }, 'Creating Pi session');

  const modelRuntime = await getOrCreateModelRuntime();
  const customTools = createOpenConnectorTools(projectId);

  const piAgentDir = join(config.dataDir, 'pi-agent');

  const resolvedModel = await resolveActiveModel(settings.model, modelRuntime);
  
  if (!resolvedModel.isValid) {
    log.warn(
      { requestedModel: settings.model, reason: resolvedModel.fallbackReason },
      'No valid credential for model - session will fail on prompt'
    );
  }
  
  if (resolvedModel.fallbackReason && resolvedModel.isValid && resolvedModel.model !== settings.model) {
    log.info(
      { original: settings.model, resolved: resolvedModel.model, provider: resolvedModel.providerId },
      'Using fallback model due to missing credentials'
    );
    updateSettings({ model: resolvedModel.model });
  }

  const model = resolvedModel.isValid && resolvedModel.model
    ? modelRuntime.getModel(resolvedModel.providerId, resolvedModel.model) ??
      modelRuntime.getModel(resolvedModel.providerId, resolvedModel.model.split('/').pop() ?? resolvedModel.model)
    : undefined;

  const { session } = await createAgentSession({
    cwd: projectCwd,
    agentDir: piAgentDir,
    modelRuntime,
    model,
    sessionManager: SessionManager.inMemory(projectCwd),
    customTools,
    tools: ['read', 'oc_search_actions', 'oc_get_action_guide', 'oc_execute_action', 'oc_list_connections'],
  });

  const projectSession: ProjectSession = {
    session,
    projectId,
    cwd: projectCwd,
    modelRuntime,
  };

  activeSessions.set(projectId, projectSession);
  log.info({ projectId }, 'Pi session created');

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
  for (const [projectId, session] of activeSessions) {
    session.session.dispose();
    log.info({ projectId }, 'Pi session disposed');
  }
  activeSessions.clear();
  sharedModelRuntime = null;
  clearRuntimeCache();
  log.info('All sessions and runtime cleared');
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

export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

function isAuthError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('no api key') ||
      msg.includes('api key not found') ||
      msg.includes('use /login') ||
      msg.includes('unauthorized') ||
      msg.includes('authentication') ||
      msg.includes('credential')
    );
  }
  return false;
}

export async function runPrompt(projectId: string, text: string): Promise<string | null> {
  const authStatus = await checkAuthStatus();
  
  if (!authStatus.hasAnyCredential) {
    throw new AuthRequiredError(
      'אין חיבור לספק AI. היכנס להגדרות ולחץ "התחבר עם ChatGPT" או "התחבר עם Claude" כדי להפעיל את הסוכן.'
    );
  }

  try {
    const { session } = await getOrCreateSession(projectId);
    await session.prompt(text);
    await session.waitForIdle();

    const messages = session.state.messages;
    return extractTextFromMessages(messages);
  } catch (err) {
    if (isAuthError(err)) {
      throw new AuthRequiredError(
        'החיבור לספק AI נכשל. היכנס להגדרות וודא שהחיבור פעיל, או התחבר מחדש.'
      );
    }
    throw err;
  }
}

export async function runPromptWithCallbacks(
  projectId: string,
  text: string,
  callbacks: RunPromptCallbacks
): Promise<string | null> {
  const authStatus = await checkAuthStatus();
  
  if (!authStatus.hasAnyCredential) {
    throw new AuthRequiredError(
      'אין חיבור לספק AI. היכנס להגדרות ולחץ "התחבר עם ChatGPT" או "התחבר עם Claude" כדי להפעיל את הסוכן.'
    );
  }

  let session: AgentSession;
  try {
    const result = await getOrCreateSession(projectId);
    session = result.session;
  } catch (err) {
    if (isAuthError(err)) {
      throw new AuthRequiredError(
        'החיבור לספק AI נכשל. היכנס להגדרות וודא שהחיבור פעיל, או התחבר מחדש.'
      );
    }
    throw err;
  }

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
    }
  });

  try {
    await session.prompt(text);
    await session.waitForIdle();

    const messages = session.state.messages;
    return extractTextFromMessages(messages);
  } catch (err) {
    if (isAuthError(err)) {
      throw new AuthRequiredError(
        'החיבור לספק AI נכשל. היכנס להגדרות וודא שהחיבור פעיל, או התחבר מחדש.'
      );
    }
    throw err;
  } finally {
    unsubscribe();
  }
}
