import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IN_PROCESS_LAUNCH_RUN_ID_PREFIX,
  IN_PROCESS_LAUNCH_SPAWN_ID_PREFIX,
  SUPERVISED_HANDOFF_RUN_ID_PREFIX,
  isInProcessLaunchIdentity,
  spawnRowKind,
} from './spawn-row-class';
import { isInProcessLaunchRow } from '../harness/improvements/watchdog';

/**
 * EI-21344971525195182 — PIN the spawn-row class boundary instead of asserting it.
 *
 * Class membership ("is this `spawned_agents` row an in-process launch or a
 * supervised invoke-once child?") is code-describing metadata that several KILLING
 * reapers gate on. It was hand-copied into four places and kept in step only by a
 * comment claiming one "mirrors" the other — and they drifted: an `invoke-*`
 * short-circuit moved 71% of the `durable-spawn:*` population across the boundary
 * on 2026-08-21, nothing failed, and nothing alerted.
 *
 * Per the repo's derive/pin/attest ladder the fix is to DERIVE it from one module
 * (`spawn-row-class.ts`) and then PIN that there is still only one. These tests are
 * the pin: they fail when a copy reappears, when the delegating callers stop
 * agreeing with the source of truth, or when the prefix set the boundary is built
 * from changes without a deliberate edit here.
 *
 * Falsifiability: the source-scan tests take their subject paths from env vars, so
 * `scripts/mutation-probe.sh --file <subject> --mutate … --test 'PROBE_… ={} npm run
 * test:file -- packages/operator-core/lib/fleet/spawn-row-class.test.ts'` can prove
 * they catch a re-introduced copy WITHOUT mutating the shared tree.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
// WI-41180: a sync spawn in the PURE lane blocks the worker's event loop, so vitest cannot time
// it out and one block wedges the ~2,740-file fork. Every sync call here carries an explicit bound.
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: HERE,
  encoding: 'utf8',
  timeout: 30_000,
  killSignal: 'SIGKILL',
}).trim();

const SPAWN_ROW_CLASS_PATH =
  process.env.PROBE_SPAWN_ROW_CLASS_PATH ?? join(REPO_ROOT, 'packages/operator-core/lib/fleet/spawn-row-class.ts');
const SPAWN_RECLAIM_PATH =
  process.env.PROBE_SPAWN_RECLAIM_PATH ?? join(REPO_ROOT, 'packages/operator-core/lib/fleet/spawn-reclaim.ts');

/** Files allowed to contain the boundary's prefix literals side by side. */
const SINGLE_SOURCE_ALLOWLIST = new Set([
  'packages/operator-core/lib/fleet/spawn-row-class.ts',
  'packages/operator-core/lib/fleet/spawn-row-class.test.ts',
]);

describe('spawn-row class boundary: the prefix set is pinned, not incidental', () => {
  /**
   * These three strings ARE the boundary. Two killing reapers and a liveness probe
   * change behaviour when this set changes, and the `invoke-` prefix in particular
   * is owned by the /invoke route — a different subsystem from this classifier,
   * which is precisely how it moved without anyone deciding to move it.
   *
   * If you are changing one of these, the census that justified the current values
   * must be re-run: `SELECT count(*) FILTER (WHERE run_id LIKE 'invoke-%') , count(*)
   * FROM harness_shared.spawned_agents WHERE spawn_id LIKE 'durable-spawn:%'` over a
   * 14-day window. On 2026-08-24 that read 56 of 79 (71%).
   */
  it('holds exactly the three prefixes the class is built from', () => {
    expect(IN_PROCESS_LAUNCH_RUN_ID_PREFIX).toBe('launch-');
    expect(IN_PROCESS_LAUNCH_SPAWN_ID_PREFIX).toBe('durable-spawn:');
    expect(SUPERVISED_HANDOFF_RUN_ID_PREFIX).toBe('invoke-');
  });
});

describe('spawn-row class boundary: identity vs kind diverge deliberately', () => {
  const rows: { spawn_id: string; run_id: string | null | undefined; label: string }[] = [
    { label: 'legacy launch row', spawn_id: 's-legacy', run_id: 'launch-legacy' },
    { label: 'durable spawn, pre-handoff', spawn_id: 'durable-spawn:release-fix:1', run_id: 'r-durable-spawn:1' },
    { label: 'durable spawn, handed off', spawn_id: 'durable-spawn:release-fix:1', run_id: 'invoke-implement-42' },
    { label: 'durable spawn, double-invoke', spawn_id: 'durable-spawn:release-fix:1', run_id: 'invoke-invoke-42' },
    { label: 'durable spawn, launch-keyed', spawn_id: 'durable-spawn:release-fix:1', run_id: 'launch:key' },
    { label: 'supervised bee', spawn_id: 's-bee-1', run_id: 'r-bee-1' },
    { label: 'supervised bee, handed off', spawn_id: 's-bee-1', run_id: 'invoke-implement-7' },
    { label: 'null run_id', spawn_id: 's-bee-2', run_id: null },
    { label: 'undefined run_id', spawn_id: 'durable-spawn:x', run_id: undefined },
  ];

  it('classifies the handoff shape as a supervised bee while its IDENTITY stays in-process', () => {
    const handedOff = { spawn_id: 'durable-spawn:release-fix:1', run_id: 'invoke-implement-42' };
    // This single row is the whole bug: the two answers disagree, both are correct
    // for their own question, and a reaper that uses the wrong one kills healthy work.
    expect(isInProcessLaunchIdentity(handedOff)).toBe(true);
    expect(spawnRowKind({ spawnId: handedOff.spawn_id, runId: handedOff.run_id, pid: 701 })).toBe('spawn');
  });

  it('diverges ONLY on the invoke-handoff prefix — nowhere else in the matrix', () => {
    for (const row of rows) {
      const identity = isInProcessLaunchIdentity(row);
      const kind = spawnRowKind({ spawnId: row.spawn_id, runId: row.run_id ?? null, pid: null });
      const divergent = identity && kind === 'spawn';
      const handedOff = (row.run_id ?? '').startsWith(SUPERVISED_HANDOFF_RUN_ID_PREFIX);
      expect({ label: row.label, divergent }).toEqual({ label: row.label, divergent: identity && handedOff });
    }
  });
});

describe('spawn-row class boundary: every caller agrees with the source of truth', () => {
  /**
   * watchdog.ts's `isInProcessLaunchRow` is the copy that drifted. It now delegates,
   * and this asserts the delegation BEHAVIOURALLY — a re-introduced copy that is
   * merely "the same for the cases I thought of" fails here on the handoff shapes.
   */
  it('watchdog.isInProcessLaunchRow === spawn-row-class.isInProcessLaunchIdentity', () => {
    const cases: { spawn_id: string; run_id?: string | null }[] = [
      { spawn_id: 's-legacy', run_id: 'launch-legacy' },
      { spawn_id: 'durable-spawn:release-fix:1', run_id: 'r-durable-spawn:1' },
      { spawn_id: 'durable-spawn:release-fix:1', run_id: 'invoke-implement-42' },
      { spawn_id: 'durable-spawn:release-fix:1', run_id: 'invoke-invoke-42' },
      { spawn_id: 's-bee-1', run_id: 'invoke-implement-7' },
      { spawn_id: 's-bee-1', run_id: 'r-bee-1' },
      { spawn_id: 's-bee-2', run_id: null },
      { spawn_id: 'durable-spawn:x' },
      { spawn_id: 'launch-not-a-spawn-id-prefix', run_id: 'r-x' },
    ];
    for (const row of cases) {
      expect({ row, v: isInProcessLaunchRow(row) }).toEqual({ row, v: isInProcessLaunchIdentity(row) });
    }
  });
});

describe('spawn-row class boundary: only one implementation exists', () => {
  const TS_LAUNCH_LITERAL = new RegExp(`['"]${IN_PROCESS_LAUNCH_RUN_ID_PREFIX}['"]`);
  const TS_DURABLE_LITERAL = new RegExp(`['"]${IN_PROCESS_LAUNCH_SPAWN_ID_PREFIX}['"]`);

  /** A hand-copied boundary looks like both prefix literals within a few lines of each other. */
  function carriesBoundaryCopy(source: string): boolean {
    const lines = source.split('\n');
    const launchAt = lines.flatMap((l, i) => (TS_LAUNCH_LITERAL.test(l) ? [i] : []));
    const durableAt = lines.flatMap((l, i) => (TS_DURABLE_LITERAL.test(l) ? [i] : []));
    return launchAt.some((a) => durableAt.some((b) => Math.abs(a - b) <= 2));
  }

  it('no TypeScript file outside the source of truth re-implements the prefix test', () => {
    // Candidate set: tracked AND untracked files mentioning the spawn-id prefix at all.
    // --untracked matters — a newly added copy is untracked, which is exactly the case
    // this guard exists to catch, and a tracked-only scan would silently miss it.
    const candidates = execFileSync(
      'git',
      ['grep', '-l', '--untracked', '-e', IN_PROCESS_LAUNCH_SPAWN_ID_PREFIX, '--', '*.ts'],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' },
    )
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    // POSITIVE CONTROL: the source of truth itself must be in the candidate set AND be
    // flagged by the detector. Without this, a broken scan (wrong cwd, a `git grep` that
    // matched nothing) returns an empty offender list that reads exactly like a clean pass.
    expect(candidates).toContain('packages/operator-core/lib/fleet/spawn-row-class.ts');
    expect(carriesBoundaryCopy(readFileSync(SPAWN_ROW_CLASS_PATH, 'utf8'))).toBe(true);

    const offenders = candidates.filter(
      (rel) => !SINGLE_SOURCE_ALLOWLIST.has(rel) && carriesBoundaryCopy(readFileSync(join(REPO_ROOT, rel), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  /**
   * The one copy the module graph cannot own: `markSpawnHandoff` writes the boundary
   * as SQL. It is the WRITER of the `invoke-` prefix, so if it and the classifier ever
   * disagree about which rows get handed off, the class silently moves again.
   */
  it('the markSpawnHandoff SQL uses the same prefixes as the classifier', () => {
    const src = readFileSync(SPAWN_RECLAIM_PATH, 'utf8');
    expect(src).toContain(`run_id LIKE '${IN_PROCESS_LAUNCH_RUN_ID_PREFIX}%'`);
    expect(src).toContain(`spawn_id LIKE '${IN_PROCESS_LAUNCH_SPAWN_ID_PREFIX}%'`);
    expect(src).toContain(`'${SUPERVISED_HANDOFF_RUN_ID_PREFIX}' || run_id`);
  });
});
