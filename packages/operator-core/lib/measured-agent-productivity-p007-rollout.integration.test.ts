import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface RolloutEvidence {
  assertions: Array<{ id: string; passed: boolean }>;
  comparison: {
    baselineMatched: boolean;
    causalImprovementEstablished: boolean;
    rolloutVerdict: string;
  };
  latency: { unknown: number };
  negativeControl: {
    claim: Record<string, boolean>;
    contradictions: string[];
    outcome: string;
    expectedVerdict: string;
  };
  policy: { broaderRollout: string };
  population: {
    members: Array<{ terminalCommitted: number }>;
    replacementMembersIncluded: boolean;
  };
  subject: { planItem: string; spec: string; workItem: string };
}

const evidencePath = fileURLToPath(
  new URL('../../../docs/evidence/measured-agent-productivity-p007-rollout-hold-2026-09-08.json', import.meta.url),
);

async function readEvidence(): Promise<RolloutEvidence> {
  return JSON.parse(await readFile(evidencePath, 'utf8')) as RolloutEvidence;
}

describe('measured-agent-productivity P-007 rollout decision', () => {
  it('preserves the fixed historical cohort and records HOLD when improvement is not established', async () => {
    const evidence = await readEvidence();

    expect(evidence.subject).toEqual({
      plan: 'measured-agent-productivity-2026-09-06',
      planItem: 'P-007',
      workItem: 'WI-10000336',
      spec: 'SPEC-P007-rollout@1',
      specFingerprint: '6ab084d2ed6353d4c480a599353ef82440c0df46cad83763f70aea01c4326b28',
      decision: 'measured-agent-productivity-2026-09-06#D-010',
    });
    expect(evidence.population.members.map((member) => member.terminalCommitted)).toEqual([0, 7, 0]);
    expect(evidence.population.replacementMembersIncluded).toBe(false);
    expect(evidence.comparison).toMatchObject({
      baselineMatched: false,
      causalImprovementEstablished: false,
      rolloutVerdict: 'hold-no-broader-rollout',
    });
    expect(evidence.policy.broaderRollout).toBe('hold');
    expect(evidence.assertions.every((assertion) => assertion.passed)).toBe(true);
  });

  it('rejects a false GO when the baseline is unmatched, member output is unbalanced, and latency is incomplete', async () => {
    const evidence = await readEvidence();
    const falseGo = evidence.negativeControl.claim;
    const contradictions: string[] = [];

    if (falseGo.matched250kBaseline && !evidence.comparison.baselineMatched) contradictions.push('baseline-unmatched');
    if (
      falseGo.balancedMemberContribution &&
      evidence.population.members.some((member) => member.terminalCommitted === 0)
    ) {
      contradictions.push('terminal-distribution-0-7-0');
    }
    if (falseGo.completeLatency && evidence.latency.unknown > 0) contradictions.push('latency-unknown-5-of-7');
    if (falseGo.broaderRollout && evidence.policy.broaderRollout !== 'go') contradictions.push('acceptance-chain-absent');

    expect(contradictions).toEqual(evidence.negativeControl.contradictions);
    expect(evidence.negativeControl.outcome).toBe('killed');
    expect(evidence.negativeControl.expectedVerdict).toBe('hold-no-broader-rollout');
  });
});
