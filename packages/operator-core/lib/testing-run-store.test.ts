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
const execFileSyncMock = vi.fn();
const persistSqlMock = vi.fn();
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...a: unknown[]) => spawnMock(...(a as [])),
    execFileSync: (...a: unknown[]) => execFileSyncMock(...a),
  };
});
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    getOrgPg: () => ({ sql: persistSqlMock }),
  };
});

type Store = typeof import('./testing-run-store');
const req = (over: Partial<Parameters<Store['startRun']>[0]> = {}) =>
  ({ kind: 'vitest' as const, label: 'L', command: 'npx', args: ['vitest', 'run'], cwd: '/tmp', ...over });

let store: Store;
beforeEach(async () => {
  vi.resetModules();
  spawnMock.mockClear();
  execFileSyncMock.mockReset();
  persistSqlMock.mockReset();
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

describe('computeWorktreeDirty (EI-18795303393201472)', () => {
  const clean = (commit: string) => ({ commit, porcelain: '' });

  it('same commit, clean porcelain before and after ⇒ not dirty', () => {
    expect(store.computeWorktreeDirty(clean('abc'), clean('abc'))).toBe(false);
  });

  it('HEAD moved between snapshots ⇒ dirty (a commit landed mid-run)', () => {
    expect(store.computeWorktreeDirty(clean('abc'), clean('def'))).toBe(true);
  });

  it('uncommitted changes to the tested files BEFORE the run ⇒ dirty', () => {
    expect(store.computeWorktreeDirty({ commit: 'abc', porcelain: ' M file.ts' }, clean('abc'))).toBe(true);
  });

  it('uncommitted changes to the tested files AFTER the run ⇒ dirty (the torn-read case)', () => {
    expect(store.computeWorktreeDirty(clean('abc'), { commit: 'abc', porcelain: ' M file.ts' })).toBe(true);
  });

  it('an unreadable git snapshot (null commit) is treated as dirty, fail-safe', () => {
    expect(store.computeWorktreeDirty({ commit: null, porcelain: '' }, clean('abc'))).toBe(true);
    expect(store.computeWorktreeDirty(clean('abc'), { commit: null, porcelain: '' })).toBe(true);
  });

  it('an unreadable porcelain read (null, git errored) is treated as dirty, fail-safe', () => {
    expect(store.computeWorktreeDirty({ commit: 'abc', porcelain: null }, clean('abc'))).toBe(true);
  });
});

describe('persistHarnessTestRuns worktree_dirty (EI-18795303393201472)', () => {
  const oneRow = () => [
    {
      filePath: 'lib/x.test.ts',
      status: 'fail' as const,
      durationMs: 10,
      // HarnessTestFileRow types these as Date, not string — vitest never typechecks, so
      // the ISO-string form passed here read as green locally and only surfaced at tsc.
      startedAt: new Date(),
      finishedAt: new Date(),
      outputTail: null,
    },
  ];

  it('defaults worktree_dirty to false when the caller omits it', async () => {
    let capturedValues: unknown[] = [];
    const fakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      capturedValues = values;
      return Promise.resolve([]);
    }) as Parameters<Store['persistHarnessTestRuns']>[0]['sql'];
    await store.persistHarnessTestRuns({
      harnessSlug: 'papercusp',
      workspaceId: 'ws',
      rows: oneRow(),
      runGroupId: 'g1',
      sql: fakeSql,
    });
    // Last positional value in the INSERT template is worktree_dirty (schema order).
    expect(capturedValues.at(-1)).toBe(false);
  });

  it('carries worktree_dirty:true through to the insert when the caller marks the run dirty', async () => {
    let capturedValues: unknown[] = [];
    const fakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      capturedValues = values;
      return Promise.resolve([]);
    }) as Parameters<Store['persistHarnessTestRuns']>[0]['sql'];
    await store.persistHarnessTestRuns({
      harnessSlug: 'papercusp',
      workspaceId: 'ws',
      rows: oneRow(),
      runGroupId: 'g1',
      worktreeDirty: true,
      sql: fakeSql,
    });
    expect(capturedValues.at(-1)).toBe(true);
  });
});

describe('fallback persistence worktree snapshots (EI-18795303393201472)', () => {
  it('uses the post-run commit and marks a run dirty when the tree changes', async () => {
    const commitAnswers = ['before-sha\n', 'after-sha\n'];
    const porcelainAnswers = ['', ' M peer-edit.ts\n'];
    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args.includes('rev-parse')) return commitAnswers.shift();
      if (args.includes('status')) return porcelainAnswers.shift();
      return '';
    });
    let capturedValues: unknown[] = [];
    persistSqlMock.mockImplementation((_strings: TemplateStringsArray, ...values: unknown[]) => {
      capturedValues = values;
      return Promise.resolve([]);
    });
    const previousPersistOptIn = process.env.PAPERCUSP_TEST_RUNS_PERSIST;
    process.env.PAPERCUSP_TEST_RUNS_PERSIST = '1';
    try {
      store.startRun(req({ kind: 'shell' }));
      lastChild._emitClose(0);
      await vi.waitFor(() => expect(persistSqlMock).toHaveBeenCalled());
      expect(capturedValues[10]).toBe('after-sha');
      expect(capturedValues.at(-1)).toBe(true);
    } finally {
      if (previousPersistOptIn === undefined) delete process.env.PAPERCUSP_TEST_RUNS_PERSIST;
      else process.env.PAPERCUSP_TEST_RUNS_PERSIST = previousPersistOptIn;
    }
  });
});
