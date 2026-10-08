import { describe, expect, it } from 'vitest';
import { lookupByMcpName, listAllProjectedTools } from '@papercusp/tooldef';
import { buildSidecarAwareReranker, resolveProcessSidecarUrl } from '../memory/embed-sidecar-wiring';
import { scoreSubjectEvidence, SUBJECT_EVIDENCE_MIN_SCORE } from './relevance-router';
import { evaluateSubjectCases, HELD_OUT_SUBJECT_CASES } from './subject-evidence.fixtures';
import '../agent-tools/index';

describe('registered subject evidence with the real local scorer', () => {
  it('measures labelled held-out top choice, recall and explicit no-expert outcomes', async () => {
    for (const name of ['computer:provision_desktop', 'computer:observe', 'db:migrate']) {
      expect(lookupByMcpName(name)?.description).toBeTruthy();
    }
    expect(listAllProjectedTools().length).toBeGreaterThan(100);
    const url = await resolveProcessSidecarUrl(undefined, ['POST /rerank']);
    const health = url ? await (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) })).json() : null;
    const runtime = { endpoint: url, engine: url ? 'sidecar' : 'in-process',
      build: health?.sha ?? null, modelState: health?.models?.rerank ?? null,
      execution: health?.rerankExecutionHealth?.active ?? null };
    console.info('subject-scorer-preflight', JSON.stringify(runtime));
    const failures: { contracts: string[]; reason: string }[] = [];
    const baseScorer = await buildSidecarAwareReranker();
    const scorer: typeof baseScorer = async (query, contracts, opts) => {
      try {
        const scores = await baseScorer(query, contracts, opts);
        console.info('subject-contract-scores', JSON.stringify({ contracts: contracts.map(c => c.split('\n')[0]), scores }));
        return scores;
      } catch (error) {
        const failure = { contracts: contracts.map(c => c.split('\n')[0]),
          reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown' };
        failures.push(failure);
        console.info('subject-contract-unavailable', JSON.stringify(failure));
        throw error;
      }
    };
    // Cold model construction is an evaluation prerequisite, not time granted
    // to production qualification. Every measured scenario retains its 4s cap.
    const warmStart = Date.now();
    await scorer('SQL migration file', ['Apply a numbered PostgreSQL DDL transaction.'], { deadline: Date.now() + 15_000 });
    console.info('subject-scorer-ready', JSON.stringify({ warmupMs: Date.now() - warmStart }));
    const measurements = [];
    for (const scenario of HELD_OUT_SUBJECT_CASES) {
      const scores = await scoreSubjectEvidence(scenario.subject, scenario.passages.map(p => p.text), Date.now() + 4000, { scorer });
      measurements.push({ id: scenario.id, scores });
    }
    // Persisted in the normal Vitest evidence; labels and full population are
    // independent of score/ranking. Empty-truth cases are assessed separately,
    // rather than misreading the shared evaluator's null recall as zero.
    const { cases: measured, summary } = evaluateSubjectCases(measurements, SUBJECT_EVIDENCE_MIN_SCORE);
    console.info('subject-held-out-metrics', JSON.stringify(measured));
    console.info('subject-held-out-summary', JSON.stringify(summary));
    const positives = measured.filter(r => r.relevant.length);
    const negatives = measured.filter(r => !r.relevant.length);
    expect(summary.unavailable, `all labelled measurements must be available: ${JSON.stringify({ runtime, failures })}`).toBe(0);
    expect(positives[0].selected[0]).toBe('display-repair');
    expect(negatives[0].selected).toEqual([]);
    expect(summary.topChoicePrecision).toBeGreaterThanOrEqual(2 / 3);
    expect(summary.recallAt1).toBeGreaterThanOrEqual(2 / 3);
    expect(negatives.filter(r => r.selected.length)).toEqual([]);
  }, 60_000);
});
