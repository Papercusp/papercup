/**
 * pretooluse-plans-read-guard.test.ts — P-003(b) of
 * kickoff-prompt-absorption-2026-07-17: a Read/Grep targeting a
 * docs/plans/*.md projection is denied with a `plans:get` teaching hint;
 * everything else (and any junk/missing-install input) is fail-open.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHookProcess } from './spawn-hook';
import * as fs from 'node:fs';
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

function run(input: object) {
  return runHookProcess('bash', [HOOK], { input: JSON.stringify(input), env: { ...process.env, HOME: home } });
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
