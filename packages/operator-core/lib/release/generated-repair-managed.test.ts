import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFrozenCandidateQueue, parseFrozenCandidateRepairQueue, parseGeneratedRepairOperation,
  type FrozenCandidateRepairQueue } from './frozen-candidate-repair-queue';
import type { AdmissionSuccess } from './repair-head-admission';
import type { TaskRow } from '../task-manager/types';
import { healGeneratedRepair, SELECTIVE_DECLARATION_OUTPUT as OUTPUT } from '../../../../apps/operator/lib/release/heal-generated-repair';
import { beginGeneratedRepair, runGeneratedRepairWorker, cancelGeneratedRepair, observeGeneratedRepair,
  generatedRepairOwnsQueue, startGeneratedRepairWorker, buildGeneratedRepairSpawnPlan,
  parseGeneratedRepairWorkerInput, type GeneratedRepairDeps, type GeneratedRepairWorkerInput } from './generated-repair-managed';

vi.mock('../../../../apps/operator/lib/release/green-checkpoint', () => ({}));
vi.mock('../harness/routines/release-actions', () => ({ applyFrozenCandidateRepairQueueTransition: vi.fn(), readFrozenCandidateRepairQueueState: vi.fn() }));
vi.mock('../task-manager/store', () => ({ getTask: vi.fn() }));
vi.mock('../task-manager/control', () => ({ killTask: vi.fn() }));
vi.mock('../task-manager/managed-spawn', () => ({ managedSpawn: vi.fn() }));
vi.mock('./admission-offthread', () => ({ runAdmissionJob: vi.fn() }));
vi.mock('./gate-action-receipt', () => ({ executeWithGateActionReceipt: vi.fn() }));
vi.mock('./repair-auto-verify', () => ({ scheduleRepairAutoVerify: vi.fn() }));

const HEAD = 'a'.repeat(40), NEXT = 'b'.repeat(40);
const target = { workspaceId: 'fixture-workspace', installSlug: 'fixture-drill' };
function taskRow(state: TaskRow['state'], confined = true): TaskRow {
  return { taskId: 'fixture-task', rootTaskId: 'fixture-task', workspaceId: target.workspaceId,
    class: 'bash-job', title: 'Generated repair fixture', argv: [], launchedBy: 'fixture',
    state, confined, startedAt: new Date(0).toISOString(), lastSeenAt: new Date(0).toISOString(), detail: {} };
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>(r => { release = r; });
  return { promise, release };
}
function fixture() {
  let q: FrozenCandidateRepairQueue = { ...createFrozenCandidateQueue({ candidate: HEAD, base: null, nowMs: 1 }),
    phase: 'awaiting-fixer', attempts: 1, fixerSpawnId: 'fixture-fixer' };
  let taskState = 'running';
  let input!: GeneratedRepairWorkerInput;
  let worker: Promise<void> | undefined;
  const materializing = latch(), continueSetup = latch();
  let wrote = false;
  const release = vi.fn();
  const admission: AdmissionSuccess = { ok: true, commit: NEXT, tree: 'c'.repeat(40),
    diff: [OUTPUT], unchanged: [], lineageRef: 'refs/repair/fixture', published: true, entry: {
    fromRepairHead: HEAD, toRepairHead: NEXT, paths: [OUTPUT], unchanged: [], blobs: { [OUTPUT]: 'd'.repeat(40) }, actor: 'fixture-actor', atMs: Date.now(),
    source: { ref: 'source', sha: 'd'.repeat(40) }, reason: 'paired generation' } };
  const transition = vi.fn(async (_target, update) => {
    const fresh = q;
    const next = await update(q);
    if (next !== q) {
      expect(next.updatedAtMs).toBeGreaterThan(q.updatedAtMs);
      // The production transition serializes JSON through the strict queue parser.
      const parsed = parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(next)));
      expect(parsed, 'operation must survive queue readback').not.toBeNull();
      q = parsed!;
    }
    return { queue: q, fresh, status: q === fresh ? 'unchanged' : 'written', retries: 0 };
  });
  const deps = {
    transition, readQueue: vi.fn(async () => ({ status: 'value', queue: q })),
    getTask: vi.fn(async () => ({ state: taskState, confined: true })),
    killTask: vi.fn(async () => { taskState = 'killed'; return { ok: true }; }),
    startWorker: vi.fn(async value => { input = value; return { confined: true, taskId: value.taskId }; }),
    heal: vi.fn(value => healGeneratedRepair(value, {
      acquire: () => ({ acquired: true, release }),
      setup: async () => { materializing.release(); await continueSetup.promise; },
      io: () => ({
        runScript: async script => {
          if (script === 'gen:declarations') { wrote = true; return { code: 0, tail: '' }; }
          return { code: wrote ? 0 : 1, tail: '' };
        },
        dirtyPaths: async () => wrote ? [OUTPUT] : [], buildSourceCommit: async () => 'd'.repeat(40),
        admit: async () => admission, log: () => {},
      }),
    })),
    action: vi.fn(async value => ({ ok: true, receiptId: 'fixture-action', effect: await value.run() })),
    admit: vi.fn(async () => admission),
    autoVerify: vi.fn(async () => {
      expect(q.healGeneratedOperation?.status).toBe('succeeded');
      expect(q.healGeneratedOperation?.result?.persisted).toBe(true);
      return { scheduled: true };
    }),
    notify: vi.fn(async () => {
      expect(q.healGeneratedOperation?.status).toBe('succeeded');
    }),
  } as unknown as GeneratedRepairDeps;
  const begin = () => beginGeneratedRepair({ queueTarget: target, integrationRoot: '/fixture',
    queue: { ...q, updatedAtMs: 1, repairHead: HEAD }, actor: 'fixture-actor', conditionKey: 'gate:red:fixture',
    delegate: { authorized: false, callerSpawnId: null, queueFixerSpawnId: null } }, deps);
  return { deps, begin, materializing, continueSetup, release,
    get queue() { return q; }, set queue(value) { q = value; },
    get input() { return input; }, setTaskState(state: string) { taskState = state; },
    run() { worker = runGeneratedRepairWorker(input, deps); return worker; },
  };
}

describe('durable generated repair', () => {
  it('returns one receipt before slow setup finishes; same request cannot launch or publish twice', async () => {
    const f = fixture();
    const first = await f.begin();
    expect(first).toMatchObject({ started: true, operation: { status: 'running' } });
    const work = f.run(); await f.materializing.promise;
    expect(vi.mocked(f.deps.admit)).not.toHaveBeenCalled();
    // Model an arbitrarily long lost caller response without a wall-clock sleep.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    try {
      const replay = await f.begin();
      expect(replay.operation?.operationId).toBe(first.operation?.operationId);
      expect(f.deps.startWorker).toHaveBeenCalledOnce();
      f.continueSetup.release(); await work;
      const op = await observeGeneratedRepair(target, f.deps);
      expect(op).toMatchObject({ status: 'succeeded', notificationsComplete: true,
        result: { admitted: true, persisted: true, repairQueue: { candidate: HEAD, repairHead: NEXT },
          completionReceipt: { effectRef: 'release:repair-queue:heal-generated:fixture-action' } } });
      expect(f.deps.admit).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
      expect(f.deps.notify).toHaveBeenCalledOnce(); expect(f.deps.autoVerify).toHaveBeenCalledOnce();
      await f.begin(); expect(f.deps.startWorker).toHaveBeenCalledOnce();
    } finally { clock.mockRestore(); f.continueSetup.release(); await work; }
  });
  it.each(['head', 'revision', 'marker'] as const)('refuses publication after unrelated %s movement', async kind => {
    const f = fixture(); await f.begin(); const work = f.run(); await f.materializing.promise;
    f.queue = kind === 'head' ? { ...f.queue, repairHead: NEXT } : kind === 'revision'
      ? { ...f.queue, updatedAtMs: f.queue.updatedAtMs + 1 }
      : { ...f.queue, healGeneratedOperation: undefined };
    f.continueSetup.release(); await work;
    expect(f.deps.admit).not.toHaveBeenCalled(); expect(f.deps.autoVerify).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it('cancels a slow preparation before stopping the task; a surviving child cannot publish', async () => {
    const f = fixture(); const started = await f.begin(); const work = f.run(); await f.materializing.promise;
    const result = await cancelGeneratedRepair(target, started.operation!.operationId, f.deps);
    expect(result).toMatchObject({ cancelled: true, operation: { status: 'cancelled' } });
    expect(f.deps.killTask).toHaveBeenCalledWith(started.operation!.taskId);
    f.continueSetup.release(); await work;
    expect(f.deps.admit).not.toHaveBeenCalled(); expect(f.queue.healGeneratedOperation?.status).toBe('cancelled');
  });
  it('refuses cancellation once publication reserves the queue and retains the published result', async () => {
    const f = fixture(); const admitted = latch(), resume = latch();
    vi.mocked(f.deps.admit).mockImplementation(async () => {
      admitted.release(); await resume.promise;
      return { ok: true, commit: NEXT, tree: 'c'.repeat(40), diff: [OUTPUT], unchanged: [], lineageRef: 'refs/repair/fixture', published: true,
        entry: { fromRepairHead: HEAD, toRepairHead: NEXT,
        paths: [OUTPUT], unchanged: [], blobs: { [OUTPUT]: 'd'.repeat(40) }, actor: 'fixture-actor', atMs: Date.now(), source: { ref: 'source', sha: 'd'.repeat(40) }, reason: 'paired generation' } };
    });
    const started = await f.begin(); const work = f.run(); f.continueSetup.release(); await admitted.promise;
    expect(await cancelGeneratedRepair(target, started.operation!.operationId, f.deps))
      .toMatchObject({ cancelled: false, reason: 'operation-not-cancellable' });
    expect(f.deps.killTask).not.toHaveBeenCalled(); resume.release(); await work;
    expect(f.queue.healGeneratedOperation?.status).toBe('succeeded');
  });
  it('records a preparation exception and recovers an ended worker without launching again', async () => {
    const f = fixture(); await f.begin();
    vi.mocked(f.deps.heal).mockRejectedValueOnce(new Error('materialization failed'));
    await f.run(); expect(f.queue.healGeneratedOperation).toMatchObject({ status: 'failed', result: { reason: expect.stringContaining('materialization failed') } });
    await f.begin(); expect(f.deps.startWorker).toHaveBeenCalledOnce();
    const g = fixture(); await g.begin(); g.setTaskState('timed_out');
    expect(await observeGeneratedRepair(target, g.deps)).toMatchObject({ status: 'interrupted', result: { effectMayHaveRun: false } });
    expect(g.deps.startWorker).toHaveBeenCalledOnce();
  });
  it('keeps unavailable task liveness unknown rather than relaunching or declaring a failure', async () => {
    const f = fixture(); await f.begin(); vi.mocked(f.deps.getTask).mockRejectedValueOnce(new Error('ledger unavailable'));
    await expect(observeGeneratedRepair(target, f.deps)).rejects.toThrow('ledger unavailable');
    expect(f.queue.healGeneratedOperation?.status).toBe('running'); expect(f.deps.startWorker).toHaveBeenCalledOnce();
  });
  it('waits for delayed confinement enrollment before doing repair work', async () => {
    const f = fixture(); await f.begin(); f.continueSetup.release();
    vi.useFakeTimers();
    try {
      vi.mocked(f.deps.getTask)
        .mockResolvedValueOnce(taskRow('pending', false))
        .mockResolvedValueOnce(taskRow('running'));
      const work = f.run();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.deps.heal).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000); await work;
      expect(f.deps.heal).toHaveBeenCalledOnce();
      expect(f.queue.healGeneratedOperation?.status).toBe('succeeded');
      expect(f.deps.startWorker).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it.each(['pending', 'absent', 'unreadable'] as const)
    ('bounds unconfirmed enrollment after parent loss (%s)', async state => {
      const f = fixture(); await f.begin();
      vi.useFakeTimers();
      try {
        if (state === 'unreadable') vi.mocked(f.deps.getTask).mockRejectedValue(new Error('ledger unavailable'));
        else vi.mocked(f.deps.getTask).mockResolvedValue(state === 'absent' ? null : taskRow('pending', false));
        const work = f.run();
        await vi.advanceTimersByTimeAsync(30_000); await work;
        expect(f.deps.heal).not.toHaveBeenCalled(); expect(f.deps.admit).not.toHaveBeenCalled();
        expect(f.queue.healGeneratedOperation).toMatchObject({ status: 'interrupted',
          result: { reason: 'managed-worker-enrollment-unconfirmed', effectMayHaveRun: false } });
        await f.begin(); expect(f.deps.startWorker).toHaveBeenCalledOnce();
      } finally { vi.useRealTimers(); }
    });
  it('refuses a confirmed unconfined task and records the interruption', async () => {
    const f = fixture(); await f.begin();
    vi.mocked(f.deps.getTask).mockResolvedValue(taskRow('running', false));
    await f.run();
    expect(f.deps.heal).not.toHaveBeenCalled();
    expect(f.queue.healGeneratedOperation).toMatchObject({ status: 'interrupted',
      result: { reason: 'managed-worker-enrollment-unconfirmed', effectMayHaveRun: false } });
  });
  it('retains publication uncertainty when reservation races a stale observer task read', async () => {
    const f = fixture(); await f.begin();
    vi.mocked(f.deps.getTask).mockImplementationOnce(async () => {
      await f.deps.transition(target, q => ({ ...q, healGeneratedOperation: {
        ...q.healGeneratedOperation!, status: 'publishing', phase: 'publishing',
      }, updatedAtMs: q.updatedAtMs + 1 }));
      return taskRow('exited');
    });
    expect(await observeGeneratedRepair(target, f.deps)).toMatchObject({ status: 'interrupted',
      result: { effectMayHaveRun: true } });
    expect(f.queue.healGeneratedOperation?.result?.effectMayHaveRun).toBe(true);
    await f.begin(); expect(f.deps.startWorker).toHaveBeenCalledOnce();
  });
  it('retries terminal notifications from stored success without repeating generation or publication', async () => {
    const f = fixture(); await f.begin();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(f.deps.notify).mockRejectedValueOnce(new Error('emitter unavailable'));
    try {
      f.continueSetup.release(); await f.run();
      expect(f.queue.healGeneratedOperation?.notificationsComplete).not.toBe(true);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('recoverable'), expect.any(Error));
      expect(await observeGeneratedRepair(target, f.deps)).toMatchObject({ notificationsComplete: true });
      expect(f.deps.admit).toHaveBeenCalledOnce(); expect(f.deps.heal).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });
  it('strictly retains the operation and refuses a malformed writer marker', async () => {
    const f = fixture(); await f.begin();
    expect(generatedRepairOwnsQueue(f.queue, f.queue.healGeneratedOperation!)).toBe(true);
    expect(parseGeneratedRepairOperation({ ...f.queue.healGeneratedOperation, taskId: null })).toBeNull();
    expect(parseFrozenCandidateRepairQueue({ ...f.queue, healGeneratedOperation: { corrupt: true } })).toBeNull();
  });
});

describe('generated repair task launch', () => {
  it('uses a host-independent task with a retained log and exact operation input', async () => {
    const f = fixture(); await f.begin();
    const dir = mkdtempSync(join(tmpdir(), 'generated-repair-test-'));
    const previous = process.env.PAPERCUSP_DESKTOP_PARENT_PID;
    process.env.PAPERCUSP_DESKTOP_PARENT_PID = '99999';
    const spawn = vi.fn(async () => ({ confined: true }));
    try {
      const plan = buildGeneratedRepairSpawnPlan();
      expect(plan.env.PAPERCUSP_DESKTOP_PARENT_PID).toBeUndefined();
      await startGeneratedRepairWorker(f.input, { spawn: spawn as never, spawnPlan: plan, logDir: dir });
      const [cmd, args, metadata, options] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>, { taskId: string; spawnOptions: { env: NodeJS.ProcessEnv } }];
      expect(cmd).toBeTruthy(); expect(args).toContainEqual(expect.stringContaining('generated-repair-worker-bin.ts'));
      expect(metadata).toMatchObject({ launchedBy: 'release:repair-queue:heal-generated', runtimeMaxSec: 2700 });
      expect(options.taskId).toBe(f.input.taskId);
      expect(options.spawnOptions.env.PAPERCUSP_DESKTOP_PARENT_PID).toBeUndefined();
      expect(parseGeneratedRepairWorkerInput(options.spawnOptions.env.PAPERCUSP_GENERATED_REPAIR_WORKER_INPUT)).toEqual(f.input);
      expect(readFileSync(String(metadata.logPath), 'utf8')).toBe('');
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_DESKTOP_PARENT_PID; else process.env.PAPERCUSP_DESKTOP_PARENT_PID = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('routes both packaged entries and excludes writer mode from the host port preflight', () => {
    const root = resolve(import.meta.dirname, '../../../..');
    for (const entry of ['apps/operator/bin/hono-host.ts', 'apps/operator/bin/serve.ts', 'apps/operator/bin/hono-host-port-preflight.ts']) {
      expect(readFileSync(resolve(root, entry), 'utf8')).toContain('PAPERCUSP_GENERATED_REPAIR_WORKER_MODE');
    }
    expect(parseGeneratedRepairWorkerInput('{}')).toBeNull();
  });
});
