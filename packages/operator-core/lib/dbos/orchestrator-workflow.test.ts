/**
 * Tests for the DBOS durable per-feature pipeline turn-loop (featurePipelineImpl,
 * exported as featurePipelineWorkflow). This is the PRODUCTION orchestration path
 * for every feature in every harness and had ZERO coverage (plan
 * harness-test-coverage-for-launch P-006).
 *
 * The DBOS SDK is mocked so DBOS.runStep just runs its thunk and
 * DBOS.registerWorkflow returns the impl unchanged — letting us drive the real
 * loop directly. parseDecision + classifyDecision are NOT mocked, so the real
 * decision→dispatch classification is exercised. The agent runner, finalizer,
 * debugger-gate, and settled-hook are injected via their setters.
 *
 * The most important case: an empty/failed `decide` invoke must THROW (so DBOS
 * retries and ultimately ERRORs the workflow) rather than parse to a clean
 * terminal and FALSE-SUCCEED the pipeline with no work done.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the DBOS SDK: runStep runs the thunk inline (so loop logic executes and
// a throwing step propagates); registerWorkflow returns the impl so
// featurePipelineWorkflow === featurePipelineImpl and is directly callable.
// WorkflowQueue must be a real constructor (a vi.fn arrow can't be `new`'d).
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
      runStep: (fn: () => unknown) => fn(),
      registerWorkflow: (impl: unknown) => impl,
      startWorkflow: () => () => Promise.resolve(),
    },
  };
});

import {
  featurePipelineWorkflow,
  setPipelineInvokeRunner,
  setPipelineFinalizer,
  setPipelineDebuggerHook,
  setPipelineSettledHook,
  setPipelineTestDigestHook,
  type PipelineInput,
  type PipelineInvokeRunner,
} from './orchestrator-workflow';

type RunnerCall = {
  role: string;
  feature: string;
  key: string;
  extras: string[];
  ws?: string;
};

let runnerCalls: RunnerCall[] = [];
let directorOutputs: string[] = [];
let directorIdx = 0;
let infiniteDispatch = false;

let finalizer: ReturnType<typeof vi.fn>;
let settledHook: ReturnType<typeof vi.fn>;
let debuggerHook: ReturnType<typeof vi.fn>;
let testDigestHook: ReturnType<typeof vi.fn>;

const ORCH = 'director';

beforeEach(() => {
  runnerCalls = [];
  directorOutputs = [];
  directorIdx = 0;
  infiniteDispatch = false;

  const fakeRunner: PipelineInvokeRunner = async (_slug, role, feature, key, extras, ws) => {
    runnerCalls.push({ role, feature, key, extras, ws });
    if (role === ORCH) {
      if (infiniteDispatch) return { output: 'NEXT_WORKER F-1', exitCode: 0 };
      const out = directorOutputs[directorIdx++] ?? 'IDLE';
      return { output: out, exitCode: 0 };
    }
    return { output: `ran ${role}`, exitCode: 0 };
  };
  setPipelineInvokeRunner(fakeRunner);

  finalizer = vi.fn(async () => {});
  setPipelineFinalizer(finalizer);

  settledHook = vi.fn();
  setPipelineSettledHook(settledHook);

  // Default debugger gate is wired but a no-op (fired:false) so it never
  // pollutes the runner-call sequence; the dedicated test overrides it.
  debuggerHook = vi.fn(async () => ({ fired: false }));
  setPipelineDebuggerHook(debuggerHook);

  // Default test-digest hook (P-010) is wired but contributes no extras; the
  // dedicated test overrides it.
  testDigestHook = vi.fn(async () => ({ extras: [] as string[] }));
  setPipelineTestDigestHook(testDigestHook);
});

afterEach(() => vi.clearAllMocks());

const input = (over: Partial<PipelineInput> = {}): PipelineInput => ({
  harnessSlug: 'sheets',
  featureId: 'F-1',
  workspaceId: 'ws-1',
  ...over,
});

describe('featurePipelineWorkflow — happy path', () => {
  it('runs director→worker→director→validator→director→DONE, finalizes done, fires settled hook', async () => {
    directorOutputs = ['NEXT_WORKER F-1', 'NEXT_VALIDATOR F-1', 'DONE'];

    const result = await featurePipelineWorkflow(input());

    expect(result).toBe('pipeline-complete (last=DONE)');
    expect(runnerCalls.map((c) => c.role)).toEqual([
      'director',
      'worker',
      'director',
      'validator',
      'director',
    ]);
    // Finalize a DONE outcome exactly once, then refill the freed slot.
    expect(finalizer).toHaveBeenCalledTimes(1);
    expect(finalizer).toHaveBeenCalledWith(
      expect.objectContaining({ harnessSlug: 'sheets', featureId: 'F-1', outcome: 'done', workspaceId: 'ws-1' }),
    );
    expect(settledHook).toHaveBeenCalledTimes(1);
    expect(settledHook).toHaveBeenCalledWith('sheets', 'ws-1');
  });

  it('threads workspaceId and replay-stable idempotency keys into every agent run', async () => {
    directorOutputs = ['NEXT_WORKER F-1', 'DONE'];

    await featurePipelineWorkflow(input({ workspaceId: 'ws-XYZ' }));

    expect(runnerCalls.every((c) => c.ws === 'ws-XYZ')).toBe(true);
    // key = `${slug}:${feature}:${role}:t${turn}` — deterministic per turn so a
    // DBOS replay reuses the completed step instead of re-spawning the agent.
    expect(runnerCalls[0].key).toBe('sheets:F-1:director:t0');
    expect(runnerCalls[1].key).toBe('sheets:F-1:worker:t0');
    expect(runnerCalls[2].key).toBe('sheets:F-1:director:t1');
    expect(runnerCalls[1].extras).toEqual(['FEATURE_ID=F-1']);
  });
});

describe('featurePipelineWorkflow — terminal outcomes', () => {
  it('ESCALATE finalizes escalate (with reason) and does NOT fire the settled hook', async () => {
    directorOutputs = ['ESCALATE stuck-after-3-attempts'];

    const result = await featurePipelineWorkflow(input());

    expect(result).toBe('pipeline-complete (last=ESCALATE)');
    expect(finalizer).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'escalate', reason: 'stuck-after-3-attempts' }),
    );
    // escalate leaves the feature re-pickable → no immediate refill (avoid churn).
    expect(settledHook).not.toHaveBeenCalled();
  });

  it('IDLE stops cleanly with no finalize and no settled hook', async () => {
    directorOutputs = ['IDLE'];

    const result = await featurePipelineWorkflow(input());

    expect(result).toBe('pipeline-complete (last=IDLE)');
    expect(finalizer).not.toHaveBeenCalled();
    expect(settledHook).not.toHaveBeenCalled();
  });

  it('a global-only verb (NEXT_HARNESS) is unsupported per-feature: stop, do not finalize', async () => {
    directorOutputs = ['NEXT_HARNESS other-slug'];

    const result = await featurePipelineWorkflow(input());

    expect(result).toMatch(/^pipeline-complete \(last=UNSUPPORTED/);
    expect(finalizer).not.toHaveBeenCalled();
    expect(settledHook).not.toHaveBeenCalled();
  });
});

describe('featurePipelineWorkflow — no false success', () => {
  it('THROWS (does not return a clean terminal) when the decide invoke returns empty output', async () => {
    setPipelineInvokeRunner(async (_s, role) => {
      runnerCalls.push({ role, feature: '', key: '', extras: [] });
      return { output: '   ', exitCode: 0 }; // whitespace-only ⇒ empty
    });

    await expect(featurePipelineWorkflow(input())).rejects.toThrow(/decide invoke failed/);
    expect(finalizer).not.toHaveBeenCalled();
    expect(settledHook).not.toHaveBeenCalled();
  });

  it('THROWS when the decide invoke exits non-zero', async () => {
    setPipelineInvokeRunner(async () => ({ output: 'DONE', exitCode: 1 }));
    await expect(featurePipelineWorkflow(input())).rejects.toThrow(/decide invoke failed/);
    expect(finalizer).not.toHaveBeenCalled();
  });
});

describe('featurePipelineWorkflow — bounded + gated', () => {
  it('a never-terminating director stops at MAX_TURNS without finalizing', async () => {
    infiniteDispatch = true; // director always says NEXT_WORKER

    const result = await featurePipelineWorkflow(input());

    expect(result).toBe('pipeline-complete (last=WORKER)');
    expect(finalizer).not.toHaveBeenCalled();
    expect(settledHook).not.toHaveBeenCalled();
    // 2 runner calls per turn (decide + dispatch). MAX_TURNS defaults to 200.
    expect(runnerCalls.length).toBe(200 * 2);
  });

  it('fires the debugger gate immediately before a worker dispatch (P-012)', async () => {
    directorOutputs = ['NEXT_WORKER F-1', 'DONE'];

    await featurePipelineWorkflow(input());

    expect(debuggerHook).toHaveBeenCalledTimes(1);
    expect(debuggerHook).toHaveBeenCalledWith(
      expect.objectContaining({ harnessSlug: 'sheets', featureId: 'F-1', workspaceId: 'ws-1' }),
    );
    // The gate runs before the worker agent runs.
    const roles = runnerCalls.map((c) => c.role);
    expect(roles).toEqual(['director', 'worker', 'director']);
  });

  it('fires the test-digest hook before a validator dispatch and appends its extras (P-010)', async () => {
    directorOutputs = ['NEXT_VALIDATOR F-1', 'DONE'];
    testDigestHook = vi.fn(async () => ({ extras: ['TEST_DIGEST=.papercusp/test-digest/F-1.md (exit=0; 20 passed)'] }));
    setPipelineTestDigestHook(testDigestHook);

    await featurePipelineWorkflow(input());

    expect(testDigestHook).toHaveBeenCalledTimes(1);
    expect(testDigestHook).toHaveBeenCalledWith(
      expect.objectContaining({ harnessSlug: 'sheets', featureId: 'F-1', workspaceId: 'ws-1' }),
    );
    const validatorCall = runnerCalls.find((c) => c.role === 'validator');
    expect(validatorCall?.extras).toEqual(
      expect.arrayContaining([
        'FEATURE_ID=F-1',
        'TEST_DIGEST=.papercusp/test-digest/F-1.md (exit=0; 20 passed)',
      ]),
    );
    // Not fired for non-validator dispatches.
    directorOutputs = ['NEXT_WORKER F-1', 'DONE'];
    directorIdx = 0;
    runnerCalls = [];
    testDigestHook.mockClear();
    await featurePipelineWorkflow(input());
    expect(testDigestHook).not.toHaveBeenCalled();
  });
});
