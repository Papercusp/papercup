/**
 * testing-run-store.ts — in-memory map of detached per-file test runs.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-014/P-015.
 *
 * Mirrors the admin-test-runs-store pattern (used by the existing
 * /api/admin/testing/test-runs route): a Map<runId, snapshot> populated
 * by spawn calls and polled by sibling routes. Output is rolling-
 * appended; we keep the last ~16KB.
 *
 * Runs auto-evict 1h after finishing so the map stays bounded across
 * a long dev session.
 *
 * P-014 persistence (admin-ui rows):
 * - For 'vitest' / 'playwright' spawns, we set `PAPERCUSP_TEST_RUN_SOURCE=admin-ui`
 *   on the child env. The admin-test-runs reporter inside the child reads it
 *   and writes per-file rows with `source='admin-ui'`. This preserves
 *   per-file granularity, including for vitest-multi (Run section / Run all).
 * - For 'node' / 'shell' spawns there's no in-process reporter, so the store
 *   itself writes one fallback row on close. Fail-soft (D-007) — never throws.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative as pathRelative, posix } from 'node:path';
import { resolveAgentWorkspaceRoot } from './agent-tools/capability/base-dir';
import { resolveGitContext } from './testing-branch-resolve';
import { captureWorktreeSnapshot, computeWorktreeDirty, type WorktreeGitSnapshot } from './testing-worktree';
import { currentLoopLag, classifyLoopPressure } from './event-loop-lag-monitor';
import {
  beginSyncEnrolment,
  completeSyncEnrolment,
  finishSyncEnrolment,
  syncEnrolmentScopePath,
} from './task-manager/enroll-sync';
import { isTerminalState, type TaskSpec, type TaskState } from './task-manager/types';

export { captureWorktreeSnapshot, computeWorktreeDirty };
export type { WorktreeGitSnapshot };

/** A postgres-js-like tagged-template client; injectable so persistence seams are testable. */
type SqlLike = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown>;

/**
 * EI-4940 — a host-saturation-era test timeout ("Test timed out in 60000ms")
 * is indistinguishable from a genuine red in the Tests-tab history: 16 of 24
 * "failing" files in a real triage were saturation artifacts (WI-1089's
 * overnight event-loop/RSS incident) that passed fresh on the recovered box.
 * Stamp each row with the host's event-loop-lag p95 + process RSS AT PERSIST
 * TIME (both processes here run INSIDE the operator: the harness run route
 * runs vitest in-process, and this store's own fallback-row persist runs in
 * the operator's own process right after its spawned child closes) — a
 * reviewer (or a future auto-retry / Tests-tab badge) can then tell "the host
 * was saturated when this ran" apart from "this is a real red" with no
 * re-run. NULL means no monitor was running on this process — absence of
 * signal, never a claim the host was calm.
 */
function captureSaturationSnapshot(): { loopLagP95Ms: number | null; rssMb: number | null } {
  const lag = currentLoopLag();
  return {
    loopLagP95Ms: lag ? lag.p95Ms : null,
    rssMb: Math.round((process.memoryUsage().rss / 1_048_576) * 10) / 10,
  };
}

/** A `Test timed out in <N>ms` failure (vitest/jest's own message shape) —
 *  the failure class WI-1089's saturation incident actually produced. Exported
 *  for reuse (the eventual Tests-tab badge, or an agent triaging a red set). */
export const TIMEOUT_FAILURE_RE = /test timed out|timed out in \d+\s*ms|exceeded timeout of \d+\s*ms/i;

/**
 * EI-4940 — is this failing row LIKELY a host-saturation artifact rather than
 * a genuine bug? Both conditions must hold: the row is a FAILURE that reads
 * like a bare timeout (not an assertion/structural error — those are real
 * regardless of host load), AND the host's event-loop lag was in the CRITICAL
 * band at persist time (the same band `isLoopSaturated()` uses LIVE — reused
 * here, not reinvented, so the threshold has one source of truth).
 *
 * A `false` verdict does NOT mean "definitely a real bug" — it means this
 * heuristic found no saturation signal; a `loopLagP95Ms: null` row (no monitor
 * running when it was recorded, e.g. an older row) always reads false, which
 * is the conservative direction (never HIDES a real red as "just saturation").
 */
export function isLikelySaturationArtifact(row: {
  status: string;
  outputTail?: string | null;
  loopLagP95Ms?: number | null;
}): boolean {
  if (row.status !== 'fail' && row.status !== 'error') return false;
  if (row.loopLagP95Ms == null || classifyLoopPressure(row.loopLagP95Ms) !== 'critical') return false;
  return TIMEOUT_FAILURE_RE.test(row.outputTail ?? '');
}

export type RunStatus = 'running' | 'pass' | 'fail' | 'cancelled' | 'error';

export interface RunSnapshot {
  runId: string;
  /** The task-manager row that owns this process, when enrolment was enabled. */
  taskId?: string;
  kind: 'vitest' | 'playwright' | 'cargo' | 'node' | 'shell' | 'admin-suite';
  label: string;
  filePath?: string;
  command: string[];
  status: RunStatus;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  output: string;
  truncated: boolean;
}

interface RunState {
  snapshot: RunSnapshot;
  proc: ChildProcess | null;
  cwd: string;
  worktreeBefore: WorktreeGitSnapshot;
}

const _runs = new Map<string, RunState>();
const OUTPUT_CAP_BYTES = 16 * 1024;
const EVICTION_MS = 60 * 60 * 1000;
const SNAPSHOT_PERSIST_TIMEOUT_MS = 1_000;
const TEST_RUN_PERSIST_TIMEOUT_MS = 1_000;
/**
 * Keep timeout recovery's optional initial snapshot write well inside the
 * foreground transport margin. The detached child is launched first, so a
 * slow import or database write can only downgrade durability; it cannot hide
 * the recovery handle from the caller.
 */
export const DETACHED_RUN_DURABILITY_RESPONSE_BUDGET_MS = 2_000;
const SNAPSHOT_PRUNE_INTERVAL_MS = 60_000;
let lastSnapshotPruneAt = 0;

interface DurableRunSnapshotRow {
  run_id: string;
  task_id: string | null;
  kind: RunSnapshot['kind'];
  label: string;
  file_path: string | null;
  command: unknown;
  status: RunStatus;
  exit_code: number | null;
  started_at: Date | string | number;
  finished_at: Date | string | number | null;
  output: string;
  truncated: boolean;
  /** Joined task-manager state used to reconcile a worker-death orphan. */
  task_state?: TaskState | string | null;
}

function snapshotPersistenceEnabled(sqlOverride?: SqlLike): boolean {
  // Throwaway children in unit tests must not write to the developer's live
  // database. An explicit SQL seam (or the opt-in env used by the existing
  // fallback-row tests) still exercises the production writer in Vitest.
  return Boolean(sqlOverride) || !process.env.VITEST || process.env.PAPERCUSP_TEST_RUNS_PERSIST === '1';
}

async function snapshotSql(sqlOverride?: SqlLike): Promise<SqlLike | null> {
  if (sqlOverride) return sqlOverride;
  if (!snapshotPersistenceEnabled()) return null;
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    return getOrgPg().sql as unknown as SqlLike;
  } catch {
    return null;
  }
}

async function boundedSnapshotQuery<T>(query: PromiseLike<unknown>): Promise<T | null> {
  try {
    const result = await Promise.race([
      Promise.resolve(query),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('testing_run_snapshot_query_timeout')), SNAPSHOT_PERSIST_TIMEOUT_MS),
      ),
    ]);
    return result as T;
  } catch {
    // D-007: snapshot persistence/readback is observability, never a reason
    // to fail or delay the test process/foreground response.
    return null;
  }
}

function epochMs(value: Date | string | number | null): number | null {
  if (value === null) return null;
  const millis = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function commandFromRow(value: unknown): string[] | null {
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return [...value];
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string') ? [...parsed] : null;
  } catch {
    return null;
  }
}

function snapshotFromRow(row: DurableRunSnapshotRow): RunSnapshot | null {
  const startedAt = epochMs(row.started_at);
  const command = commandFromRow(row.command);
  if (startedAt === null || command === null) return null;
  return {
    runId: row.run_id,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    kind: row.kind,
    label: row.label,
    ...(row.file_path === null ? {} : { filePath: row.file_path }),
    command,
    status: row.status,
    exitCode: row.exit_code,
    startedAt,
    finishedAt: epochMs(row.finished_at),
    output: row.output ?? '',
    truncated: Boolean(row.truncated),
  };
}

/**
 * Persist one detached-run snapshot in the shared live-run ledger.
 *
 * This is deliberately fire-and-forget at lifecycle call sites. The process
 * local map remains the fast control/read cache; this row is the cross-worker
 * recovery source when a status request lands on a different operator worker.
 * Every failure is swallowed and bounded so a DB outage cannot affect tests.
 */
export async function persistRunSnapshot(snapshot: RunSnapshot, sqlOverride?: SqlLike): Promise<boolean> {
  if (!snapshotPersistenceEnabled(sqlOverride)) return false;
  // Snapshot values are mutable while the child runs. Freeze the values for
  // this write before the async pool lookup, otherwise an initial "running"
  // write can observe the later close-handler mutation and race a sibling
  // lifecycle write with a different state.
  const persistedSnapshot: RunSnapshot = {
    ...snapshot,
    command: [...snapshot.command],
  };
  const sql = await snapshotSql(sqlOverride);
  if (!sql) return false;
  const startedAt = new Date(persistedSnapshot.startedAt).toISOString();
  const finishedAt =
    persistedSnapshot.finishedAt === null ? null : new Date(persistedSnapshot.finishedAt).toISOString();
  let query: PromiseLike<unknown>;
  try {
    query = sql`
      INSERT INTO harness_shared.testing_run_snapshots
        (run_id, kind, label, file_path, command, status, exit_code, started_at, finished_at, output, truncated, task_id)
      VALUES
        (${persistedSnapshot.runId}, ${persistedSnapshot.kind}, ${persistedSnapshot.label}, ${persistedSnapshot.filePath ?? null},
         ${JSON.stringify(persistedSnapshot.command)}::jsonb, ${persistedSnapshot.status}, ${persistedSnapshot.exitCode},
         ${startedAt}, ${finishedAt}, ${persistedSnapshot.output}, ${persistedSnapshot.truncated}, ${persistedSnapshot.taskId ?? null})
      ON CONFLICT (run_id) DO UPDATE SET
        kind = EXCLUDED.kind,
        label = EXCLUDED.label,
        file_path = EXCLUDED.file_path,
        command = EXCLUDED.command,
        status = CASE
          WHEN harness_shared.testing_run_snapshots.status = 'cancelled'
            OR (
              harness_shared.testing_run_snapshots.finished_at IS NOT NULL
              AND EXCLUDED.finished_at IS NULL
            )
            THEN harness_shared.testing_run_snapshots.status
          ELSE EXCLUDED.status
        END,
        exit_code = CASE
          WHEN harness_shared.testing_run_snapshots.status = 'cancelled'
            OR (
              harness_shared.testing_run_snapshots.finished_at IS NOT NULL
              AND EXCLUDED.finished_at IS NULL
            )
            THEN harness_shared.testing_run_snapshots.exit_code
          ELSE EXCLUDED.exit_code
        END,
        started_at = EXCLUDED.started_at,
        finished_at = CASE
          WHEN harness_shared.testing_run_snapshots.status = 'cancelled'
            OR (
              harness_shared.testing_run_snapshots.finished_at IS NOT NULL
              AND EXCLUDED.finished_at IS NULL
            )
            THEN harness_shared.testing_run_snapshots.finished_at
          ELSE EXCLUDED.finished_at
        END,
        output = CASE
          WHEN harness_shared.testing_run_snapshots.status = 'cancelled'
            OR (
              harness_shared.testing_run_snapshots.finished_at IS NOT NULL
              AND EXCLUDED.finished_at IS NULL
            )
            THEN harness_shared.testing_run_snapshots.output
          ELSE EXCLUDED.output
        END,
        truncated = CASE
          WHEN harness_shared.testing_run_snapshots.status = 'cancelled'
            OR (
              harness_shared.testing_run_snapshots.finished_at IS NOT NULL
              AND EXCLUDED.finished_at IS NULL
            )
            THEN harness_shared.testing_run_snapshots.truncated
          ELSE EXCLUDED.truncated
        END,
        task_id = COALESCE(EXCLUDED.task_id, harness_shared.testing_run_snapshots.task_id),
        updated_at = now()
    `;
  } catch {
    // A malformed/unavailable SQL seam is still a persistence failure, not a
    // reason to reject the detached process start.
    return false;
  }
  const rows = await boundedSnapshotQuery<unknown[]>(query);
  return rows !== null;
}

async function prunePersistedRunSnapshots(sqlOverride?: SqlLike): Promise<void> {
  if (!snapshotPersistenceEnabled(sqlOverride)) return;
  const sql = await snapshotSql(sqlOverride);
  if (!sql) return;
  await boundedSnapshotQuery(sql`
    DELETE FROM harness_shared.testing_run_snapshots
     WHERE finished_at IS NOT NULL
       AND finished_at < now() - interval '1 hour'
  `);
}

async function readPersistedRunSnapshot(runId: string, sqlOverride?: SqlLike): Promise<RunSnapshot | null> {
  const sql = await snapshotSql(sqlOverride);
  if (!sql) return null;
  let query: PromiseLike<unknown>;
  try {
    query = sql`
      SELECT run_id, kind, label, file_path, command, status, exit_code,
             started_at, finished_at, output, truncated, task_id,
             task_ledger.state AS task_state
        FROM harness_shared.testing_run_snapshots
        LEFT JOIN harness_shared.task_ledger AS task_ledger
          ON task_ledger.task_id = harness_shared.testing_run_snapshots.task_id
       WHERE run_id = ${runId}
         AND (finished_at IS NULL OR finished_at >= now() - interval '1 hour')
       LIMIT 1
    `;
  } catch {
    return null;
  }
  const rows = await boundedSnapshotQuery<DurableRunSnapshotRow[]>(query);
  const row = rows?.[0];
  if (!row) return null;
  const snapshot = snapshotFromRow(row);
  if (!snapshot) return null;
  return reconcilePersistedOrphan(snapshot, row, sql);
}

/**
 * A detached snapshot is not itself a liveness oracle: the worker that owned
 * its child may have disappeared after writing `status='running'`. The linked
 * task-manager row is the durable process-liveness authority. Once that row is
 * terminal, the process is conclusively gone (or was killed), so keeping the
 * snapshot running would manufacture a live result forever.
 *
 * The update is compare-and-set on `status='running'`. A late child close or a
 * concurrent status reader therefore cannot resurrect a terminal snapshot, and
 * concurrent readers converge on the same honest `error` disposition.
 */
async function reconcilePersistedOrphan(
  snapshot: RunSnapshot,
  row: DurableRunSnapshotRow,
  sql: SqlLike,
): Promise<RunSnapshot> {
  const taskState = row.task_state;
  if (snapshot.status !== 'running' || typeof taskState !== 'string' || !isTerminalState(taskState as TaskState)) {
    return snapshot;
  }

  const finishedAt = Date.now();
  const note =
    `\n[detached-recovery] task-manager reports linked process ${row.task_id ?? snapshot.taskId ?? 'unknown'} ` +
    `is no longer live (state=${taskState}); no test verdict was observed.\n`;
  const combinedOutput = snapshot.output + note;
  const output = combinedOutput.length > OUTPUT_CAP_BYTES ? combinedOutput.slice(-OUTPUT_CAP_BYTES) : combinedOutput;
  const reconciled: RunSnapshot = {
    ...snapshot,
    status: 'error',
    exitCode: null,
    finishedAt,
    output,
    truncated: snapshot.truncated || combinedOutput.length > OUTPUT_CAP_BYTES,
  };

  let update: PromiseLike<unknown>;
  try {
    update = sql`
      UPDATE harness_shared.testing_run_snapshots
         SET status = 'error',
             exit_code = NULL,
             finished_at = ${new Date(finishedAt).toISOString()},
             output = ${reconciled.output},
             truncated = ${reconciled.truncated},
             updated_at = now()
       WHERE run_id = ${snapshot.runId}
         AND status = 'running'
       RETURNING run_id
    `;
  } catch {
    return snapshot;
  }
  const rows = await boundedSnapshotQuery<unknown[]>(update);
  return rows && rows.length > 0 ? reconciled : snapshot;
}

function evictOldRuns(): void {
  const now = Date.now();
  const cutoff = now - EVICTION_MS;
  for (const [id, s] of _runs) {
    if (s.snapshot.finishedAt !== null && s.snapshot.finishedAt < cutoff) {
      _runs.delete(id);
    }
  }
  if (now - lastSnapshotPruneAt >= SNAPSHOT_PRUNE_INTERVAL_MS) {
    lastSnapshotPruneAt = now;
    void prunePersistedRunSnapshots();
  }
}

function appendOutput(state: RunState, chunk: string): void {
  const next = state.snapshot.output + chunk;
  if (next.length > OUTPUT_CAP_BYTES) {
    state.snapshot.output = next.slice(-OUTPUT_CAP_BYTES);
    state.snapshot.truncated = true;
  } else {
    state.snapshot.output = next;
  }
}

export interface SpawnRequest {
  kind: RunSnapshot['kind'];
  label: string;
  filePath?: string;
  command: string;
  args: string[];
  cwd?: string;
  /** Environment values supplied by the caller for the child process. */
  env?: NodeJS.ProcessEnv;
  /**
   * Durable wall-clock ceiling for the task-manager scope. Detached recovery
   * must carry its requested timeout into systemd so an operator restart cannot
   * leave the child and its running snapshot alive indefinitely.
   */
  runtimeMaxSec?: number | null;
}

/**
 * Signal a run's process group when the child was started detached. A detached
 * runner can synchronously spawn a router, which can synchronously spawn
 * Vitest and its workers; signalling only the direct child leaves that tree
 * running after the caller thinks cancellation succeeded. Keep the direct
 * child fallback for platforms without POSIX process-group signalling and for
 * children that do not expose a pid (the latter is also how lightweight test
 * doubles model a process).
 */
function signalRunProcess(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Negative-pid signalling is unavailable or the group has already exited.
    }
  }
  try {
    proc.kill(signal);
  } catch {
    /* already gone */
  }
}

type SyncEnrolment = ReturnType<typeof beginSyncEnrolment>;

interface PreparedRun {
  snapshot: RunSnapshot;
  cwd: string;
  worktreeBefore: WorktreeGitSnapshot;
  childEnv: NodeJS.ProcessEnv;
  taskSpec: TaskSpec;
  enrolment: SyncEnrolment;
  scopeCgroupPath: string | null;
  wrapped: ReturnType<SyncEnrolment['wrap']>;
}

function prepareRun(req: SpawnRequest): PreparedRun {
  evictOldRuns();
  const runId = randomUUID();
  const snapshot: RunSnapshot = {
    runId,
    kind: req.kind,
    label: req.label,
    filePath: req.filePath,
    command: [req.command, ...req.args],
    status: 'running',
    exitCode: null,
    startedAt: Date.now(),
    finishedAt: null,
    output: '',
    truncated: false,
  };

  // Use the same integration-root resolver as agent capability tools. The
  // operator may run from the release checkout while the agent edits staging;
  // process.cwd() is therefore not a safe implicit tree for detached runs.
  const cwd = req.cwd ?? resolveAgentWorkspaceRoot({});
  const worktreeBefore = captureWorktreeSnapshot(cwd);
  const childEnv = {
    ...process.env,
    ...req.env,
    PAPERCUSP_TEST_RUN_GROUP: runId,
    // P-004 (deterministic-coverage-census): arm coverage attribution, so an admin-UI
    // run contributes the same surface→test evidence an agent's `testing:run` does. A
    // unit fork disarms itself off the no-real-pg rail — see attribution/context.ts.
    PAPERCUSP_TEST_ATTRIBUTION: '1',
    // P-014: tell the in-process reporter (vitest/playwright) to stamp
    // rows with source='admin-ui' instead of inferring ci/local. For
    // node/shell runners we additionally write a single fallback row
    // from this store at close (see persistFallbackRow below).
    PAPERCUSP_TEST_RUN_SOURCE: 'admin-ui',
  };
  const taskSpec: TaskSpec = {
    class: 'test-run',
    title: req.label.slice(0, 300),
    argv: [req.command, ...req.args],
    cwd,
    runtimeMaxSec: req.runtimeMaxSec,
    launchedBy: 'testing-run-store',
    detail: { runId, kind: req.kind },
  };
  // task-manager P-008: mint the task id + confinement decision before the
  // fork. Ledger writes remain fire-and-forget so the synchronous startRun API
  // keeps its existing shape and a persistence outage never prevents a test
  // run from starting.
  const enrolment = beginSyncEnrolment(taskSpec);
  if (enrolment.enrolled) snapshot.taskId = enrolment.taskId;
  const scopeCgroupPath = syncEnrolmentScopePath(enrolment, 'test-run');
  const wrapped = enrolment.wrap(req.command, req.args, childEnv, cwd);
  return { snapshot, cwd, worktreeBefore, childEnv, taskSpec, enrolment, scopeCgroupPath, wrapped };
}

function launchPreparedRun(prepared: PreparedRun, opts: { persistInitialSnapshot: boolean }): RunSnapshot {
  const { snapshot, cwd, worktreeBefore, childEnv, taskSpec, enrolment, scopeCgroupPath, wrapped } = prepared;
  let enrolmentFinished = false;
  const finishEnrolment = (outcome: Parameters<typeof finishSyncEnrolment>[1]): void => {
    // ChildProcess emits `error` followed by `close` for an asynchronous spawn
    // failure. The task ledger has one terminal transition, so make the two
    // notifications idempotent just as the in-memory snapshot transition is.
    if (enrolmentFinished) return;
    enrolmentFinished = true;
    finishSyncEnrolment(enrolment, outcome, { scopeCgroupPath });
  };
  let proc: ChildProcess;
  try {
    proc = spawn(wrapped.binary, wrapped.argv, {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Detached runs are process-group leaders. This is required both for
      // admin cancellation and for timeout recovery launched by testing:run:
      // the router may own a nested Vitest process tree.
      detached: true,
    });
  } catch (e) {
    snapshot.status = 'error';
    snapshot.exitCode = -1;
    snapshot.finishedAt = Date.now();
    snapshot.output = e instanceof Error ? e.message : String(e);
    _runs.set(snapshot.runId, { snapshot, proc: null, cwd, worktreeBefore });
    void persistRunSnapshot(snapshot);
    finishEnrolment({
      state: 'exited',
      exitCode: null,
      exitReason: `spawn error: ${e instanceof Error ? e.message : String(e)}`,
    });
    return snapshot;
  }

  const state: RunState = { snapshot, proc, cwd, worktreeBefore };
  _runs.set(snapshot.runId, state);
  if (opts.persistInitialSnapshot) void persistRunSnapshot(snapshot);

  proc.stdout?.on('data', (b: Buffer) => appendOutput(state, b.toString('utf8')));
  proc.stderr?.on('data', (b: Buffer) => appendOutput(state, b.toString('utf8')));
  proc.on('error', (e) => {
    appendOutput(state, `\n[spawn-error] ${e.message}\n`);
    state.snapshot.status = 'error';
    if (state.snapshot.finishedAt === null) state.snapshot.finishedAt = Date.now();
    void persistRunSnapshot(state.snapshot);
    void persistFallbackRow(state.snapshot, state.worktreeBefore, state.cwd);
    finishEnrolment({
      state: 'exited',
      exitCode: null,
      exitReason: `spawn error: ${e.message}`,
    });
  });
  proc.on('close', (code) => {
    state.snapshot.exitCode = code;
    state.snapshot.finishedAt = Date.now();
    if (state.snapshot.status !== 'cancelled' && state.snapshot.status !== 'error') {
      state.snapshot.status = code === 0 ? 'pass' : 'fail';
    }
    void persistRunSnapshot(state.snapshot);
    void persistFallbackRow(state.snapshot, state.worktreeBefore, state.cwd);
    finishEnrolment({
      state: state.snapshot.status === 'cancelled' ? 'killed' : 'exited',
      exitCode: code,
    });
  });

  // Registration follows a successful spawn. The process listeners above are
  // attached first so a very fast child cannot lose output or its terminal
  // lifecycle event while the asynchronous ledger write is being scheduled.
  completeSyncEnrolment(enrolment, taskSpec, proc.pid ?? null);

  return snapshot;
}

/**
 * Start a run without changing the existing synchronous API. The initial
 * snapshot is persisted best-effort after the local process-control state is
 * registered, matching the historical admin/TUI launch semantics.
 */
export function startRun(req: SpawnRequest): RunSnapshot {
  return launchPreparedRun(prepareRun(req), { persistInitialSnapshot: true });
}

/**
 * Start a detached recovery with an actionable handle before waiting on its
 * optional durable snapshot. The child must start first: a slow dynamic import
 * or database write must not consume the foreground transport margin before
 * testing:run can return `detachedRunId`.
 *
 * `durable` is true only when the initial `running` snapshot write settled
 * before this function returned. A timeout or database outage leaves the run
 * readable from this worker's local map, but callers must not promise that
 * testing:run-status can recover it after a worker restart. The persistence
 * promise continues in the background after the bounded response window.
 */
export async function startRunDurable(
  req: SpawnRequest,
  sqlOverride?: SqlLike,
): Promise<{ snapshot: RunSnapshot; durable: boolean }> {
  const prepared = prepareRun(req);
  const snapshot = launchPreparedRun(prepared, { persistInitialSnapshot: false });
  const persistence = persistRunSnapshot(snapshot, sqlOverride).catch(() => false);
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    deadlineTimer = setTimeout(() => resolve(false), DETACHED_RUN_DURABILITY_RESPONSE_BUDGET_MS);
    deadlineTimer.unref?.();
  });
  const durable = await Promise.race([persistence, deadline]);
  if (deadlineTimer) clearTimeout(deadlineTimer);
  return { snapshot, durable };
}

/**
 * P-014 fallback persistence — write one row to harness_shared.test_runs
 * for runners that have no in-process reporter (node, shell). For vitest /
 * playwright spawns the in-process reporter already writes per-file rows
 * with source='admin-ui'; this helper short-circuits in those cases to
 * avoid duplicating work.
 *
 * D-007 fail-soft: every error swallowed, never throws.
 */
async function persistFallbackRow(s: RunSnapshot, worktreeBefore: WorktreeGitSnapshot, cwd: string): Promise<void> {
  if (s.kind === 'vitest' || s.kind === 'playwright' || s.kind === 'cargo') return;
  if (s.kind === 'admin-suite') return;
  if (s.status === 'running') return;
  // Under vitest the store's own lifecycle tests spawn throwaway node/shell
  // children ('sleeper', 'no-such-bin', …); persisting those would spray junk
  // rows into whatever live DB the dev box exposes. A test that wants the
  // persistence path mocks @papercusp/db-org or sets the opt-in env.
  if (process.env.VITEST && !process.env.PAPERCUSP_TEST_RUNS_PERSIST) return;
  try {
    const filePath = s.filePath ?? s.label;
    const startedAtIso = new Date(s.startedAt).toISOString();
    const finishedAtIso = s.finishedAt ? new Date(s.finishedAt).toISOString() : null;
    const duration = s.finishedAt ? s.finishedAt - s.startedAt : null;
    const outputTail = s.output ? s.output.slice(-4096) : null;

    const worktreeAfter = captureWorktreeSnapshot(cwd);
    const worktreeDirty = computeWorktreeDirty(worktreeBefore, worktreeAfter);
    let branch: string | null = null;
    try {
      const ctx = await resolveGitContext();
      branch = ctx.branch;
    } catch {
      /* fail-soft */
    }
    // The post-run snapshot is the only commit attribution that corresponds
    // to the run's close-time tree. resolveGitContext() is cached for display
    // metadata and must not reintroduce the torn-read hazard here.
    const commit = worktreeAfter.commit;

    // WI-6583: carry the harness scope keys when the spawning context set
    // them. PAPERCUSP_TEST_RUN_HARNESS / PAPERCUSP_WORKSPACE_ID (P-007, a
    // deliberately harness-scoped dogfood run) is checked first, then the two
    // OTHER naming conventions that carry the same identity on the vast
    // majority of real runs: HARNESS_SLUG (harness-spawned agent-role
    // processes, endpoint-route/routes/harness/spawn.ts) and
    // PAPERCUSP_HARNESS_SLUG / PAPERCUSP_WORKSPACE (an interactive su/psu
    // shell session). NULL only when none apply — both columns stay nullable
    // (migration 413). Mirrors resolveTestRunHarnessSlug/WorkspaceId in
    // libs/test-config's admin-test-runs-reporter.ts (duplicated rather than
    // imported: this is production runtime code, test-config is a test-only
    // package).
    const harnessSlug =
      process.env.PAPERCUSP_TEST_RUN_HARNESS || process.env.HARNESS_SLUG || process.env.PAPERCUSP_HARNESS_SLUG || null;
    const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID || process.env.PAPERCUSP_WORKSPACE || null;
    const { loopLagP95Ms, rssMb } = captureSaturationSnapshot();
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    await Promise.race([
      sql`
        INSERT INTO harness_shared.test_runs
          (file_path, framework, status, duration_ms, started_at, finished_at, output_tail, run_group_id, source, branch, commit_sha, harness_slug, workspace_id, loop_lag_p95_ms, rss_mb, worktree_dirty)
        VALUES
          (${filePath}, ${s.kind}, ${s.status}, ${duration}, ${startedAtIso},
           ${finishedAtIso}, ${outputTail}, ${s.runId}, ${'admin-ui'}, ${branch}, ${commit}, ${harnessSlug}, ${workspaceId}, ${loopLagP95Ms}, ${rssMb}, ${worktreeDirty})
      `,
      new Promise((_, reject) => setTimeout(() => reject(new Error('pg_insert_timeout')), 1000)),
    ]).catch(() => {
      /* swallow — D-007 */
    });
  } catch {
    /* swallow — D-007 */
  }
}

export function getRun(runId: string): RunSnapshot | null {
  const s = _runs.get(runId);
  return s ? { ...s.snapshot } : null;
}

/**
 * Async local-first reader for status surfaces. A worker that owns the child
 * returns immediately from `_runs`; a sibling worker falls through to the
 * shared snapshot ledger. Missing/expired/unreadable rows remain `null`.
 */
export async function getRunAsync(runId: string, sqlOverride?: SqlLike): Promise<RunSnapshot | null> {
  evictOldRuns();
  const local = getRun(runId);
  if (local) return local;
  return readPersistedRunSnapshot(runId, sqlOverride);
}

export function cancelRun(runId: string): boolean {
  const s = _runs.get(runId);
  if (!s || !s.proc) return false;
  if (s.snapshot.status !== 'running') return false;
  s.snapshot.status = 'cancelled';
  s.snapshot.finishedAt = Date.now();
  void persistRunSnapshot(s.snapshot);
  signalRunProcess(s.proc, 'SIGTERM');
  setTimeout(() => {
    if (s.proc && s.proc.exitCode == null && !s.proc.killed) signalRunProcess(s.proc, 'SIGKILL');
  }, 5000).unref();
  return true;
}

/**
 * Cancel locally when this worker owns the process; otherwise record the
 * cancellation in the shared ledger so a sibling status surface does not
 * claim the run is still active. The local owner cannot be signalled across
 * workers by this process, so the upsert's cancellation guard prevents its
 * eventual close callback from resurrecting the durable row as pass/fail.
 */
export async function cancelRunAsync(runId: string, sqlOverride?: SqlLike): Promise<boolean> {
  if (_runs.has(runId)) return cancelRun(runId);
  const sql = await snapshotSql(sqlOverride);
  if (!sql) return false;
  const rows = await boundedSnapshotQuery<unknown[]>(sql`
    UPDATE harness_shared.testing_run_snapshots
       SET status = 'cancelled',
           finished_at = COALESCE(finished_at, now()),
           updated_at = now()
     WHERE run_id = ${runId}
       AND status = 'running'
     RETURNING run_id
  `);
  return Boolean(rows && rows.length > 0);
}

export function listRuns(limit = 50): RunSnapshot[] {
  evictOldRuns();
  return Array.from(_runs.values())
    .map((s) => ({ ...s.snapshot }))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
}

// ── P-007/P-020: harness Tests-tab ingestion ──────────────────────────────
//
// The harness run route (routes/harness/testing.ts) runs vitest INSIDE the
// operator (which has DB access) with a JSON reporter alongside the human one.
// It parses the JSON into one row per test FILE and persists each to
// harness_shared.test_runs stamped with harness_slug + workspace_id, so EVERY
// managed hive's Tests tab can render its own run history with NO per-repo
// scaffolding and NO backfill. This is the run-route INGESTION half; the
// completion-gate half is the global papercusp-test-completion-gate flag (P-006),
// so coding-hive instantiation needs no separate gate wiring.
//
// ⚠ That "stamped with harness_slug + workspace_id" claim is true ONLY for rows ingested
// through THIS route. It does NOT hold for the table as a whole: the separate CI/dogfood-admin-ui
// vitest reporter (libs/test-config/src/admin-test-runs-reporter.ts) writes to the SAME
// harness_shared.test_runs table but derives both columns from env vars that gate/CI runs never
// set, so every row from that writer has workspace_id/harness_slug NULL. A reader of the comment
// above alone would reasonably (and wrongly) conclude the whole table is scoped — that is exactly
// what produced the tenant-scope advisory bug in EI-19324633485547042: applying a
// workspace_id/harness_slug predicate to gate-triage rows silently excludes every one of them and
// reads as a clean "no failures". For CI/gate-population reads, scope by source/commit_sha
// instead (see buildTestRunsAdvisory in pg-read-query.ts).

/** One per-file row distilled from a vitest JSON report. */
export interface HarnessTestFileRow {
  /** Worktree-root-relative POSIX path — matches the panel's history query key. */
  filePath: string;
  /** Executor family recorded in test_runs.framework. Vitest remains the default. */
  framework?: 'vitest' | 'playwright' | 'node' | 'shell' | 'cargo' | 'operational';
  status: 'pass' | 'fail' | 'skip' | 'error';
  durationMs: number | null;
  startedAt: Date;
  finishedAt: Date;
  outputTail: string | null;
}

/** Minimal shape of the jest-compatible vitest `--reporter=json` output. */
interface VitestJsonAssertion {
  status?: string;
  duration?: number | null;
  failureMessages?: unknown;
  title?: string;
  fullName?: string;
}
interface VitestJsonFile {
  name?: string;
  status?: string;
  startTime?: number;
  endTime?: number;
  message?: string;
  assertionResults?: VitestJsonAssertion[];
}

function relToRootPosix(absPath: string, rootAbs: string): string {
  const rel = pathRelative(rootAbs, absPath);
  return rel.split(/[/\\]/).join(posix.sep);
}

/**
 * Parse a vitest `--reporter=json` report into one {@link HarnessTestFileRow}
 * per test file. `rootAbs` is the worktree the run executed in; absolute file
 * paths from the reporter are relativized to root-relative POSIX so they match
 * the Tests-tab panel's history-query key (expandGlobs output).
 *
 * Pure + defensive: malformed JSON or an unexpected shape yields []. A
 * non-vitest report (no `testResults`) likewise yields [] — best-effort skip.
 */
export function parseVitestJsonForHarnessRows(jsonText: string, rootAbs: string): HarnessTestFileRow[] {
  let parsed: { testResults?: VitestJsonFile[] };
  try {
    parsed = JSON.parse(jsonText) as { testResults?: VitestJsonFile[] };
  } catch {
    return [];
  }
  const files = Array.isArray(parsed.testResults) ? parsed.testResults : [];
  const rows: HarnessTestFileRow[] = [];
  for (const f of files) {
    if (!f || typeof f.name !== 'string' || f.name.length === 0) continue;
    const filePath = relToRootPosix(f.name, rootAbs);

    const asserts = Array.isArray(f.assertionResults) ? f.assertionResults : [];
    let status: HarnessTestFileRow['status'];
    if (f.status === 'failed') {
      status = 'fail';
    } else if (f.status === 'passed') {
      // A file vitest marks "passed" whose every test was skipped/todo is a
      // skip row, not a pass — surface that distinctly in the history chip.
      const hasReal = asserts.some((a) => a.status !== 'skipped' && a.status !== 'pending' && a.status !== 'todo');
      status = asserts.length > 0 && !hasReal ? 'skip' : 'pass';
    } else if (f.status === 'skipped' || f.status === 'pending' || f.status === 'todo') {
      status = 'skip';
    } else {
      // Unknown / never-finished (e.g. an import-time crash) → error.
      status = 'error';
    }

    const start = typeof f.startTime === 'number' ? f.startTime : null;
    const end = typeof f.endTime === 'number' ? f.endTime : null;
    const finishedAt = end !== null ? new Date(end) : new Date();
    const durationMs = start !== null && end !== null ? Math.max(0, Math.round(end - start)) : null;
    const startedAt = start !== null ? new Date(start) : new Date(finishedAt.getTime() - (durationMs ?? 0));

    // Best-effort failure tail for the history sheet.
    let outputTail: string | null = null;
    const msgs: string[] = [];
    if (typeof f.message === 'string' && f.message.trim()) msgs.push(f.message.trim());
    for (const a of asserts) {
      if (a.status === 'failed' && Array.isArray(a.failureMessages)) {
        for (const m of a.failureMessages) if (typeof m === 'string') msgs.push(m);
      }
    }
    if (msgs.length > 0) outputTail = msgs.join('\n').slice(-4000);

    rows.push({ filePath, status, durationMs, startedAt, finishedAt, outputTail });
  }
  return rows;
}

// ── P-021: the AGENT-facing distillation ──────────────────────────────────
//
// `parseVitestJsonForHarnessRows` above answers the Tests-tab's question ("one
// row per FILE, for history"). An agent asks a different one: "did it pass, and
// if not, which TEST failed and why". D-021 measured that gap: 84.8% of the
// 2,620 test-running commands in the 7d corpus pipe their output to `tail`/
// `head` and 81.7% merge stderr into that pipe, because the only way to answer
// the second question today is to eyeball raw reporter output through a
// hand-chosen line budget (median `tail -60`).
//
// So this is a SECOND PURE PROJECTION over the SAME parsed JSON, not a second
// parser and never a stdout scrape (D-022). The two differ only in grain:
// `parseVitestJsonForHarnessRows` collapses every failure message into a
// 4000-char `outputTail` and DISCARDS `assertionResults[].fullName`; this one
// keeps the test identity and drops everything the agent will not read.

/** One failing test, identified precisely enough to re-run it with `-t`. */
export interface DistilledTestFailure {
  /** Root-relative POSIX path of the file the failing test lives in. */
  file: string;
  /**
   * The failing test's full name (`describe > it`), from `fullName`, falling
   * back to `title`. {@link COLLECTION_FAILURE_TEST} when the file never
   * produced assertions at all — see the note on that constant.
   */
  test: string;
  /** First failure message, trimmed to `maxMessageChars`. */
  message: string;
  /** Structured assertion value captured by the optional test-run sidecar. */
  actual?: string;
  /** Structured assertion value captured by the optional test-run sidecar. */
  expected?: string;
}

/** One structured assertion detail emitted by admin-test-runs-reporter. */
export interface TestFailureDetail {
  file: string;
  test: string;
  message?: string;
  actual?: string;
  expected?: string;
}

/**
 * A test file that threw at import/collection time has NO assertionResults —
 * its error lives only in the file-level `message`. That is simultaneously the
 * most confusing failure class (Vitest 4 prints nothing per-suite when two or
 * more collide — EI-18099113673609528, which `scripts/test-files.mjs` carries a
 * whole recovery path for) and the one a naive per-test projection drops
 * ENTIRELY, reporting `failed: 0` for a run that failed. Surfacing it under a
 * reserved pseudo-test name is what keeps this projection honest.
 */
export const COLLECTION_FAILURE_TEST = '(file failed to collect)';

/** The distilled envelope P-021 returns instead of raw reporter output. */
export interface DistilledTestRun {
  /** Tests that passed, summed across files (NOT files — the file grain lives in test_runs). */
  passed: number;
  failed: number;
  skipped: number;
  /** Test FILES the run covered — the router's `matched` count, from the report itself. */
  files: number;
  failures: DistilledTestFailure[];
  /** True when `failures` was capped; the counts above always remain complete. */
  failuresTruncated: boolean;
  /** Wall-clock span of the run (max endTime - min startTime), null if unreported. */
  durationMs: number | null;
  /**
   * Per-FILE counts, keyed by the same repo-root-relative POSIX path `failures[].file`
   * uses. Complete even when `failures` is capped — which is the whole point: it lets a
   * caller that batched several files into ONE run attribute a verdict back to each file
   * WITHOUT trusting the (truncatable) failure list. Reading a file's verdict off
   * `failures` alone is unsound: once the cap trips, a genuinely failing file can be
   * absent from that list and would read as a pass. `collectionFailed` marks a file that
   * failed without producing a failing assertion, so `failed: 0` there still means red.
   */
  byFile: Record<string, { passed: number; failed: number; skipped: number; collectionFailed: boolean }>;
}

/** Budgets chosen from D-021's measurement: agents keep a median of 60 output
 *  lines, so ~20 failures at ~1.2KB each stays inside the context they were
 *  already willing to spend, while carrying strictly more signal. */
const DEFAULT_MAX_FAILURES = 20;
const DEFAULT_MAX_MESSAGE_CHARS = 1200;
const FAILURE_DETAIL_MAX_CHARS = 4_000;
const FAILURE_DETAILS_MAX_RECORDS = 2_000;

function stringifyFailureDetail(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value.slice(0, FAILURE_DETAIL_MAX_CHARS);
  try {
    const seen = new WeakSet<object>();
    const encoded = JSON.stringify(value, (_key, child: unknown) => {
      if (typeof child === 'bigint') return `${child}n`;
      if (typeof child === 'object' && child !== null) {
        if (seen.has(child)) return '[Circular]';
        seen.add(child);
      }
      return child;
    });
    if (encoded !== undefined) return encoded.slice(0, FAILURE_DETAIL_MAX_CHARS);
  } catch {
    /* fail-soft */
  }
  try {
    return String(value).slice(0, FAILURE_DETAIL_MAX_CHARS);
  } catch {
    return undefined;
  }
}

/**
 * Parse the optional reporter sidecar. It is intentionally independent of the
 * JSON reporter schema: Vitest's JSON projection can elide object diffs while
 * TestCase.result().errors still carries the useful actual/expected values.
 */
export function parseFailureDetailsSidecar(jsonText: string, rootAbs: string): TestFailureDetail[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const raw = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { failures?: unknown }).failures)
      ? (parsed as { failures: unknown[] }).failures
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { details?: unknown }).details)
        ? (parsed as { details: unknown[] }).details
        : [];
  const details = new Map<string, TestFailureDetail>();
  for (const entry of raw.slice(0, FAILURE_DETAILS_MAX_RECORDS)) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;
    if (typeof value.file !== 'string' || !value.file || typeof value.test !== 'string' || !value.test) continue;
    const file = isAbsolute(value.file) ? relToRootPosix(value.file, rootAbs) : value.file.replaceAll('\\', '/');
    const detail: TestFailureDetail = { file, test: value.test };
    for (const field of ['message', 'actual', 'expected'] as const) {
      const text = stringifyFailureDetail(value[field]);
      if (text !== undefined) detail[field] = text;
    }
    const key = `${detail.file}\u0000${detail.test}`;
    const previous = details.get(key);
    details.set(key, {
      ...(previous ?? {}),
      ...detail,
      ...(previous?.message && detail.message === undefined ? { message: previous.message } : {}),
      ...(previous?.actual !== undefined && detail.actual === undefined ? { actual: previous.actual } : {}),
      ...(previous?.expected !== undefined && detail.expected === undefined ? { expected: previous.expected } : {}),
    });
  }
  return [...details.values()];
}

/** Alias kept descriptive for callers that use the Vitest terminology. */
export const parseVitestFailureDetails = parseFailureDetailsSidecar;

function enrichFailure(failure: DistilledTestFailure, detail: TestFailureDetail | undefined): DistilledTestFailure {
  if (!detail) return failure;
  return {
    ...failure,
    ...(detail.actual !== undefined ? { actual: detail.actual } : {}),
    ...(detail.expected !== undefined ? { expected: detail.expected } : {}),
    ...(detail.message && failure.message === '(no failure message reported)' ? { message: detail.message } : {}),
  };
}

/**
 * Distil a vitest `--reporter=json` report into the agent-facing envelope.
 *
 * Pure + defensive, exactly like its sibling: malformed JSON or an unexpected
 * shape yields an empty, all-zero run rather than throwing — a distillation
 * failure must never be reported as a test failure.
 *
 * @param jsonText raw `--reporter=json` output
 * @param rootAbs the worktree the run executed in (absolute paths are relativized against it)
 */
export function distillVitestRun(
  jsonText: string,
  rootAbs: string,
  opts?: { maxFailures?: number; maxMessageChars?: number; failureDetails?: readonly TestFailureDetail[] },
): DistilledTestRun {
  const maxFailures = opts?.maxFailures ?? DEFAULT_MAX_FAILURES;
  const maxMessageChars = opts?.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
  const empty: DistilledTestRun = {
    passed: 0,
    failed: 0,
    skipped: 0,
    files: 0,
    failures: [],
    failuresTruncated: false,
    durationMs: null,
    byFile: {},
  };

  let parsed: { testResults?: VitestJsonFile[] };
  try {
    parsed = JSON.parse(jsonText) as { testResults?: VitestJsonFile[] };
  } catch {
    return empty;
  }
  const files = Array.isArray(parsed.testResults) ? parsed.testResults : [];
  if (files.length === 0) return empty;

  const out: DistilledTestRun = { ...empty, failures: [], byFile: {} };
  const detailByKey = new Map(
    (opts?.failureDetails ?? []).map((detail) => [`${detail.file}\u0000${detail.test}`, detail] as const),
  );
  let minStart: number | null = null;
  let maxEnd: number | null = null;

  for (const f of files) {
    if (!f || typeof f.name !== 'string' || f.name.length === 0) continue;
    out.files += 1;
    const file = relToRootPosix(f.name, rootAbs);
    // One bucket per reported file, created even for a file with zero assertions, so a
    // caller can tell "this file ran and reported nothing" from "this file never ran".
    const bucket = (out.byFile[file] ??= { passed: 0, failed: 0, skipped: 0, collectionFailed: false });

    if (typeof f.startTime === 'number') minStart = minStart === null ? f.startTime : Math.min(minStart, f.startTime);
    if (typeof f.endTime === 'number') maxEnd = maxEnd === null ? f.endTime : Math.max(maxEnd, f.endTime);

    const asserts = Array.isArray(f.assertionResults) ? f.assertionResults : [];
    for (const a of asserts) {
      if (!a) continue;
      if (a.status === 'failed') {
        out.failed += 1;
        bucket.failed += 1;
        const message = (Array.isArray(a.failureMessages) ? a.failureMessages : []).find(
          (m): m is string => typeof m === 'string' && m.trim().length > 0,
        );
        if (out.failures.length < maxFailures) {
          out.failures.push(
            enrichFailure(
              {
                file,
                test: (a.fullName ?? a.title ?? '(unnamed test)').trim() || '(unnamed test)',
                message: (message ?? '(no failure message reported)').trim().slice(0, maxMessageChars),
              },
              detailByKey.get(`${file}\u0000${(a.fullName ?? a.title ?? '(unnamed test)').trim() || '(unnamed test)'}`),
            ),
          );
        } else {
          out.failuresTruncated = true;
        }
      } else if (a.status === 'skipped' || a.status === 'pending' || a.status === 'todo') {
        out.skipped += 1;
        bucket.skipped += 1;
      } else if (a.status === 'passed') {
        out.passed += 1;
        bucket.passed += 1;
      }
    }

    // The collection-failure case: the file is failed but produced no failing
    // assertion to attribute it to. Without this branch the run reports
    // `failed: 0` while the suite is red — see COLLECTION_FAILURE_TEST.
    const hasFailingAssertion = asserts.some((a) => a?.status === 'failed');
    if (f.status === 'failed' && !hasFailingAssertion) {
      out.failed += 1;
      bucket.failed += 1;
      bucket.collectionFailed = true;
      if (out.failures.length < maxFailures) {
        out.failures.push(
          enrichFailure(
            {
              file,
              test: COLLECTION_FAILURE_TEST,
              message: (typeof f.message === 'string' && f.message.trim()
                ? f.message.trim()
                : '(no failure message reported)'
              ).slice(0, maxMessageChars),
            },
            detailByKey.get(`${file}\u0000${COLLECTION_FAILURE_TEST}`),
          ),
        );
      } else {
        out.failuresTruncated = true;
      }
    }
  }

  out.durationMs = minStart !== null && maxEnd !== null ? Math.max(0, Math.round(maxEnd - minStart)) : null;
  return out;
}

/**
 * Merge the per-group distilled runs of ONE logical test run into a single result.
 *
 * EI-18822211427354845: `scripts/test-files.mjs` routes a multi-workspace request into
 * one `vitest run` PER owning workspace config, so a run spanning N workspaces produces
 * N JSON reports, not one. The caller previously read a single report path and reported
 * that group as if it were the whole run — a two-workspace request whose first group was
 * RED came back `passed:7, failed:0, failures:[]`, describing only the second group.
 *
 * Counts sum. `failures` concatenates, re-applying `maxFailures` across the COMBINED list
 * so the cap means the same thing it does for one group; `failuresTruncated` is sticky —
 * true if any input truncated OR the merge itself cut the list. `durationMs` sums, because
 * the router runs groups SEQUENTIALLY (a max would under-report a multi-group run); it
 * stays null only when every group reported null.
 */
export function mergeDistilledRuns(runs: DistilledTestRun[], opts?: { maxFailures?: number }): DistilledTestRun {
  const maxFailures = opts?.maxFailures ?? DEFAULT_MAX_FAILURES;
  const merged: DistilledTestRun = {
    passed: 0,
    failed: 0,
    skipped: 0,
    files: 0,
    failures: [],
    failuresTruncated: false,
    durationMs: null,
    byFile: {},
  };
  let sawDuration = false;
  let durationTotal = 0;

  for (const run of runs) {
    if (!run) continue;
    merged.passed += run.passed;
    merged.failed += run.failed;
    merged.skipped += run.skipped;
    merged.files += run.files;
    if (run.failuresTruncated) merged.failuresTruncated = true;
    // Per-file grain must survive the merge, or a caller that batched files spanning
    // several ROUTER GROUPS (each group is its own vitest config, run sequentially) would
    // get a merged report whose byFile is missing every group after the first. A file is
    // only ever reported by the one group that owns it, so a plain accumulate is right;
    // the += guards the pathological case of the same file appearing twice.
    for (const [file, b] of Object.entries(run.byFile ?? {})) {
      const bucket = (merged.byFile[file] ??= { passed: 0, failed: 0, skipped: 0, collectionFailed: false });
      bucket.passed += b.passed;
      bucket.failed += b.failed;
      bucket.skipped += b.skipped;
      if (b.collectionFailed) bucket.collectionFailed = true;
    }
    for (const failure of run.failures) {
      if (merged.failures.length < maxFailures) merged.failures.push(failure);
      else merged.failuresTruncated = true;
    }
    if (typeof run.durationMs === 'number') {
      sawDuration = true;
      durationTotal += run.durationMs;
    }
  }

  merged.durationMs = sawDuration ? durationTotal : null;
  return merged;
}

/**
 * The BYTE ceiling on a `testing:run` result (plan
 * `bash-substitution-reachable-ceiling-2026-08-01`, D-062).
 *
 * DERIVED, NOT CHOSEN — do not round it to a convenient number. 5,949 B is the
 * hard cap `| tail -60` imposes on the bash command this tool replaces (the
 * median pipe agents actually write, per D-021). The promotion argument needs
 * per-call DOMINANCE, not a better average: an average lets the tool be worse
 * exactly when a suite fails badly and the agent can least afford it. Measured
 * before this bound existed, `testing:run` reached 20,569 B, with 2.6% of calls
 * carrying 28.7% of all its bytes.
 *
 * WHY `maxFailures` COULD NOT DO THIS. `maxFailures` caps the failure LIST
 * COUNT, which is not a byte bound in any sense — one long assertion diff can
 * outweigh fifty terse failures. That is the whole reason D-062 had to settle
 * the parameter before anyone coded it.
 */
export const TESTING_RUN_MAX_PAYLOAD_BYTES = 5949;

/**
 * Message-length ladder tried before any failure is DROPPED.
 *
 * Order matters and encodes a judgement: knowing WHICH tests failed is worth
 * more than the full text of any one failure, so we shrink messages across the
 * board before we stop naming failures at all. An agent who still needs the
 * full diff can re-run one file (or pass `testNamePattern`) — but it cannot
 * re-discover a failure whose existence was never reported.
 */
const MESSAGE_BUDGET_LADDER = [1200, 600, 300, 150, 80, 40] as const;

/** Bytes of a value as it will actually be transported. */
function payloadBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

function clampFailureText(text: string, chars: number): string {
  if (chars <= 0) return '';
  if (text.length <= chars) return text;
  return `${text.slice(0, Math.max(0, chars - 1))}…`;
}

function clampFailureMessage(f: DistilledTestFailure, chars: number): DistilledTestFailure {
  return {
    ...f,
    message: clampFailureText(f.message, chars),
    ...(f.actual !== undefined ? { actual: clampFailureText(f.actual, chars) } : {}),
    ...(f.expected !== undefined ? { expected: clampFailureText(f.expected, chars) } : {}),
  };
}

/**
 * Bound a `testing:run` result to {@link TESTING_RUN_MAX_PAYLOAD_BYTES} BYTES,
 * keeping every COUNT complete and stating plainly what was cut (D-062).
 *
 * ── The invariant this exists to protect ────────────────────────────────────
 * `failed` is ALWAYS the true total number of failing tests. `failures` is a
 * bounded SAMPLE of them. Those are different objects, and reading the second
 * as the first is exactly the error class filed as EI-19340874432965755 ("a
 * signal that is TRUE, about a different object than it was read as"). So when
 * this function cuts anything it emits `failuresReturned`, `failuresOmitted`
 * and a human-readable `truncationNote` — `failures.length` can then never be
 * mistaken for "how many failed", because the payload says both numbers out
 * loud.
 *
 * ── Why the un-truncated path adds NOTHING ──────────────────────────────────
 * The verification criterion for this change (plan Now/next) is that the max
 * drops to ≤5,949 B while the MEDIAN stays unmoved near 197 B — a median that
 * moves means the bound is clipping ordinary results and is set too low. The
 * median call is a green run with zero failures, so adding explanatory fields
 * unconditionally would move the very number that certifies the change is
 * correct. Hence: when nothing is cut, the payload is returned byte-identical
 * to what it was before this function existed.
 */
export function boundTestRunPayload<E extends Record<string, unknown>>(
  envelope: E,
  run: DistilledTestRun,
  opts?: { maxBytes?: number },
): E &
  DistilledTestRun & {
    failuresReturned?: number;
    failuresOmitted?: number;
    truncationNote?: string;
  } {
  const budget = opts?.maxBytes ?? TESTING_RUN_MAX_PAYLOAD_BYTES;

  const build = (failures: DistilledTestFailure[], truncated: boolean) => {
    const base = { ...envelope, ...run, failures, failuresTruncated: run.failuresTruncated || truncated };
    if (!base.failuresTruncated) return base;
    const omitted = Math.max(0, run.failed - failures.length);
    return {
      ...base,
      failuresReturned: failures.length,
      failuresOmitted: omitted,
      truncationNote:
        `showing ${failures.length} of ${run.failed} failing test(s); the counts above are COMPLETE — ` +
        `\`failures.length\` is a bounded sample, not how many failed. ` +
        `Payload bounded to ${budget} B. Re-run one file, or pass testNamePattern, for the full text.`,
    };
  };

  // Fast path: it already fits. Return it untouched so the common green result
  // keeps the exact shape (and byte count) it had before this bound existed.
  const asIs = build(run.failures, false);
  if (payloadBytes(asIs) <= budget) return asIs;

  // Lever 1 — shrink every message, preserving the full list of WHICH tests failed.
  for (const chars of MESSAGE_BUDGET_LADDER) {
    const candidate = build(
      run.failures.map((f) => clampFailureMessage(f, chars)),
      true,
    );
    if (payloadBytes(candidate) <= budget) return candidate;
  }

  // Lever 2 — still over: drop failures from the end at the tightest clamp.
  const tightest = MESSAGE_BUDGET_LADDER[MESSAGE_BUDGET_LADDER.length - 1];
  let kept = run.failures.map((f) => clampFailureMessage(f, tightest));
  while (kept.length > 1) {
    kept = kept.slice(0, -1);
    const candidate = build(kept, true);
    if (payloadBytes(candidate) <= budget) return candidate;
  }

  // Lever 3 — a single failure whose own name/path still overruns. Never report
  // zero failures for a red run: give the one survivor whatever budget is left,
  // even if that is no message at all. If the envelope ALONE exceeds the budget
  // there is nothing further to trim, and an honest over-budget result beats a
  // silent claim that nothing failed.
  if (kept.length === 1) {
    const headroom = budget - payloadBytes(build([{ ...kept[0], message: '', actual: '', expected: '' }], true));
    if (headroom > 0) {
      const fitted = clampFailureMessage(kept[0], Math.max(0, Math.min(kept[0].message.length, headroom - 8)));
      const candidate = build([fitted], true);
      if (payloadBytes(candidate) <= budget) return candidate;
    }
    return build([{ ...kept[0], message: '', actual: '', expected: '' }], true);
  }
  return build(kept, true);
}

export interface PersistHarnessTestRunsParams {
  harnessSlug: string;
  workspaceId: string;
  rows: HarnessTestFileRow[];
  runGroupId: string;
  branch?: string | null;
  commit?: string | null;
  /** test_runs.source — must satisfy the CHECK ('ci'|'local'|'admin-ui'); defaults to 'admin-ui'. */
  source?: 'ci' | 'local' | 'admin-ui';
  /** EI-18795303393201472: true when the run executed against a working tree that
   *  wasn't provably stable start-to-finish (see computeWorktreeDirty) — the stamped
   *  `commit` can't be trusted as the code that actually ran. Defaults to false ONLY
   *  for callers that never had the hazard (an isolated-checkout run); a caller that
   *  ran against the shared tree should always pass this explicitly. */
  worktreeDirty?: boolean;
  /** Test seam: inject a fake sql client. Defaults to getOrgPg().sql. */
  sql?: SqlLike;
}

export interface PersistHarnessTestRunsResult {
  written: number;
  ids: number[];
}

export interface HarnessTestRunIdQuery {
  harnessSlug: string;
  workspaceId: string;
  runGroupId: string;
  filePath?: string;
  sql?: SqlLike;
}

function positiveSafeInteger(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

/**
 * Resolve the numeric execution-ledger rows for one exact, tenant-scoped run
 * group. This is the shared readback seam for testing:run and the operational
 * recorder; callers never have to hand-query test_runs to obtain bindable IDs.
 */
export async function findHarnessTestRunIds(params: HarnessTestRunIdQuery): Promise<number[]> {
  try {
    let sql = params.sql;
    if (!sql) {
      const { getOrgPg } = await import('@papercusp/db-org');
      sql = getOrgPg().sql as unknown as SqlLike;
    }
    const rows = await sql`
      SELECT id
        FROM harness_shared.test_runs
       WHERE workspace_id = ${params.workspaceId}
         AND harness_slug = ${params.harnessSlug}
         AND run_group_id = ${params.runGroupId}
         AND (${params.filePath ?? null}::text IS NULL OR file_path = ${params.filePath ?? null})
       ORDER BY id`;
    if (!Array.isArray(rows)) return [];
    return rows
      .map((row) => positiveSafeInteger((row as { id?: unknown })?.id))
      .filter((id): id is number => id !== null);
  } catch {
    return [];
  }
}

/**
 * Persist per-file harness test rows to harness_shared.test_runs, stamped with
 * harness_slug + workspace_id (migration 413). Returns the number of rows
 * written. D-007 fail-soft: a DB/parse error never throws — a failed run-tab
 * ingestion must NOT break the test run. The count-only compatibility wrapper
 * bounds each insert at 1s; the exact-ID variant below waits for its RETURNING
 * result so it cannot report a false negative after a late commit.
 */
export async function persistHarnessTestRuns(params: PersistHarnessTestRunsParams): Promise<number> {
  return (await persistHarnessTestRunsInternal(params, { timeoutMs: TEST_RUN_PERSIST_TIMEOUT_MS })).written;
}

/**
 * The ID-returning form used when a caller must bind the execution to an exact
 * spec-evidence row. Keep persistHarnessTestRuns as the count-only compatibility
 * wrapper for existing Tests-tab callers. It intentionally waits for the
 * INSERT result: Promise.race does not cancel a timed-out query, so racing this
 * exact-ID path can commit a row after returning `{ written: 0, ids: [] }` and
 * make an already-persisted operational run report `ledger_write_failed`.
 */
export async function persistHarnessTestRunsWithIds(
  params: PersistHarnessTestRunsParams,
): Promise<PersistHarnessTestRunsResult> {
  return persistHarnessTestRunsInternal(params);
}

async function persistHarnessTestRunsInternal(
  params: PersistHarnessTestRunsParams,
  options: { timeoutMs?: number } = {},
): Promise<PersistHarnessTestRunsResult> {
  const { harnessSlug, workspaceId, rows, runGroupId } = params;
  if (rows.length === 0) return { written: 0, ids: [] };
  const source = params.source ?? 'admin-ui';
  const branch = params.branch ?? null;
  const commit = params.commit ?? null;
  const worktreeDirty = params.worktreeDirty ?? false;
  // Captured ONCE for the whole persist call (the run's persist moment), not
  // per-file-row — the lag gauge already windows/averages, and a re-sample per
  // row would be noise without adding signal.
  const { loopLagP95Ms, rssMb } = captureSaturationSnapshot();
  let written = 0;
  const ids: number[] = [];
  try {
    let sql = params.sql;
    if (!sql) {
      const { getOrgPg } = await import('@papercusp/db-org');
      sql = getOrgPg().sql as unknown as SqlLike;
    }
    for (const row of rows) {
      const insert = Promise.resolve(
        sql`
          INSERT INTO harness_shared.test_runs
            (file_path, framework, status, duration_ms, started_at, finished_at, output_tail, run_group_id, source, branch, commit_sha, harness_slug, workspace_id, loop_lag_p95_ms, rss_mb, worktree_dirty)
          VALUES
            (${row.filePath}, ${row.framework ?? 'vitest'}, ${row.status}, ${row.durationMs}, ${row.startedAt},
             ${row.finishedAt}, ${row.outputTail}, ${runGroupId}, ${source}, ${branch}, ${commit}, ${harnessSlug}, ${workspaceId}, ${loopLagP95Ms}, ${rssMb}, ${worktreeDirty})
          RETURNING id
        `,
      );
      const inserted = await (options.timeoutMs === undefined
        ? insert
        : Promise.race([
            insert,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('pg_insert_timeout')), options.timeoutMs),
            ),
          ])
      )
        .then((result) => {
          written++;
          return result;
        })
        .catch(() => {
          /* swallow — D-007 */
          return null;
        });
      const id = Array.isArray(inserted)
        ? positiveSafeInteger((inserted[0] as { id?: unknown } | undefined)?.id)
        : null;
      if (id !== null) ids.push(id);
    }
  } catch {
    /* swallow — D-007 */
  }
  return { written, ids };
}

/** INTERNAL — test-only. Wipe the store. */
export function _resetTestingRunStore(): void {
  for (const s of _runs.values()) {
    if (s.proc && !s.proc.killed) {
      try {
        s.proc.kill('SIGKILL');
      } catch {
        /* swallow */
      }
    }
  }
  _runs.clear();
  lastSnapshotPruneAt = 0;
}
