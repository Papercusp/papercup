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
import { relative as pathRelative, posix } from 'node:path';
import { inferWorkspaceRoot } from './testing-domain-glob';
import { resolveGitContext } from './testing-branch-resolve';

export type RunStatus = 'running' | 'pass' | 'fail' | 'cancelled' | 'error';

export interface RunSnapshot {
  runId: string;
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
}

const _runs = new Map<string, RunState>();
const OUTPUT_CAP_BYTES = 16 * 1024;
const EVICTION_MS = 60 * 60 * 1000;

function evictOldRuns(): void {
  const cutoff = Date.now() - EVICTION_MS;
  for (const [id, s] of _runs) {
    if (s.snapshot.finishedAt !== null && s.snapshot.finishedAt < cutoff) {
      _runs.delete(id);
    }
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
}

export function startRun(req: SpawnRequest): RunSnapshot {
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

  const cwd = req.cwd ?? inferWorkspaceRoot();
  let proc: ChildProcess;
  try {
    proc = spawn(req.command, req.args, {
      cwd,
      env: {
        ...process.env,
        PAPERCUSP_TEST_RUN_GROUP: runId,
        // P-014: tell the in-process reporter (vitest/playwright) to stamp
        // rows with source='admin-ui' instead of inferring ci/local. For
        // node/shell runners we additionally write a single fallback row
        // from this store at close (see persistFallbackRow below).
        PAPERCUSP_TEST_RUN_SOURCE: 'admin-ui',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    snapshot.status = 'error';
    snapshot.exitCode = -1;
    snapshot.finishedAt = Date.now();
    snapshot.output = e instanceof Error ? e.message : String(e);
    _runs.set(runId, { snapshot, proc: null });
    return snapshot;
  }

  const state: RunState = { snapshot, proc };
  _runs.set(runId, state);

  proc.stdout?.on('data', (b: Buffer) => appendOutput(state, b.toString('utf8')));
  proc.stderr?.on('data', (b: Buffer) => appendOutput(state, b.toString('utf8')));
  proc.on('error', (e) => {
    appendOutput(state, `\n[spawn-error] ${e.message}\n`);
    state.snapshot.status = 'error';
    if (state.snapshot.finishedAt === null) state.snapshot.finishedAt = Date.now();
    void persistFallbackRow(state.snapshot);
  });
  proc.on('close', (code) => {
    state.snapshot.exitCode = code;
    state.snapshot.finishedAt = Date.now();
    if (state.snapshot.status !== 'cancelled') {
      state.snapshot.status = code === 0 ? 'pass' : 'fail';
    }
    void persistFallbackRow(state.snapshot);
  });

  return snapshot;
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
async function persistFallbackRow(s: RunSnapshot): Promise<void> {
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

    let branch: string | null = null;
    let commit: string | null = null;
    try {
      const ctx = await resolveGitContext();
      branch = ctx.branch;
      commit = ctx.commit;
    } catch { /* fail-soft */ }

    // P-007: carry the harness scope keys when the spawning context set them
    // (PAPERCUSP_TEST_RUN_HARNESS / PAPERCUSP_WORKSPACE_ID). NULL for the plain
    // dogfood/admin-ui path — both columns are nullable (migration 413).
    const harnessSlug = process.env.PAPERCUSP_TEST_RUN_HARNESS || null;
    const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID || null;
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    await Promise.race([
      sql`
        INSERT INTO harness_shared.test_runs
          (file_path, framework, status, duration_ms, started_at, finished_at, output_tail, run_group_id, source, branch, commit_sha, harness_slug, workspace_id)
        VALUES
          (${filePath}, ${s.kind}, ${s.status}, ${duration}, ${startedAtIso},
           ${finishedAtIso}, ${outputTail}, ${s.runId}, ${'admin-ui'}, ${branch}, ${commit}, ${harnessSlug}, ${workspaceId})
      `,
      new Promise((_, reject) => setTimeout(() => reject(new Error('pg_insert_timeout')), 1000)),
    ]).catch(() => { /* swallow — D-007 */ });
  } catch { /* swallow — D-007 */ }
}

export function getRun(runId: string): RunSnapshot | null {
  const s = _runs.get(runId);
  return s ? { ...s.snapshot } : null;
}

export function cancelRun(runId: string): boolean {
  const s = _runs.get(runId);
  if (!s || !s.proc) return false;
  if (s.snapshot.status !== 'running') return false;
  s.snapshot.status = 'cancelled';
  s.snapshot.finishedAt = Date.now();
  try {
    s.proc.kill('SIGTERM');
    setTimeout(() => {
      if (s.proc && !s.proc.killed) s.proc.kill('SIGKILL');
    }, 5000).unref();
  } catch {
    /* swallow */
  }
  return true;
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

/** One per-file row distilled from a vitest JSON report. */
export interface HarnessTestFileRow {
  /** Worktree-root-relative POSIX path — matches the panel's history query key. */
  filePath: string;
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
export function parseVitestJsonForHarnessRows(
  jsonText: string,
  rootAbs: string,
): HarnessTestFileRow[] {
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
      const hasReal = asserts.some(
        (a) => a.status !== 'skipped' && a.status !== 'pending' && a.status !== 'todo',
      );
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

/** A postgres-js-like tagged-template client; injectable so the persist path is unit-testable. */
type SqlLike = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown>;

export interface PersistHarnessTestRunsParams {
  harnessSlug: string;
  workspaceId: string;
  rows: HarnessTestFileRow[];
  runGroupId: string;
  branch?: string | null;
  commit?: string | null;
  /** test_runs.source — must satisfy the CHECK ('ci'|'local'|'admin-ui'); defaults to 'admin-ui'. */
  source?: 'ci' | 'local' | 'admin-ui';
  /** Test seam: inject a fake sql client. Defaults to getOrgPg().sql. */
  sql?: SqlLike;
}

/**
 * Persist per-file harness test rows to harness_shared.test_runs, stamped with
 * harness_slug + workspace_id (migration 413). Returns the number of rows
 * written. D-007 fail-soft: a DB/parse error never throws — a failed run-tab
 * ingestion must NOT break the test run. Each insert has a 1s timeout.
 */
export async function persistHarnessTestRuns(
  params: PersistHarnessTestRunsParams,
): Promise<number> {
  const { harnessSlug, workspaceId, rows, runGroupId } = params;
  if (rows.length === 0) return 0;
  const source = params.source ?? 'admin-ui';
  const branch = params.branch ?? null;
  const commit = params.commit ?? null;
  let written = 0;
  try {
    let sql = params.sql;
    if (!sql) {
      const { getOrgPg } = await import('@papercusp/db-org');
      sql = getOrgPg().sql as unknown as SqlLike;
    }
    for (const row of rows) {
      await Promise.race([
        Promise.resolve(
          sql`
            INSERT INTO harness_shared.test_runs
              (file_path, framework, status, duration_ms, started_at, finished_at, output_tail, run_group_id, source, branch, commit_sha, harness_slug, workspace_id)
            VALUES
              (${row.filePath}, ${'vitest'}, ${row.status}, ${row.durationMs}, ${row.startedAt},
               ${row.finishedAt}, ${row.outputTail}, ${runGroupId}, ${source}, ${branch}, ${commit}, ${harnessSlug}, ${workspaceId})
          `,
        ),
        new Promise((_, reject) => setTimeout(() => reject(new Error('pg_insert_timeout')), 1000)),
      ])
        .then(() => {
          written++;
        })
        .catch(() => {
          /* swallow — D-007 */
        });
    }
  } catch {
    /* swallow — D-007 */
  }
  return written;
}

/** INTERNAL — test-only. Wipe the store. */
export function _resetTestingRunStore(): void {
  for (const s of _runs.values()) {
    if (s.proc && !s.proc.killed) {
      try { s.proc.kill('SIGKILL'); } catch { /* swallow */ }
    }
  }
  _runs.clear();
}
