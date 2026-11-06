import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildDetachedTestRunRequest, launchManagedTestProcess, runTestProcess, type ManagedTestProcessDeps } from './run';
import { REPO_ROOT } from '../docs/_repo-paths';
import { testRunDeadline } from './run-artifacts';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn<NonNullable<ManagedTestProcessDeps['managedSpawnFn']>>(),
  killScope: vi.fn(async () => ({ ok: true, action: 'kill' })),
}));
vi.mock('../../task-manager/managed-spawn', async original => ({
  ...await original<typeof import('../../task-manager/managed-spawn')>(),
  managedSpawn: mocks.spawn,
  markManagedSpawnTeardown: () => vi.fn(),
}));
vi.mock('../../task-manager/control', async original => ({
  ...await original<typeof import('../../task-manager/control')>(),
  killScopeUnit: mocks.killScope,
}));
vi.mock('../../resource-governor/execution', async original => ({
  ...await original<typeof import('../../resource-governor/execution')>(),
  runGovernedOperation: (_spec: unknown, run: (context: unknown) => unknown) => run({}),
}));

const directories: string[] = [];
afterEach(async () => {
  const owned = directories.splice(0);
  await Promise.all(owned.map(path => rm(path, { recursive: true, force: true })));
  for (const path of owned) expect(existsSync(path)).toBe(false);
  mocks.spawn.mockReset();
  mocks.killScope.mockClear();
});

it.each(['close', 'spawn-error'] as const)('retains real child %s and original output before the ledger handoff', async event => {
  const root = await mkdtemp(join(tmpdir(), 'papercusp-testing-real-handoff-'));
  directories.push(root);
  const source = "process.stdout.write('real-child-output\\n'); process.stderr.write('real-child-error\\n'); process.exitCode = 7;";
  let releaseLedger!: () => void;
  const ledger = new Promise<void>(resolve => { releaseLedger = resolve; });
  let child: ChildProcess | undefined;
  let childClosed = false;
  let handedOff = false;
  mocks.spawn.mockImplementation(async (command, args, spec, options) => {
    expect(command).toBe(join(REPO_ROOT, 'scripts/testing-run-probe-overlay.sh'));
    expect(spec.argv).toEqual([command, ...args]);
    expect(args).toContain(source);
    options?.stage?.('spawn-fork');
    const spawned = spawnChild(event === 'spawn-error' ? join(root, 'missing-overlay.sh') : command,
      [...args], options?.spawnOptions ?? {});
    child = spawned;
    // managedSpawn's own ledger observer also handles errors independently of
    // the caller. Preserve that behavior while controlling only its async wait.
    spawned.on('error', () => {});
    spawned.once('close', () => { childClosed = true; });
    options?.onSpawn?.(spawned, 'realhandofftask');
    await ledger;
    handedOff = true;
    return { child: spawned, taskId: 'realhandofftask', scopeUnit: null, confined: false,
      waitForCompletion: async () => ({ status: 'recorded' }) };
  });
  const controller = new AbortController();
  let outcome: Awaited<ReturnType<typeof runTestProcess>> | undefined;
  const result = runTestProcess(process.execPath, ['-e', source], [], root, root, {
    PAPERCUSP_TEST_ARTIFACT_DIR: root, PAPERCUSP_TEST_RUN_GROUP: 'real-handoff',
    PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT: join(root, 'probe-admission'),
  }, 60_000, controller.signal).then(value => { outcome = value; });
  try {
    await vi.waitFor(() => expect(childClosed).toBe(true), { timeout: 5_000 });
    await vi.waitFor(() => expect(outcome).toBeDefined());
    expect(handedOff).toBe(false);
    expect(outcome).toMatchObject({ timedOut: false, aborted: false });
    expect(outcome?.terminationUnconfirmed).toBeUndefined();
    const [stdoutPath, stderrPath] = outcome!.outputLogPaths!;
    if (event === 'close') {
      expect(outcome?.code).toBe(7);
      expect(await readFile(stdoutPath!)).toEqual(Buffer.from('real-child-output\n'));
      expect(await readFile(stderrPath!)).toEqual(Buffer.from('real-child-error\n'));
      expect(outcome?.output).toContain('real-child-output');
      expect(outcome?.output).toContain('real-child-error');
    } else {
      expect(outcome?.spawnError).toMatch(/ENOENT/);
      expect(await readFile(stdoutPath!)).toHaveLength(0);
      expect(await readFile(stderrPath!)).toHaveLength(0);
    }
    const phases = (await readFile(join(root, 'phases.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(phases).toContainEqual(expect.objectContaining({ stage: 'process-child-close', taskId: 'realhandofftask' }));
    if (event === 'spawn-error') expect(phases).toContainEqual(expect.objectContaining({ stage: 'process-child-error' }));
    expect(phases.some(phase => phase.stage === 'process-launch-handoff')).toBe(false);
  } finally {
    controller.abort();
    releaseLedger();
    if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await result;
    await new Promise(resolve => setImmediate(resolve));
  }
  expect(handedOff).toBe(true);
  expect(childClosed).toBe(true);
});

it('waits for Task Manager settlement after the foreground child closes on timeout', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'papercusp-testing-settlement-'));
  directories.push(outputDir);
  const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn(() => true) }) as unknown as ChildProcess;
  let recordTask!: (value: { status: 'recorded' }) => void;
  const taskSettlement = new Promise<{ status: 'recorded' }>(resolve => { recordTask = resolve; });
  let childClosed = false;
  mocks.spawn.mockImplementation(async (_command, _args, _spec, options) => {
    options?.onSpawn?.(child, 'foreground-settlement');
    return {
      child,
      taskId: 'foreground-settlement',
      scopeUnit: 'pc-foreground-settlement.scope',
      confined: true,
      waitForCompletion: () => taskSettlement,
    };
  });
  mocks.killScope.mockImplementation(async () => {
    child.emit('close', null, 'SIGTERM');
    childClosed = true;
    return { ok: true, action: 'kill' };
  });

  let outcome: Awaited<ReturnType<typeof runTestProcess>> | undefined;
  let settled = false;
  const controller = new AbortController();
  const result = runTestProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], [], outputDir, outputDir, {
    PAPERCUSP_TEST_ARTIFACT_DIR: outputDir,
    PAPERCUSP_TEST_RUN_GROUP: 'timeout-settlement',
    PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT: join(outputDir, 'probe-admission'),
  }, 200, controller.signal).then(value => {
    outcome = value;
    settled = true;
  });
  try {
    await vi.waitFor(() => expect(mocks.killScope).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(childClosed).toBe(true), { timeout: 5_000 });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    recordTask({ status: 'recorded' });
    await result;
    expect(outcome).toMatchObject({ timedOut: true, aborted: false });
    expect(outcome).not.toHaveProperty('terminationUnconfirmed');
  } finally {
    controller.abort();
    recordTask({ status: 'recorded' });
    await result;
  }
});

it('keeps a timeout unconfirmed when Task Manager delegates a still-live scope', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'papercusp-testing-delegated-settlement-'));
  directories.push(outputDir);
  const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn(() => true) }) as unknown as ChildProcess;
  mocks.spawn.mockImplementation(async (_command, _args, _spec, options) => {
    options?.onSpawn?.(child, 'foreground-delegated');
    return {
      child,
      taskId: 'foreground-delegated',
      scopeUnit: 'pc-foreground-delegated.scope',
      confined: true,
      waitForCompletion: async () => ({ status: 'delegated', reason: 'scope still populated' }),
    };
  });
  mocks.killScope.mockImplementation(async () => {
    child.emit('close', null, 'SIGTERM');
    return { ok: true, action: 'kill' };
  });

  const outcome = await runTestProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], [], outputDir, outputDir, {
    PAPERCUSP_TEST_ARTIFACT_DIR: outputDir,
    PAPERCUSP_TEST_RUN_GROUP: 'timeout-delegated-settlement',
    PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT: join(outputDir, 'probe-admission'),
  }, 200);
  expect(outcome).toMatchObject({
    timedOut: true,
    aborted: false,
    terminationUnconfirmed: true,
    taskId: 'foreground-delegated',
  });
});

it('keeps the detached core in its serving checkout while preserving an external test root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'papercusp-external-background-'));
  directories.push(root);
  const file = 'dirty.integration.test.ts';
  const request = buildDetachedTestRunRequest({ root, files: [file], background: true,
    deadline: testRunDeadline(60_000), workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' });
  for (const report of request.detachedReportArtifacts ?? []) directories.push(dirname(report.reportPath));
  // The worker imports cwd-based platform helpers before it spawns the test.
  // An unrelated corpus has neither these scripts nor the platform docs tree.
  expect(existsSync(join(root, 'scripts/testing-run-probe-overlay.sh'))).toBe(false);
  expect(request.cwd).toBe(REPO_ROOT);
  expect(existsSync(join(request.cwd!, 'scripts/testing-run-probe-overlay.sh'))).toBe(true);
  expect(request.args?.at(-1)).toContain(JSON.stringify(root));
  expect(request.requestedFiles).toEqual([file]);
});

it.each([true, false])('preserves foreground task ownership with parent context present=%s', async nested => {
  const outputDir = await mkdtemp(join(tmpdir(), 'papercusp-testing-task-context-'));
  directories.push(outputDir);
  const outputPath = join(outputDir, 'router.log');
  const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn(() => true) }) as unknown as ChildProcess;
  const spawn = vi.fn<NonNullable<ManagedTestProcessDeps['managedSpawnFn']>>(async () => ({
    child, taskId: 'foregroundtask', scopeUnit: null, confined: false,
    waitForCompletion: async () => ({ status: 'recorded' }),
  }));
  await launchManagedTestProcess({
    command: process.execPath, args: [], cwd: process.cwd(),
    env: {
      PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
      PAPERCUSP_TEST_RUN_WORK_ITEM: 'WI-context',
      ...(nested ? { PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: 'parenttask1234' } : {}),
    },
    timeoutMs: 60_000, runGroup: 'task-context', workspaceId: 'papercusp-workspace',
    outputPath,
  }, { managedSpawnFn: spawn });
  expect(spawn.mock.calls[0]?.[2]).toMatchObject({
    workItemId: 'WI-context', harnessSlug: 'papercusp',
    parentTaskId: nested ? 'parenttask1234' : null,
    logPath: outputPath,
  });
});

it.each([false, true])('preserves ordered wrapper cleanup with bounded escalation (confined=%s)', async confined => {
  const outputDir = await mkdtemp(join(tmpdir(), 'papercusp-testing-ordered-cleanup-'));
  directories.push(outputDir);
  const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn(() => true) }) as unknown as ChildProcess;
  const killScope = vi.fn(async () => ({ ok: true as const, scopeUnit: 'pc-orderedcleanup.scope', action: 'kill' }));
  const killGroup = vi.fn();
  const launched = await launchManagedTestProcess({
    command: process.execPath, args: [], cwd: process.cwd(), env: {}, timeoutMs: 60_000,
    cooperativeTermination: true, runGroup: 'ordered-cleanup', workspaceId: 'papercusp-workspace',
    outputPath: join(outputDir, 'router.log'),
  }, {
    managedSpawnFn: async () => ({ child, taskId: 'orderedcleanup',
      scopeUnit: confined ? 'pc-orderedcleanup.scope' : null, confined,
      waitForCompletion: async () => ({ status: 'recorded' }) }),
    killScopeUnitFn: killScope, killProcessGroupFn: killGroup,
  });
  vi.useFakeTimers();
  try {
    launched.terminate();
    if (confined) {
      expect(killScope).toHaveBeenCalledWith('pc-orderedcleanup.scope', expect.objectContaining({
        signal: 'SIGTERM', cooperativeRoots: true, escalateAfterMs: expect.any(Number),
      }));
      expect(child.kill).not.toHaveBeenCalled();
    } else {
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(killGroup).not.toHaveBeenCalled();
      await vi.runOnlyPendingTimersAsync();
      expect(killGroup).toHaveBeenCalledExactlyOnceWith(4242, 'SIGKILL');
    }
  } finally {
    vi.useRealTimers();
  }
});

it.each(['close', 'error', 'blocked'] as const)('settles a %s child before handoff without confusing cancellation and exit', async event => {
  const outputDir = await mkdtemp(join(tmpdir(), 'papercusp-testing-handoff-'));
  directories.push(outputDir);
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) }) as unknown as ChildProcess;
  child.on('error', () => {});
  let forked!: () => void;
  const spawned = new Promise<void>(resolve => { forked = resolve; });
  let releaseLedger!: () => void;
  const ledger = new Promise<void>(resolve => { releaseLedger = resolve; });
  mocks.spawn.mockImplementation(async (_command, _args, _spec, options) => {
    options?.stage?.('spawn-fork');
    options?.onSpawn?.(child, 'earlyclosetask');
    forked();
    await ledger;
    return { child, taskId: 'earlyclosetask', scopeUnit: 'pc-earlyclosetask.scope', confined: true,
      waitForCompletion: async () => ({ status: 'recorded' }) };
  });
  const controller = new AbortController();
  let outcome: Awaited<ReturnType<typeof runTestProcess>> | undefined;
  const result = runTestProcess(process.execPath, [], [], process.cwd(), process.cwd(), {
    PAPERCUSP_TEST_ARTIFACT_DIR: outputDir, PAPERCUSP_TEST_RUN_GROUP: 'early-close',
  }, 60_000, controller.signal).then(value => { outcome = value; });
  try {
    await spawned;
    if (event === 'close') child.emit('close', 7, null);
    else if (event === 'error') child.emit('error', new Error('fork failed before handoff'));
    else controller.abort();
    await vi.waitFor(() => expect(outcome).toBeDefined());
    expect(outcome).toMatchObject({ timedOut: false, aborted: event === 'blocked' });
    if (event === 'blocked') {
      expect(outcome).toMatchObject({ terminationUnconfirmed: true, taskId: 'earlyclosetask' });
    }
    if (event === 'close') expect(outcome?.code).toBe(7);
    if (event === 'error') expect(outcome?.spawnError).toBe('fork failed before handoff');
    const phases = (await readFile(join(outputDir, 'phases.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).stage);
    expect(phases).toContain('process-spawn-fork');
    expect(phases).toContain('process-child-spawned');
    expect(phases).not.toContain('process-launch-handoff');
    if (event !== 'blocked') expect(phases).toContain(`process-child-${event}`);
  } finally {
    controller.abort();
    releaseLedger();
    await result;
    await new Promise(resolve => setImmediate(resolve));
  }
  // Only a still-live cancelled launch needs termination when its handle arrives.
  expect(mocks.killScope).toHaveBeenCalledTimes(event === 'blocked' ? 1 : 0);
});

it.each(['close', 'error'] as const)('observes child %s before the managed ledger handoff completes', async event => {
  const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn(() => true) }) as unknown as ChildProcess;
  // managedSpawn itself observes errors; keep the fake faithful even on the red run.
  child.on('error', () => {});
  let forked!: () => void;
  const spawned = new Promise<void>(resolve => { forked = resolve; });
  let releaseLedger!: () => void;
  const ledger = new Promise<void>(resolve => { releaseLedger = resolve; });
  const terminals: string[] = [];
  const outputDir = await mkdtemp(join(tmpdir(), 'papercusp-testing-early-close-'));
  directories.push(outputDir);
  const launch = launchManagedTestProcess({
    command: process.execPath, args: [], cwd: process.cwd(), env: {}, timeoutMs: 60_000,
    runGroup: 'early-close', workspaceId: 'papercusp-workspace', outputPath: join(outputDir, 'router.log'),
    onSpawn: observed => {
      observed.once('close', code => terminals.push(`close:${code}`));
      observed.once('error', error => terminals.push(`error:${error.message}`));
    },
  }, {
    managedSpawnFn: async (_command, _args, _spec, options) => {
      options?.onSpawn?.(child, 'earlyclosetask');
      forked();
      await ledger;
      return { child, taskId: 'earlyclosetask', scopeUnit: null, confined: false,
        waitForCompletion: async () => ({ status: 'recorded' }) };
    },
  });
  try {
    await spawned;
    if (event === 'close') child.emit('close', 7, null);
    else child.emit('error', new Error('fork failed before handoff'));
    // A blocked npm child emits neither terminal event. Here the child closes
    // while the ledger wait is held, before launch can resolve.
    expect(terminals).toEqual([event === 'close' ? 'close:7' : 'error:fork failed before handoff']);
  } finally {
    releaseLedger();
    await launch;
  }
});
