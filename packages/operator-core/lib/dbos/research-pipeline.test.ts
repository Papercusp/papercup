/**
 * P-018 — the end-to-end proof, deterministically: the SAME durable pipeline
 * (featurePipelineImpl), given the `research` blueprint's spine via
 * PipelineInput.spine, drives a RESEARCH pipeline — a research-director emitting
 * research verbs (NEXT_RESEARCHER / NEXT_VERIFIER / DONE) that dispatch the
 * research roles. No coding verbs, no `director`, no git — just a different
 * declared graph through the same engine. (A full LIVE agent-driven run is a
 * deliberate, budget-incurring validation, not an autonomous test.)
 *
 * DBOS is mocked (runStep runs inline) so the real loop + the real
 * parseDecisionFor/deriveNext run against the research spine.
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

const researchSpine = loadBuiltinBlueprint('research').blueprint.spine;
const DECIDER = researchSpine.decider; // 'research-director'

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
  harnessSlug: 'lit-review',
  featureId: 'R-1',
  workspaceId: 'ws-r',
  spine: researchSpine,
  ...over,
});

describe('research pipeline (same engine, research spine)', () => {
  it('the decider is the research-director, not the coding director', () => {
    expect(DECIDER).toBe('research-director');
  });

  it('drives research-director → researcher → verifier → DONE via research verbs', async () => {
    deciderOutputs = ['NEXT_RESEARCHER R-1', 'NEXT_VERIFIER R-1', 'DONE'];

    const result = await featurePipelineWorkflow(input());

    expect(result).toBe('pipeline-complete (last=DONE)');
    expect(calls.map((c) => c.role)).toEqual([
      'research-director',
      'researcher',
      'research-director',
      'verifier',
      'research-director',
    ]);
    // The research spine's extras template resolved {feature} → the task id.
    const researcher = calls.find((c) => c.role === 'researcher')!;
    expect(researcher.extras).toEqual(['FEATURE_ID=R-1']);
  });

  it('a coding verb is NOT recognized under the research vocabulary (falls to default/idle)', async () => {
    // The research director never emits NEXT_WORKER; if it did, that verb is not
    // in the research spine's edges → deriveNext returns the default (idle) → stop.
    deciderOutputs = ['NEXT_WORKER R-1'];

    const result = await featurePipelineWorkflow(input());

    expect(result).toBe('pipeline-complete (last=IDLE)');
    // Only the decider ran; no role was dispatched for the unrecognized verb.
    expect(calls.map((c) => c.role)).toEqual(['research-director']);
  });
});
