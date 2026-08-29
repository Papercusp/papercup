/**
 * pretooluse-plans-read-guard.test.ts — P-003(b) of
 * kickoff-prompt-absorption-2026-07-17: a Read/Grep targeting a
 * docs/plans/*.md projection is denied with a `plans:get` teaching hint;
 * everything else (and any junk/missing-install input) is fail-open.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHookProcess } from './spawn-hook';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import { join } from 'node:path';

const HOOK = join(__dirname, '..', 'pretooluse-plans-read-guard.sh');
let home: string;

beforeAll(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'plans-guard-home-'));
  fs.mkdirSync(join(home, '.papercusp'), { recursive: true });
  fs.writeFileSync(join(home, '.papercusp', 'superuser-token'), 'test-token\n');
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

// HERMETICITY. The hook's identity check calls PAPERCUSP_OPERATOR_URL, and this
// suite inherited it: every agent session exports one, so the deny cases below
// passed or failed by WHICH operator happened to answer. A :3070 bearer rejection
// is inconclusive -> deny (green); a :9071 confirmed `not_found` is the ALLOW
// branch (red) — same code, opposite verdict, decided entirely outside the test.
// Pin it to a closed port so the lookup is deterministically inconclusive, which
// is the precondition every deny case here actually means to assert. The allow
// branch is no longer implicit: it gets an explicit stub below.
const UNREACHABLE_OPERATOR = 'http://127.0.0.1:1';

function run(input: object, operatorUrl: string = UNREACHABLE_OPERATOR) {
  return runHookProcess('bash', [HOOK], {
    input: JSON.stringify(input),
    env: { ...process.env, HOME: home, PAPERCUSP_OPERATOR_URL: operatorUrl, PAPERCUSP_HARNESS_SLUG: 'test-harness' },
  });
}

function denyReason(stdout: string): string | undefined {
  if (!stdout) return undefined;
  const parsed = JSON.parse(stdout);
  return parsed?.hookSpecificOutput?.permissionDecisionReason;
}

describe('pretooluse-plans-read-guard', () => {
  it('denies Read on a docs/plans/<slug>.md file, teaching plans:get', async () => {
    const r = await run({
      tool_name: 'Read',
      tool_input: { file_path: '/home/u/papercupai-workspace/papercusp/docs/plans/my-plan-2026-07-17.md' },
    });
    expect(r.status).toBe(0);
    const reason = denyReason(r.stdout);
    expect(reason).toBeDefined();
    expect(reason).toMatch(/plans:get/);
    expect(reason).toMatch(/projection/i);
  });

  it('denies Read on an archived plan file', async () => {
    const r = await run({
      tool_name: 'Read',
      tool_input: { file_path: 'docs/plans/archive/old-plan.md' },
    });
    expect(denyReason(r.stdout)).toMatch(/plans:get/);
  });

  it('allows Read on a non-plan markdown file', async () => {
    const r = await run({
      tool_name: 'Read',
      tool_input: { file_path: '/home/u/papercupai-workspace/papercusp/docs/design/overview.md' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('allows Read on a non-md file under docs/plans (e.g. a stray asset)', async () => {
    const r = await run({
      tool_name: 'Read',
      tool_input: { file_path: 'docs/plans/diagram.png' },
    });
    expect(r.stdout.trim()).toBe('');
  });

  it('denies Grep explicitly path-scoped to the docs/plans directory', async () => {
    const r = await run({
      tool_name: 'Grep',
      tool_input: { pattern: 'status', path: 'docs/plans' },
    });
    expect(denyReason(r.stdout)).toMatch(/plans:get/);
  });

  it('denies Grep explicitly path-scoped to one plan file', async () => {
    const r = await run({
      tool_name: 'Grep',
      tool_input: { pattern: 'status', path: 'docs/plans/my-plan.md' },
    });
    expect(denyReason(r.stdout)).toMatch(/plans:get/);
  });

  it('allows a repo-wide Grep with no path (never over-blocks a broad search)', async () => {
    const r = await run({ tool_name: 'Grep', tool_input: { pattern: 'TODO' } });
    expect(r.stdout.trim()).toBe('');
  });

  it('allows a Grep scoped to an unrelated directory', async () => {
    const r = await run({ tool_name: 'Grep', tool_input: { pattern: 'TODO', path: 'packages/operator-core' } });
    expect(r.stdout.trim()).toBe('');
  });

  it('allows an unrelated tool (Bash) untouched', async () => {
    const r = await run({ tool_name: 'Bash', tool_input: { command: 'cat docs/plans/my-plan.md' } });
    expect(r.stdout.trim()).toBe('');
  });

  it('fails open when Papercusp is not installed (no token file)', async () => {
    const bareHome = fs.mkdtempSync(join(os.tmpdir(), 'plans-guard-bare-'));
    try {
      const r = await runHookProcess('bash', [HOOK], {
        input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'docs/plans/x.md' } }),
        env: { ...process.env, HOME: bareHome },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    } finally {
      fs.rmSync(bareHome, { recursive: true, force: true });
    }
  });

  it('fails open on malformed JSON input', async () => {
    const r = await runHookProcess('bash', [HOOK], { input: 'not json', env: { ...process.env, HOME: home } });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });
});

// The live identity check decides deny-vs-allow for a path that ALREADY matched
// the plan-file pattern, so both of its verdicts have to be pinned explicitly.
// They were not: every case above reaches it only as "inconclusive", so the allow
// verdict was exercised solely by whichever operator the ambient
// PAPERCUSP_OPERATOR_URL pointed at — which is exactly how an environment-decided
// red hid here. A stub operator makes each verdict a stated input.
describe('pretooluse-plans-read-guard — live identity check (stubbed operator)', () => {
  const PLAN_READ = {
    tool_name: 'Read',
    tool_input: { file_path: '/home/u/papercupai-workspace/papercusp/docs/plans/my-plan-2026-07-17.md' },
  };

  async function withStubOperator(inner: unknown, fn: (url: string) => Promise<void>) {
    const envelope = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(inner) }] },
    });
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(envelope);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await fn(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('ALLOWS a plan-shaped path the operator confirms is not a plan', async () => {
    await withStubOperator({ results: [{ error: 'not_found' }] }, async (url) => {
      const r = await run(PLAN_READ, url);
      expect(r.status).toBe(0);
      // Confirmed not_found is the one verdict that widens the guard: a file that
      // merely LOOKS like a plan projection is a real doc, and reading it is fine.
      expect(r.stdout.trim()).toBe('');
    });
  });

  it('DENIES when the operator confirms the slug is a real plan', async () => {
    await withStubOperator({ results: [{ ok: true }] }, async (url) => {
      const r = await run(PLAN_READ, url);
      expect(r.status).toBe(0);
      expect(denyReason(r.stdout)).toMatch(/plans:get/);
    });
  });

  it('DENIES on an unrecognized response shape (inconclusive never widens the guard)', async () => {
    await withStubOperator({ results: [{ error: 'superuser_invalid_bearer' }] }, async (url) => {
      const r = await run(PLAN_READ, url);
      expect(denyReason(r.stdout)).toMatch(/plans:get/);
    });
  });
});
