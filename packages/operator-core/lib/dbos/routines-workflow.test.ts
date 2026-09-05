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
  evaluateRoutineDispatchAdmission,
  ROUTINE_FIRE_QUEUES,
  ROUTINE_FIRE_TIMEOUT_MS,
  routineFireTimeoutMs,
  routineFireWorkflow,
} from './routines-workflow';
import {
  LOOP_WAKE_TARGET_ROLE,
  CRITICAL_ROUTINE_ACTIONS,
  TRIGGER_POLL_ACTIONS,
  queueForRoutine,
} from './routines-queue-classification';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';

beforeEach(() => {
  state.stepOutputs.length = 0;
  vi.clearAllMocks();
});

describe('evaluateRoutineDispatchAdmission — capless DBOS fan-out feedback (EI-224330)', () => {
  it('admits one liveness-floor start per queue without probing', async () => {
    const probe = vi.fn(async () => 'critical' as const);
    await expect(evaluateRoutineDispatchAdmission(0, probe)).resolves.toEqual({
      admitted: true,
      pressure: null,
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    ['ok', true],
    ['elevated', false],
    ['critical', false],
  ] as const)('uses a fresh %s probe before every additional start', async (pressure, admitted) => {
    const probe = vi.fn(async () => pressure);
    await expect(evaluateRoutineDispatchAdmission(1, probe)).resolves.toEqual({ admitted, pressure });
    expect(probe).toHaveBeenCalledOnce();
  });

  it('is wired before claim/start and leaves a pressured queue unclaimed for a later tick', () => {
    const source = readFileSync(resolve(__dirname, 'routines-workflow.ts'), 'utf8');
    const loop = source.split('for (const r of due) {')[1]?.split('// EI-11171 critical-routine floor (cont.):')[0] ?? '';
    const admission = loop.indexOf('evaluateRoutineDispatchAdmission(startedInQueue)');
    const claim = loop.indexOf('claimDueRoutine(sql, r)');
    const start = loop.indexOf('DBOS.startWorkflow');
    expect(admission).toBeGreaterThan(-1);
    expect(admission).toBeLessThan(claim);
    expect(claim).toBeLessThan(start);
    expect(loop).toContain('pausedQueues.add(queueName)');
    expect(loop).toContain('startedByQueue.set(queueName, startedInQueue + 1)');
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
  it('registers the shared, critical, deadline-sensitive loop, and external-poll queues at boot', () => {
    // Every lane queueForRoutine can return MUST be registered here, or a fire enqueued
    // onto it is never consumed (WI-41662 added routines-triggers).
    expect(ROUTINE_FIRE_QUEUES).toEqual([
      'routines',
      'routines-critical',
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
      ...[...TRIGGER_POLL_ACTIONS].map((a) => `system:${a}`),
      'system:green-checkpoint',
      'mug',
      '',
    ];
    for (const target of routableTargets) {
      expect(ROUTINE_FIRE_QUEUES).toContain(queueForRoutine(target));
    }
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
