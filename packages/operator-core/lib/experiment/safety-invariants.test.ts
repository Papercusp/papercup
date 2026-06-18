/**
 * Recursion-safety invariants for the experiment API (`experiment-registry-invocation-
 * api` P-060). These pin the rails that keep a self-modifying experiment loop safe —
 * complements the global recursion-safety-invariants suite (FB-22). A refactor that
 * silently un-makes any of these should turn this suite red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listTests, resetTestRegistry } from '@papercusp/eval-battery';
import {
  SAFETY_EXCLUDED_PREFIXES,
  isSafetyExcluded,
  partitionArm,
  validateArm,
} from './knob-space';
import {
  _resetExperimentRegistration,
  gymDescriptor,
  hiveDescriptor,
  instanceDescriptor,
  registerExperimentDescriptors,
} from './descriptors';
import { runExperiment, type RunExperimentDeps } from './run-core';

beforeEach(() => {
  resetTestRegistry();
  _resetExperimentRegistration();
});

describe('the safety-excluded set is structurally un-addressable', () => {
  it('every excluded prefix is rejected by validateArm even when the slice would match it', () => {
    for (const prefix of SAFETY_EXCLUDED_PREFIXES) {
      const v = validateArm({ id: 'x', knobs: { [`${prefix}.child`]: 1 } }, [prefix]);
      expect(v.ok, prefix).toBe(false);
      expect(v.excluded, prefix).toContain(`${prefix}.child`);
    }
  });

  it('partitionArm throws on every excluded prefix (defense in depth)', () => {
    for (const prefix of SAFETY_EXCLUDED_PREFIXES) {
      expect(() => partitionArm({ id: 'x', knobs: { [`${prefix}.child`]: 1 } }), prefix).toThrow(/safety-excluded/);
    }
  });
});

describe('no registered test can expose a safety-excluded knob', () => {
  it('every descriptor’s knobSlice is free of the excluded set', () => {
    registerExperimentDescriptors();
    for (const test of listTests()) {
      for (const sliceEntry of test.knobSlice) {
        expect(isSafetyExcluded(sliceEntry), `${test.id}:${sliceEntry}`).toBe(false);
      }
    }
  });
});

describe('the live tiers never execute without their bound deps (staged, not stubbed-on)', () => {
  it('gym/instance/hive descriptors refuse to run with no live deps', async () => {
    const ctx = { workspaceId: 'ws' } as never;
    const req = { batteryId: 'b', arms: [], repeats: 1, payload: {} } as never;
    for (const d of [gymDescriptor(), instanceDescriptor(), hiveDescriptor()]) {
      // gym is mapped+wired but refuses without live abDeps; instance/hive are the gated
      // cost-exception, staged behind their own infra. Either way: no spend in v1.
      await expect(d.run(req, ctx), d.id).rejects.toThrow(/STAGED|gated cost-exception/);
    }
  });
});

describe('the fidelity-tier escalation discipline gates spend (P-041)', () => {
  function deps(over: Partial<RunExperimentDeps> = {}): RunExperimentDeps {
    return {
      runGovernedReplay: vi.fn(async () => ({ verdict: { allow: true, remainingUsd: null }, result: null })) as unknown as RunExperimentDeps['runGovernedReplay'],
      replayRunner: (async () => ({ outputText: '', costUsd: 0, inputTokens: 0, outputTokens: 0, replayed: true })) as unknown as RunExperimentDeps['replayRunner'],
      judge: (async () => ({ text: '', costUsd: 0, inputTokens: 0, outputTokens: 0 })) as unknown as RunExperimentDeps['judge'],
      now: () => 0,
      ...over,
    };
  }

  it('a spending tier with NO escalation justification refuses BEFORE the governor (no spend)', async () => {
    const governorPreflight = vi.fn(async () => ({ allow: true, remainingUsd: null }));
    const out = await runExperiment(
      { testId: 'gym', tier: 'live', batteryId: 'b', arms: [], cases: [{ caseId: 'c', context: 'x', intent: 'y' }], repeats: 1 },
      { workspaceId: 'ws' },
      deps({ governorPreflight }),
    );
    expect(out.ok).toBe(false);
    expect(out.refused?.reason).toMatch(/offline signal|couldn.t-isolate/i);
    expect(governorPreflight).not.toHaveBeenCalled();
  });

  it('a live tier fails CLOSED on the governor even with valid escalation (no armed budget ⇒ no spend)', async () => {
    const governorPreflight = vi.fn(async () => ({ allow: false, reason: 'governor-unbudgeted', remainingUsd: 0 }));
    const out = await runExperiment(
      { testId: 'gym', tier: 'live', batteryId: 'b', arms: [], cases: [{ caseId: 'c', context: 'x', intent: 'y' }], repeats: 1, escalation: { couldntIsolate: 'needs real pipeline contention to surface' } },
      { workspaceId: 'ws' },
      deps({ governorPreflight }),
    );
    expect(out.ok).toBe(false);
    expect(out.refused?.reason).toBe('governor-unbudgeted');
  });
});

describe('a governed refusal never spends, and the API only proposes', () => {
  it('experiment:run surfaces a governor refusal as ok:false with no result', async () => {
    const runGovernedReplay = vi.fn(async () => ({ verdict: { allow: false, reason: 'governor-dark', remainingUsd: null }, result: null }));
    const deps: RunExperimentDeps = {
      runGovernedReplay: runGovernedReplay as unknown as RunExperimentDeps['runGovernedReplay'],
      replayRunner: (async () => ({ outputText: '', costUsd: 0, inputTokens: 0, outputTokens: 0, replayed: true })) as unknown as RunExperimentDeps['replayRunner'],
      judge: (async () => ({ text: '', costUsd: 0, inputTokens: 0, outputTokens: 0 })) as unknown as RunExperimentDeps['judge'],
      now: () => 0,
    };
    const out = await runExperiment(
      {
        testId: 'replay',
        batteryId: 'b',
        arms: [{ id: 'cand', knobs: { 'overlay.systemOverlay': 'x' } }],
        cases: [{ caseId: 'c', context: 'ctx', intent: 'do' }],
        repeats: 1,
      },
      { workspaceId: 'ws' },
      deps,
    );
    expect(out.ok).toBe(false);
    expect(out.refused?.reason).toBe('governor-dark');
    expect(out.result).toBeUndefined();
  });
});
