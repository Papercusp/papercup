/**
 * userpromptsubmit-memory.sh — turn-start memory delta at prompt submit
 * (memory-delivery-unification-2026-07-12 P-003a).
 *
 * Drives the shell hook exactly as Claude Code does — the UserPromptSubmit
 * JSON on stdin, an additionalContext JSON (or silence) on stdout — against a
 * HERMETIC local HTTP stub standing in for the operator
 * (PAPERCUSP_OPERATOR_URL), so the suite touches no real operator. Fail-open
 * everywhere: the hook must NEVER block a prompt (exit ≠ 0) whatever the
 * input or the operator's health.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'userpromptsubmit-memory.sh');
const SID = 'su-hook-test';
const LONG_PROMPT = 'please investigate the flaky epoch ledger integration on the papercusp harness';

let server: Server;
let baseUrl = '';
let lastBody: Record<string, unknown> | null = null;
let nextResponse: { status?: number; body?: unknown } = { body: { ok: true, text: '' } };

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', async () => {
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

// ASYNC spawn on purpose: the operator stub lives in THIS process, and a
// spawnSync would block the event loop — the stub could never answer and
// every server-hitting case would look like a hook-side timeout.
function runHook(
  input: unknown,
  env: Record<string, string | undefined> = {},
): Promise<{ stdout: string; status: number | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn('bash', [SCRIPT], {
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
    let stdout = '';
    child.stdout.on('data', (c) => {
      stdout += String(c);
    });
    child.on('close', (status) => resolvePromise({ stdout, status }));
    child.stdin.write(typeof input === 'string' ? input : JSON.stringify(input));
    child.stdin.end();
  });
}

function contextOf(out: { stdout: string }): string | null {
  const line = out.stdout.trim();
  if (!line) return null;
  const parsed = JSON.parse(line) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return parsed.hookSpecificOutput?.additionalContext ?? null;
}

describe('userpromptsubmit-memory.sh', () => {
  it('no PAPERCUSP_SID → silent no-op, exit 0', async () => {
    const out = await runHook({ prompt: LONG_PROMPT }, { PAPERCUSP_SID: undefined });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('kill switch PAPERCUSP_TURN_START_MEMORY=off → silent, exit 0', async () => {
    const out = await runHook({ prompt: LONG_PROMPT }, { PAPERCUSP_TURN_START_MEMORY: 'off' });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('low-signal prompt (short) → silent, no operator call', async () => {
    lastBody = null;
    const out = await runHook({ prompt: 'continue' });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
    expect(lastBody).toBeNull();
  });

  it('emits additionalContext with the endpoint text; POST carries owner/prompt/dims', async () => {
    nextResponse = { body: { ok: true, text: '## Relevant memory\n\n- [ref] fact' } };
    const out = await runHook({ prompt: LONG_PROMPT });
    expect(out.status).toBe(0);
    expect(contextOf(out)).toContain('## Relevant memory');
    expect(lastBody).toMatchObject({
      owner: SID,
      prompt: LONG_PROMPT,
      workspace: 'ws-test',
      harness: 'papercusp',
    });
  });

  it('empty text from the endpoint → silent', async () => {
    nextResponse = { body: { ok: true, text: '' } };
    const out = await runHook({ prompt: LONG_PROMPT });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('operator down (unreachable port) → fail-open silent, exit 0', async () => {
    const out = await runHook(
      { prompt: LONG_PROMPT },
      { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1' },
    );
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('malformed stdin JSON → fail-open silent, exit 0', async () => {
    const out = await runHook('not-json{');
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });
});
