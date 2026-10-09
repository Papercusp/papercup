import type { CurrentBenchmarkProtocol } from './schema';

/** Shared no-inference fixture; runtime/context pins are deliberately synthetic. */
export function currentProtocolFixture(runId = 'run-1', maxWallClockMs = 100): CurrentBenchmarkProtocol {
  const arm = (id: string) => ({
    id, agent: 'codex' as const, model: 'configured-alias', effort: 'high', account: 'auto',
    generationBudget: { maxUsd: 3, maxWallClockMs },
    runtime: { sourceRevision: 'fixture-source', runtimeRevision: 'fixture-runtime', clientVersion: 'fixture-client', promptHash: 'a'.repeat(64), toolsHash: 'b'.repeat(64) },
  });
  return {
    schemaVersion: 1, runId, taskIds: ['t1'], seeds: [1], arms: [arm('papercusp'), arm('baseline')],
    aggregateBudgetUsd: 60, maxInFlightUsd: 3,
    priceSchedule: { version: 'frozen-prices-v1', rates: [{ model: 'configured-alias', inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 2 }] },
    grader: { family: 'official', version: 'pinned', imageDigest: 'fixture-image-digest' },
    context: { corpusHash: 'c'.repeat(64), memoryHash: 'd'.repeat(64), corpusRef: 'fixture:corpus', memoryRef: 'fixture:memory',
      isolation: 'fresh-per-assignment', forbiddenSources: ['other-arm-solutions', 'hidden-grader-answers'] },
    exclusions: [], stopping: { maxAttemptsPerAssignment: 1, budgetAction: 'record-cap-outcome', graderOutage: 'repair-or-inconclusive', superiorityClaim: 'withheld-confirmation-only' },
    confirmation: { taskIds: ['withheld-1'], seeds: [2], plannedPairedTasks: 1, minimumEffect: 0.2, alpha: 0.05, power: 0.8, method: 'paired-binomial-power-plan-fixture' },
  };
}
