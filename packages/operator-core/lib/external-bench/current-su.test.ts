import { describe, expect, it, vi } from 'vitest';
import {
  currentBenchLaunchRequest, currentBenchRunLabel, currentSuBenchHarnessDriver,
  liveCurrentSuBenchPorts, recoverCurrentBenchRun,
  type CurrentBenchIdentity, type CurrentBenchTask, type CurrentSuBenchOptions, type CurrentSuBenchPorts,
} from './current-su';
import type { BenchHarnessOps } from './bench-harness-live';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';

const native = vi.hoisted(() => ({ launch: vi.fn(), kill: vi.fn() }));
vi.mock('../agent-tools/capability/launch-agent', () => ({ default: { handler: native.launch } }));
vi.mock('../task-manager/control', () => ({ killTask: native.kill }));

const options: CurrentSuBenchOptions = {
  workspaceId: 'bench-private', runId: 'run-1', agent: 'codex', model: 'configured-alias',
  effort: 'high', account: 'auto', pollIntervalMs: 10, driveTimeoutMs: 100,
};
const handle = { slug: 'xbench-current-1', featureId: 'xbench-feature-1', worktreePath: '/scratch/task' };
const request = {
  blueprintId: 'su', task: { benchmark: 'swe-bench-pro', instanceId: 't1', problemStatement: 'Fix the public issue.', graderMeta: { hidden: 'SECRET' } },
  checkout: { dir: '/scratch/task', repo: 'a/b', baseCommit: 'base', cleanup: async () => {} },
  budget: { maxUsd: 3, maxWallClockMs: 100 },
};
const identity: CurrentBenchIdentity = {
  measuredBy: 'runtime-observation', runtimeRevision: 'served-revision', sourceRevision: 'source-revision',
  model: 'served-model', effort: 'medium', clientVersion: 'native-client/1',
  promptHash: 'measured-prompt', toolsHash: 'measured-tools', observedAt: '2026-10-09T20:00:00Z', evidenceRefs: ['usage:actual-task'],
};
function fixture(opts = options) {
  let clock = 0;
  const row: CurrentBenchTask = {
    taskId: 'task-own', workspaceId: opts.workspaceId, state: 'exited', exitCode: 0,
    detail: { label: currentBenchLaunchRequest(opts, handle, 'issue').label },
  };
  const lifecycle: BenchHarnessOps = {
    now: () => clock,
    createHarness: vi.fn(async () => handle), addFeature: vi.fn(async () => {}),
    driveToDone: vi.fn(async () => ({ disposition: 'error' })),
    collectCost: vi.fn(async () => ({ costUsd: 0.25, tokensIn: 20, tokensOut: 10, turns: 1 })),
    teardown: vi.fn(async () => {}),
  };
  const ports: CurrentSuBenchPorts = {
    admit: vi.fn(async () => ({ admitted: true, receiptRef: 'budget:reservation-1' })),
    launch: vi.fn(async () => ({ agentStarted: true, tasks: [{ taskId: row.taskId, ownerId: 'su-native' }] })),
    getTask: vi.fn(async () => row), listTasks: vi.fn(async () => [row]),
    killTask: vi.fn(async id => ({ ok: true, taskId: id, action: 'kill' })),
    sleep: vi.fn(async ms => { clock += ms; }),
    readCompletion: vi.fn(async () => null), readIdentity: vi.fn(async () => identity),
  };
  return { row, ports, lifecycle, run: () => currentSuBenchHarnessDriver(lifecycle, ports, opts).spinRunAndCost(request) };
}
describe('current native benchmark execution', () => {
  it('uses the maintained native su request, pins explicit controls and excludes hidden grader inputs', async () => {
    const f = fixture();
    const result = await f.run();
    expect(f.ports.launch).toHaveBeenCalledWith(expect.objectContaining({
      harness: handle.slug, cwd: handle.worktreePath, feature: handle.featureId, workItem: handle.featureId,
      independent: true, headless: true, count: 1, mcpTarget: 'spawn-host',
      members: [{ role: 'su', agent: 'codex', model: 'configured-alias', effort: 'high', account: 'auto' }],
    }));
    const args = vi.mocked(f.ports.launch).mock.calls[0][0];
    expect(args.brief).toContain(request.task.problemStatement);
    expect(args.brief).not.toContain('SECRET');
    expect(result.telemetry.stopReason).toBe('done');
    expect(result.telemetry.armMeta?.currentExecution).toMatchObject({
      configured: { model: 'configured-alias', effort: 'high' }, measured: identity, identityStatus: 'measured',
      launchReceipt: { tasks: [{ taskId: 'task-own' }] }, terminalReceipt: { taskId: 'task-own', exitCode: 0 }, retiredTaskIds: ['task-own'],
    });
    expect(f.lifecycle.driveToDone).not.toHaveBeenCalled();
    expect(f.lifecycle.teardown).toHaveBeenCalledOnce();
  });
  it.each([null, { ...identity, measuredBy: 'configuration' }, { ...identity, toolsHash: '' }, { ...identity, evidenceRefs: [] }])(
    'does not convert missing or configured identity into a runtime measurement: %j', async value => {
      const f = fixture();
      vi.mocked(f.ports.readIdentity).mockResolvedValue(value as CurrentBenchIdentity | null);
      const result = await f.run();
      expect(result.telemetry.armMeta?.currentExecution).toMatchObject({ identityStatus: 'unknown', measured: null });
    },
  );
  it('refuses production workspace before registration or process launch', () => {
    const f = fixture();
    expect(() => currentSuBenchHarnessDriver(f.lifecycle, f.ports, { ...options, workspaceId: ' papercusp-workspace ' })).toThrow(/PRODUCTION/);
    expect(f.lifecycle.createHarness).not.toHaveBeenCalled();
    expect(f.ports.launch).not.toHaveBeenCalled();
  });
  it('refuses retired treatment dispatch rather than reconstructing its blueprint', async () => {
    const f = fixture();
    const result = await currentSuBenchHarnessDriver(f.lifecycle, f.ports, options).spinRunAndCost({ ...request, blueprintId: 'external-bench' });
    expect(result.telemetry.generationError).toMatch(/retired treatment/);
    expect(f.lifecycle.createHarness).not.toHaveBeenCalled();
    expect(f.ports.launch).not.toHaveBeenCalled();
  });
  it('records declined admission as a cap outcome and launches no process', async () => {
    const f = fixture();
    vi.mocked(f.ports.admit).mockResolvedValue({ admitted: false, receiptRef: 'budget:full' });
    expect((await f.run()).telemetry.stopReason).toBe('budget-exhausted');
    expect(f.ports.launch).not.toHaveBeenCalled();
  });
  it('requires a durable budget receipt before launch', async () => {
    const f = fixture();
    vi.mocked(f.ports.admit).mockResolvedValue({ admitted: true, receiptRef: '' });
    expect((await f.run()).telemetry.generationError).toMatch(/no durable receipt/);
    expect(f.ports.launch).not.toHaveBeenCalled();
  });
  it('cancels before launch without admitting or spending', async () => {
    const ac = new AbortController(); ac.abort();
    const f = fixture({ ...options, signal: ac.signal });
    expect((await f.run()).telemetry.stopReason).toBe('timeout');
    expect(f.ports.admit).not.toHaveBeenCalled();
    expect(f.ports.launch).not.toHaveBeenCalled();
  });
  it('cancels a process whose launch completes after cancellation and retains its receipt', async () => {
    const ac = new AbortController();
    const f = fixture({ ...options, signal: ac.signal });
    vi.mocked(f.ports.launch).mockImplementation(async () => { ac.abort(); return { agentStarted: true, tasks: [{ taskId: 'task-own' }] }; });
    const result = await f.run();
    expect(result.telemetry.generationError).toMatch(/cancelled during/);
    expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
    expect(result.telemetry.armMeta?.currentExecution).toMatchObject({ retiredTaskIds: ['task-own'] });
  });
  it('uses the attempt wall-clock cap and retires its live task', async () => {
    const f = fixture(); f.row.state = 'running'; f.row.exitCode = null;
    const result = await currentSuBenchHarnessDriver(f.lifecycle, f.ports, options).spinRunAndCost({ ...request, budget: { maxUsd: 3, maxWallClockMs: 20 } });
    expect(result.telemetry.stopReason).toBe('timeout');
    expect(result.telemetry.wallClockMs).toBe(20);
    expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
  });
  it('preserves completed work while stopping a still-live native host', async () => {
    const f = fixture(); f.row.state = 'running'; f.row.exitCode = null;
    vi.mocked(f.ports.readCompletion).mockResolvedValue('done');
    expect((await f.run()).telemetry.stopReason).toBe('done');
    expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
  });
  it('stops at the metered attempt cap and retains the total cost', async () => {
    const f = fixture(); f.row.state = 'running'; f.row.exitCode = null;
    vi.mocked(f.lifecycle.collectCost).mockResolvedValue({ costUsd: 3, tokensIn: 20, tokensOut: 10, turns: 1 });
    const result = await f.run();
    expect(result.telemetry.stopReason).toBe('budget-exhausted');
    expect(result.telemetry.costUsd).toBe(3);
    expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
    expect(f.ports.launch).toHaveBeenCalledOnce();
  });
  it('refuses a task receipt pointing to another workspace', async () => {
    const f = fixture(); f.row.workspaceId = 'papercusp-workspace';
    expect((await f.run()).telemetry.generationError).toMatch(/identity\/scope/);
    expect(f.ports.killTask).not.toHaveBeenCalled();
  });
  it('reports unobserved termination as an error rather than a clean exit', async () => {
    const f = fixture(); f.row.state = 'ended_unobserved'; f.row.exitCode = null;
    expect((await f.run()).telemetry.generationError).toMatch(/unobserved/);
  });
  it('cleans a partially launched task using durable labels when the launch reply is lost', async () => {
    const f = fixture(); vi.mocked(f.ports.launch).mockRejectedValue(new Error('transport lost receipt'));
    expect((await f.run()).telemetry.generationError).toMatch(/lost receipt/);
    expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
  });
  it('refuses a launch receipt without observed native start and cleans its task', async () => {
    const f = fixture(); vi.mocked(f.ports.launch).mockResolvedValue({ agentStarted: false, tasks: [{ taskId: 'task-own' }] });
    expect((await f.run()).telemetry.generationError).toMatch(/no verified single-agent start/);
    expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
  });
  it('does not claim successful generation when process cleanup fails', async () => {
    const f = fixture();
    vi.mocked(f.ports.killTask).mockResolvedValue({ ok: false, taskId: 'task-own', action: 'kill', error: 'not_live' });
    const result = await f.run();
    expect(result.telemetry.stopReason).toBe('error');
    expect(result.telemetry.generationError).toMatch(/cleanup failed/);
  });
});
describe('current benchmark restart and live binding', () => {
  it('recovers only tasks belonging to the exact interrupted run and workspace', async () => {
    const f = fixture();
    const peer = { ...f.row, taskId: 'peer', detail: { label: `${currentBenchRunLabel('run-2')}solver` } };
    const production = { ...f.row, taskId: 'production', workspaceId: 'papercusp-workspace' };
    vi.mocked(f.ports.listTasks).mockResolvedValue([f.row, peer, production]);
    expect(await recoverCurrentBenchRun(f.ports, options)).toEqual(['task-own']);
    expect(f.ports.listTasks).toHaveBeenCalledWith({ workspaceId: 'bench-private', labelPrefix: currentBenchRunLabel('run-1'), includeEnded: true, limit: 1000 });
    expect(f.ports.killTask).toHaveBeenCalledExactlyOnceWith('task-own');
  });
  it('fails closed on a truncated cleanup census', async () => {
    const f = fixture(); vi.mocked(f.ports.listTasks).mockResolvedValue(Array.from({ length: 1000 }, () => f.row));
    await expect(recoverCurrentBenchRun(f.ports, options)).rejects.toThrow(/census exceeded/);
    expect(f.ports.killTask).not.toHaveBeenCalled();
  });
  it('calls the maintained handler with the original authenticated context and subtree controller', async () => {
    const f = fixture();
    const ctx = { workspaceId: 'bench-private', authenticatedPrincipal: { retained: true } } as unknown as PapercuspUnifiedToolContext;
    const ports = liveCurrentSuBenchPorts(ctx, f.ports);
    const args = currentBenchLaunchRequest(options, handle, 'issue');
    await ports.launch(args);
    expect(native.launch).toHaveBeenCalledWith(args, ctx);
    await ports.killTask('task-own');
    expect(native.kill).toHaveBeenCalledWith('task-own', { includeSubtree: true, reapTerminalResidue: true, escalateAfterMs: 5000 });
    expect(ctx.workspaceId).toBe('bench-private');
  });
});
