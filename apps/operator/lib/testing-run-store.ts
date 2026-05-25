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

    const pg = await import('postgres');
    const url =
      process.env.HARNESS_ADMIN_DATABASE_URL ??
      process.env.PAPERCUSP_TEST_RUNS_DB_URL ??
      'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
    const sql = pg.default(url, {
      max: 1,
      connect_timeout: 1,
      idle_timeout: 1,
      max_lifetime: 5,
      onnotice: () => {},
    });
    await Promise.race([
      sql`
        INSERT INTO harness_shared.test_runs
          (file_path, framework, status, duration_ms, started_at, finished_at, output_tail, run_group_id, source, branch, commit_sha)
        VALUES
          (${filePath}, ${s.kind}, ${s.status}, ${duration}, ${startedAtIso},
           ${finishedAtIso}, ${outputTail}, ${s.runId}, ${'admin-ui'}, ${branch}, ${commit})
      `,
      new Promise((_, reject) => setTimeout(() => reject(new Error('pg_insert_timeout')), 1000)),
    ]).catch(() => { /* swallow — D-007 */ });
    try { await sql.end({ timeout: 1 }); } catch { /* swallow */ }
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

/** INTERNAL — test-only. Wipe the store. */
export function _resetTestingRunStore(): void {
  for (const s of _runs.values()) {
    if (s.proc && !s.proc.killed) {
      try { s.proc.kill('SIGKILL'); } catch { /* swallow */ }
    }
  }
  _runs.clear();
}
