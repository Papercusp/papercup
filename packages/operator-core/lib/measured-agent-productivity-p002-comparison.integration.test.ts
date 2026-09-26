import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  evaluateP002Comparison,
  type P002ComparisonInput,
} from './measured-agent-productivity-p002-decision';

interface P002Evidence extends P002ComparisonInput {
  subject: { plan: string; planItem: string; workItem: string; decision: string };
  source: { batteryId: string; sourceSnapshot: string };
  method: P002ComparisonInput['method'] & { runnerModel: string; judgeModel: string };
  recorded: {
    experimentWinner: string | null;
    verdict: string;
    preload: string;
    recommendation: string;
  };
  disclosedGaps: string[];
}

// The committed operational record of the 2026-09-07 P-002 replay battery, copied
// verbatim from harness_shared.replay_runs + experiment_runs. The mutation probe
// (copy-out mode) overrides the path so the tracked file is never dirtied.
const evidencePath =
  process.env.P002_EVIDENCE_PATH ??
  fileURLToPath(new URL('../../../docs/evidence/measured-agent-productivity-p002-comparison-2026-09-07.json', import.meta.url));

async function readEvidence(): Promise<P002Evidence> {
  return JSON.parse(await readFile(evidencePath, 'utf8')) as P002Evidence;
}

describe('measured-agent-productivity P-002 context-strategy comparison', () => {
  it('records the owner-authorized battery on matched tasks, one runner, one judge and one rubric', async () => {
    const evidence = await readEvidence();
    expect(evidence.subject).toMatchObject({
      plan: 'measured-agent-productivity-2026-09-06',
      planItem: 'P-002',
      workItem: 'WI-10000331',
      decision: 'measured-agent-productivity-2026-09-06#D-009',
    });
    expect(evidence.source.batteryId).toBe('p002-relevance-dedup-20260907-878ab3bb-r1');
    expect(evidence.method).toMatchObject({
      runnerModel: 'gpt-5.6-sol',
      judgeModel: 'gpt-5.6-sol:xhigh',
      preselectedWinner: null,
      minDelta: 0,
    });
    // Hard-coded ledger literals: the oracle is the replay_runs rows, not the evaluator.
    const composite = (variantId: string) =>
      evidence.cells.filter((cell) => cell.variantId === variantId).map((cell) => [cell.taskId, cell.composite]);
    expect(composite('baseline')).toEqual([
      ['WI-10000276', 9.75],
      ['WI-10000316', 2.8],
      ['EI-22552545539859127', 7.4],
    ]);
    expect(composite('relevance-dedup')).toEqual([
      ['WI-10000276', 10],
      ['WI-10000316', 1.4],
      ['EI-22552545539859127', 4.1],
    ]);
    expect(evidence.recorded.experimentWinner).toBeNull();
  });

  it('re-derives HOLD from judged quality: baseline holds and relevant preload is retained', async () => {
    const evidence = await readEvidence();
    const result = evaluateP002Comparison(evidence);

    expect(result.fair).toBe(true);
    expect(result.fairnessViolations).toEqual([]);
    expect(result.compared).toHaveLength(1);
    expect(result.compared[0]).toMatchObject({ variantId: 'relevance-dedup', eligible: true, wins: 1 });
    expect(result.compared[0].delta).toBeCloseTo(-1.4833333333, 6);
    expect(result.verdict).toBe('baseline-holds');
    expect(result.winner).toBe('baseline');
    expect(result.preload).toBe('retain-current-preload');
    expect(result.removalEvidence).toBeNull();

    // The recorded decision must agree with the re-derivation, not merely exist.
    expect(evidence.recorded.verdict).toBe(result.verdict);
    expect(evidence.recorded.preload).toBe(result.preload);
    expect(evidence.recorded.recommendation).toContain('guaranteed relevant preload');
    expect(evidence.recorded.recommendation).toContain('no fleet-wide default change');
  });

  it('discloses the arms that could not run instead of scoring them', async () => {
    const evidence = await readEvidence();
    const result = evaluateP002Comparison(evidence);
    expect(result.notCompared.map((arm) => arm.id)).toEqual(['higher-context', 'combined']);
    expect(result.notCompared[0].reason).toContain('250000');
    expect(evidence.disclosedGaps.some((gap) => gap.includes('higher-context'))).toBe(true);
  });
});
