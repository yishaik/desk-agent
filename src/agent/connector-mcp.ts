/**
 * Stdio MCP server exposing Open Connector to the Claude Code engine.
 *
 * Spawned by the unmodified `claude` binary (see claude-code.ts). Mirrors the
 * oc_* tools the Pi engine gets, including the mutating-action confirmation
 * gate — pending confirmations are file-backed (core/confirmations.ts) so the
 * WhatsApp handler in the agent process can resolve a user's "yes".
 *
 * Protocol: newline-delimited JSON-RPC 2.0 (MCP stdio transport).
 */
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { OpenConnectorClient } from '../open-connector/client.ts';
import { loadSettings } from '../core/settings.ts';
import {
  requiresConfirmation,
  createPendingConfirmation,
  formatConfirmationRequest,
} from '../core/confirmations.ts';

const client = new OpenConnectorClient(process.env['DESK_PROJECT_ID'] || undefined);

function disabledServices(): Set<string> {
  const settings = loadSettings();
  return new Set(settings.services.filter((s) => s.enabled === false).map((s) => s.id));
}

function isActionEnabled(actionId: string): boolean {
  const settings = loadSettings();
  const serviceId = actionId.split('.')[0];
  if (!serviceId) return true;
  const svc = settings.services.find((s) => s.id === serviceId);
  if (svc?.enabled === false) return false;
  return !(svc?.disabledActions ?? []).includes(actionId);
}

export const TOOLS = [
  {
    name: 'search_actions',
    description: 'Search for available actions across connected services. Use this to discover what you can do.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords' },
        service: { type: 'string', description: 'Optional service id to filter by' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_action_guide',
    description: 'Get detailed documentation and input schema for an action before executing it.',
    inputSchema: {
      type: 'object',
      properties: { actionId: { type: 'string' } },
      required: ['actionId'],
    },
  },
  {
    name: 'execute_action',
    description: 'Execute an Open Connector action. Read-only actions run immediately. Mutating actions (send, reply, create, update, delete, ...) are never executed by this tool directly: it records a pending confirmation that the user approves by replying "yes" in WhatsApp, outside the model. You cannot approve on the user\'s behalf — do not call this tool again for the same action.',
    inputSchema: {
      type: 'object',
      properties: {
        actionId: { type: 'string' },
        input: { type: 'object', description: 'Action input matching its schema' },
        connectionName: { type: 'string' },
      },
      required: ['actionId', 'input'],
    },
  },
  {
    name: 'list_connections',
    description: 'List all connected services and their status.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'search_actions': {
      const query = String(args['query'] ?? '');
      const service = args['service'] ? String(args['service']) : undefined;
      const disabled = disabledServices();
      let actions = (await client.searchActions(query)).filter(
        (a) => !disabled.has(a.service) && isActionEnabled(a.id)
      );
      if (service) {
        if (disabled.has(service)) return `Service "${service}" is currently disabled.`;
        actions = actions.filter((a) => a.service === service);
      }
      if (actions.length === 0) {
        return 'No actions found matching your query. Try different keywords or check connected services.';
      }
      const list = actions.slice(0, 10)
        .map((a) => `- **${a.id}**: ${a.displayName}\n  ${a.description ?? ''}`)
        .join('\n\n');
      return `Found ${actions.length} action(s):\n\n${list}\n\nUse get_action_guide for details before executing.`;
    }

    case 'get_action_guide': {
      const actionId = String(args['actionId'] ?? '');
      if (!isActionEnabled(actionId)) return `Action "${actionId}" is currently disabled.`;
      return client.getActionGuide(actionId);
    }

    case 'execute_action': {
      const actionId = String(args['actionId'] ?? '');
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const connectionName = args['connectionName'] ? String(args['connectionName']) : undefined;
      if (!isActionEnabled(actionId)) return `Action "${actionId}" is currently disabled.`;

      if (requiresConfirmation(actionId)) {
        // Never executed from inside the model's turn — see core/confirmations.ts.
        // The owner's "yes" in WhatsApp is resolved by the agent process.
        const confirmationId = createPendingConfirmation({ actionId, input, connectionName });
        return formatConfirmationRequest(actionId, input, confirmationId);
      }

      const result = await client.executeAction({ actionId, input, connectionName });
      if (!result.success) {
        return `❌ Action failed: ${result.message}`;
      }
      return `✅ Action "${actionId}" executed successfully.\n\nResult:\n${JSON.stringify(result.data, null, 2)}`;
    }

    case 'list_connections': {
      const disabled = disabledServices();
      const connections = (await client.listConnections()).filter((c) => !disabled.has(c.service));
      if (connections.length === 0) {
        return 'No services connected yet. Configure connections in the Open Connector console.';
      }
      return 'Connected services:\n\n' + connections
        .map((c) => `- **${c.service}** (${c.connectionName}): ${c.identity?.label ?? c.authType}`)
        .join('\n');
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- minimal MCP stdio plumbing -------------------------------------------

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// Only serve stdio when run as the entry point (tests import callTool directly).
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const rl = isMain ? createInterface({ input: process.stdin }) : null;
rl?.on('line', (line) => {
  if (!line.trim()) return;
  let req: { jsonrpc: string; id?: number | string; method: string; params?: Record<string, unknown> };
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  const reply = (result: unknown) => {
    if (req.id !== undefined) send({ jsonrpc: '2.0', id: req.id, result });
  };
  const replyError = (message: string) => {
    if (req.id !== undefined) send({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message } });
  };

  switch (req.method) {
    case 'initialize':
      reply({
        protocolVersion: (req.params?.['protocolVersion'] as string) ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'desk-connector', version: '1.0.0' },
      });
      break;
    case 'notifications/initialized':
      break;
    case 'ping':
      reply({});
      break;
    case 'tools/list':
      reply({ tools: TOOLS });
      break;
    case 'tools/call': {
      const name = String((req.params?.['name'] as string) ?? '');
      const args = (req.params?.['arguments'] ?? {}) as Record<string, unknown>;
      callTool(name, args)
        .then((text) => reply({ content: [{ type: 'text', text }] }))
        .catch((err) => reply({
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }));
      break;
    }
    default:
      if (req.id !== undefined) replyError(`Method not found: ${req.method}`);
  }
});
