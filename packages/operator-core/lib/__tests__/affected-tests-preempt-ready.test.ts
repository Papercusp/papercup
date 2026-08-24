/**
 * Regression guards for the once-only `test:affected` after-ready barrier
 * (EI-21361599312981776).
 *
 * The wrapper must remain preemptible while affected-tests is still deriving or
 * previewing work, then protect the run only after its task plan is final and
 * immediately before the first task shard starts. These tests exercise the
 * cheap early exits and pin the expensive execution boundary structurally.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');
const PACKAGE_JSON = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
const source = readFileSync(AFFECTED_TESTS, 'utf8');

function runAffected(args: string[], marker: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [AFFECTED_TESTS, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      AFFECTED_RETRY_FAILED: '0',
      PC_HEAVY_PREEMPT_READY_FILE: marker,
    },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

describe('affected-tests after-ready publication boundary (EI-21361599312981776)', () => {
  it.each([
    ['dry preview', ['--changed-paths', 'scripts/affected-tests.mjs', '--dry'], 0],
    ['print-affected enumeration', ['--changed-paths', 'scripts/affected-tests.mjs', '--print-affected'], 0],
    ['unknown-flag refusal', ['--changed-paths', 'scripts/affected-tests.mjs', '--dry-rnu'], 1],
  ])('does not publish the execution marker on the %s early exit', (_name, args, expectedStatus) => {
    const dir = mkdtempSync(join(tmpdir(), 'affected-ready-early-'));
    const marker = join(dir, 'ready-marker');
    try {
      const result = runAffected(args, marker);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(expectedStatus);
      expect(existsSync(marker), `an early exit must not publish ${marker}`).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publishes exactly after all early exits and immediately before the first task shard', () => {
    const publication = source.indexOf('publishPreemptReadyMarker();');
    const emptyTasks = source.indexOf('if (!tasks.length)');
    const dryExit = source.indexOf('if (dry) {');
    const initialPool = source.indexOf('const initialPool = await runBudgetedTaskShards');

    expect(publication).toBeGreaterThan(emptyTasks);
    expect(publication).toBeGreaterThan(dryExit);
    expect(initialPool).toBeGreaterThan(publication);
    expect(source.slice(publication, initialPool)).toBe('publishPreemptReadyMarker();\n');
  });

  it('cleans a published marker from the process-exit path', () => {
    const exitHandler = source.indexOf('process.on("exit", (code) => {');
    const cleanup = source.indexOf('cleanupPreemptReadyMarker();', exitHandler);
    const abort = source.indexOf('emitAbortMarker(', exitHandler);

    expect(exitHandler).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(exitHandler);
    expect(abort).toBeGreaterThan(cleanup);
    expect(source).toContain('flag: "wx"');
  });
});

describe('once-only package wiring', () => {
  it('opts test:affected and its integration variant into the after-ready barrier', () => {
    expect(PACKAGE_JSON.scripts?.['test:affected']).toContain(
      'PC_HEAVY_PREEMPT_AFTER_READY=1',
    );
    expect(PACKAGE_JSON.scripts?.['test:affected:integration']).toContain(
      'PC_HEAVY_PREEMPT_AFTER_READY=1',
    );
  });

  it('does not silently widen the barrier to related or all-workspace sweeps', () => {
    for (const name of ['test:related', 'test:all', 'test:all:integration']) {
      expect(PACKAGE_JSON.scripts?.[name]).not.toContain('PC_HEAVY_PREEMPT_AFTER_READY=1');
    }
  });
});
