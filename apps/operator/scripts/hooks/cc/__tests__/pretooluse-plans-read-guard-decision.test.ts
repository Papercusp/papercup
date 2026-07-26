/**
 * pretooluse-plans-read-guard-decision.test.ts — the plans-read-guard hook's
 * OPERATOR-DEPENDENT identity check (EI-18645886273852502, 2026-07-25).
 *
 * pretooluse-plans-read-guard.test.ts already covers the operator-INDEPENDENT
 * paths (path matching, fail-open contract — no token / malformed input /
 * unrelated tools never block a read). This suite closes the one path that
 * needs a live operator: docs/plans/**\/*.md is now an IDENTITY check, not a
 * pure path match — the hook does a live `plans:get { slug, harness }` before
 * denying a single-file match, and only a CONFIRMED `not_found` lets the
 * Read/Grep through. Uses the same in-process JSON-RPC stub pattern as
 * pretooluse-locks-decision.test.ts so the not_found → allow / ok:true → deny
 * / inconclusive → deny (fail-SAFE toward the old behavior) matrix is
 * regression-guarded without needing a live operator.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runHookProcess } from './spawn-hook';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

const HOOK = join(__dirname, '..', 'pretooluse-plans-read-guard.sh');

let home: string;
let server: Server;
let port: number;
/** The inner plans:get tool result the stub returns next. */
let nextInner: unknown = { ok: true, results: [{ ok: false, slug: 'x', error: 'not_found' }], counts: { ok: 0, failed: 1 } };
/** HTTP status the stub answers with (500 simulates an operator-side failure). */
let nextStatus = 200;
let lastRequest: { url: string; body: Record<string, any> } | null = null;

beforeAll(async () => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'plans-guard-dec-home-'));
  fs.mkdirSync(join(home, '.papercusp'), { recursive: true });
  fs.writeFileSync(join(home, '.papercusp', 'superuser-token'), 'test-token\n');

  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      lastRequest = { url: req.url ?? '', body: body ? JSON.parse(body) : {} };
      if (nextStatus !== 200) {
        res.writeHead(nextStatus, { 'content-type': 'application/json' });
        res.end('{"error":"boom"}');
        return;
      }
      const rpc = {
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: JSON.stringify(nextInner) }] },
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rpc));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
  nextInner = { ok: true, results: [{ ok: false, slug: 'x', error: 'not_found' }], counts: { ok: 0, failed: 1 } };
  nextStatus = 200;
  lastRequest = null;
});

function notFoundResult(slug: string) {
  return { ok: true, results: [{ ok: false, slug, error: 'not_found' }], counts: { ok: 0, failed: 1 } };
}
function foundResult(slug: string) {
  return { ok: true, results: [{ ok: true, slug, harness: 'papercusp', frontmatter: { title: 't' } }], counts: { ok: 1, failed: 0 } };
}

async function run(input: object, extraEnv: Record<string, string> = {}) {
  const { status, stdout } = await runHookProcess('bash', [HOOK], {
    input: JSON.stringify(input),
    env: {
      ...process.env,
      HOME: home,
      PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${port}`,
      PAPERCUSP_HARNESS_SLUG: 'papercusp',
      ...extraEnv,
    },
  });
  return { status, stdout: stdout.trim() };
}

function denyReason(stdout: string): string | undefined {
  if (!stdout) return undefined;
  return JSON.parse(stdout)?.hookSpecificOutput?.permissionDecisionReason;
}

describe('pretooluse-plans-read-guard — live identity check', () => {
  it('allows Read on a docs/plans/*.md file the operator confirms is NOT a plan (e.g. a handoff BRIEF)', async () => {
    nextInner = notFoundResult('BRIEF-handoff-2026-07-25');
    const r = await run({
      tool_name: 'Read',
      tool_input: { file_path: 'apps/operator/docs/plans/BRIEF-handoff-2026-07-25.md' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(lastRequest?.body?.params?.arguments).toMatchObject({
      slug: 'BRIEF-handoff-2026-07-25',
      harness: 'papercusp',
    });
  });

  it('denies Read on a docs/plans/*.md file the operator confirms IS a real plan', async () => {
    nextInner = foundResult('my-plan-2026-07-17');
    const r = await run({
      tool_name: 'Read',
      tool_input: { file_path: 'docs/plans/my-plan-2026-07-17.md' },
    });
    expect(denyReason(r.stdout)).toMatch(/plans:get/);
  });

  it('falls back to deny when the operator is unreachable (inconclusive, fail-SAFE toward the old behavior)', async () => {
    const r = await run(
      { tool_name: 'Read', tool_input: { file_path: 'docs/plans/BRIEF-unreachable.md' } },
      { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1' },
    );
    expect(denyReason(r.stdout)).toMatch(/plans:get/);
  });

  it('falls back to deny when the operator 500s (inconclusive)', async () => {
    nextStatus = 500;
    const r = await run({ tool_name: 'Read', tool_input: { file_path: 'docs/plans/BRIEF-server-error.md' } });
    expect(denyReason(r.stdout)).toMatch(/plans:get/);
  });

  it('falls back to deny when the harness is unknown (never calls the operator)', async () => {
    const r = await run(
      { tool_name: 'Read', tool_input: { file_path: 'docs/plans/BRIEF-no-harness.md' } },
      { PAPERCUSP_HARNESS_SLUG: '' },
    );
    expect(denyReason(r.stdout)).toMatch(/plans:get/);
    expect(lastRequest).toBeNull();
  });

  it('allows Grep single-file-scoped to a docs/plans/*.md file confirmed NOT a plan', async () => {
    nextInner = notFoundResult('HANDOFF-coordination');
    const r = await run({
      tool_name: 'Grep',
      tool_input: { pattern: 'status', path: 'docs/plans/HANDOFF-coordination.md' },
    });
    expect(r.stdout).toBe('');
  });

  it('denies Grep single-file-scoped to a docs/plans/*.md file confirmed to BE a plan', async () => {
    nextInner = foundResult('my-plan');
    const r = await run({
      tool_name: 'Grep',
      tool_input: { pattern: 'status', path: 'docs/plans/my-plan.md' },
    });
    expect(denyReason(r.stdout)).toMatch(/plans:get/);
  });

  it('keeps the directory-scoped Grep deny unconditional — no identity call is made (no single slug)', async () => {
    nextInner = notFoundResult('irrelevant'); // even if the stub WOULD say not_found, no slug exists to ask about
    const r = await run({ tool_name: 'Grep', tool_input: { pattern: 'status', path: 'docs/plans' } });
    expect(denyReason(r.stdout)).toMatch(/plans:get/);
    expect(lastRequest).toBeNull();
  });

  it('allows an archived-plan-shaped Read confirmed NOT a plan', async () => {
    nextInner = notFoundResult('old-draft');
    const r = await run({ tool_name: 'Read', tool_input: { file_path: 'docs/plans/archive/old-draft.md' } });
    expect(r.stdout).toBe('');
  });
});
