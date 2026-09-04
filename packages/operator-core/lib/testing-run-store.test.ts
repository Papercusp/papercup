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
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  _emitError: (error: Error) => void;
  _emitClose: (code: number) => void;
}
let lastChild: FakeChild;

function makeChild(): FakeChild {
  const closeCbs: Array<(c: number) => void> = [];
  const errorCbs: Array<(error: Error) => void> = [];
  const child: FakeChild = {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: (e, cb) => {
      if (e === 'close') closeCbs.push(cb as (c: number) => void);
      if (e === 'error') errorCbs.push(cb as (error: Error) => void);
    },
    pid: 4242,
    kill: vi.fn(),
    killed: false,
    _emitError: (error) => errorCbs.forEach((cb) => cb(error)),
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
const taskManagerMocks = vi.hoisted(() => ({
  begin: vi.fn(),
  complete: vi.fn(),
  finish: vi.fn(),
  scopePath: vi.fn(),
}));
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...a: unknown[]) => spawnMock(...(a as [])),
    execFileSync: (...a: unknown[]) => execFileSyncMock(...a),
  };
});
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>().catch(
    () => ({}) as typeof import('@papercusp/db-org'),
  );
  return {
    ...actual,
    getOrgPg: () => ({ sql: persistSqlMock }),
  };
});
vi.mock('./task-manager/enroll-sync', () => ({
  beginSyncEnrolment: (...args: unknown[]) => taskManagerMocks.begin(...args),
  completeSyncEnrolment: (...args: unknown[]) => taskManagerMocks.complete(...args),
  finishSyncEnrolment: (...args: unknown[]) => taskManagerMocks.finish(...args),
  syncEnrolmentScopePath: (...args: unknown[]) => taskManagerMocks.scopePath(...args),
}));

type Store = typeof import('./testing-run-store');
const req = (over: Partial<Parameters<Store['startRun']>[0]> = {}) =>
  ({ kind: 'vitest' as const, label: 'L', command: 'npx', args: ['vitest', 'run'], cwd: '/tmp', ...over });

let store: Store;
beforeEach(async () => {
  vi.resetModules();
  spawnMock.mockClear();
  execFileSyncMock.mockReset();
  persistSqlMock.mockReset();
  taskManagerMocks.begin.mockReset();
  taskManagerMocks.complete.mockReset();
  taskManagerMocks.finish.mockReset();
  taskManagerMocks.scopePath.mockReset();
  taskManagerMocks.scopePath.mockReturnValue(null);
  taskManagerMocks.begin.mockImplementation(() => ({
    taskId: 'task-test-run',
    confined: false,
    scopeUnit: null,
    enrolled: true,
    registrationReady: null,
    releaseEnvironmentTransport: vi.fn(),
    wrap: vi.fn((binary: string, argv: string[]) => ({ binary, argv })),
  }));
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

  it('enrols before spawning and wraps the command with the exact task spec/env/cwd', () => {
    const enrolment = {
      taskId: 'task-confined',
      confined: true,
      scopeUnit: 'pc-task-confined.scope',
      enrolled: true,
      registrationReady: null,
      releaseEnvironmentTransport: vi.fn(),
      wrap: vi.fn((binary: string, argv: string[], _env: unknown, _cwd: string) => ({
        binary: 'systemd-run',
        argv: ['--unit=pc-task-confined.scope', binary, ...argv],
      })),
    };
    taskManagerMocks.begin.mockReturnValueOnce(enrolment);
    taskManagerMocks.scopePath.mockReturnValueOnce('/user.slice/papercusp.slice/pc-task-confined.scope');

    const snap = store.startRun(req({ label: 'a'.repeat(400), command: 'node', args: ['worker.js'] }));
    const beginOrder = taskManagerMocks.begin.mock.invocationCallOrder[0]!;
    const spawnOrder = spawnMock.mock.invocationCallOrder[0]!;
    const completeOrder = taskManagerMocks.complete.mock.invocationCallOrder[0]!;

    expect(beginOrder).toBeLessThan(spawnOrder);
    expect(spawnOrder).toBeLessThan(completeOrder);
    expect(taskManagerMocks.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        class: 'test-run',
        title: 'a'.repeat(300),
        argv: ['node', 'worker.js'],
        cwd: '/tmp',
        launchedBy: 'testing-run-store',
        detail: { runId: snap.runId, kind: 'vitest' },
      }),
    );
    expect(enrolment.wrap).toHaveBeenCalledWith(
      'node',
      ['worker.js'],
      expect.objectContaining({
        PAPERCUSP_TEST_RUN_GROUP: snap.runId,
        PAPERCUSP_TEST_ATTRIBUTION: '1',
        PAPERCUSP_TEST_RUN_SOURCE: 'admin-ui',
      }),
      '/tmp',
    );
    expect(spawnMock).toHaveBeenCalledWith(
      'systemd-run',
      ['--unit=pc-task-confined.scope', 'node', 'worker.js'],
      expect.objectContaining({ cwd: '/tmp', env: expect.any(Object), detached: true }),
    );
    expect(taskManagerMocks.complete).toHaveBeenCalledWith(enrolment, expect.objectContaining({
      class: 'test-run',
      argv: ['node', 'worker.js'],
      cwd: '/tmp',
      launchedBy: 'testing-run-store',
      detail: { runId: snap.runId, kind: 'vitest' },
    }), 4242);
  });

  it('finishes the enrolled task on a synchronous spawn error', () => {
    const spawnError = new Error('spawn unavailable');
    spawnMock.mockImplementationOnce(() => {
      throw spawnError;
    });

    const snap = store.startRun(req({ command: 'missing' }));
    const enrolment = taskManagerMocks.begin.mock.results[0]?.value;

    expect(snap.status).toBe('error');
    expect(taskManagerMocks.complete).not.toHaveBeenCalled();
    expect(taskManagerMocks.finish).toHaveBeenCalledWith(
      enrolment,
      { state: 'exited', exitCode: null, exitReason: 'spawn error: spawn unavailable' },
      { scopeCgroupPath: null },
    );
  });
});

describe('task lifecycle handlers', () => {
  it('finishes once on child error even when the child subsequently closes', () => {
    const snap = store.startRun(req());
    const enrolment = taskManagerMocks.begin.mock.results[0]?.value;
    const childError = new Error('ENOENT');

    lastChild._emitError(childError);
    lastChild._emitClose(1);

    expect(store.getRun(snap.runId)?.status).toBe('error');
    expect(taskManagerMocks.finish).toHaveBeenCalledTimes(1);
    expect(taskManagerMocks.finish).toHaveBeenCalledWith(
      enrolment,
      { state: 'exited', exitCode: null, exitReason: 'spawn error: ENOENT' },
      { scopeCgroupPath: null },
    );
  });

  it('finishes a normal close with the observed exit code and derived scope path', () => {
    taskManagerMocks.scopePath.mockReturnValueOnce('/user.slice/pc-test-run.scope');
    const snap = store.startRun(req());
    const enrolment = taskManagerMocks.begin.mock.results[0]?.value;
    lastChild._emitClose(7);

    expect(store.getRun(snap.runId)?.status).toBe('fail');
    expect(taskManagerMocks.finish).toHaveBeenCalledWith(
      enrolment,
      { state: 'exited', exitCode: 7 },
      { scopeCgroupPath: '/user.slice/pc-test-run.scope' },
    );
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

describe('durable detached snapshot lifecycle', () => {
  type Sql = Parameters<Store['persistRunSnapshot']>[1];

  it('persists the running snapshot before spawning the detached child', async () => {
    const events: string[] = [];
    const sql = vi.fn(async () => {
      events.push('persist');
      return [];
    }) as unknown as Sql;
    spawnMock.mockImplementationOnce(() => {
      events.push('spawn');
      lastChild = makeChild();
      return lastChild;
    });

    const result = await store.startRunDurable(req(), sql);

    expect(result.durable).toBe(true);
    expect(result.snapshot.status).toBe('running');
    expect(events).toEqual(['persist', 'spawn']);
  });

  it('keeps the active snapshot readable after the local worker state is gone', async () => {
    let durableRow: Record<string, unknown> | null = null;
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('INSERT INTO harness_shared.testing_run_snapshots')) {
        durableRow = {
          run_id: values[0],
          kind: values[1],
          label: values[2],
          file_path: values[3],
          command: values[4],
          status: values[5],
          exit_code: values[6],
          started_at: values[7],
          finished_at: values[8],
          output: values[9],
          truncated: values[10],
        };
        return [];
      }
      if (statement.includes('SELECT run_id, kind, label')) return durableRow ? [durableRow] : [];
      return [];
    }) as unknown as Sql;

    const { snapshot, durable } = await store.startRunDurable(req(), sql);
    expect(durable).toBe(true);

    // Simulate the operator worker being replaced while the detached process
    // remains alive. The sibling worker has no local _runs entry to consult.
    store._resetTestingRunStore();

    await expect(store.getRunAsync(snapshot.runId, sql)).resolves.toMatchObject({
      runId: snapshot.runId,
      status: 'running',
      finishedAt: null,
    });
  });

  it('still launches when the durable write fails and reports durable=false', async () => {
    const sql = vi.fn(async () => {
      throw new Error('database unavailable');
    }) as unknown as Sql;

    const result = await store.startRunDurable(req(), sql);

    expect(result.durable).toBe(false);
    expect(result.snapshot.status).toBe('running');
    expect(spawnMock).toHaveBeenCalled();
  });

  it('freezes snapshot values before an asynchronous persistence lookup', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sql = vi.fn(async () => {
      await gate;
      return [];
    }) as unknown as Sql;
    const snapshot: Parameters<Store['persistRunSnapshot']>[0] = {
      runId: 'race-run',
      kind: 'shell' as const,
      label: 'race',
      command: ['bash', '-c', 'true'],
      status: 'running' as const,
      exitCode: null,
      startedAt: 1_700_000_000_000,
      finishedAt: null,
      output: '',
      truncated: false,
    };

    const pending = store.persistRunSnapshot(snapshot, sql);
    snapshot.status = 'pass';
    snapshot.exitCode = 0;
    snapshot.finishedAt = snapshot.startedAt + 1_000;
    release();
    await expect(pending).resolves.toBe(true);

    const values = (sql as unknown as ReturnType<typeof vi.fn>).mock.calls[0].slice(1);
    expect(values[5]).toBe('running');
    expect(values[6]).toBeNull();
    expect(values[8]).toBeNull();
  });
});

describe('fallback persistence worktree snapshots (EI-18795303393201472)', () => {
  it('uses the post-run commit and marks a run dirty when the tree changes', async () => {
    // Load the partial db-org mock before the close handler starts its 1s
    // persistence window; importOriginal is cold after resetModules.
    await import('@papercusp/db-org');
    const commitAnswers = ['before-sha\n', 'after-sha\n'];
    const porcelainAnswers = ['', ' M peer-edit.ts\n'];
    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args.includes('rev-parse')) return commitAnswers.shift();
      if (args.includes('status')) return porcelainAnswers.shift();
      return '';
    });
    persistSqlMock.mockImplementation((_strings: TemplateStringsArray, ..._values: unknown[]) => {
      return Promise.resolve([]);
    });
    const previousPersistOptIn = process.env.PAPERCUSP_TEST_RUNS_PERSIST;
    process.env.PAPERCUSP_TEST_RUNS_PERSIST = '1';
    try {
      store.startRun(req({ kind: 'shell' }));
      lastChild._emitClose(0);
      await vi.waitFor(() =>
        expect(persistSqlMock.mock.calls.some((call) => call.at(-1) === true)).toBe(true),
      );
      const fallbackCall = persistSqlMock.mock.calls.find((call) => call.at(-1) === true);
      const capturedValues = fallbackCall?.slice(1) ?? [];
      expect(capturedValues[10]).toBe('after-sha');
      expect(capturedValues.at(-1)).toBe(true);
    } finally {
      if (previousPersistOptIn === undefined) delete process.env.PAPERCUSP_TEST_RUNS_PERSIST;
      else process.env.PAPERCUSP_TEST_RUNS_PERSIST = previousPersistOptIn;
    }
  });
});
