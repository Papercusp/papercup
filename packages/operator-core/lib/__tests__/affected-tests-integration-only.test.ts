/**
 * affected-tests-integration-only.test.ts — EI-24955492938994792 regression guard.
 *
 * Schema/migration edits must run every workspace's integration suite. The only door used to be
 * `npm run test:all:integration` (`--all --integration`), which ALSO queued every unit lane
 * (~118 tasks), so it competed for gate-sized admission and was projected to starve.
 * `--integration-only` queues exactly the `test:integration` tasks.
 *
 * Asserts BEHAVIOR via the real CLI's `--print-affected` probe (exits before running a suite).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

function selectedCommands(args: string[]): string[] {
  const r = spawnSync('node', [AFFECTED_TESTS, ...args, '--print-affected'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
    killSignal: 'SIGKILL',
  });
  expect(r.status, `affected-tests ${args.join(' ')} --print-affected failed:\n${r.stderr}`).toBe(0);
  return (r.stdout ?? '')
    .split('\n')
    .filter((l) => l.startsWith('AFFECTED_WS_CMD\t'))
    .map((l) => l.slice('AFFECTED_WS_CMD\t'.length).trim());
}

describe('affected-tests --integration-only (EI-24955492938994792)', () => {
  it('queues exactly the test:integration tasks of the full --all --integration sweep, and nothing else', () => {
    const full = selectedCommands(['--all', '--integration']);
    const only = selectedCommands(['--all', '--integration-only']);

    const fullIntegration = full.filter((c) => /\btest:integration$/.test(c));
    // Positive control: the full sweep really contains unit tasks AND integration tasks, so
    // the narrowing below is measured against a population that could fail it.
    expect(fullIntegration.length).toBeGreaterThan(0);
    expect(full.length).toBeGreaterThan(fullIntegration.length);

    // No unit lane, no lint:el-tools: every selected command is an integration task.
    expect(only.filter((c) => !/\btest:integration$/.test(c))).toEqual([]);
    // And no integration task is dropped by the narrowing.
    expect([...only].sort()).toEqual([...fullIntegration].sort());
  });

  it('includes the db workspace, whose migrations motivate the schema verification door', () => {
    const only = selectedCommands(['--all', '--integration-only']);
    expect(only.some((c) => c.includes('libs/papercusp/libs/db') && c.endsWith('test:integration'))).toBe(true);
  });

  it('is wired as the root test:integration-only script', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts?.['test:integration-only']).toMatch(/scripts\/affected-tests\.mjs --all --integration-only$/);
  });
});
