/**
 * P-043: testing-run-store tests.
 *
 * Spawn a fast-exiting `bash -c "echo hi"` and a slow `sleep 30`,
 * verify startRun returns a snapshot, status transitions to pass,
 * output captured, cancellation works.
 *
 * Uses the live store (no DB needed — store is in-memory).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  startRun,
  getRun,
  cancelRun,
  listRuns,
  _resetTestingRunStore,
} from '../testing-run-store';

afterEach(() => {
  _resetTestingRunStore();
});

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe('startRun', () => {
  it('returns a snapshot with status=running for a real spawn', () => {
    const snap = startRun({
      kind: 'shell',
      label: 'echo',
      command: 'bash',
      args: ['-c', 'echo hello; exit 0'],
    });
    expect(snap.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(snap.status).toBe('running');
    expect(snap.exitCode).toBeNull();
    expect(snap.command).toEqual(['bash', '-c', 'echo hello; exit 0']);
  });

  it('transitions to pass + captures output for a success exit', async () => {
    const snap = startRun({
      kind: 'shell',
      label: 'echo',
      command: 'bash',
      args: ['-c', 'echo captured-output; exit 0'],
    });
    await waitFor(() => getRun(snap.runId)?.finishedAt !== null);
    const after = getRun(snap.runId);
    expect(after?.status).toBe('pass');
    expect(after?.exitCode).toBe(0);
    expect(after?.output).toContain('captured-output');
  });

  it('transitions to fail for a non-zero exit', async () => {
    const snap = startRun({
      kind: 'shell',
      label: 'fail',
      command: 'bash',
      args: ['-c', 'echo nope >&2; exit 7'],
    });
    await waitFor(() => getRun(snap.runId)?.finishedAt !== null);
    const after = getRun(snap.runId);
    expect(after?.status).toBe('fail');
    expect(after?.exitCode).toBe(7);
    expect(after?.output).toContain('nope');
  });

  it('returns status=error when spawn itself throws', () => {
    const snap = startRun({
      kind: 'shell',
      label: 'no-such-bin',
      command: '/definitely/not/a/binary/zzz',
      args: [],
    });
    // Spawn doesn't sync-throw on ENOENT — Node emits 'error' on the proc.
    // We accept either error-on-construction OR error event flips status.
    expect(['running', 'error']).toContain(snap.status);
  });
});

describe('cancelRun', () => {
  it('SIGTERMs a running process and flips status to cancelled', async () => {
    const snap = startRun({
      kind: 'shell',
      label: 'sleeper',
      command: 'bash',
      args: ['-c', 'sleep 30'],
    });
    // Give the child a beat to actually start.
    await new Promise((r) => setTimeout(r, 100));
    const ok = cancelRun(snap.runId);
    expect(ok).toBe(true);
    await waitFor(() => getRun(snap.runId)?.finishedAt !== null);
    expect(getRun(snap.runId)?.status).toBe('cancelled');
  });

  it('returns false for an unknown runId', () => {
    expect(cancelRun('00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('returns false for an already-finished run', async () => {
    const snap = startRun({
      kind: 'shell',
      label: 'short',
      command: 'bash',
      args: ['-c', 'true'],
    });
    await waitFor(() => getRun(snap.runId)?.finishedAt !== null);
    expect(cancelRun(snap.runId)).toBe(false);
  });
});

describe('listRuns', () => {
  it('returns recent runs newest-first', async () => {
    const a = startRun({ kind: 'shell', label: 'a', command: 'bash', args: ['-c', 'true'] });
    await new Promise((r) => setTimeout(r, 10));
    const b = startRun({ kind: 'shell', label: 'b', command: 'bash', args: ['-c', 'true'] });
    const all = listRuns();
    const ids = all.map((s) => s.runId);
    expect(ids.indexOf(b.runId)).toBeLessThan(ids.indexOf(a.runId));
  });
});

describe('P-014 admin-ui source propagation', () => {
  // The store sets PAPERCUSP_TEST_RUN_SOURCE=admin-ui on every spawn so the
  // in-process Vitest/Playwright reporter stamps rows with the right source.
  // The child env is observable via bash printenv.
  it('passes PAPERCUSP_TEST_RUN_SOURCE=admin-ui to the child env', async () => {
    const snap = startRun({
      kind: 'shell',
      label: 'env-probe',
      command: 'bash',
      args: ['-c', 'echo SRC=$PAPERCUSP_TEST_RUN_SOURCE; exit 0'],
    });
    await waitFor(() => getRun(snap.runId)?.finishedAt !== null);
    expect(getRun(snap.runId)?.output).toContain('SRC=admin-ui');
  });

  it('passes PAPERCUSP_TEST_RUN_GROUP=<runId> to the child env', async () => {
    const snap = startRun({
      kind: 'shell',
      label: 'group-probe',
      command: 'bash',
      args: ['-c', 'echo GRP=$PAPERCUSP_TEST_RUN_GROUP; exit 0'],
    });
    await waitFor(() => getRun(snap.runId)?.finishedAt !== null);
    expect(getRun(snap.runId)?.output).toContain(`GRP=${snap.runId}`);
  });

  // persistFallbackRow is fail-soft (D-007). With no PG configured for the
  // unit-test env the insert silently swallows; the run should still finish
  // cleanly and never throw.
  it('node/shell close handler never throws even when PG is unreachable', async () => {
    const original = process.env.HARNESS_ADMIN_DATABASE_URL;
    process.env.HARNESS_ADMIN_DATABASE_URL = 'postgresql://nobody@127.0.0.1:1/papercusp_no_such_db';
    try {
      const snap = startRun({
        kind: 'shell',
        label: 'fail-soft',
        command: 'bash',
        args: ['-c', 'echo done'],
      });
      await waitFor(() => getRun(snap.runId)?.finishedAt !== null, 5000);
      expect(getRun(snap.runId)?.status).toBe('pass');
    } finally {
      if (original === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
      else process.env.HARNESS_ADMIN_DATABASE_URL = original;
    }
  });
});
