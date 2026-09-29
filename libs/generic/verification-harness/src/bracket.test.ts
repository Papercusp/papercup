import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_KEEP_RUNS, keepRunsFromEnv, pruneRuns } from './runner.js';

/**
 * vh.sh BRACKET MODE: a long linear `set -e` script marks section boundaries (vh_begin) instead
 * of wrapping sections in functions, so its own abort semantics are untouched and an abort still
 * yields a structured result naming the phase and step it died in.
 */
const vh = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../bin/vh.sh');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'vh-bracket-'));

function run(body: string, env: Record<string, string> = {}, args: string[] = []) {
  const root = tmp();
  const file = path.join(root, 'h.sh');
  writeFileSync(file, `set -euo pipefail\nsource ${JSON.stringify(vh)}\n${body.replaceAll('$ROOT', root)}`);
  const r = spawnSync('bash', [file, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  const result = existsSync(path.join(root, 'ev', 'latest', 'result.json'))
    ? JSON.parse(readFileSync(path.join(root, 'ev', 'latest', 'result.json'), 'utf8'))
    : null;
  const rows = result
    ? (result.phases as { phase: string; status: string; step: string | null; reasonCode: string | null }[]).map((p) => [
        p.phase,
        p.status,
        p.step,
        p.reasonCode,
      ])
    : null;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, result, rows, root };
}

const chain = `
vh_phase prep ""
vh_phase build prep
vh_phase ship build
vh_init linear "$ROOT/ev"
vh_bracket_trap
`;

describe('vh.sh bracket mode', () => {
  it('an abort under set -e fails the open phase at its last step and blocks the rest; the exit code is kept', () => {
    const r = run(`${chain}
vh_begin prep
vh_step fetch
vh_begin build
vh_step compile
false
vh_begin ship
`);
    expect(r.code).toBe(1);
    expect(r.rows).toEqual([
      ['prep', 'passed', 'fetch', null],
      ['build', 'failed', 'compile', 'exit-1'],
      ['ship', 'blocked', null, 'aborted:build:exit-1'],
    ]);
    expect(r.stdout).toMatch(/HARNESS_RESULT harness=linear verdict=fail .*first_failure=build\/compile\/exit-1 passed=1 failed=1 blocked=1/);
  });

  it('chains in front of an EXIT trap the script already had, which still runs with the real status', () => {
    const r = run(`
trap 'echo "own-trap rc=$?" > "$ROOT/own-trap"' EXIT
${chain}
vh_begin prep
vh_begin build
vh_begin ship
exit 0
`);
    expect(r.code).toBe(0);
    expect(r.result.verdict).toBe('pass');
    expect(readFileSync(path.join(r.root, 'own-trap'), 'utf8')).toBe('own-trap rc=0\n');
  });

  it('vh_fail names the reason and an explicit exit code survives', () => {
    const r = run(`${chain}
vh_begin prep
vh_step probe
vh_fail rig-unreachable "ssh timed out"
exit 7
`);
    expect(r.code).toBe(7);
    expect(r.rows?.[0]).toEqual(['prep', 'failed', 'probe', 'rig-unreachable']);
    expect(r.rows?.[1]).toEqual(['build', 'blocked', null, 'aborted:prep:exit-7']);
  });

  it('a deliberate early exit 0 declares the rest skipped; an undeclared one is a failure', () => {
    const declared = run(`${chain}
vh_begin prep
vh_skip_rest precheck-only
exit 0
`);
    expect(declared.result.verdict).toBe('pass');
    expect(declared.rows?.slice(1)).toEqual([
      ['build', 'skipped', null, 'precheck-only'],
      ['ship', 'skipped', null, 'precheck-only'],
    ]);
    const silent = run(`${chain}
vh_begin prep
exit 0
`);
    expect(silent.result.verdict).toBe('fail');
    expect(silent.rows?.[1]).toEqual(['build', 'failed', null, 'not-reported']);
  });

  it('a script with its own EXIT handler finalizes by calling vh_exit from it', () => {
    const r = run(`
vh_phase prep ""
vh_phase build prep
vh_init own-handler "$ROOT/ev"
teardown() { local rc=$?; vh_exit "$rc"; echo "teardown rc=$rc" > "$ROOT/td"; }
trap teardown EXIT
vh_begin prep
vh_begin build
exit 3
`);
    expect(r.code).toBe(3);
    expect(r.rows).toEqual([
      ['prep', 'passed', null, null],
      ['build', 'failed', null, 'exit-3'],
    ]);
    expect(readFileSync(path.join(r.root, 'td'), 'utf8')).toBe('teardown rc=3\n');
  });

  it('VH_LOG_FD=2 keeps the harness stdout free of contract lines', () => {
    const r = run(`${chain}
vh_begin prep
echo payload
vh_begin build
vh_begin ship
`, { VH_LOG_FD: '2' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('payload\n');
    expect(r.stderr).toMatch(/VH_BEGIN phase=prep/);
    expect(r.stderr).toMatch(/HARNESS_RESULT harness=linear verdict=pass/);
  });

  it('VH_FAIL_OPEN: a contract that cannot start disables itself loudly and the harness still runs', () => {
    const r = run(`
vh_phase prep ""
vh_init linear /proc/definitely-not-writable/ev
vh_bracket_trap
vh_begin prep
echo ran
exit 4
`, { VH_FAIL_OPEN: '1' });
    expect(r.code).toBe(4);
    expect(r.stdout).toBe('ran\n');
    expect(r.stderr).toMatch(/VH_DISABLED harness=linear reason=evidence-root-unwritable/);
  });

  it('without VH_FAIL_OPEN a contract that cannot start is fatal', () => {
    const r = run(`
vh_phase prep ""
vh_init linear /proc/definitely-not-writable/ev
echo unreachable
`);
    expect(r.code).toBe(2);
    expect(r.stdout).not.toMatch(/unreachable/);
  });

  it('VH_DISABLE keeps vh_run harnesses honest: a failing phase still fails vh_finish', () => {
    const r = run(`
vh_phase a ""
vh_phase b ""
vh_init disabled "$ROOT/ev"
vh_run a true
vh_run b false
vh_finish
`, { VH_DISABLE: '1' });
    expect(r.code).toBe(1);
    expect(r.result).toBeNull();
  });
});

describe('pruneRuns (evidence retention)', () => {
  const mkRun = (root: string, name: string, finished = true) => {
    mkdirSync(path.join(root, name), { recursive: true });
    if (finished) writeFileSync(path.join(root, name, 'result.json'), '{}');
  };

  it('keeps the newest runs, never the one latest points at, never one still in progress', async () => {
    const root = tmp();
    const names = ['20260101T000000Z-1', '20260102T000000Z-2', '20260103T000000Z-3', '20260104T000000Z-4', '20260105T000000Z-5'];
    for (const n of names) mkRun(root, n);
    mkRun(root, '20250101T000000Z-9', false); // unfinished and fresh: in progress
    mkRun(root, '20250101T000000Z-8', false); // unfinished and old: crashed
    const old = new Date('2025-01-01T00:00:00Z');
    utimesSync(path.join(root, '20250101T000000Z-8'), old, old);
    mkdirSync(path.join(root, 'not-a-run'));
    symlinkSync('20260101T000000Z-1', path.join(root, 'latest'));

    const removed = await pruneRuns(root, 2);
    expect(removed.sort()).toEqual(['20250101T000000Z-8', '20260102T000000Z-2', '20260103T000000Z-3']);
    for (const kept of ['20260101T000000Z-1', '20260104T000000Z-4', '20260105T000000Z-5', '20250101T000000Z-9', 'not-a-run']) {
      expect(existsSync(path.join(root, kept))).toBe(true);
    }
  });

  it('VH_KEEP_RUNS=0 disables pruning; junk falls back to the default', async () => {
    expect(keepRunsFromEnv({ VH_KEEP_RUNS: '0' })).toBe(0);
    expect(keepRunsFromEnv({ VH_KEEP_RUNS: 'lots' })).toBe(DEFAULT_KEEP_RUNS);
    expect(keepRunsFromEnv({})).toBe(DEFAULT_KEEP_RUNS);
    const root = tmp();
    mkRun(root, '20260101T000000Z-1');
    expect(await pruneRuns(root, 0)).toEqual([]);
  });
});
