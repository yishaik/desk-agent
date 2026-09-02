#!/usr/bin/env node
// Stand-in for the `claude` CLI in tests (CLAUDE_CODE_BIN=scripts/fake-claude.mjs).
// Records argv + stdin to $FAKE_CLAUDE_LOG and prints a minimal stream-json turn.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  // The runner hands the child an explicit env (no inheritance, #31), so the log
  // lands under HOME — which the runner does set (data/claude-code).
  const logPath = process.env.FAKE_CLAUDE_LOG || (process.env.HOME ? join(process.env.HOME, 'fake-claude.log') : null);
  if (logPath) appendFileSync(logPath, JSON.stringify({ args, stdin }) + '\n');
  const sessionId = process.env.FAKE_CLAUDE_SESSION || 'fake-session-1';
  const reply = process.env.FAKE_CLAUDE_REPLY || `echo: ${stdin.trim()}`;
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, tools: [], mcp_servers: [] }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: reply }] } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: sessionId, result: reply }) + '\n');
  process.exit(0);
});
