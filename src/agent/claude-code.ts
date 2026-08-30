/**
 * Claude Code engine — runs the unmodified `claude` binary in headless print
 * mode with the customer's own subscription login.
 *
 * Why: Anthropic bills third-party OAuth (the Pi runtime path) from extra
 * usage per token. The one compliant way to use a customer's Pro/Max plan
 * limits is the end user signing in to the unmodified Claude Code binary
 * (see code.claude.com/docs/en/legal-and-compliance). Auth uses Claude Code's
 * own `setup-token` flow; the credential belongs to the customer and lives
 * only inside their stack.
 *
 * Open Connector tools are provided to Claude Code via a stdio MCP server
 * (connector-mcp.ts) that shares the file-backed confirmation store with the
 * WhatsApp handler.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/config.ts';
import { createChildLogger } from '../core/logger.ts';
import { loadSettings } from '../core/settings.ts';

const log = createChildLogger('claude-code');

const BASE_DIR = join(config.dataDir, 'claude-code');
const TOKEN_PATH = join(BASE_DIR, 'token');
const SESSIONS_PATH = join(BASE_DIR, 'sessions.json');
const CONFIG_DIR = join(BASE_DIR, 'config');

const PROMPT_TIMEOUT_MS = 240_000;
const CLAUDE_BIN = process.env['CLAUDE_CODE_BIN'] || 'claude';

function ensureDirs(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

export function isClaudeCodeConnected(): boolean {
  try {
    return readFileSync(TOKEN_PATH, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

export function disconnectClaudeCode(): void {
  rmSync(TOKEN_PATH, { force: true });
  rmSync(SESSIONS_PATH, { force: true });
}

function readToken(): string {
  return readFileSync(TOKEN_PATH, 'utf8').trim();
}

function loadSessions(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(SESSIONS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveSession(projectId: string, sessionId: string): void {
  ensureDirs();
  const sessions = loadSessions();
  sessions[projectId] = sessionId;
  writeFileSync(SESSIONS_PATH, JSON.stringify(sessions), { mode: 0o600 });
}

export function clearClaudeCodeSession(projectId: string): void {
  const sessions = loadSessions();
  if (sessions[projectId]) {
    delete sessions[projectId];
    writeFileSync(SESSIONS_PATH, JSON.stringify(sessions), { mode: 0o600 });
  }
}

// --- setup-token login flow ------------------------------------------------
// `claude setup-token` is Claude Code's own headless auth flow: it prints an
// authorize URL, the user approves in a browser and pastes a code back, and
// the CLI prints a long-lived token. We drive it under a pseudo-TTY.

interface SetupState {
  child: ChildProcess;
  output: string;
  authorizeUrl?: string;
  done: boolean;
  error?: string;
}

let setupState: SetupState | null = null;

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

export async function startClaudeCodeLogin(): Promise<{ authorizeUrl?: string; error?: string }> {
  if (setupState && !setupState.done && setupState.authorizeUrl) {
    return { authorizeUrl: setupState.authorizeUrl };
  }
  if (setupState && !setupState.done) {
    setupState.child.kill('SIGKILL');
  }

  ensureDirs();
  // `script` allocates the TTY setup-token insists on.
  // Wide pseudo-terminal — at 80 columns the printed token wraps mid-string.
  const child = spawn('script', ['-qec', `stty cols 500 2>/dev/null; ${CLAUDE_BIN} setup-token`, '/dev/null'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG_DIR, HOME: BASE_DIR, TERM: 'xterm', COLUMNS: '500' },
    cwd: BASE_DIR,
  });

  const state: SetupState = { child, output: '', done: false };
  setupState = state;

  child.stdout?.on('data', (d: Buffer) => { state.output += stripAnsi(d.toString()); });
  child.stderr?.on('data', (d: Buffer) => { state.output += stripAnsi(d.toString()); });
  child.on('exit', (code) => {
    state.done = true;
    if (code !== 0 && !state.output.includes('sk-ant-')) {
      state.error = `setup-token exited with code ${code}`;
      log.error({ code, tail: state.output.slice(-500) }, 'claude setup-token failed');
    }
  });

  const start = Date.now();
  while (Date.now() - start < 30_000) {
    const match = state.output.match(/https:\/\/[^\s"']*oauth[^\s"']*/);
    if (match) {
      state.authorizeUrl = match[0];
      log.info('Claude Code setup-token authorize URL ready');
      return { authorizeUrl: state.authorizeUrl };
    }
    if (state.done) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  child.kill('SIGKILL');
  setupState = null;
  log.error({ tail: state.output.slice(-500) }, 'setup-token produced no authorize URL');
  return { error: 'לא התקבל קישור התחברות מ-Claude Code. ודא שהחבילה מותקנת ונסה שוב.' };
}

export async function completeClaudeCodeLogin(code: string): Promise<{ success: boolean; error?: string }> {
  const state = setupState;
  if (!state || state.done) {
    return { success: false, error: 'לא נמצאה התחברות פעילה. התחל מחדש.' };
  }

  // The setup-token prompt is a raw-mode TUI: Enter must be '\r', and a short
  // gap between the pasted code and the Enter keypress makes Ink register both.
  state.child.stdin?.write(code.trim());
  await new Promise((r) => setTimeout(r, 400));
  state.child.stdin?.write('\r');

  const start = Date.now();
  while (Date.now() - start < 45_000 && !state.done) {
    await new Promise((r) => setTimeout(r, 500));
  }

  // Join wrapped lines before matching — a PTY may still split the token.
  const flat = stripAnsi(state.output).replace(/[\r\n]/g, '');
  const tokenMatch = flat.match(/sk-ant-[a-zA-Z0-9_-]{40,}/);
  if (tokenMatch) {
    ensureDirs();
    writeFileSync(TOKEN_PATH, tokenMatch[0], { mode: 0o600 });
    setupState = null;
    log.info('Claude Code token stored');
    return { success: true };
  }

  const error = state.error ?? 'הקוד לא התקבל. נסה להתחבר מחדש.';
  log.error({ tail: stripAnsi(state.output).slice(-500) }, 'setup-token completion failed');
  if (state.done) setupState = null;
  return { success: false, error };
}

// --- prompt execution ------------------------------------------------------

export interface ClaudeCodeCallbacks {
  onToolStart?: (toolName: string) => void;
  onThinking?: () => void;
}

function buildMcpConfig(projectId: string): string {
  return JSON.stringify({
    mcpServers: {
      connector: {
        type: 'stdio',
        command: 'node',
        args: ['--experimental-strip-types', join(process.cwd(), 'src/agent/connector-mcp.ts')],
        env: {
          DATA_DIR: config.dataDir,
          OPEN_CONNECTOR_URL: config.openConnectorUrl,
          OPEN_CONNECTOR_TOKEN: process.env['OPEN_CONNECTOR_TOKEN'] ?? '',
          CONNECTOR_ADMIN_TOKEN: process.env['CONNECTOR_ADMIN_TOKEN'] ?? '',
          PAIR_TOKEN: process.env['PAIR_TOKEN'] ?? '',
          DESK_PROJECT_ID: projectId,
        },
      },
    },
  });
}

function buildSystemPrompt(): string {
  const settings = loadSettings();
  return [
    `You are ${settings.botName || 'a personal WhatsApp assistant'} for ${settings.ownerName || 'the owner'}${settings.businessName ? ` (${settings.businessName})` : ''}.`,
    settings.businessDescription ? `Business: ${settings.businessDescription}` : '',
    `Timezone: ${settings.timezone || 'UTC'}.`,
    'You converse over WhatsApp: keep replies short, helpful, and in the user\'s language.',
    'Use the connector MCP tools (search_actions, get_action_guide, execute_action, list_connections) to work with the user\'s connected services.',
    'Mutating actions require the user to reply "yes" in WhatsApp — never claim you executed one without a successful tool result.',
    'You have no file or shell access; only the connector tools and conversation.',
  ].filter(Boolean).join('\n');
}

export async function runClaudeCodePrompt(
  projectId: string,
  text: string,
  callbacks: ClaudeCodeCallbacks = {}
): Promise<string | null> {
  if (!isClaudeCodeConnected()) {
    throw new Error('Claude Code אינו מחובר. התחבר דרך ההגדרות.');
  }

  const projectCwd = join(config.dataDir, 'projects', projectId);
  mkdirSync(projectCwd, { recursive: true });

  const settings = loadSettings();
  const modelSuffix = settings.model?.startsWith('claude-code/')
    ? settings.model.slice('claude-code/'.length)
    : '';

  const attempt = (resumeId?: string): Promise<{ text: string | null; sessionId?: string; errorMessage?: string; exitCode: number | null; stderr: string }> =>
    new Promise((resolve) => {
      const args = [
        '-p', text,
        '--output-format', 'stream-json',
        '--verbose',
        '--mcp-config', buildMcpConfig(projectId),
        '--strict-mcp-config',
        '--allowed-tools', 'mcp__connector__*',
        '--disallowed-tools', 'Bash,Edit,Write,NotebookEdit,Read,Glob,Grep,Task,WebFetch,WebSearch',
        '--append-system-prompt', buildSystemPrompt(),
      ];
      if (modelSuffix && modelSuffix !== 'default') args.push('--model', modelSuffix);
      if (resumeId) args.push('--resume', resumeId);

      const child = spawn(CLAUDE_BIN, args, {
        cwd: projectCwd,
        env: {
          ...process.env,
          CLAUDE_CODE_OAUTH_TOKEN: readToken(),
          CLAUDE_CONFIG_DIR: CONFIG_DIR,
          HOME: BASE_DIR,
        },
      });

      let resultText: string | null = null;
      let sessionId: string | undefined;
      let errorMessage: string | undefined;
      let stderr = '';
      let buffer = '';

      const timer = setTimeout(() => {
        errorMessage = errorMessage ?? 'Claude Code timed out';
        child.kill('SIGKILL');
      }, PROMPT_TIMEOUT_MS);

      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.stdout?.on('data', (d: Buffer) => {
        buffer += d.toString();
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line); } catch { continue; }

          if (event['session_id']) sessionId = String(event['session_id']);

          if (event['type'] === 'assistant') {
            const message = event['message'] as { content?: Array<{ type: string; name?: string }> } | undefined;
            for (const block of message?.content ?? []) {
              if (block.type === 'tool_use') callbacks.onToolStart?.(block.name ?? 'tool');
              if (block.type === 'text') callbacks.onThinking?.();
            }
          }

          if (event['type'] === 'result') {
            if (event['subtype'] === 'success') {
              resultText = typeof event['result'] === 'string' ? event['result'] : null;
            } else {
              errorMessage = String(event['result'] ?? event['subtype'] ?? 'unknown error');
            }
          }
        }
      });

      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({ text: resultText, sessionId, errorMessage, exitCode, stderr });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ text: null, errorMessage: err.message, exitCode: null, stderr });
      });
    });

  const previousSession = loadSessions()[projectId];
  let run = await attempt(previousSession);

  // A stale/invalid session must not kill the conversation — retry fresh once.
  if (!run.text && previousSession) {
    log.warn({ projectId, exitCode: run.exitCode, errorMessage: run.errorMessage }, 'Claude Code resume failed, retrying without session');
    clearClaudeCodeSession(projectId);
    run = await attempt(undefined);
  }

  if (run.sessionId) saveSession(projectId, run.sessionId);

  if (!run.text) {
    const detail = run.errorMessage ?? run.stderr.slice(0, 300) ?? 'unknown';
    log.error({ projectId, exitCode: run.exitCode, detail }, 'Claude Code produced no result');
    throw new Error(`המודל החזיר שגיאה: ${detail.slice(0, 300)}`);
  }

  return run.text;
}
