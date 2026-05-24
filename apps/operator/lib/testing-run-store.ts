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
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { inferWorkspaceRoot } from './testing-domain-glob';

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
      env: { ...process.env, PAPERCUSP_TEST_RUN_GROUP: runId },
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
  });
  proc.on('close', (code) => {
    state.snapshot.exitCode = code;
    state.snapshot.finishedAt = Date.now();
    if (state.snapshot.status === 'cancelled') return;
    state.snapshot.status = code === 0 ? 'pass' : 'fail';
  });

  return snapshot;
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
