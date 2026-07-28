/**
 * pretooluse-midturn-context.sh — mid-turn context push at tool dispatch
 * (context-injection-audit-2026-07-28 P-015, decision D-026).
 *
 * Drives the shell hook exactly as Claude Code does — the PreToolUse JSON on
 * stdin, an additionalContext JSON (or silence) on stdout — against a HERMETIC
 * local HTTP stub standing in for the operator (PAPERCUSP_OPERATOR_URL), so the
 * suite touches no real operator.
 *
 * TWO invariants here are worth more than the rest put together:
 *
 *  1. FAIL-OPEN. This hook sits in front of EVERY investigation-shaped tool call
 *     in every psu session. If it can ever exit non-zero or hang, it does not
 *     degrade recall — it breaks the agent's ability to run tools at all. Every
 *     hostile input below must still exit 0.
 *  2. IT GRANTS NO PERMISSION. The output must carry additionalContext and NO
 *     `permissionDecision`. Emitting `permissionDecision: 'allow'` is how a
 *     context hook silently becomes a blanket auto-approver for Bash/Grep/Read,
 *     bypassing the permission system — a real hazard, since the one existing
 *     PreToolUse additionalContext emitter in this tree (the bash resource gate)
 *     legitimately does emit `allow` and is the obvious thing to copy from.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHookProcess } from './spawn-hook';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pretooluse-midturn-context.sh');
const SID = 'su-midturn-test';
const GREP_CALL = { tool_name: 'Grep', tool_input: { pattern: 'WI-6512', path: 'packages' } };

let server: Server;
let baseUrl = '';
let lastBody: Record<string, unknown> | null = null;
let nextResponse: { status?: number; body?: unknown } = { body: { ok: true, text: '' } };

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      try {
        lastBody = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        lastBody = null;
      }
      res.writeHead(nextResponse.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(nextResponse.body ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

// Async spawn + EPIPE-tolerant stdin: see ./spawn-hook.ts, which owns both invariants.
function runHook(
  input: unknown,
  env: Record<string, string | undefined> = {},
): Promise<{ stdout: string; status: number | null }> {
  return runHookProcess('bash', [SCRIPT], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: Object.fromEntries(
      Object.entries({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PAPERCUSP_SID: SID,
        PAPERCUSP_OPERATOR_URL: baseUrl,
        PAPERCUSP_WORKSPACE: 'ws-test',
        PAPERCUSP_HARNESS_SLUG: 'papercusp',
        // Never inherit real proxy env into the hermetic call.
        http_proxy: undefined,
        https_proxy: undefined,
        ...env,
      }).filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
  });
}

function outputOf(out: { stdout: string }): Record<string, unknown> | null {
  const line = out.stdout.trim();
  if (!line) return null;
  return (JSON.parse(line) as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput ?? null;
}

describe('pretooluse-midturn-context.sh', () => {
  it('emits additionalContext and NEVER a permissionDecision — it must not auto-approve the call', async () => {
    nextResponse = { body: { ok: true, text: 'WI-6512 is already documented in three docstrings' } };
    const out = await runHook(GREP_CALL);

    const hookOutput = outputOf(out);
    expect(hookOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      additionalContext: 'WI-6512 is already documented in three docstrings',
    });
    // The load-bearing negative: no permission vote, in any form.
    expect(hookOutput).not.toHaveProperty('permissionDecision');
    expect(hookOutput).not.toHaveProperty('permissionDecisionReason');
    expect(out.stdout).not.toContain('allow');
  });

  it('POSTs the tool name and RAW tool input — query derivation is the server\'s job', async () => {
    // The hook stays a dumb transport: it must not try to build the query
    // itself, or the derivation stops being fixable without reinstalling this
    // script on every box in the fleet.
    lastBody = null;
    nextResponse = { body: { ok: true, text: 'x' } };
    await runHook(GREP_CALL);
    expect(lastBody).toMatchObject({
      owner: SID,
      tool: 'Grep',
      toolInput: { pattern: 'WI-6512', path: 'packages' },
      workspace: 'ws-test',
      harness: 'papercusp',
    });
  });

  it('no PAPERCUSP_SID → silent no-op, exit 0 (psu sessions only)', async () => {
    const out = await runHook(GREP_CALL, { PAPERCUSP_SID: undefined });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('kill switch disables it entirely without touching the operator', async () => {
    lastBody = null;
    const out = await runHook(GREP_CALL, { PAPERCUSP_MID_TURN_CONTEXT: 'off' });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
    expect(lastBody).toBeNull();
  });

  it('empty text from the endpoint → silent (the common case: epoch dedup said nothing new)', async () => {
    nextResponse = { body: { ok: true, text: '' } };
    const out = await runHook(GREP_CALL);
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('operator down (unreachable port) → fail-open silent, exit 0', async () => {
    const out = await runHook(GREP_CALL, { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1' });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('operator 500 → fail-open silent, exit 0', async () => {
    nextResponse = { status: 500, body: { error: 'boom' } };
    const out = await runHook(GREP_CALL);
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('malformed stdin JSON → fail-open silent, exit 0', async () => {
    const out = await runHook('not-json{');
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('a PreToolUse payload with no tool_name → fail-open silent, exit 0', async () => {
    nextResponse = { body: { ok: true, text: 'should not be reached' } };
    const out = await runHook({ tool_input: { pattern: 'x' } });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });
});
