/**
 * Pins the durable loop-fire result at the DBOS workflow seam. A completed
 * `loop:wake` step with an undefined operation output previously erased whether
 * the fire delivered or was withheld, which made a parked-loop incident look
 * like a healthy workflow completion in DBOS forensics.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import { ROUTINE_FIRE_QUEUES, routineFireWorkflow } from './routines-workflow';
import {
  LOOP_WAKE_TARGET_ROLE,
  CRITICAL_ROUTINE_ACTIONS,
  TRIGGER_POLL_ACTIONS,
  queueForRoutine,
} from './routines-queue-classification';

beforeEach(() => {
  state.stepOutputs.length = 0;
  vi.clearAllMocks();
});

describe('routineFireWorkflow — durable loop:wake output', () => {
  it('registers the shared, critical, deadline-sensitive loop, and external-poll queues at boot', () => {
    // Every lane queueForRoutine can return MUST be registered here, or a fire enqueued
    // onto it is never consumed (WI-41662 added routines-triggers).
    expect(ROUTINE_FIRE_QUEUES).toEqual(['routines', 'routines-critical', 'routines-loop', 'routines-triggers']);
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
