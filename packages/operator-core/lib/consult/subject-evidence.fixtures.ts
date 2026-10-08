import { evaluateRelevance } from '@papercusp/search-core';

/** Independently labelled evaluation population, declared before measuring this
 * edition. Calibration passages (soleOwner, observe, model migration) are
 * deliberately excluded. Labels describe expertise; scores never set labels. */
export const HELD_OUT_SUBJECT_CASES = [
  { id: 'gui-paraphrase', subject: 'computer:provision_desktop', relevant: ['display-repair'], passages: [
    { id: 'display-repair', text: 'A sandbox display was still registered after its X server died. I verified the dead process, retired its lease and created a new isolated screen for the browser.' },
    { id: 'checkpoint-owner', text: 'I fixed the green checkpoint ownership claim. Only the elected release fixer should rerun the suite and promote the green commit.' },
  ] },
  { id: 'gui-no-expert', subject: 'computer:provision_desktop', relevant: [], passages: [
    { id: 'gate-policy', text: 'The release gate is held by another live agent. Send evidence once and stop running parallel checkpoint monitors.' },
    { id: 'memory-policy', text: 'A durable memory fact belongs in the shared store, while checkpoints hold the current lane and recovery context.' },
  ] },
  { id: 'widgets-paraphrase', subject: 'computer:observe', relevant: ['widget-reader'], passages: [
    { id: 'widget-reader', text: 'I repaired AT-SPI traversal so the application exposes focused controls, labels and widget roles. Each accessible element has a stable reference for activation.' },
    { id: 'deployment-monitor', text: 'I observe release telemetry and monitor the green checkpoint before deciding whether the deployment is stalled.' },
  ] },
  { id: 'database-paraphrase', subject: 'db:migrate', relevant: ['schema-author'], passages: [
    { id: 'schema-author', text: 'I applied a numbered DDL change to PostgreSQL after obtaining the schema lease. The database version ledger records the transaction and rollback procedure.' },
    { id: 'model-worker', text: 'I migrated the inference worker to another model endpoint. The scheduler drains prompts and preserves the account cache before switching model providers.' },
  ] },
  { id: 'database-no-expert', subject: 'db:migrate', relevant: [], passages: [
    { id: 'provider-change', text: 'The model migration changes provider credentials and inference routing. I moved generation calls to a new gateway and validated token usage.' },
    { id: 'fleet-transition', text: 'Migrate the headless fleet to the next account by restarting its inference sessions; retain warm carry across agent wakes.' },
  ] },
] as const;

/** One result per declared case. Unknown scores stay unknown in the aggregate;
 * incomplete populations cannot produce an apparently precise verdict. */
export function evaluateSubjectCases(
  results: readonly { id: string; scores: readonly (number | null)[] }[],
  minScore: number,
) {
  if (results.length !== HELD_OUT_SUBJECT_CASES.length ||
    new Set(results.map(r => r.id)).size !== results.length ||
    results.some(r => !HELD_OUT_SUBJECT_CASES.some(c => c.id === r.id))) {
    throw new Error('subject-evaluation-population-mismatch');
  }
  const cases = HELD_OUT_SUBJECT_CASES.map(scenario => {
    const result = results.find(r => r.id === scenario.id)!;
    if (result.scores.length !== scenario.passages.length) throw new Error('subject-evaluation-score-shape');
    const scores = result.scores.map(score => typeof score === 'number' && Number.isFinite(score) &&
      score >= 0 && score <= 1 ? score : null);
    const ranked = scenario.passages.flatMap((passage, i) => scores[i] !== null && scores[i]! >= minScore
      ? [{ ...passage, score: scores[i]! }] : [])
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const relevant = new Set<string>(scenario.relevant);
    const metrics = evaluateRelevance({ ranked, k: 1, grade: passage => relevant.has(passage.id) ? 3 : 0,
      groundTruth: { ids: [...relevant], idOf: passage => passage.id } });
    return { id: scenario.id, scores, selected: ranked.map(p => p.id), relevant: [...relevant], metrics };
  });
  const positives = cases.filter(c => c.relevant.length);
  const negatives = cases.filter(c => !c.relevant.length);
  const unavailable = cases.flatMap(c => c.scores).filter(s => s === null).length;
  return {
    cases,
    summary: {
      population: cases.length, positiveCases: positives.length, noExpertCases: negatives.length,
      topChoicePrecision: unavailable ? null : positives.filter(c => c.relevant.includes(c.selected[0])).length / positives.length,
      recallAt1: unavailable ? null : positives.reduce((sum, c) => sum + (c.metrics.recallAtK ?? 0), 0) / positives.length,
      falseExpertCases: negatives.filter(c => c.selected.length).length, unavailable,
    },
  };
}
