/**
 * The three identity hook shims (portable-identity-packages-2026-09-26 P-011):
 * pretooluse-identity-guard.sh, stop-identity-context.sh and
 * sessionstart-identity-context.sh.
 *
 * Each is a thin exec shim for the shared dispatcher, so what is asserted here is
 * the shim's own contract, driven exactly as Claude Code drives it (event JSON on
 * stdin) against a hermetic local stub for the operator:
 *   - it reaches the RIGHT endpoint with the event it names;
 *   - its only output is the adapter's envelope (a deny, or context);
 *   - it exits 0 with NO output when the operator is down, never a refusal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHookProcess } from './spawn-hook';

const HERE = dirname(fileURLToPath(import.meta.url));
const shim = (name: string) => resolve(HERE, '..', name);

let server: Server;
let baseUrl = '';
let received: Array<{ url: string; body: Record<string, unknown> | null }> = [];
let responseText = '';

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        body = null;
      }
      received.push({ url: req.url ?? '', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, text: responseText }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  received = [];
  responseText = '';
});

function run(script: string, input: unknown, operatorUrl = baseUrl) {
  return runHookProcess('bash', [shim(script)], {
    input: JSON.stringify(input),
    env: Object.fromEntries(
      Object.entries({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PAPERCUSP_SID: 'su-identity-shim-test',
        PAPERCUSP_OPERATOR_URL: operatorUrl,
        PAPERCUSP_WORKSPACE: 'ws-test',
      }).filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
  });
}

describe('pretooluse-identity-guard.sh', () => {
  it('renders a refusal as a deny for the pending call', async () => {
    responseText = 'Refused by identity safe-coder rule no-rm: no recursive deletes';
    const out = await run('pretooluse-identity-guard.sh', {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' },
    });
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout.trim())).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: responseText,
      },
    });
    expect(received[0]!.url).toContain('/api/agent-mcp/tool-guard');
    expect(received[0]!.body).toMatchObject({ tool: 'Bash', input: { command: 'rm -rf /' } });
  });

  it('emits nothing for no verdict, and nothing when the operator is down', async () => {
    const quiet = await run('pretooluse-identity-guard.sh', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(quiet).toMatchObject({ status: 0, stdout: '' });
    const down = await run('pretooluse-identity-guard.sh', { tool_name: 'Bash', tool_input: {} }, 'http://127.0.0.1:9');
    expect(down).toMatchObject({ status: 0, stdout: '' });
  });
});

describe('stop-identity-context.sh', () => {
  it('delivers stop context, and never re-fires from a stop it already continued', async () => {
    responseText = 'STOP CONTEXT';
    const out = await run('stop-identity-context.sh', { hook_event_name: 'Stop', stop_hook_active: false });
    expect(JSON.parse(out.stdout.trim())).toEqual({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'STOP CONTEXT' } });
    expect(received[0]!.url).toContain('/api/agent-mcp/stop-context');

    received = [];
    const again = await run('stop-identity-context.sh', { hook_event_name: 'Stop', stop_hook_active: true });
    expect(again).toMatchObject({ status: 0, stdout: '' });
    expect(received).toHaveLength(0);
  });
});

describe('sessionstart-identity-context.sh', () => {
  it('re-seeds a compacted context, carrying the source to the server', async () => {
    responseText = 'RESEED';
    const out = await run('sessionstart-identity-context.sh', { hook_event_name: 'SessionStart', source: 'compact' });
    expect(JSON.parse(out.stdout.trim())).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'RESEED' } });
    expect(received[0]!.url).toContain('/api/agent-mcp/compaction-context');
    expect(received[0]!.body).toMatchObject({ source: 'compact' });
  });

  it('asks nothing on a resume', async () => {
    const out = await run('sessionstart-identity-context.sh', { hook_event_name: 'SessionStart', source: 'resume' });
    expect(out).toMatchObject({ status: 0, stdout: '' });
    expect(received).toHaveLength(0);
  });
});
