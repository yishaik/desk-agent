/**
 * Claude Code engine — runs the unmodified `claude` binary in headless print
 * mode with the customer's own subscription login.
 *
 * Why: Anthropic bills third-party OAuth (the Pi runtime path) from extra
 * usage per token. The one compliant way to use a customer's Pro/Max plan
 * limits is the end user signing in to the unmodified Claude Code binary
 * (see code.claude.com/docs/en/legal-and-compliance). Auth drives Claude
 * Code's own interactive login; the credential belongs to the customer and
 * lives only inside their stack, managed by the binary itself.
 *
 * Open Connector tools are provided to Claude Code via a stdio MCP server
 * (connector-mcp.ts) that shares the file-backed confirmation store with the
 * WhatsApp handler.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/config.ts';
import { createChildLogger } from '../core/logger.ts';
import { loadSettings } from '../core/settings.ts';
import { buildIdentityPrompt } from '../core/identity-files.ts';
import { renderSkillsPrompt } from '../core/skills.ts';

const log = createChildLogger('claude-code');

const BASE_DIR = join(config.dataDir, 'claude-code');
const TOKEN_PATH = join(BASE_DIR, 'token'); // legacy setup-token artifact, no longer used
const SESSIONS_PATH = join(BASE_DIR, 'sessions.json');
const CONFIG_DIR = join(BASE_DIR, 'config');
const CREDENTIALS_PATH = join(CONFIG_DIR, '.credentials.json');
const MCP_CONFIG_PATH = join(BASE_DIR, 'mcp.json');

/**
 * Build a minimal, safe environment for Claude Code child processes.
 * Does NOT inherit process.env to avoid leaking secrets like ANTHROPIC_API_KEY,
 * MODEL_API_KEY, PAIR_TOKEN, etc.
 */
function buildClaudeCodeEnv(): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: BASE_DIR,
    CLAUDE_CONFIG_DIR: CONFIG_DIR,
    TERM: 'xterm',
    LANG: process.env['LANG'] ?? 'en_US.UTF-8',
    DISABLE_AUTOUPDATER: '1',
    COLUMNS: '500',
  };
}

/**
 * List of error patterns that indicate a stale/invalid session.
 * Only these errors should trigger session clear + retry.
 */
const SESSION_INVALID_PATTERNS = [
  /no conversation found/i,
  /session not found/i,
  /invalid session/i,
  /session.*expired/i,
  /could not find session/i,
];

const PROMPT_TIMEOUT_MS = 240_000;
const CLAUDE_BIN = process.env['CLAUDE_CODE_BIN'] || 'claude';

function ensureDirs(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

export function isClaudeCodeConnected(): boolean {
  return existsSync(CREDENTIALS_PATH);
}

export function disconnectClaudeCode(): void {
  rmSync(CREDENTIALS_PATH, { force: true });
  rmSync(TOKEN_PATH, { force: true });
  rmSync(SESSIONS_PATH, { force: true });
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

// --- interactive login flow ------------------------------------------------
// setup-token's sk-ant-oat01 tokens are rejected by the API (Feb 2026 change),
// so we drive Claude Code's own interactive first-run login under a pseudo-TTY
// instead. The binary stores access+refresh credentials itself
// (.credentials.json) — exactly the auth path an ordinary Claude Code user
// gets, drawing on the customer's Pro/Max plan limits.

interface SetupState {
  child: ChildProcess;
  output: string;
  authorizeUrl?: string;
  done: boolean;
  error?: string;
  handled: Set<string>;
}

let setupState: SetupState | null = null;

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

// One-shot answers to the first-run TUI prompts, whichever of them appear.
// Tested with @anthropic-ai/claude-code@2.1.258 — bump Dockerfile
// CLAUDE_CODE_VERSION after verifying new TUI strings still match.
function driveOnboarding(state: SetupState): void {
  const out = state.output;
  const press = (key: string, tag: string) => {
    if (state.handled.has(tag)) return;
    state.handled.add(tag);
    state.child.stdin?.write(key);
    log.debug({ tag }, 'Answered onboarding prompt');
  };

  if (/text style|theme|looks best/i.test(out)) press('\r', 'theme');
  // Option 1 is "Claude account with subscription" — the default selection.
  if (/log ?in method|subscription|Console account/i.test(out)) press('\r', 'method');
  if (/security notes|press enter to continue/i.test(out) && state.handled.has('method')) press('\r', 'continue');
  if (/trust the files|do you trust/i.test(out)) press('\r', 'trust');
}

export async function startClaudeCodeLogin(): Promise<{ authorizeUrl?: string; error?: string }> {
  if (setupState && !setupState.done && setupState.authorizeUrl) {
    return { authorizeUrl: setupState.authorizeUrl };
  }
  if (setupState && !setupState.done) {
    setupState.child.kill('SIGKILL');
  }

  ensureDirs();
  // A fresh login must not reuse half-written credentials.
  rmSync(CREDENTIALS_PATH, { force: true });

  const child = spawn('script', ['-qec', `stty cols 500 2>/dev/null; ${CLAUDE_BIN}`, '/dev/null'], {
    env: buildClaudeCodeEnv(),
    cwd: BASE_DIR,
  });

  const state: SetupState = { child, output: '', done: false, handled: new Set() };
  setupState = state;

  const onData = (d: Buffer) => {
    state.output += stripAnsi(d.toString());
    driveOnboarding(state);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('exit', (code) => {
    state.done = true;
    if (!isClaudeCodeConnected()) {
      state.error = `claude exited with code ${code} before login completed`;
    }
  });

  const start = Date.now();
  while (Date.now() - start < 45_000) {
    const match = state.output.match(/https:\/\/[^\s"']*oauth[^\s"']*/);
    if (match) {
      state.authorizeUrl = match[0];
      log.info('Claude Code login authorize URL ready');
      return { authorizeUrl: state.authorizeUrl };
    }
    if (state.done) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  child.kill('SIGKILL');
  setupState = null;
  log.error({ tail: state.output.slice(-800) }, 'claude login produced no authorize URL');
  return { error: 'לא התקבל קישור התחברות מ-Claude Code. נסה שוב.' };
}

export async function completeClaudeCodeLogin(code: string): Promise<{ success: boolean; error?: string }> {
  const state = setupState;
  if (!state || state.done) {
    return { success: false, error: 'לא נמצאה התחברות פעילה. התחל מחדש.' };
  }

  // Raw-mode TUI: paste the code, then Enter as '\r' after a short gap.
  state.child.stdin?.write(code.trim());
  await new Promise((r) => setTimeout(r, 400));
  state.child.stdin?.write('\r');

  const start = Date.now();
  while (Date.now() - start < 45_000 && !state.done) {
    if (isClaudeCodeConnected() || /login successful|logged in/i.test(state.output)) {
      // Dismiss any "press enter" confirmation, let credentials flush, then
      // shut the interactive session down.
      state.child.stdin?.write('\r');
      await new Promise((r) => setTimeout(r, 1500));
      state.child.kill('SIGKILL');
      setupState = null;
      if (isClaudeCodeConnected()) {
        log.info('Claude Code credentials stored');
        return { success: true };
      }
      break;
    }
    if (/invalid|expired/i.test(state.output.slice(-300))) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const error = state.error ?? 'הקוד לא התקבל. נסה להתחבר מחדש.';
  log.error({ tail: stripAnsi(state.output).slice(-800) }, 'claude login completion failed');
  state.child.kill('SIGKILL');
  setupState = null;
  return { success: false, error };
}


// --- prompt execution ------------------------------------------------------

export interface ClaudeCodeCallbacks {
  onToolStart?: (toolName: string) => void;
  onThinking?: () => void;
}

/**
 * Build MCP config and write to a secure file.
 * The MCP server only needs DATA_DIR, OPEN_CONNECTOR_URL, OPEN_CONNECTOR_TOKEN,
 * and DESK_PROJECT_ID. PAIR_TOKEN and CONNECTOR_ADMIN_TOKEN are NOT passed
 * (they're not needed by the MCP server).
 * 
 * Returns the path to the config file.
 */
function buildMcpConfig(projectId: string): string {
  const mcpConfig = {
    mcpServers: {
      connector: {
        type: 'stdio',
        command: 'node',
        args: ['--experimental-strip-types', join(process.cwd(), 'src/agent/connector-mcp.ts')],
        env: {
          DATA_DIR: config.dataDir,
          OPEN_CONNECTOR_URL: config.openConnectorUrl,
          OPEN_CONNECTOR_TOKEN: process.env['OPEN_CONNECTOR_TOKEN'] ?? '',
          DESK_PROJECT_ID: projectId,
          DESK_MCP_SERVER: '1',
        },
      },
    },
  };
  
  ensureDirs();
  writeFileSync(MCP_CONFIG_PATH, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
  chmodSync(MCP_CONFIG_PATH, 0o600);
  return MCP_CONFIG_PATH;
}

function buildSystemPrompt(): string {
  const settings = loadSettings();
  const identityPrompt = buildIdentityPrompt(settings);
  
  return [
    identityPrompt,
    '',
    '## WhatsApp Context',
    'You converse over WhatsApp: keep replies short, helpful, and in the user\'s language.',
    '',
    '## Open Connector Tools',
    'Use the connector MCP tools (search_actions, get_action_guide, execute_action, list_connections) to work with the user\'s connected services.',
    'Mutating actions (send, reply, create, update, delete, ...) are never executed by execute_action directly: the tool records a pending request and the user approves it by replying "yes" in WhatsApp, outside your control. You cannot approve on the user\'s behalf and must not call the tool again for the same action.',
    'Never claim an action was executed unless a tool result or a system note in the conversation says it ran.',
    'You have no file or shell access; only the connector tools and conversation.',
    '',
    renderSkillsPrompt(settings.skillPacks),
  ].join('\n').trimEnd();
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
      const mcpConfigPath = buildMcpConfig(projectId);
      const args = [
        '-p', '-',
        '--output-format', 'stream-json',
        '--verbose',
        '--mcp-config', mcpConfigPath,
        '--strict-mcp-config',
        '--allowed-tools', 'mcp__connector__*',
        '--disallowed-tools', 'Bash,Edit,Write,NotebookEdit,Read,Glob,Grep,Task,WebFetch,WebSearch',
        '--append-system-prompt', buildSystemPrompt(),
      ];
      if (modelSuffix && modelSuffix !== 'default') args.push('--model', modelSuffix);
      if (resumeId) args.push('--resume', resumeId);

      const child = spawn(CLAUDE_BIN, args, {
        cwd: projectCwd,
        env: buildClaudeCodeEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdin?.write(text);
      child.stdin?.end();

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

  // Only clear session and retry if the error indicates an invalid/stale session.
  // Transient failures (rate limits, network errors, etc.) must NOT wipe conversation history.
  if (!run.text && previousSession) {
    const errorText = `${run.errorMessage ?? ''} ${run.stderr}`;
    const isSessionInvalid = SESSION_INVALID_PATTERNS.some((p) => p.test(errorText));
    
    if (isSessionInvalid) {
      log.warn({ projectId, exitCode: run.exitCode, errorMessage: run.errorMessage }, 'Claude Code session invalid, retrying without session');
      clearClaudeCodeSession(projectId);
      run = await attempt(undefined);
    } else {
      log.warn({ projectId, exitCode: run.exitCode, errorMessage: run.errorMessage }, 'Claude Code failed (transient), keeping session intact');
    }
  }

  if (run.sessionId) saveSession(projectId, run.sessionId);

  if (!run.text) {
    const detail = run.errorMessage ?? run.stderr.slice(0, 300) ?? 'unknown';
    log.error({ projectId, exitCode: run.exitCode, detail }, 'Claude Code produced no result');
    throw new Error(`המודל החזיר שגיאה: ${detail.slice(0, 300)}`);
  }

  return run.text;
}
