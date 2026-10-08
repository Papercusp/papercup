import { describe, expect, it } from 'vitest';
import { lookupByMcpName, listAllProjectedTools } from '@papercusp/tooldef';
import { evaluateRelevance } from '@papercusp/search-core';
import { buildSidecarAwareReranker, resolveProcessSidecarUrl } from '../memory/embed-sidecar-wiring';
import { scoreSubjectEvidence, SUBJECT_EVIDENCE_MIN_SCORE } from './relevance-router';
import { HELD_OUT_SUBJECT_CASES } from './subject-evidence.fixtures';
import '../agent-tools/index';

describe('registered subject evidence with the real local scorer', () => {
  it('measures labelled held-out top choice, recall and explicit no-expert outcomes', async () => {
    for (const name of ['computer:provision_desktop', 'computer:observe', 'db:migrate']) {
      expect(lookupByMcpName(name)?.description).toBeTruthy();
    }
    expect(listAllProjectedTools().length).toBeGreaterThan(100);
    const url = await resolveProcessSidecarUrl(undefined, ['POST /rerank']);
    const health = url ? await (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) })).json() : null;
    console.info('subject-scorer-preflight', JSON.stringify({ endpoint: url, health }));
    const baseScorer = await buildSidecarAwareReranker();
    const scorer: typeof baseScorer = async (query, contracts, opts) => {
      try {
        const scores = await baseScorer(query, contracts, opts);
        console.info('subject-contract-scores', JSON.stringify({ contracts: contracts.map(c => c.split('\n')[0]), scores }));
        return scores;
      } catch (error) {
        console.info('subject-contract-unavailable', JSON.stringify({ contracts: contracts.map(c => c.split('\n')[0]),
          reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown' }));
        throw error;
      }
    };
    // Cold model construction is an evaluation prerequisite, not time granted
    // to production qualification. Every measured scenario retains its 4s cap.
    const warmStart = Date.now();
    await scorer('SQL migration file', ['Apply a numbered PostgreSQL DDL transaction.'], { deadline: Date.now() + 15_000 });
    console.info('subject-scorer-ready', JSON.stringify({ warmupMs: Date.now() - warmStart }));
    const measured = [];
    for (const scenario of HELD_OUT_SUBJECT_CASES) {
      const scores = await scoreSubjectEvidence(scenario.subject, scenario.passages.map(p => p.text), Date.now() + 4000, { scorer });
      const ranked = scenario.passages.map((p, i) => ({ ...p, score: scores[i]! }))
        .filter(p => p.score >= SUBJECT_EVIDENCE_MIN_SCORE).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      const relevant = new Set<string>(scenario.relevant);
      const metrics = evaluateRelevance({ ranked, k: 1, grade: p => relevant.has(p.id) ? 3 : 0,
        groundTruth: { ids: [...relevant], idOf: p => p.id } });
      measured.push({ id: scenario.id, scores, selected: ranked.map(p => p.id), relevant: [...relevant], metrics });
    }
    // Persisted in the normal Vitest evidence; labels and full population are
    // independent of score/ranking. Empty-truth cases are assessed separately,
    // rather than misreading the shared evaluator's null recall as zero.
    console.info('subject-held-out-metrics', JSON.stringify(measured));
    const positives = measured.filter(r => r.relevant.length);
    const negatives = measured.filter(r => !r.relevant.length);
    const unavailable = measured.flatMap(r => r.scores).filter(s => s === null).length;
    const correct = positives.filter(r => r.relevant.includes(r.selected[0])).length;
    const recall = positives.reduce((sum, r) => sum + (r.metrics.recallAtK ?? 0), 0) / positives.length;
    console.info('subject-held-out-summary', JSON.stringify({ population: measured.length, positiveCases: positives.length,
      noExpertCases: negatives.length, topChoicePrecision: unavailable ? null : correct / positives.length, recallAt1: unavailable ? null : recall,
      falseExpertCases: negatives.filter(r => r.selected.length).length, unavailable }));
    expect(unavailable, 'all labelled measurements must be available for a precision acceptance verdict').toBe(0);
    expect(positives[0].selected[0]).toBe('display-repair');
    expect(negatives[0].selected).toEqual([]);
    expect(correct / positives.length).toBeGreaterThanOrEqual(2 / 3);
    expect(recall).toBeGreaterThanOrEqual(2 / 3);
    expect(negatives.filter(r => r.selected.length)).toEqual([]);
  }, 60_000);
});
