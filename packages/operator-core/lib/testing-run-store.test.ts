/**
 * Coverage for testing-run-store — the in-memory detached test-run map.
 * node:child_process is a controllable fake child; runs use kind 'vitest' so
 * the close handler's PG fallback-persist short-circuits (no DB). resetModules
 * per test isolates the module-level _runs map.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface FakeChild {
  stdout: { on: (e: string, cb: (b: Buffer) => void) => void };
  stderr: { on: (e: string, cb: (b: Buffer) => void) => void };
  on: (e: string, cb: (arg: unknown) => void) => void;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  _emitError: (error: Error) => void;
  _emitStdout: (chunk: string) => void;
  _emitClose: (code: number) => void;
}
let lastChild: FakeChild;

function makeChild(): FakeChild {
  const closeCbs: Array<(c: number) => void> = [];
  const errorCbs: Array<(error: Error) => void> = [];
  const stdoutCbs: Array<(b: Buffer) => void> = [];
  const child: FakeChild = {
    stdout: { on: (_e, cb) => stdoutCbs.push(cb) },
    stderr: { on: () => {} },
    on: (e, cb) => {
      if (e === 'close') closeCbs.push(cb as (c: number) => void);
      if (e === 'error') errorCbs.push(cb as (error: Error) => void);
    },
    pid: 4242,
    kill: vi.fn(),
    killed: false,
    _emitError: (error) => errorCbs.forEach((cb) => cb(error)),
    _emitStdout: (chunk) => stdoutCbs.forEach((cb) => cb(Buffer.from(chunk))),
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
  Object.assign(persistSqlMock, { begin: (run: (tx: typeof persistSqlMock) => Promise<unknown>) => run(persistSqlMock) });
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

  it('preserves the exact requested Vitest file manifest in the snapshot and task detail', () => {
    const requestedFiles = ['lib/first.test.ts', 'lib/second.test.ts'];
    const snap = store.startRun(req({ requestedFiles }));
    requestedFiles.push('lib/late.test.ts');

    expect(snap.requestedFiles).toEqual(['lib/first.test.ts', 'lib/second.test.ts']);
    expect(taskManagerMocks.begin.mock.calls[0]?.[0].detail).toMatchObject({
      requestedFiles: ['lib/first.test.ts', 'lib/second.test.ts'],
    });
  });

  it('merges caller environment into the child while preserving run-owned markers', () => {
    const snap = store.startRun(
      req({
        env: {
          PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
          PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace',
          PAPERCUSP_TEST_RUN_GROUP: 'caller-group-must-not-win',
        },
      }),
    );

    expect(spawnMock).toHaveBeenCalledWith(
      'npx',
      ['vitest', 'run'],
      expect.objectContaining({
        env: expect.objectContaining({
          PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
          PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace',
          PAPERCUSP_TEST_RUN_GROUP: snap.runId,
        }),
      }),
    );
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

    const snap = store.startRun(
      req({ label: 'a'.repeat(400), command: 'node', args: ['worker.js'], runtimeMaxSec: 900 }),
    );
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
        runtimeMaxSec: 900,
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
      runtimeMaxSec: 900,
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
  it('retains a saved report when close-time ledger ingestion fails', async () => {
    const reportDir = await mkdtemp('/tmp/papercusp-testing-run-retain-');
    const reportPath = join(reportDir, 'report.json');
    const previousPersistOptIn = process.env.PAPERCUSP_TEST_RUNS_PERSIST;
    process.env.PAPERCUSP_TEST_RUNS_PERSIST = '1';
    try {
      await writeFile(reportPath, JSON.stringify({ testResults: [{
        name: '/tmp/lib/saved.test.ts', status: 'passed',
        assertionResults: [{ status: 'passed' }],
      }] }));
      let finalized!: () => void;
      const done = new Promise<void>(resolve => { finalized = resolve; });
      persistSqlMock.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.join(' ');
        if (statement.includes('INSERT INTO harness_shared.test_runs')) throw new Error('ledger unavailable');
        if (statement.includes('INSERT INTO harness_shared.testing_run_snapshots') && values[5] === 'pass') finalized();
        return [];
      });
      store.startRun(req({ detachedReportArtifacts: [{ reportPath, root: '/tmp',
        scope: { harnessSlug: 'papercusp', workspaceId: 'papercusp-workspace' },
      }] }));
      lastChild._emitClose(0);
      await done;
      await expect(readFile(reportPath, 'utf8')).resolves.toContain('testResults');
      expect(persistSqlMock.mock.calls.some(call => call[0].join(' ').includes('pg_advisory_xact_lock'))).toBe(true);
    } finally {
      if (previousPersistOptIn === undefined) delete process.env.PAPERCUSP_TEST_RUNS_PERSIST;
      else process.env.PAPERCUSP_TEST_RUNS_PERSIST = previousPersistOptIn;
      await rm(reportDir, { recursive: true, force: true });
    }
  });
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

  it('ingests a detached reporter-less JSON artifact on close and cleans it up', async () => {
    const reportDir = await mkdtemp('/tmp/papercusp-testing-run-store-report-');
    const reportPath = join(reportDir, 'report.json');
    const failureDetailsPath = join(reportDir, 'failure-details.json');
    const previousPersistOptIn = process.env.PAPERCUSP_TEST_RUNS_PERSIST;
    process.env.PAPERCUSP_TEST_RUNS_PERSIST = '1';
    try {
      // Warm the mocked database module before the close handler starts its
      // fail-soft dynamic import; cold import resolution can exceed the
      // lifecycle assertion's bounded wait under the full Vitest suite.
      await import('@papercusp/db-org');
      await writeFile(
        reportPath,
        JSON.stringify({
          testResults: [
            {
              name: '/tmp/packages/external/example.test.ts',
              status: 'failed',
              startTime: 1_700_000_000_000,
              endTime: 1_700_000_000_025,
              assertionResults: [{
                status: 'failed',
                fullName: 'suite > works',
                failureMessages: ['expected a structured diff'],
              }],
            },
          ],
        }),
      );
      await writeFile(
        failureDetailsPath,
        JSON.stringify({
          failures: [{
            file: '/tmp/packages/external/example.test.ts',
            test: 'suite > works',
            actual: 'actual-value',
            expected: 'expected-value',
          }],
        }),
      );
      execFileSyncMock.mockImplementation((_command: string, args: string[]) =>
        args[0] === 'rev-parse' ? 'detached-sha\n' : '',
      );
      let resolveTerminalSnapshot!: () => void;
      const terminalSnapshotPersisted = new Promise<void>((resolve) => {
        resolveTerminalSnapshot = resolve;
      });
      persistSqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join(' ').includes('INSERT INTO harness_shared.testing_run_snapshots') && values[5] === 'fail') {
          resolveTerminalSnapshot();
        }
        return Promise.resolve([{ id: 42 }]);
      });

      const snapshot = store.startRun(
        req({
          detachedReportArtifacts: [
            {
              reportPath,
              failureDetailsPath,
              root: '/tmp',
              testNamePattern: 'suite > works',
              scope: { harnessSlug: 'papercusp', workspaceId: 'papercusp-workspace' },
            },
          ],
        }),
      );
      lastChild._emitStdout('x'.repeat(16 * 1024));
      lastChild._emitClose(1);

      await terminalSnapshotPersisted;
      const [strings, ...values] = persistSqlMock.mock.calls.find((call) =>
        call[0]?.join(' ').includes('INSERT INTO harness_shared.test_runs'),
      ) ?? [];
      expect(strings?.join(' ')).toContain('INSERT INTO harness_shared.test_runs');
      expect(values[0]).toBe('packages/external/example.test.ts');
      expect(values[2]).toBe('fail');
      expect(values[7]).toBe(snapshot.runId);
      expect(values[8]).toBe('local');
      expect(values[11]).toBe('papercusp');
      expect(values[12]).toBe('papercusp-workspace');
      // EI-24799048791133095: the jsonb param must be the OBJECT. A pre-stringified
      // value is double-encoded by postgres-js's default serializer into a jsonb
      // STRING scalar, and every `execution_details->>'key'` read returns NULL.
      const executionDetails = values.at(-1);
      expect(typeof executionDetails).toBe('object');
      expect(executionDetails).toMatchObject({
        schemaVersion: 1,
        root: '/tmp',
        filePath: 'packages/external/example.test.ts',
        runGroupId: snapshot.runId,
        workspaceId: 'papercusp-workspace',
        harnessSlug: 'papercusp',
        testNamePattern: 'suite > works',
        passed: 0,
        failed: 1,
        skipped: 0,
        collectionFailed: false,
        commitSha: 'detached-sha',
        worktreeDirty: false,
      });
      const snapshotCalls = persistSqlMock.mock.calls.filter((call) =>
        call[0]?.join(' ').includes('INSERT INTO harness_shared.testing_run_snapshots'),
      );
      const finalSnapshotValues = snapshotCalls.at(-1)?.slice(1) ?? [];
      expect(finalSnapshotValues[5]).toBe('fail');
      expect(finalSnapshotValues[9]).toContain('suite > works');
      expect(finalSnapshotValues[9]).toContain('actual: actual-value');
      expect(finalSnapshotValues[9]).toContain('expected: expected-value');
      expect(finalSnapshotValues[9]).toHaveLength(16 * 1024);
      expect(finalSnapshotValues[10]).toBe(true);
      const testRunCallIndex = persistSqlMock.mock.calls.findIndex((call) =>
        call[0]?.join(' ').includes('INSERT INTO harness_shared.test_runs'),
      );
      const finalSnapshotCallIndex = persistSqlMock.mock.calls.findIndex((call) =>
        call[0]?.join(' ').includes('INSERT INTO harness_shared.testing_run_snapshots') && call[6] === 'fail',
      );
      expect(finalSnapshotCallIndex).toBeGreaterThan(testRunCallIndex);
      await vi.waitFor(async () => expect(readFile(reportPath)).rejects.toThrow());
      await vi.waitFor(async () => expect(readFile(failureDetailsPath)).rejects.toThrow());
    } finally {
      if (previousPersistOptIn === undefined) delete process.env.PAPERCUSP_TEST_RUNS_PERSIST;
      else process.env.PAPERCUSP_TEST_RUNS_PERSIST = previousPersistOptIn;
      await rm(reportDir, { recursive: true, force: true });
    }
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
    // worktree_dirty precedes the optional execution_details payload.
    expect(capturedValues.at(-2)).toBe(false);
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
    expect(capturedValues.at(-2)).toBe(true);
  });
});

describe('durable detached snapshot lifecycle', () => {
  type Sql = Parameters<Store['persistRunSnapshot']>[1];

  it.each([
    { name: 'running snapshot', status: 'running', expected: 'pass' },
    { name: 'prior no-verdict error', status: 'error', expected: 'pass' },
    { name: 'closed snapshot missing ledger', status: 'pass', expected: 'pass' },
    { name: 'failing assertions', status: 'running', expected: 'fail', failure: true },
    { name: 'cancelled task', status: 'cancelled', expected: 'cancelled', cancelled: true },
    { name: 'partial report', status: 'running', expected: 'error', partial: true },
    { name: 'failed ledger insert', status: 'running', expected: 'error', writeFailure: true },
    { name: 'lost snapshot CAS', status: 'running', expected: 'running', casLost: true },
    { name: 'legacy command metadata', status: 'running', expected: 'pass', legacy: true },
    { name: 'legacy inline selector', status: 'running', expected: 'pass', legacy: true, inlineSelector: true },
    { name: 'legacy wrong tenant', status: 'running', expected: 'error', legacy: true, wrongScope: true },
    { name: 'expired legacy snapshot', status: 'error', expected: 'pass', legacy: true, expired: true },
    { name: 'pruned legacy snapshot', status: 'running', expected: 'pass', legacy: true, expired: true, missing: true },
    { name: 'pruned legacy inline selector', status: 'running', expected: 'pass', legacy: true, expired: true, missing: true, inlineSelector: true },
    { name: 'pruned snapshot wrong tenant', status: 'running', expected: null, legacy: true, expired: true, missing: true, wrongScope: true },
    { name: 'pruned snapshot partial report', status: 'running', expected: null, legacy: true, expired: true, missing: true, partial: true },
    { name: 'pruned snapshot ambiguous task', status: 'running', expected: null, legacy: true, expired: true, missing: true, ambiguous: true },
    { name: 'ended_unobserved retained PASS', status: 'running', expected: 'pass', taskState: 'ended_unobserved', processExit: null },
    { name: 'ended_unobserved retained FAIL', status: 'error', expected: 'fail', failure: true, taskState: 'ended_unobserved', processExit: null },
    { name: 'ended_unobserved pruned PASS', status: 'running', expected: 'pass', legacy: true, expired: true, missing: true, taskState: 'ended_unobserved', processExit: null },
    { name: 'ended_unobserved pruned FAIL', status: 'running', expected: 'fail', failure: true, legacy: true, expired: true, missing: true, taskState: 'ended_unobserved', processExit: null },
    { name: 'ended_unobserved partial report', status: 'running', expected: 'error', partial: true, taskState: 'ended_unobserved', processExit: null },
    { name: 'live task retained report', status: 'running', expected: 'running', taskState: 'running', processExit: null },
    { name: 'live task pruned report', status: 'running', expected: null, legacy: true, expired: true, missing: true, taskState: 'running', processExit: null },
    { name: 'cancelled task running snapshot', status: 'running', expected: 'error', taskState: 'killed', processExit: null },
    { name: 'cancelled task pruned report', status: 'running', expected: null, legacy: true, expired: true, missing: true, taskState: 'killed', processExit: null },
    { name: 'exited without observed exit', status: 'running', expected: 'error', processExit: null },
    { name: 'observed exit contradicts report', status: 'running', expected: 'error', processExit: 1 },
  ] as const)('saved report recovery after worker disappearance: $name', async (scenario) => {
    const options = scenario as {
      status: string; expected: string | null; failure?: boolean; cancelled?: boolean;
      partial?: boolean; writeFailure?: boolean; casLost?: boolean; legacy?: boolean; wrongScope?: boolean;
      expired?: boolean; missing?: boolean;
      ambiguous?: boolean;
      inlineSelector?: boolean;
      taskState?: 'ended_unobserved' | 'running' | 'killed';
      processExit?: number | null;
    };
    const { status } = options;
    const taskState = options.taskState ?? (options.cancelled ? 'killed' : 'exited');
    const processExit = options.processExit === undefined ? (options.failure ? 1 : 0) : options.processExit;
    const reportDir = await mkdtemp('/tmp/papercusp-testing-run-recovery-');
    const reportPath = join(reportDir, 'papercusp-testing-run-detached-fixture.json');
    try {
      execFileSyncMock.mockImplementation((_command: string, args: string[]) =>
        args[0] === 'rev-parse' ? 'launch-sha\n' : '',
      );
      const { snapshot } = await store.startRunDurable(req({
        requestedFiles: ['lib/saved.test.ts'],
        detachedReportArtifacts: [{
          reportPath, root: '/tmp', testNamePattern: 'saved assertion',
          scope: { harnessSlug: 'papercusp', workspaceId: 'papercusp-workspace' },
        }],
      }), vi.fn(async () => []) as unknown as Sql);
      const detail = taskManagerMocks.begin.mock.calls[0]![0].detail;
      store._resetTestingRunStore();
      await writeFile(reportPath, JSON.stringify({
        success: !options.failure, numTotalTests: options.partial ? 3 : 2,
        numPassedTests: options.failure ? 0 : 1, numFailedTests: options.failure ? 1 : 0,
        numPendingTests: 1, numTodoTests: 0,
        testResults: [{
          name: '/tmp/lib/saved.test.ts', status: options.failure ? 'failed' : 'passed',
          startTime: snapshot.startedAt, endTime: snapshot.startedAt + 25,
          assertionResults: [{ status: options.failure ? 'failed' : 'passed', fullName: 'saved assertion' }, { status: 'pending' }],
        }],
      }));
      const ledger: Record<string, unknown>[] = [];
      const writes: unknown[][] = [];
      const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.join(' ');
        const snapshotRead = statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot');
        const taskRead = statement.includes('FROM harness_shared.task_ledger AS task_ledger');
        if (snapshotRead && options.expired) return [];
        if (taskRead && options.wrongScope) return [];
        if (taskRead && options.ambiguous) return [{}, {}];
        // Model the actual task-state SQL predicate, including pruned snapshots.
        if (taskRead && !statement.includes(`'${taskState}'`)) return [];
        if (snapshotRead || taskRead) return [{
          run_id: snapshot.runId, task_id: snapshot.taskId, kind: 'vitest', label: 'saved',
          file_path: null, command: options.legacy ? [
            'node', 'scripts/test-files.mjs', `--outputFile=${reportPath}`,
            ...(options.inlineSelector ? ['--testNamePattern=saved assertion'] : ['-t', 'saved assertion']),
          ] : snapshot.command, status, exit_code: status === 'pass' ? 0 : null,
          started_at: snapshot.startedAt, finished_at: status === 'error' ? snapshot.startedAt + 30 : null,
          output: status === 'error' ? '[detached-recovery] no test verdict was observed.' : '', truncated: false,
          task_state: taskState, task_exit_code: processExit,
          task_ended_at: taskState === 'running' ? null : snapshot.startedAt + 25,
          task_detail: options.legacy ? { requestedFiles: ['lib/saved.test.ts'] } : detail,
          task_cwd: '/tmp', task_harness_slug: options.legacy ? null : 'papercusp', task_workspace_id: 'papercusp-workspace',
          snapshot_missing: options.missing ?? false,
        }];
        if (statement.includes('FROM harness_shared.test_runs')) return ledger;
        if (statement.includes('INSERT INTO harness_shared.test_runs')) {
          if (options.writeFailure) throw new Error('ledger unavailable');
          writes.push(values);
          ledger.push({ file_path: values[0], status: values[2], finished_at: values[5], output_tail: values[6] });
          return [{ id: 42 }];
        }
        if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) return options.casLost ? [] : [{ run_id: snapshot.runId }];
        return [];
      });
      Object.assign(sql, { begin: async (run: (tx: typeof sql) => Promise<unknown>) => {
        const before = ledger.length;
        try { return await run(sql); }
        catch (error) { ledger.splice(before); throw error; }
      } });

      const recovered = await store.getRunAsync(snapshot.runId, sql as unknown as Sql, options.legacy ? {
        root: '/tmp', harnessSlug: 'papercusp', workspaceId: options.wrongScope ? 'other-workspace' : 'papercusp-workspace',
      } : undefined);
      if (options.expected === null) expect(recovered).toBeNull();
      else expect(recovered?.status).toBe(options.expected);
      if (options.expired) {
        const taskQuery = sql.mock.calls.find(([strings]) => strings.join(' ').includes('FROM harness_shared.task_ledger AS task_ledger'));
        expect(taskQuery).toBeDefined();
        expect(taskQuery!.slice(1)).toEqual(expect.arrayContaining([
          snapshot.runId, options.wrongScope ? 'other-workspace' : 'papercusp-workspace', '/tmp', 'papercusp',
        ]));
      }
      if (options.expected !== 'pass' && options.expected !== 'fail') {
        await expect(readFile(reportPath, 'utf8')).resolves.toContain('testResults');
        return;
      }
      expect(recovered).toMatchObject({ exitCode: processExit, finishedAt: snapshot.startedAt + 25 });
      expect(sql.mock.calls.some(([strings]) => strings.join(' ').includes('UPDATE harness_shared.task_ledger'))).toBe(false);
      if (taskState === 'ended_unobserved') expect(recovered!.output).toContain('process exit code was not observed');
      expect(writes).toHaveLength(1);
      expect(writes[0]![7]).toBe(snapshot.runId);
      expect(writes[0]![10]).toBe(options.legacy ? null : 'launch-sha');
      expect(writes[0]![15]).toBe(true);
      expect(typeof writes[0]!.at(-1)).toBe('object');
      expect(writes[0]!.at(-1)).toMatchObject({
        root: '/tmp', passed: options.failure ? 0 : 1, skipped: 1, testNamePattern: 'saved assertion', worktreeDirty: true,
      });
      await expect(readFile(reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(reportDir, { recursive: true, force: true });
    }
  });

  it('spawns the detached child before waiting for the running snapshot persistence', async () => {
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
    expect(events).toEqual(['spawn', 'persist']);
  });

  it('returns the detached handle before a slow initial snapshot write settles', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const write = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sql = vi.fn(async () => {
        await write;
        return [];
      }) as unknown as Sql;

      const pending = store.startRunDurable(req(), sql);
      // launchPreparedRun is synchronous, so the child handle exists even
      // while the optional durable write is still blocked.
      expect(spawnMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(store.DETACHED_RUN_DURABILITY_RESPONSE_BUDGET_MS + 1);
      const result = await pending;

      expect(result.snapshot.runId).toBeTruthy();
      expect(result.snapshot.status).toBe('running');
      expect(result.durable).toBe(false);

      // Let the background write settle before restoring real timers.
      release();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries initial snapshot persistence after the foreground durability budget expires', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      let releaseRetry!: () => void;
      let retrySettled = false;
      const sql = vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) return new Promise<unknown[]>(() => {});
        if (attempts === 2) {
          return new Promise<unknown[]>((resolve) => {
            releaseRetry = () => {
              retrySettled = true;
              resolve([]);
            };
          });
        }
        return [];
      }) as unknown as Sql;

      const pending = store.startRunDurable(req(), sql);
      await vi.advanceTimersByTimeAsync(store.DETACHED_RUN_DURABILITY_RESPONSE_BUDGET_MS + 1);
      const result = await pending;

      // The child-first response contract remains intact even while the
      // background retry is waiting on a recovered database attempt.
      expect(result.durable).toBe(false);
      expect(attempts).toBe(2);
      expect(retrySettled).toBe(false);

      releaseRetry();
      await vi.advanceTimersByTimeAsync(0);
      expect(retrySettled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
          task_id: values[11],
          task_state: 'running',
        };
        return [];
      }
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) return durableRow ? [durableRow] : [];
      return [];
    }) as unknown as Sql;

    const { snapshot, durable } = await store.startRunDurable(req(), sql);
    expect(durable).toBe(true);

    // Simulate the operator worker being replaced while the detached process
    // remains alive. The sibling worker has no local _runs entry to consult.
    store._resetTestingRunStore();

    await expect(store.getRunAsync(snapshot.runId, sql)).resolves.toMatchObject({
      runId: snapshot.runId,
      taskId: 'task-test-run',
      status: 'running',
      finishedAt: null,
    });
    // Both joined tables expose exit_code and timestamps. An unqualified
    // projection fails with PostgreSQL 42702 on a sibling worker, while the
    // launching worker's local map masks that SQL error.
    const readSql = (sql as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => (call[0] as TemplateStringsArray).join(' '))
      .find((statement) => statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot'));
    expect(readSql).toContain('snapshot.exit_code');
    expect(readSql).toContain('snapshot.started_at');
    expect(readSql).toContain('snapshot.finished_at');
    expect(readSql).toContain('WHERE snapshot.run_id =');
  });

  it('retries an empty sibling read until the confirmed snapshot becomes visible', async () => {
    let snapshotReads = 0;
    const durableRow = {
      run_id: 'visible-after-write',
      task_id: null,
      kind: 'vitest',
      label: 'detached test',
      file_path: null,
      command: ['node', 'vitest'],
      status: 'running',
      exit_code: null,
      started_at: new Date(1_700_000_000_000),
      finished_at: null,
      output: '',
      truncated: false,
      task_state: null,
      task_deadline_at: null,
    };
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
        snapshotReads += 1;
        return snapshotReads === 1 ? [] : [durableRow];
      }
      if (statement.includes('SELECT DISTINCT ON (file_path)')) return [];
      return [];
    }) as unknown as Sql;

    await expect(store.getRunAsync(durableRow.run_id, sql)).resolves.toMatchObject({
      runId: durableRow.run_id,
      status: 'running',
      finishedAt: null,
    });
    expect(snapshotReads).toBe(2);
  });

  it('distinguishes an unavailable snapshot lookup from a missing row', async () => {
    const unavailableSql = vi.fn(async () => {
      throw new Error('database unavailable');
    }) as unknown as Sql;
    const missingSql = vi.fn(async () => []) as unknown as Sql;

    await expect(store.getRunAsync('unavailable-run', unavailableSql)).rejects.toBeInstanceOf(
      store.TestingRunSnapshotUnavailableError,
    );
    await expect(store.getRunAsync('missing-run', missingSql)).resolves.toBeNull();
  });

  it('recovers a terminal detached verdict from test_runs when its snapshot read is unavailable', async () => {
    const runId = 'ledger-recovery-run';
    const ledgerRows = Array.from({ length: 5 }, (_, index) => ({
      file_path: `lib/file-${index + 1}.test.ts`,
      status: 'pass',
      finished_at: new Date(1_700_000_001_000 + index * 1_000),
      output_tail: null,
    }));
    const sql = vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) throw new Error('snapshot table unavailable');
      if (statement.includes('FROM harness_shared.task_ledger')) {
        return [{
          state: 'exited',
          exit_code: 0,
          requested_files: ledgerRows.map((row) => row.file_path),
        }];
      }
      if (statement.includes('FROM harness_shared.test_runs')) return ledgerRows;
      return [];
    }) as unknown as Sql;

    await expect(store.getRunAsync(runId, sql)).rejects.toBeInstanceOf(store.TestingRunSnapshotUnavailableError);
    await expect(store.getTestRunLedgerRecoveryAsync(runId, sql)).resolves.toMatchObject({
      runId,
      status: 'pass',
      exitCode: 0,
      finishedAt: 1_700_000_005_000,
      fileCount: 5,
      files: ledgerRows.map((row) => ({
        filePath: row.file_path,
        status: row.status,
        finishedAt: row.finished_at.getTime(),
      })),
    });
    expect((sql as unknown as ReturnType<typeof vi.fn>).mock.calls.some((call) => call[0].join(' ').includes('FROM harness_shared.test_runs'))).toBe(true);
  });

  it.each([
    { name: 'while the linked task is running', taskState: 'running', exitCode: null, expected: null },
    { name: 'after a clean task exit', taskState: 'exited', exitCode: 0, expected: 'pass' },
    { name: 'after a nonzero task exit', taskState: 'exited', exitCode: 1, expected: null },
  ] as const)(
    'requires a linked detached task to finish before ledger recovery: $name',
    async (scenario) => {
      const runId = `ledger-${scenario.name.replaceAll(' ', '-')}`;
      const ledgerRows = Array.from({ length: 9 }, (_, index) => ({
        file_path: `lib/workspace-one-${index + 1}.test.ts`,
        status: 'pass',
        finished_at: new Date(1_700_000_001_000 + index * 1_000),
        output_tail: null,
      }));
      const sql = vi.fn(async (strings: TemplateStringsArray) => {
        const statement = strings.join(' ');
        if (statement.includes('FROM harness_shared.task_ledger')) {
          return [{
            state: scenario.taskState,
            exit_code: scenario.exitCode,
            requested_files: ledgerRows.map((row) => row.file_path),
          }];
        }
        if (statement.includes('FROM harness_shared.test_runs')) return ledgerRows;
        return [];
      }) as unknown as Sql;

      const recovery = await store.getTestRunLedgerRecoveryAsync(runId, sql);

      if (scenario.expected === 'pass') {
        expect(recovery).toMatchObject({ runId, status: 'pass', fileCount: 9 });
      } else {
        expect(recovery).toBeNull();
      }
      const ledgerRead = (sql as unknown as ReturnType<typeof vi.fn>).mock.calls
        .some((call) => call[0].join(' ').includes('FROM harness_shared.test_runs'));
      expect(ledgerRead).toBe(scenario.taskState !== 'running');
    },
  );

  it('does not recover an unmanifested all-pass detached ledger as a pass', async () => {
    const ledgerRows = [{
      file_path: 'lib/unmanifested.test.ts',
      status: 'pass',
      finished_at: new Date(1_700_000_001_000),
      output_tail: null,
    }];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.task_ledger')) {
        return [{ state: 'exited', exit_code: 0 }];
      }
      if (statement.includes('FROM harness_shared.test_runs')) return ledgerRows;
      return [];
    }) as unknown as Sql;

    await expect(store.getTestRunLedgerRecoveryAsync('unmanifested-ledger-run', sql)).resolves.toBeNull();
  });

  it('does not recover a detached verdict from a partial or unreadable test_runs group', async () => {
    const partialSql = vi.fn(async (strings: TemplateStringsArray) => {
      if (strings.join(' ').includes('FROM harness_shared.test_runs')) {
        return [
          {
            file_path: 'lib/finished.test.ts',
            status: 'pass',
            finished_at: new Date(1_700_000_001_000),
            output_tail: null,
          },
          { file_path: 'lib/active.test.ts', status: 'running', finished_at: null, output_tail: null },
        ];
      }
      return [];
    }) as unknown as Sql;
    const unavailableSql = vi.fn(async () => {
      throw new Error('test_runs unavailable');
    }) as unknown as Sql;

    await expect(store.getTestRunLedgerRecoveryAsync('partial-run', partialSql)).resolves.toBeNull();
    await expect(store.getTestRunLedgerRecoveryAsync('unreadable-ledger-run', unavailableSql)).resolves.toBeNull();
  });

  it('reconciles a persisted running snapshot when its linked task is terminal', async () => {
    const updates: unknown[][] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
        return [
          {
            run_id: 'orphan-run',
            task_id: 'task-orphan',
            kind: 'shell',
            label: 'orphan',
            file_path: null,
            command: ['bash', '-c', 'true'],
            status: 'running',
            exit_code: null,
            started_at: new Date(1_700_000_000_000),
            finished_at: null,
            output: 'partial output',
            truncated: false,
            task_state: 'exited',
            task_deadline_at: null,
          },
        ];
      }
      if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) {
        updates.push(values);
        return [{ run_id: 'orphan-run' }];
      }
      return [];
    }) as unknown as Sql;

    await expect(store.getRunAsync('orphan-run', sql)).resolves.toMatchObject({
      runId: 'orphan-run',
      taskId: 'task-orphan',
      status: 'error',
      exitCode: null,
      finishedAt: expect.any(Number),
      output: expect.stringContaining('no test verdict was observed'),
    });
    expect(updates).toHaveLength(1);
    expect((sql as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0].join(' ')).toContain(
      "WHERE run_id =",
    );
  });

  it('does not recover a stale snapshot as pass when no task row can supply the manifest', async () => {
    const updates: unknown[][] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
        return [
          {
            run_id: 'ledger-pass-run',
            task_id: null,
            kind: 'vitest',
            label: 'detached',
            file_path: 'lib/example.test.ts',
            command: ['node', 'router.js'],
            status: 'running',
            exit_code: null,
            started_at: new Date(1_700_000_000_000),
            finished_at: null,
            output: '',
            truncated: false,
            task_state: null,
            task_deadline_at: null,
          },
        ];
      }
      if (statement.includes('FROM harness_shared.test_runs')) {
        return [
          {
            file_path: 'lib/example.test.ts',
            status: 'pass',
            finished_at: new Date(1_700_000_001_000),
            output_tail: null,
          },
        ];
      }
      if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) {
        updates.push(values);
        return [{ run_id: 'ledger-pass-run' }];
      }
      return [];
    }) as unknown as Sql;

    await expect(store.getRunAsync('ledger-pass-run', sql)).resolves.toMatchObject({
      runId: 'ledger-pass-run',
      status: 'running',
      finishedAt: null,
    });
    expect(updates).toHaveLength(0);
    expect((sql as unknown as ReturnType<typeof vi.fn>).mock.calls.some((call) => call[0].join(' ').includes('FROM harness_shared.test_runs'))).toBe(true);
  });

  it('does not recover a running snapshot from a partial or active test_runs ledger', async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
        return [
          {
            run_id: 'ledger-partial-run',
            task_id: null,
            kind: 'vitest',
            label: 'detached',
            file_path: null,
            command: ['node', 'router.js'],
            status: 'running',
            exit_code: null,
            started_at: new Date(1_700_000_000_000),
            finished_at: null,
            output: '',
            truncated: false,
            task_state: null,
            task_deadline_at: null,
          },
        ];
      }
      if (statement.includes('FROM harness_shared.test_runs')) {
        return [
          {
            file_path: 'lib/one.test.ts',
            status: 'pass',
            finished_at: new Date(1_700_000_001_000),
            output_tail: null,
          },
          {
            file_path: 'lib/two.test.ts',
            status: 'running',
            finished_at: null,
            output_tail: null,
          },
        ];
      }
      return [];
    }) as unknown as Sql;

    await expect(store.getRunAsync('ledger-partial-run', sql)).resolves.toMatchObject({
      runId: 'ledger-partial-run',
      status: 'running',
      finishedAt: null,
    });
  });

  it.each([
    { name: 'while the linked router is still running', taskState: 'running', taskExitCode: null, expected: 'running' },
    { name: 'after the linked router exits cleanly with one requested file missing', taskState: 'exited', taskExitCode: 0, expected: 'error' },
    { name: 'after the linked router exits unsuccessfully', taskState: 'exited', taskExitCode: 1, expected: 'error' },
  ] as const)(
    'does not finalize from an all-pass subset emitted by one workspace: $name',
    async (scenario) => {
      const runId = 'multi-workspace-ledger-run';
      const ledgerRows = Array.from({ length: 9 }, (_, index) => ({
        file_path: `lib/workspace-one-${index + 1}.test.ts`,
        status: 'pass',
        finished_at: new Date(1_700_000_001_000 + index * 1_000),
        output_tail: null,
      }));
      const requestedFiles = [
        ...ledgerRows.map((row) => row.file_path),
        'lib/workspace-two-1.test.ts',
      ];
      const updates: unknown[][] = [];
      const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.join(' ');
        if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
          return [{
            run_id: runId,
            task_id: 'task-multi-workspace',
            kind: 'vitest',
            label: 'multi-workspace router',
            file_path: null,
            command: ['node', 'scripts/test-files.mjs'],
            status: 'running',
            exit_code: null,
            started_at: new Date(1_700_000_000_000),
            finished_at: null,
            output: '',
            truncated: false,
            task_state: scenario.taskState,
            task_deadline_at: null,
            task_exit_code: scenario.taskExitCode,
            task_ended_at: scenario.taskState === 'running' ? null : new Date(1_700_000_020_000),
            task_detail: { requestedFiles },
          }];
        }
        if (statement.includes('FROM harness_shared.test_runs')) return ledgerRows;
        if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) {
          updates.push(values);
          return [{ run_id: runId }];
        }
        return [];
      }) as unknown as Sql;

      const recovered = await store.getRunAsync(runId, sql);

      expect(recovered).toMatchObject({ runId, status: scenario.expected });
      const ledgerRead = (sql as unknown as ReturnType<typeof vi.fn>).mock.calls
        .some((call) => call[0].join(' ').includes('FROM harness_shared.test_runs'));
      if (scenario.taskState === 'running') {
        expect(ledgerRead).toBe(false);
        expect(updates).toHaveLength(0);
        expect(recovered?.finishedAt).toBeNull();
      } else if (scenario.expected === 'pass') {
        expect(ledgerRead).toBe(true);
        expect(updates).toHaveLength(1);
        expect(recovered).toMatchObject({ exitCode: 0, finishedAt: 1_700_000_009_000 });
      } else {
        expect(ledgerRead).toBe(true);
        expect(updates).toHaveLength(1);
        expect(recovered).toMatchObject({
          status: 'error',
          exitCode: null,
          output: expect.stringContaining('no test verdict was observed'),
        });
      }
    },
  );

  it.each([
    {
      name: 'exact coverage',
      requestedFiles: ['lib/first.test.ts', 'lib/second.test.ts'],
      rows: ['lib/first.test.ts', 'lib/second.test.ts'],
      expected: 'pass',
    },
    {
      name: 'partial coverage',
      requestedFiles: ['lib/first.test.ts', 'lib/second.test.ts'],
      rows: ['lib/first.test.ts'],
      expected: 'error',
    },
    {
      name: 'unknown coverage',
      requestedFiles: null,
      rows: ['lib/first.test.ts', 'lib/second.test.ts'],
      expected: 'error',
    },
  ] as const)('enforces requested-file coverage on a persisted terminal PASS: $name', async (scenario) => {
    const runId = `terminal-pass-${scenario.name.replaceAll(' ', '-')}`;
    const requestedFiles = scenario.requestedFiles;
    const ledgerRows = scenario.rows.map((file_path, index) => ({
      file_path,
      status: 'pass',
      finished_at: new Date(1_700_000_001_000 + index * 1_000),
      output_tail: null,
    }));
    const updates: unknown[][] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
        return [{
          run_id: runId,
          task_id: 'task-terminal-pass',
          kind: 'vitest',
          label: 'terminal pass',
          file_path: null,
          command: ['node', 'scripts/test-files.mjs'],
          status: 'pass',
          exit_code: 0,
          started_at: new Date(1_700_000_000_000),
          finished_at: new Date(1_700_000_010_000),
          output: '',
          truncated: false,
          task_state: 'exited',
          task_exit_code: 0,
          task_ended_at: new Date(1_700_000_010_000),
          task_detail: requestedFiles ? { requestedFiles } : {},
        }];
      }
      if (statement.includes('FROM harness_shared.test_runs')) return ledgerRows;
      if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) {
        updates.push(values);
        return [{ run_id: runId }];
      }
      return [];
    }) as unknown as Sql;

    const recovered = await store.getRunAsync(runId, sql);

    expect(recovered?.status).toBe(scenario.expected);
    if (scenario.expected === 'pass') {
      expect(recovered?.requestedFiles).toEqual(requestedFiles);
      expect(recovered?.output).not.toContain('[coverage-gate]');
      expect(updates).toHaveLength(0);
    } else {
      expect(recovered?.output).toContain('[coverage-gate]');
      expect(updates).toHaveLength(1);
      expect(updates[0]?.[0]).toBe('error');
    }
  });

  it('waits for local terminal finalization before returning testing:run status', async () => {
    type Sql = Parameters<Store['persistRunSnapshot']>[1];
    const previousPersistOptIn = process.env.PAPERCUSP_TEST_RUNS_PERSIST;
    process.env.PAPERCUSP_TEST_RUNS_PERSIST = '1';
    // Close-time persistence dynamically imports the mocked DB module. Warm it
    // first so this lifecycle assertion measures finalization, not cold import.
    await import('@papercusp/db-org');
    let releaseTerminalSnapshot!: () => void;
    let markTerminalSnapshotStarted!: () => void;
    const terminalSnapshotStarted = new Promise<void>((resolve) => {
      markTerminalSnapshotStarted = resolve;
    });
    const terminalSnapshotGate = new Promise<void>((resolve) => {
      releaseTerminalSnapshot = resolve;
    });
    persistSqlMock.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('INSERT INTO harness_shared.testing_run_snapshots') && values[5] === 'pass') {
        markTerminalSnapshotStarted();
        await terminalSnapshotGate;
      }
      return [];
    });
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      if (strings.join(' ').includes('FROM harness_shared.test_runs')) {
        return [{
          file_path: 'lib/local-pass.test.ts',
          status: 'pass',
          finished_at: new Date(1_700_000_001_000),
          output_tail: null,
        }];
      }
      return [];
    }) as unknown as Sql;

    try {
      const snapshot = store.startRun(req({ requestedFiles: ['lib/local-pass.test.ts'] }));
      lastChild._emitClose(0);
      let terminalStartTimer: ReturnType<typeof setTimeout> | undefined;
      const terminalStartResult = await Promise.race([
        terminalSnapshotStarted.then(() => 'started' as const),
        new Promise<'timeout'>((resolve) => {
          terminalStartTimer = setTimeout(() => resolve('timeout'), 1_500);
        }),
      ]);
      if (terminalStartTimer) clearTimeout(terminalStartTimer);
      expect(terminalStartResult, JSON.stringify({
        local: store.getRun(snapshot.runId),
        persistCalls: persistSqlMock.mock.calls.map((call) => ({
          query: call[0]?.join(' ').trim().replace(/\\s+/g, ' ').slice(0, 90),
          values: call.slice(1, 7),
        })),
      })).toBe('started');

      let settled = false;
      const statusRead = store.getRunAsync(snapshot.runId, sql).then((result) => {
        settled = true;
        return result;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      releaseTerminalSnapshot();
      await expect(statusRead).resolves.toMatchObject({
        runId: snapshot.runId,
        status: 'pass',
        requestedFiles: ['lib/local-pass.test.ts'],
      });
      expect(settled).toBe(true);
    } finally {
      releaseTerminalSnapshot();
      if (previousPersistOptIn === undefined) delete process.env.PAPERCUSP_TEST_RUNS_PERSIST;
      else process.env.PAPERCUSP_TEST_RUNS_PERSIST = previousPersistOptIn;
    }
  });

  it('reconciles a stale running snapshot when its linked task deadline elapsed first', async () => {
    const updates: unknown[][] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
        return [
          {
            run_id: 'deadline-run',
            task_id: 'task-deadline',
            kind: 'vitest',
            label: 'deadline',
            file_path: 'lib/example.test.ts',
            command: ['node', 'router.js'],
            status: 'running',
            exit_code: null,
            started_at: new Date(Date.now() - 120_000),
            finished_at: null,
            output: 'partial output',
            truncated: false,
            task_state: 'running',
            task_deadline_at: new Date(Date.now() - 1_000),
          },
        ];
      }
      if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) {
        updates.push(values);
        return [{ run_id: 'deadline-run' }];
      }
      return [];
    }) as unknown as Sql;

    await expect(store.getRunAsync('deadline-run', sql)).resolves.toMatchObject({
      runId: 'deadline-run',
      status: 'error',
      exitCode: null,
      finishedAt: expect.any(Number),
      output: expect.stringContaining('passed its durable runtime deadline'),
    });
    expect(updates).toHaveLength(1);
  });

  it('does not report a local orphan conversion when the compare-and-set loses a race', async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
        return [
          {
            run_id: 'raced-run',
            task_id: 'task-raced',
            kind: 'shell',
            label: 'raced',
            file_path: null,
            command: ['bash', '-c', 'true'],
            status: 'running',
            exit_code: null,
            started_at: new Date(1_700_000_000_000),
            finished_at: null,
            output: '',
            truncated: false,
            task_state: 'killed',
          },
        ];
      }
      if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) return [];
      return [];
    }) as unknown as Sql;

    await expect(store.getRunAsync('raced-run', sql)).resolves.toMatchObject({
      runId: 'raced-run',
      taskId: 'task-raced',
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
    let runClosed = false;
    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args.includes('rev-parse')) return runClosed ? 'after-sha\n' : 'before-sha\n';
      if (args.includes('status')) return runClosed ? ' M peer-edit.ts\n' : '';
      return '';
    });
    let runId: string | undefined;
    let resolveFallback!: (values: unknown[]) => void;
    const fallbackPersisted = new Promise<unknown[]>((resolve) => {
      resolveFallback = resolve;
    });
    persistSqlMock.mockImplementation((_strings: TemplateStringsArray, ..._values: unknown[]) => {
      if (runId && _values[7] === runId) resolveFallback(_values);
      return Promise.resolve([]);
    });
    const previousPersistOptIn = process.env.PAPERCUSP_TEST_RUNS_PERSIST;
    process.env.PAPERCUSP_TEST_RUNS_PERSIST = '1';
    try {
      runId = store.startRun(req({ kind: 'shell' })).runId;
      runClosed = true;
      lastChild._emitClose(0);
      const capturedValues = await fallbackPersisted;
      expect(capturedValues[10]).toBe('after-sha');
      expect(capturedValues.at(-1)).toBe(true);
    } finally {
      if (previousPersistOptIn === undefined) delete process.env.PAPERCUSP_TEST_RUNS_PERSIST;
      else process.env.PAPERCUSP_TEST_RUNS_PERSIST = previousPersistOptIn;
    }
  });
});
