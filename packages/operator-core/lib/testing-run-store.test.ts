/**
 * Coverage for testing-run-store — the in-memory detached test-run map.
 * node:child_process is a controllable fake child; runs use kind 'vitest' so
 * the close handler's PG fallback-persist short-circuits (no DB). resetModules
 * per test isolates the module-level _runs map.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeChild {
  stdout: { on: (e: string, cb: (b: Buffer) => void) => void };
  stderr: { on: (e: string, cb: (b: Buffer) => void) => void };
  on: (e: string, cb: (arg: unknown) => void) => void;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  _emitClose: (code: number) => void;
}
let lastChild: FakeChild;

function makeChild(): FakeChild {
  const closeCbs: Array<(c: number) => void> = [];
  const child: FakeChild = {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: (e, cb) => {
      if (e === 'close') closeCbs.push(cb as (c: number) => void);
    },
    kill: vi.fn(),
    killed: false,
    _emitClose: (code) => closeCbs.forEach((cb) => cb(code)),
  };
  return child;
}

const spawnMock = vi.fn(() => {
  lastChild = makeChild();
  return lastChild;
});
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, spawn: (...a: unknown[]) => spawnMock(...(a as [])) };
});

type Store = typeof import('./testing-run-store');
const req = (over: Partial<Parameters<Store['startRun']>[0]> = {}) =>
  ({ kind: 'vitest' as const, label: 'L', command: 'npx', args: ['vitest', 'run'], cwd: '/tmp', ...over });

let store: Store;
beforeEach(async () => {
  vi.resetModules();
  spawnMock.mockClear();
  store = await import('./testing-run-store');
});

describe('startRun', () => {
  it('returns a running snapshot and spawns the command', () => {
    const snap = store.startRun(req());
    expect(snap.status).toBe('running');
    expect(snap.command).toEqual(['npx', 'vitest', 'run']);
    expect(snap.runId).toBeTruthy();
    expect(spawnMock).toHaveBeenCalledWith('npx', ['vitest', 'run'], expect.objectContaining({ cwd: '/tmp' }));
  });
});

describe('getRun', () => {
  it('returns a copy of a known run, null otherwise', () => {
    const snap = store.startRun(req());
    expect(store.getRun(snap.runId)?.runId).toBe(snap.runId);
    expect(store.getRun('no-such-run')).toBeNull();
  });
});

describe('listRuns', () => {
  it('lists started runs and honors the limit', () => {
    const a = store.startRun(req({ label: 'a' }));
    const b = store.startRun(req({ label: 'b' }));
    const ids = store.listRuns().map((r) => r.runId);
    expect(ids).toContain(a.runId);
    expect(ids).toContain(b.runId);
    expect(store.listRuns(1)).toHaveLength(1);
  });
});

describe('cancelRun', () => {
  it('marks cancelled + SIGTERMs the proc; returns true', () => {
    const snap = store.startRun(req());
    expect(store.cancelRun(snap.runId)).toBe(true);
    expect(store.getRun(snap.runId)?.status).toBe('cancelled');
    expect(lastChild.kill).toHaveBeenCalledWith('SIGTERM');
  });
  it('returns false for an unknown or already-finished run', () => {
    expect(store.cancelRun('nope')).toBe(false);
    const snap = store.startRun(req());
    store.cancelRun(snap.runId);
    expect(store.cancelRun(snap.runId)).toBe(false); // already cancelled
  });
});

describe('close handler', () => {
  it('exit 0 → pass, non-zero → fail', () => {
    const a = store.startRun(req());
    lastChild._emitClose(0);
    expect(store.getRun(a.runId)?.status).toBe('pass');

    const b = store.startRun(req());
    lastChild._emitClose(1);
    expect(store.getRun(b.runId)?.status).toBe('fail');
  });

  it('a cancelled run stays cancelled even after close', () => {
    const snap = store.startRun(req());
    store.cancelRun(snap.runId);
    lastChild._emitClose(0);
    expect(store.getRun(snap.runId)?.status).toBe('cancelled');
  });
});
