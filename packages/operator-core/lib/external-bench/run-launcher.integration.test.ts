/**
 * Integration tests for the UI run launcher + the spend-safety teardown
 * (benchmark-evaluation-ui-2026-06-16 P-004 / P-005) against a real (testcontainer)
 * Postgres.
 *
 * P-004: launchBenchRun persists status=running + returns a runId immediately,
 * drives the (injected) engine detached, and finalizes to done. Single-active-run
 * is enforced.
 *
 * P-005 HARD GATE (closes impartial-benchmark-suite D-022 — the orphan-respin
 * gap): the detached run ALWAYS dissolves its hive in the finally; the boot reaper
 * dissolves + freezes any run a crashed host left in flight (so a restart can
 * never re-arm an orphan that re-spins opus); and the reaper is HEARTBEAT-GATED so
 * a run legitimately in flight in another live host is NOT killed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import type { OrgSql } from './reproducibility/db';

vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

import {
  launchBenchRun,
  cancelBenchRun,
  reapStaleBenchRuns,
  assertNoActiveRun,
  _resetActiveRunsForTests,
} from './run-launcher';
import { upsertBenchRun, setBenchRunHive, getBenchRunDetail } from './run-store';
import type { BenchTask } from './types';
import type { HiveBacklogResult, HiveBacklogRunRequest } from './hive-backlog';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const WS = 'bench-launch-test-ws';

function migrationSql(file: string): string {
  return readFileSync(resolve(SQL_DIR, file), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l) && !/\bGRANT\b/.test(l) && !/^\s*(BEGIN|COMMIT);\s*$/.test(l))
    .join('\n');
}

let db: FreshPgDb;
let sql: OrgSql;
let scope: { sql: OrgSql; workspaceId: string };

const task = (id: string): BenchTask => ({
  benchmark: 'swe-bench-pro',
  instanceId: id,
  problemStatement: 'p',
  repo: `/tmp/${id}`,
  baseCommit: 'abc',
  graderMeta: { dockerhub_tag: id, FAIL_TO_PASS: [], PASS_TO_PASS: [], testFiles: [] },
});

/** A fake engine: drives the durability hooks (so hive_slug + per-task rows land)
 *  then returns a clean result. Captured from bindDriver. */
function makeFakeEngine() {
  let hooks: {
    onHiveCreated?: (h: string) => void;
    onEnrolled?: (e: { task: BenchTask }) => void;
    onTaskCollected?: (tr: unknown) => void;
  } = {};
  const bindDriver = (opts: typeof hooks) => {
    hooks = opts;
  };
  const run = async (req: HiveBacklogRunRequest): Promise<HiveBacklogResult> => {
    hooks.onHiveCreated?.(`hive-${req.runId}`);
    for (const t of req.backlog) {
      hooks.onEnrolled?.({ task: t });
      hooks.onTaskCollected?.({
        attempt: {
          arm: req.arm, blueprintId: 'external-bench', instanceId: t.instanceId, seed: '1',
          diff: 'diff x', tokensIn: 10, tokensOut: 100, costUsd: 3, turns: 1, wallClockMs: 1000,
          trajectoryRef: '', stopReason: 'done',
        },
        cupId: `bee-${t.instanceId}`, placedAtMs: 0, startedAtMs: 0, finishedAtMs: 1000, disposition: 'spawn',
      });
    }
    return {
      arm: req.arm, suite: req.suite, runId: req.runId, seed: 1,
      startedAtMs: 0, finishedAtMs: 5000, peakConcurrentBees: 2,
      taskResults: [], coordEvents: [{ kind: 'placement', taskId: req.backlog[0]?.instanceId }],
      runError: null,
    };
  };
  return { bindDriver: bindDriver as never, run };
}

beforeAll(async () => {
  db = await createFreshPgDb('benchlaunch');
  sql = db.sql as unknown as OrgSql;
  await db.sql.unsafe(migrationSql('296-bench-run-operational-store.sql'));
  await db.sql.unsafe(migrationSql('298-bench-run-infra-excluded.sql'));
  // D-007 pot-rename: mig 296 creates bench_runs.hive_slug; mig 523 renamed it → pot_slug.
  // Replaying only 296/298 predates the rename, so apply it in-place to match the write path.
  await db.sql.unsafe(`ALTER TABLE harness_shared.bench_runs RENAME COLUMN hive_slug TO pot_slug`);
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.bench_runs       DISABLE ROW LEVEL SECURITY;
    ALTER TABLE harness_shared.bench_run_tasks  DISABLE ROW LEVEL SECURITY;
    ALTER TABLE harness_shared.bench_run_events DISABLE ROW LEVEL SECURITY;
  `);
  scope = { sql, workspaceId: WS };
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  _resetActiveRunsForTests();
  await sql`DELETE FROM harness_shared.bench_runs WHERE workspace_id = ${WS}`;
});

describe('launchBenchRun (P-004)', () => {
  it('persists status=running immediately, drives the engine detached, finalizes to done + dissolves the hive', async () => {
    const dissolve = vi.fn(async () => {});
    const { bindDriver, run } = makeFakeEngine();
    const { runId, done } = await launchBenchRun(
      { arm: 'hive-realqueen', taskSetId: '11-task-pilot', model: 'opus', cap: 5 },
      { scope, run, bindDriver, dissolve, loadBacklog: async () => [task('instance_a'), task('instance_b')], assertEnabled: async () => {}, runId: 'launch-1' },
    );
    expect(runId).toBe('launch-1');

    // Immediately after launch: running, task set seeded as todo.
    const live = await getBenchRunDetail('launch-1', scope);
    expect(live!.status).toBe('running');
    expect(live!.source).toBe('ui');
    expect(live!.taskCount).toBe(2);
    expect(live!.perTask).toHaveLength(2);

    await done;

    const final = await getBenchRunDetail('launch-1', scope);
    expect(final!.status).toBe('done');
    expect(final!.potSlug).toBe('hive-launch-1');
    expect(final!.run.coordEvents.length).toBeGreaterThan(0);
    // The finally dissolved the spawned hive — no orphan learning loop survives.
    expect(dissolve).toHaveBeenCalledWith('hive-launch-1', WS);
  });

  it('refuses a second launch while one is in flight (single-active-run)', async () => {
    await upsertBenchRun({ id: 'busy-1', arm: 'hive-realqueen', taskSetId: '11-task-pilot', model: 'opus', status: 'running' }, scope);
    await expect(assertNoActiveRun(scope)).rejects.toThrow(/conflicting_run_active/);
    await expect(
      launchBenchRun(
        { arm: 'fifo-noqueen', taskSetId: '11-task-pilot' },
        { scope, loadBacklog: async () => [task('instance_a')], assertEnabled: async () => {}, runId: 'launch-2' },
      ),
    ).rejects.toThrow(/conflicting_run_active/);
  });

  it('cancel freezes status=cancelled + dissolves the hive', async () => {
    await upsertBenchRun({ id: 'cancel-1', arm: 'hive-realqueen', taskSetId: '11-task-pilot', model: 'opus', status: 'running', potSlug: 'hive-cancel-1' }, scope);
    await setBenchRunHive('cancel-1', 'hive-cancel-1', scope);
    const dissolve = vi.fn(async () => {});
    const res = await cancelBenchRun('cancel-1', { scope, dissolve });
    expect(res.cancelled).toBe(true);
    expect(dissolve).toHaveBeenCalledWith('hive-cancel-1', WS);
    const detail = await getBenchRunDetail('cancel-1', scope);
    expect(detail!.status).toBe('cancelled');
  });
});

describe('reapStaleBenchRuns — spend-safety HARD GATE (P-005 / D-022)', () => {
  it('reaps every in-flight run on restart: dissolves the hive + freezes status (0 orphan re-spin)', async () => {
    // Two runs the crashed host left mid-flight.
    await upsertBenchRun({ id: 'stale-1', arm: 'hive-realqueen', taskSetId: '11-task-pilot', model: 'opus', status: 'running', potSlug: 'hive-stale-1' }, scope);
    await upsertBenchRun({ id: 'stale-2', arm: 'fifo-noqueen', taskSetId: '11-task-pilot', model: 'opus', status: 'running', potSlug: 'hive-stale-2' }, scope);

    const dissolve = vi.fn(async () => {});
    const { reaped } = await reapStaleBenchRuns({ scope, dissolve, staleAfterSec: 0 });

    expect(reaped.sort()).toEqual(['stale-1', 'stale-2']);
    // Every orphan hive was dissolved (deactivating its learning loops → no re-spin).
    expect(dissolve).toHaveBeenCalledWith('hive-stale-1', WS);
    expect(dissolve).toHaveBeenCalledWith('hive-stale-2', WS);
    // Status frozen to a terminal state — nothing is left 'running' to re-arm.
    for (const id of ['stale-1', 'stale-2']) {
      const d = await getBenchRunDetail(id, scope);
      expect(d!.status).toBe('error');
      expect(d!.runError).toMatch(/reaped/);
    }
    // Idempotent — a second reap finds nothing active.
    const again = await reapStaleBenchRuns({ scope, dissolve, staleAfterSec: 0 });
    expect(again.reaped).toEqual([]);
  });

  it('does NOT reap a run with a fresh heartbeat (a run legitimately in flight in another live host)', async () => {
    await upsertBenchRun({ id: 'live-1', arm: 'hive-realqueen', taskSetId: '11-task-pilot', model: 'opus', status: 'running', potSlug: 'hive-live-1' }, scope);
    const dissolve = vi.fn(async () => {});
    // updated_at was just set by upsertBenchRun → well within the 180s window.
    const { reaped } = await reapStaleBenchRuns({ scope, dissolve, staleAfterSec: 180 });
    expect(reaped).toEqual([]);
    expect(dissolve).not.toHaveBeenCalled();
    const d = await getBenchRunDetail('live-1', scope);
    expect(d!.status).toBe('running'); // untouched — still live
  });
});
