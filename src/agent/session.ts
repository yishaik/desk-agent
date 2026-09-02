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
import { buildIdentityPrompt, writeIdentityFiles } from '../core/identity-files.ts';

const log = createChildLogger('pi-session');

interface ProjectSession {
  session: AgentSession;
  projectId: string;
  cwd: string;
  modelRuntime: ModelRuntime;
}

const activeSessions = new Map<string, ProjectSession>();

/**
 * Pending session creations — prevents getOrCreateSession from racing and
 * creating two sessions for the same project (#33).
 */
const pendingCreations = new Map<string, Promise<ProjectSession>>();

let sharedModelRuntime: ModelRuntime | null = null;

// The pending-confirmation store is file-backed and shared with the connector
// MCP server (Claude Code engine). Re-exported for existing importers.
import {
  requiresConfirmation,
  createPendingConfirmation,
  formatConfirmationRequest,
} from '../core/confirmations.ts';
export {
  getPendingConfirmation,
  getLatestPendingConfirmation,
  confirmAction,
  cancelConfirmation,
  cleanupOldConfirmations,
} from '../core/confirmations.ts';

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

export function createOpenConnectorTools(projectId: string): ToolDefinition[] {
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
    description: 'Execute an Open Connector action. Read-only actions run immediately. Mutating actions (send, reply, create, update, delete, ...) are never executed by this tool directly: it records a pending confirmation that the user approves by replying "yes" in WhatsApp, outside the model. You cannot approve on the user\'s behalf — do not call this tool again for the same action.',
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
        // Mutating actions are never executed from inside the model's turn.
        // The pending store holds *unapproved* requests; the only thing that
        // approves one is the owner replying "yes" in WhatsApp, resolved by
        // whatsapp/handler.ts outside the model. There is deliberately no
        // parameter through which the model can claim approval.
        const confirmationId = createPendingConfirmation({
          actionId: params.actionId,
          input: params.input as Record<string, unknown>,
          connectionName: params.connectionName,
        });

        return {
          content: [{
            type: 'text' as const,
            text: formatConfirmationRequest(params.actionId, params.input, confirmationId),
          }],
          details: {
            needsConfirmation: true,
            actionId: params.actionId,
            confirmationId,
          },
        };
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

  // If another call is already creating the session, wait for it (#33).
  const pending = pendingCreations.get(projectId);
  if (pending) {
    return pending;
  }

  const creationPromise = createSession(projectId);
  pendingCreations.set(projectId, creationPromise);

  try {
    return await creationPromise;
  } finally {
    pendingCreations.delete(projectId);
  }
}

async function createSession(projectId: string): Promise<ProjectSession> {
  const settings = loadSettings();
  const projectCwd = `${config.dataDir}/projects/${projectId}`;

  const { existsSync, mkdirSync } = await import('node:fs');
  if (!existsSync(projectCwd)) {
    mkdirSync(projectCwd, { recursive: true });
  }

  const agentsmdPath = `${projectCwd}/AGENTS.md`;
  if (!existsSync(agentsmdPath)) {
    writeIdentityFiles(settings, projectId);
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

/**
 * Recreate the Pi session after credential or settings change.
 * 
 * Contract with Settings UI: this export must remain stable.
 * Settings UI calls this after updateSettings + writeIdentityFiles.
 * 
 * - clearAllSessions() is required so ModelRuntime is not left on the old model
 * - Identity files (AGENTS.md) should be written BEFORE calling this
 * - Claude Code session is also cleared for the project
 * 
 * Calling twice is idempotent (recreate is safe).
 */
export async function recreateSessionAfterCredentialChange(projectId: string): Promise<void> {
  const { clearClaudeCodeSession } = await import('./claude-code.ts');
  
  writeIdentityFiles(loadSettings(), projectId);
  
  clearAllSessions();
  clearClaudeCodeSession(projectId);
  
  await getOrCreateSession(projectId);
  log.info({ projectId }, 'Session recreated after credential/settings change');
}

/**
 * Alias for recreateSessionAfterCredentialChange.
 * Use when refreshing session after settings save (model or identity change).
 */
export const refreshSessionAfterSettingsSave = recreateSessionAfterCredentialChange;

export function getSession(projectId: string): ProjectSession | undefined {
  return activeSessions.get(projectId);
}

/**
 * Extract assistant text from a slice of messages (the CURRENT turn only).
 *
 * Previously this walked the entire messages array from the end and returned
 * the first assistant message with text — if the current turn had no text, it
 * would return text from a PREVIOUS turn (#34). Now callers pass startIndex
 * (messages.length before session.prompt) so we only look at the current turn.
 *
 * We also collect ALL assistant text from the current turn (a turn with
 * several tool calls may have intermediate text worth joining).
 */
export function extractTextFromMessages(
  messages: unknown[],
  startIndex = 0
): string | null {
  const allTextParts: string[] = [];

  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i] as { role?: string; content?: unknown[] };
    if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        const p = part as { type?: string; text?: string };
        if (p?.type === 'text' && p?.text) {
          allTextParts.push(p.text);
        }
      }
    }
  }

  return allTextParts.length > 0 ? allTextParts.join('\n\n') : null;
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

  const startIndex = session.state.messages.length;
  await session.prompt(text);
  await session.waitForIdle();

  const messages = session.state.messages;
  return extractTextFromMessages(messages, startIndex);
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
    const startIndex = session.state.messages.length;
    await session.prompt(text);
    await session.waitForIdle();

    const messages = session.state.messages;
    const result = extractTextFromMessages(messages, startIndex);
    if (!result) {
      const last = messages[messages.length - 1] as { errorMessage?: string } | undefined;
      log.error(
        { lastMessage: JSON.stringify(last)?.slice(0, 2000), count: messages.length, startIndex },
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
