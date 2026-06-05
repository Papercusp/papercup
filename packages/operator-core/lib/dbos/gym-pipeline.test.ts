/**
 * Brief 48 / gym tail — the gym-spine analogue of research-pipeline.test.ts:
 * the SAME durable pipeline (featurePipelineImpl), given the `gym` blueprint's
 * spine via PipelineInput.spine, drives the OPTIMIZATION pipeline — a
 * gym-director emitting gym verbs (GENERATE_TASKS / RUN_VARIANT / JUDGE /
 * PROPOSE / ACCEPT / DONE) that dispatch the gym roles (task-generator,
 * variant-runner, judge, proposer, committer). No coding verbs, no `director`,
 * no git — a different declared graph through the same engine (D-022: the gym
 * is a blueprint, not bespoke machinery). A full LIVE agent-driven cycle is a
 * deliberate, budget-incurring validation, not an autonomous test.
 *
 * DBOS is mocked (runStep runs inline) so the real loop + the real
 * parseDecisionFor/deriveNext run against the gym spine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  setPipelineSettledHook,
  setPipelineDebuggerHook,
  type PipelineInput,
  type PipelineInvokeRunner,
} from './orchestrator-workflow';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';

const gymSpine = loadBuiltinBlueprint('gym').blueprint.spine;
const DECIDER = gymSpine.decider; // 'gym-director'

type Call = { role: string; feature: string; extras: string[] };
let calls: Call[] = [];
let deciderOutputs: string[] = [];
let idx = 0;

beforeEach(() => {
  calls = [];
  deciderOutputs = [];
  idx = 0;
  const runner: PipelineInvokeRunner = async (_slug, role, feature, _key, extras) => {
    calls.push({ role, feature, extras });
    if (role === DECIDER) return { output: deciderOutputs[idx++] ?? 'IDLE', exitCode: 0 };
    return { output: `ran ${role}`, exitCode: 0 };
  };
  setPipelineInvokeRunner(runner);
  setPipelineFinalizer(vi.fn(async () => {}));
  setPipelineSettledHook(vi.fn());
  setPipelineDebuggerHook(vi.fn(async () => ({ fired: false })));
});

afterEach(() => vi.clearAllMocks());

const input = (over: Partial<PipelineInput> = {}): PipelineInput => ({
  harnessSlug: 'g48-gym',
  featureId: 'G-1',
  workspaceId: 'ws-g',
  spine: gymSpine,
  ...over,
});

describe('gym pipeline (same engine, gym spine)', () => {
  it('the decider is the gym-director, not the coding director', () => {
    expect(DECIDER).toBe('gym-director');
  });

  it('walks the optimization spine: generate → run → judge → propose → accept → DONE', async () => {
    deciderOutputs = [
      'GENERATE_TASKS G-1',
      'RUN_VARIANT G-1',
      'JUDGE G-1',
      'PROPOSE G-1',
      'ACCEPT G-1',
      'DONE',
    ];

    const result = await featurePipelineWorkflow(input());

    expect(result).toBe('pipeline-complete (last=DONE)');
    expect(calls.map((c) => c.role)).toEqual([
      'gym-director',
      'task-generator',
      'gym-director',
      'variant-runner',
      'gym-director',
      'judge',
      'gym-director',
      'proposer',
      'gym-director',
      'committer',
      'gym-director',
    ]);
    // Every optimization role got the gym-task id via the spine's extras template.
    for (const role of ['task-generator', 'variant-runner', 'judge', 'proposer', 'committer']) {
      const call = calls.find((c) => c.role === role)!;
      expect(call.extras).toEqual(['FEATURE_ID=G-1']);
    }
  });

  it('the director controls the order: looping RUN_VARIANT + JUDGE across the matrix is legal (flat verb→action map, D-024)', async () => {
    deciderOutputs = ['RUN_VARIANT G-1', 'JUDGE G-1', 'RUN_VARIANT G-1', 'JUDGE G-1', 'DONE'];

    const result = await featurePipelineWorkflow(input());

    expect(result).toBe('pipeline-complete (last=DONE)');
    expect(calls.filter((c) => c.role === 'variant-runner')).toHaveLength(2);
    expect(calls.filter((c) => c.role === 'judge')).toHaveLength(2);
  });

  it('a coding verb is NOT recognized under the gym vocabulary (falls to default/idle)', async () => {
    // The gym-director never emits NEXT_WORKER; if it did, that verb is not in
    // the gym spine's edges → deriveNext returns the default (idle) → stop.
    deciderOutputs = ['NEXT_WORKER G-1'];

    const result = await featurePipelineWorkflow(input());

    expect(result).toBe('pipeline-complete (last=IDLE)');
    // Only the decider ran; no role was dispatched for the unrecognized verb.
    expect(calls.map((c) => c.role)).toEqual(['gym-director']);
  });
});
