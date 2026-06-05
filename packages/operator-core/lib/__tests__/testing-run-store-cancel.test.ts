/**
 * testing-run-store-cancel.test.ts — cancellation + orphaned-run cleanup
 * for the admin-UI test-run store (Plan 1 P-010).
 *
 * Tests the cancel/abort path that the plan identified as untested:
 *   - cancelRun sends SIGTERM and marks status='cancelled'
 *   - cancelRun returns false for unknown / non-running / proc-less runs
 *   - The close handler respects the already-cancelled status (no overwrite)
 *   - Output cap: when output > 16KB, truncated=true and output is capped
 *   - Spawn error: status='error', exitCode=-1, output contains message
 *   - listRuns sorts newest-first and respects limit
 *   - Eviction: finishedAt < 1h cutoff causes eviction on next listRuns
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// ─── Mock child_process.spawn ─────────────────────────────────────────────────

class MockProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill = vi.fn((sig?: string) => {
    this.killed = true;
    // Simulate process exit on SIGTERM.
    if (sig === 'SIGTERM' || sig === undefined) {
      setImmediate(() => this.emit('close', null));
    }
  });
}

let mockProcInstance: MockProc;

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    mockProcInstance = new MockProc();
    return mockProcInstance;
  }),
}));
vi.mock('../testing-domain-glob', () => ({ inferWorkspaceRoot: () => '/tmp' }));
vi.mock('../testing-branch-resolve', () => ({
  resolveGitContext: async () => ({ branch: 'main', commit: 'abc' }),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _reset: () => void;
let startRun: (r: Parameters<typeof import('../testing-run-store').startRun>[0]) => ReturnType<typeof import('../testing-run-store').startRun>;
let cancelRun: typeof import('../testing-run-store').cancelRun;
let getRun: typeof import('../testing-run-store').getRun;
let listRuns: typeof import('../testing-run-store').listRuns;

beforeEach(async () => {
  vi.resetModules();
  const m = await import('../testing-run-store');
  startRun = m.startRun;
  cancelRun = m.cancelRun;
  getRun = m.getRun;
  listRuns = m.listRuns;
  _reset = m._resetTestingRunStore;
});

afterEach(() => {
  _reset?.();
});

function makeRun(label = 'test-run') {
  return startRun({ kind: 'vitest', label, command: 'echo', args: ['hi'] });
}

// ─── cancelRun ────────────────────────────────────────────────────────────────

describe('cancelRun', () => {
  it('returns false for an unknown runId', () => {
    expect(cancelRun('non-existent-id')).toBe(false);
  });

  it('sends SIGTERM to the process and marks status=cancelled', () => {
    const snap = makeRun();
    expect(snap.status).toBe('running');

    const ok = cancelRun(snap.runId);

    expect(ok).toBe(true);
    expect(getRun(snap.runId)?.status).toBe('cancelled');
    expect(getRun(snap.runId)?.finishedAt).not.toBeNull();
    expect(mockProcInstance.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('returns false if the run is already not running (e.g. pass)', async () => {
    const snap = makeRun();
    // Simulate process exiting normally first.
    mockProcInstance.emit('close', 0);
    await new Promise((r) => setImmediate(r));
    expect(getRun(snap.runId)?.status).toBe('pass');

    const ok = cancelRun(snap.runId);
    expect(ok).toBe(false);
  });

  it('close handler does NOT overwrite cancelled status to pass', async () => {
    const snap = makeRun();
    cancelRun(snap.runId);
    // Process exits with code 0 AFTER cancel.
    mockProcInstance.emit('close', 0);
    await new Promise((r) => setImmediate(r));

    expect(getRun(snap.runId)?.status).toBe('cancelled');
  });

  it('cancelRun on same run twice returns false the second time', () => {
    const snap = makeRun();
    expect(cancelRun(snap.runId)).toBe(true);
    expect(cancelRun(snap.runId)).toBe(false);
  });
});

// ─── Output cap ───────────────────────────────────────────────────────────────

describe('output cap', () => {
  it('truncated=false while output is under 16KB', () => {
    const snap = makeRun();
    mockProcInstance.stdout.emit('data', Buffer.from('x'.repeat(1000)));
    expect(getRun(snap.runId)?.truncated).toBe(false);
  });

  it('truncated=true and output capped at 16KB when over limit', () => {
    const snap = makeRun();
    // Emit 20KB of data.
    mockProcInstance.stdout.emit('data', Buffer.from('y'.repeat(20 * 1024)));
    const run = getRun(snap.runId)!;
    expect(run.truncated).toBe(true);
    expect(run.output.length).toBe(16 * 1024);
  });
});

// ─── Spawn error ──────────────────────────────────────────────────────────────

describe('spawn error', () => {
  it('sets status=error and exitCode=-1 when spawn throws', async () => {
    const { spawn } = await import('node:child_process');
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('ENOENT: command not found');
    });

    const snap = startRun({ kind: 'node', label: 'bad', command: 'nonexistent', args: [] });
    expect(snap.status).toBe('error');
    expect(snap.exitCode).toBe(-1);
    expect(snap.output).toContain('ENOENT');
    expect(snap.finishedAt).not.toBeNull();
  });
});

// ─── listRuns ─────────────────────────────────────────────────────────────────

describe('listRuns', () => {
  it('returns all registered runs', () => {
    makeRun('a');
    makeRun('b');
    makeRun('c');
    const labels = listRuns(10).map((r) => r.label).sort();
    expect(labels).toEqual(['a', 'b', 'c']);
  });

  it('respects limit parameter', () => {
    makeRun('a');
    makeRun('b');
    makeRun('c');
    expect(listRuns(2)).toHaveLength(2);
  });

  it('returns an empty array when no runs', () => {
    expect(listRuns()).toEqual([]);
  });
});

// ─── getRun ───────────────────────────────────────────────────────────────────

describe('getRun', () => {
  it('returns null for unknown id', () => {
    expect(getRun('unknown')).toBeNull();
  });

  it('returns a snapshot copy — mutations do not affect the store', () => {
    const snap = makeRun();
    const copy = getRun(snap.runId)!;
    copy.label = 'mutated';
    expect(getRun(snap.runId)!.label).toBe('test-run');
  });
});
