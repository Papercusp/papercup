/**
 * Pins the durable loop-fire result at the DBOS workflow seam. A completed
 * `loop:wake` step with an undefined operation output previously erased whether
 * the fire delivered or was withheld, which made a parked-loop incident look
 * like a healthy workflow completion in DBOS forensics.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const state = vi.hoisted(() => ({
  stepOutputs: [] as Array<{ name: string; output: unknown }>,
  loopResult: {
    fired: false,
    reason: 'await-blocking',
    detail: 'owner is parked on a blocking await',
  } as const,
}));

vi.mock('@dbos-inc/dbos-sdk', () => {
  class WorkflowQueue {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
  }

  return {
    WorkflowQueue,
    DBOS: {
      workflowID: 'test-routine-fire',
      runStep: async (fn: () => unknown, config?: { name?: string }) => {
        const output = await fn();
        state.stepOutputs.push({ name: config?.name ?? '', output });
        return output;
      },
      registerWorkflow: (impl: unknown) => impl,
      registerScheduled: vi.fn(),
      startWorkflow: vi.fn(),
    },
  };
});

vi.mock('./idempotent-register-workflow', () => ({
  idempotentRegisterWorkflow: (_key: string, register: () => unknown) => register(),
  idempotentWorkflowQueue: (_key: string, construct: () => unknown) => construct(),
}));

vi.mock('./queue-concurrency', () => ({ queueConcurrency: (ceiling: number) => ceiling }));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    getOrgPg: () => ({ sql: vi.fn() }),
    listDueCronRoutines: vi.fn(async () => []),
  };
});

vi.mock('../workspace-als', () => ({
  runWithWorkspace: (_workspaceId: string, fn: () => unknown) => fn(),
}));

vi.mock('../harness/routines/claim', () => ({
  claimDueRoutine: vi.fn(),
  claimedRoutineDispatchAllowed: vi.fn(async () => true),
}));

vi.mock('../harness/routines/loop-fire', () => ({
  fireLoopWake: vi.fn(async () => state.loopResult),
}));

vi.mock('./dbos-executor-reaper', () => ({
  clearStaleReaperLastError: vi.fn(async () => {}),
}));

vi.mock('../harness/routines/register-system-actions', () => ({}));
vi.mock('../harness/routines/configure-per-workspace', () => ({}));

import { fireLoopWake } from '../harness/routines/loop-fire';
import { registerSystemAction } from '../harness/routines/system-actions';
import {
  evaluateRoutineDispatchEpoch,
  noteRoutineFairnessAttempt,
  orderDueRoutinesFairly,
  ROUTINE_FIRE_QUEUES,
  ROUTINE_FIRE_TIMEOUT_MS,
  routineFireTimeoutMs,
  routineFireWorkflow,
} from './routines-workflow';
import {
  LOOP_WAKE_TARGET_ROLE,
  CRITICAL_ROUTINE_ACTIONS,
  FLEET_CONTROL_ACTIONS,
  HEAVY_ROUTINE_ACTIONS,
  ROUTINES_CRITICAL_QUEUE,
  ROUTINES_FLEET_CONTROL_QUEUE,
  ROUTINES_HEAVY_QUEUE,
  ROUTINES_LOOP_QUEUE,
  ROUTINES_QUEUE,
  TRIGGER_POLL_ACTIONS,
  queueForRoutine,
} from './routines-queue-classification';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { CaplessAdaptiveController } from '../resource-governor/controller';

beforeEach(() => {
  state.stepOutputs.length = 0;
  vi.clearAllMocks();
});

describe('evaluateRoutineDispatchEpoch — capless delayed-feedback admission (EI-224330)', () => {
  const START = 1_700_000_000_000;
  const queue = (epoch: ReturnType<typeof evaluateRoutineDispatchEpoch>, queueName: string) => {
    const found = epoch.queues.find((item) => item.queueName === queueName);
    if (!found) throw new Error(`missing ${queueName} decision`);
    return found;
  };

  it('bounds a many-clean-probe delayed-signal burst to current feedback credit', () => {
    const epoch = evaluateRoutineDispatchEpoch({
      pressure: 'ok',
      probeMs: 4,
      inFlightByQueue: {},
      activeQueues: [
        ROUTINES_QUEUE,
        ROUTINES_LOOP_QUEUE,
        ROUTINES_CRITICAL_QUEUE,
        ROUTINES_FLEET_CONTROL_QUEUE,
      ],
      controller: new CaplessAdaptiveController(),
      atMs: START,
    });

    // Live failure admitted 47 shared + 27 loop + 10 critical starts because each
    // immediate probe ran before its preceding async enqueue materialized. A cold
    // epoch has one start of feedback credit per active queue, regardless of how
    // many due rows the loop can enumerate synchronously.
    expect(queue(epoch, ROUTINES_QUEUE).availableStarts).toBe(1);
    expect(queue(epoch, ROUTINES_LOOP_QUEUE).availableStarts).toBe(1);
    expect(queue(epoch, ROUTINES_CRITICAL_QUEUE).availableStarts).toBe(1);
    expect(queue(epoch, ROUTINES_FLEET_CONTROL_QUEUE).availableStarts).toBe(1);
    expect([
      Math.min(47, queue(epoch, ROUTINES_QUEUE).availableStarts),
      Math.min(27, queue(epoch, ROUTINES_LOOP_QUEUE).availableStarts),
      Math.min(10, queue(epoch, ROUTINES_CRITICAL_QUEUE).availableStarts),
    ]).toEqual([1, 1, 1]);
  });

  it('probes upward without a configured maximum after sustained healthy epochs', () => {
    const controller = new CaplessAdaptiveController({ healthySamplesPerIncrease: 1 });
    const first = evaluateRoutineDispatchEpoch({
      pressure: 'ok',
      probeMs: 3,
      inFlightByQueue: {},
      activeQueues: [ROUTINES_QUEUE],
      controller,
      atMs: START,
    });
    const second = evaluateRoutineDispatchEpoch({
      pressure: 'ok',
      probeMs: 2,
      inFlightByQueue: {},
      activeQueues: [ROUTINES_QUEUE],
      controller,
      atMs: START + 30_000,
    });
    expect(queue(first, ROUTINES_QUEUE).desiredWindow).toBe(2);
    expect(queue(second, ROUTINES_QUEUE).desiredWindow).toBe(3);
  });

  it('multiplicatively contracts the database-attributed class on critical feedback', () => {
    const epoch = evaluateRoutineDispatchEpoch({
      pressure: 'critical',
      probeMs: 2_800,
      inFlightByQueue: { [ROUTINES_QUEUE]: 4 },
      activeQueues: [ROUTINES_QUEUE],
      controller: new CaplessAdaptiveController({ initialWindow: 8, contractionCooldownMs: 0 }),
      atMs: START,
    });
    expect(queue(epoch, ROUTINES_QUEUE)).toMatchObject({
      desiredWindow: 4,
      effectiveWindow: 4,
      controllerAvailableStarts: 0,
      availableStarts: 0,
      controllerProtected: false,
    });
  });

  it('subtracts actual ENQUEUED/PENDING occupancy before admitting this tick', () => {
    const epoch = evaluateRoutineDispatchEpoch({
      pressure: 'ok',
      probeMs: 4,
      inFlightByQueue: { [ROUTINES_QUEUE]: 3 },
      activeQueues: [ROUTINES_QUEUE],
      controller: new CaplessAdaptiveController({ initialWindow: 5, healthySamplesPerIncrease: 99 }),
      atMs: START,
    });
    expect(queue(epoch, ROUTINES_QUEUE)).toMatchObject({
      desiredWindow: 5,
      inFlight: 3,
      availableStarts: 2,
    });
  });

  it('keeps exactly one critical liveness floor while retaining database attribution', () => {
    const controller = new CaplessAdaptiveController({ initialWindow: 16, contractionCooldownMs: 0 });
    const empty = evaluateRoutineDispatchEpoch({
      pressure: 'critical',
      probeMs: 3_000,
      inFlightByQueue: {},
      activeQueues: [ROUTINES_QUEUE, ROUTINES_CRITICAL_QUEUE],
      controller,
      atMs: START,
    });
    expect(queue(empty, ROUTINES_QUEUE).availableStarts).toBe(0);
    expect(queue(empty, ROUTINES_CRITICAL_QUEUE)).toMatchObject({
      availableStarts: 1,
      controllerProtected: false,
    });

    const occupied = evaluateRoutineDispatchEpoch({
      pressure: 'critical',
      probeMs: 3_100,
      inFlightByQueue: { [ROUTINES_CRITICAL_QUEUE]: 1 },
      activeQueues: [ROUTINES_CRITICAL_QUEUE],
      controller,
      atMs: START + 30_000,
    });
    expect(queue(occupied, ROUTINES_CRITICAL_QUEUE)).toMatchObject({
      inFlight: 1,
      availableStarts: 0,
      controllerProtected: false,
    });
    expect(queue(occupied, ROUTINES_CRITICAL_QUEUE).desiredWindow).toBeLessThan(16);
  });

  it('rotates due candidates after each admission attempt so a later row cannot starve', () => {
    const cursors = new Map<string, number>();
    const due = ['a', 'b', 'c', 'd'].map((id) => ({
      id,
      targetRole: 'system:ordinary-routine',
      installSlug: 'papercusp',
    }));

    expect(orderDueRoutinesFairly(due, cursors).map((row) => row.id)).toEqual(['a', 'b', 'c', 'd']);
    noteRoutineFairnessAttempt(ROUTINES_QUEUE, cursors);
    noteRoutineFairnessAttempt(ROUTINES_QUEUE, cursors);

    // The next epoch starts after the two credits spent by the previous epoch,
    // even if those claims later lose their CAS race.
    expect(orderDueRoutinesFairly(due, cursors).map((row) => row.id)).toEqual(['c', 'd', 'a', 'b']);
    noteRoutineFairnessAttempt(ROUTINES_QUEUE, cursors);
    noteRoutineFairnessAttempt(ROUTINES_QUEUE, cursors);
    expect(orderDueRoutinesFairly(due, cursors).map((row) => row.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reads indexed DBOS occupancy and gates feedback credit before claim/start', () => {
    const source = readFileSync(resolve(__dirname, 'routines-workflow.ts'), 'utf8');
    const reader =
      source.split('export async function readRoutineFireInFlightByQueue')[1]?.split('/** Direct physical')[0] ?? '';
    expect(reader).toContain('queue_name = ANY(${[...ROUTINE_FIRE_QUEUES]}::text[])');
    expect(reader).toContain("status IN ('ENQUEUED', 'PENDING')");
    expect(reader).toContain("name = 'routineFire'");
    expect(reader).toContain('GROUP BY queue_name');

    const impl = source.split('async function routinesTickImpl(): Promise<void> {')[1] ?? '';
    const epoch = impl.indexOf("name: 'routine-dispatch-feedback-epoch'");
    const loop = impl.indexOf('for (const r of fairDue) {');
    const budget = impl.indexOf('const remainingStarts = remainingStartsByQueue.get(queueName) ?? 0');
    const claim = impl.indexOf('claimDueRoutine(sql, r)');
    const start = impl.indexOf('DBOS.startWorkflow');
    const spend = impl.indexOf('remainingStartsByQueue.set(queueName, remainingStarts - 1)');
    expect(epoch).toBeGreaterThan(-1);
    expect(epoch).toBeLessThan(loop);
    expect(loop).toBeLessThan(budget);
    expect(budget).toBeLessThan(claim);
    expect(claim).toBeLessThan(start);
    expect(start).toBeLessThan(spend);
    expect(impl).not.toContain('evaluateRoutineDispatchAdmission');
  });
});

describe('routinesTickImpl — loop rebase survives critical pool shed (EI-21859486764076047)', () => {
  it('runs loop-rebase before the critical-shed early return', () => {
    const source = readFileSync(resolve(__dirname, 'routines-workflow.ts'), 'utf8');
    const shedSection = source.split('// EI-11171 critical-routine floor (cont.):')[1] ?? '';
    const branch = shedSection.match(/if \(poolCritical\) \{[\s\S]*?return;\n  \}/)?.[0] ?? '';
    expect(branch).toContain('await runLoopRebaseSweep(sql);');
    expect(source).toContain('async function runLoopRebaseSweep');
  });
});

describe('routineFireWorkflow — durable loop:wake output', () => {
  it('registers every isolated routine lane at boot', () => {
    // Every lane queueForRoutine can return MUST be registered here, or a fire enqueued
    // onto it is never consumed (WI-41662 added routines-triggers).
    expect(ROUTINE_FIRE_QUEUES).toEqual([
      'routines',
      'routines-heavy',
      'routines-critical',
      'routines-fleet-control',
      'routines-loop',
      'routines-triggers',
      'routines-release',
    ]);
  });

  // Recurrence guard (WI-41662). Adding a lane is TWO edits — route to it in
  // queueForRoutine, and register it here so DBOS listens. Doing only the first
  // enqueues fires onto a queue nothing consumes: the routine then never runs at
  // all, and — exactly like the starvation this lane was added to fix — nothing
  // fails and last_fired_at keeps advancing, so it reads perfectly healthy.
  // Drive the classifier over every routable target and assert its lane is registered.
  it('registers EVERY lane queueForRoutine can return (no routable-but-unconsumed queue)', () => {
    const routableTargets = [
      LOOP_WAKE_TARGET_ROLE,
      ...[...CRITICAL_ROUTINE_ACTIONS].map((a) => `system:${a}`),
      ...[...FLEET_CONTROL_ACTIONS].map((a) => `system:${a}`),
      ...[...HEAVY_ROUTINE_ACTIONS].map((a) => `system:${a}`),
      ...[...TRIGGER_POLL_ACTIONS].map((a) => `system:${a}`),
      'system:green-checkpoint',
      'mug',
      '',
    ];
    for (const target of routableTargets) {
      expect(ROUTINE_FIRE_QUEUES).toContain(queueForRoutine(target));
    }
    expect(queueForRoutine('system:gitnexus-reindex')).toBe(ROUTINES_HEAVY_QUEUE);
    expect(ROUTINE_FIRE_QUEUES).toContain(queueForRoutine('system:green-checkpoint', operatorHomeHarnessSlug()));
  });

  it('checkpoints and returns the complete LoopFireResult from the DBOS step', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await routineFireWorkflow(
      'rt_papercusp_loop_su-pinned',
      'papercusp-workspace',
      'papercusp',
      'su',
      {},
      { carry: 'cold' },
      'loop-su-pinned',
      300,
      'su-pinned',
    );

    expect(fireLoopWake).toHaveBeenCalledWith({
      routineId: 'rt_papercusp_loop_su-pinned',
      routineName: 'loop-su-pinned',
      workspaceId: 'papercusp-workspace',
      installSlug: 'papercusp',
      targetOwnerId: 'su-pinned',
      payloadTemplate: { carry: 'cold' },
      intervalSec: 300,
    });
    expect(state.stepOutputs).toEqual([
      {
        name: 'routine-fire-start',
        output: {
          routineId: 'rt_papercusp_loop_su-pinned',
          workspaceId: 'papercusp-workspace',
          installSlug: 'papercusp',
          targetRole: 'su',
          routineName: 'loop-su-pinned',
        },
      },
      { name: 'routine-fire-active-fence', output: true },
      { name: 'loop:wake', output: state.loopResult },
      { name: 'clear-reaper-last-error', output: undefined },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fire WITHHELD (await-blocking'));
    warn.mockRestore();
  });
});

describe('routineFireTimeoutMs — per-action deadline seam', () => {
  it('uses a registered long-action deadline while retaining the two-hour default elsewhere', () => {
    const longTimeout = 24 * 60 * 60_000;
    registerSystemAction('test-long-running-routine', async () => {}, { routineTimeoutMs: longTimeout });

    expect(routineFireTimeoutMs('system:test-long-running-routine')).toBe(longTimeout);
    expect(routineFireTimeoutMs('system:unknown-action')).toBe(ROUTINE_FIRE_TIMEOUT_MS);
    expect(routineFireTimeoutMs('agent-role')).toBe(ROUTINE_FIRE_TIMEOUT_MS);
  });

  it('fails closed on an absent, non-positive, fractional, or unsafe configured value', () => {
    registerSystemAction('test-invalid-routine-timeout', async () => {}, { routineTimeoutMs: 0 });
    registerSystemAction('test-fractional-routine-timeout', async () => {}, { routineTimeoutMs: 1.5 });
    registerSystemAction('test-unsafe-routine-timeout', async () => {}, {
      routineTimeoutMs: Number.MAX_SAFE_INTEGER + 1,
    });

    expect(routineFireTimeoutMs('system:test-invalid-routine-timeout')).toBe(ROUTINE_FIRE_TIMEOUT_MS);
    expect(routineFireTimeoutMs('system:test-fractional-routine-timeout')).toBe(ROUTINE_FIRE_TIMEOUT_MS);
    expect(routineFireTimeoutMs('system:test-unsafe-routine-timeout')).toBe(ROUTINE_FIRE_TIMEOUT_MS);
  });
});
