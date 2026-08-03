/**
 * Tests for the P-005 diagnosis-cluster lane.
 *
 * These deliberately pin the MEASUREMENTS, not just the behaviour. Three results
 * in this module were arrived at by measuring against the real corpus and each
 * one contradicts the obvious design, so each is asserted here to stop it being
 * "improved" back:
 *
 *   1. the key is ONE marked word, and tightening it loses recall for nothing;
 *   2. embedding cosine cannot separate this class from background noise;
 *   3. the ritual population is held out STRUCTURALLY, never by its title text.
 *
 * The fixture titles are real, verbatim from the corpus rows the plan's
 * Background names — a paraphrase would test the paraphrase, not the class.
 */
import { describe, expect, it } from 'vitest';

import {
  clusterByDiagnosis,
  rankDiagnosisClusters,
  DIAGNOSIS_SHAPES,
  EMBEDDING_CANNOT_SEPARATE,
  type DiagnosisCluster,
} from './diagnosis-clusters';
import type { ImprovementCandidate } from './policy';

function cand(partial: Partial<ImprovementCandidate> & { id: string; title: string }): ImprovementCandidate {
  return {
    kind: 'change',
    scope: 'harness:papercusp',
    severity: 'nit',
    state: 'open',
    body: '',
    createdAt: '2026-07-01T00:00:00.000Z',
    createdBy: `agent-${partial.id}`,
    ...partial,
  } as ImprovementCandidate;
}

/** The seven real class members named in the plan's Background, verbatim. */
const CLASS_MEMBERS: ImprovementCandidate[] = [
  cand({
    id: 'EI-19375905555183196',
    title: 'THE PREMISE WAS THE BUG — and the same shape recurred three times in one session: a mass-death that never happened',
    createdBy: 'agent-a',
    createdAt: '2026-08-02T10:00:00.000Z',
  }),
  cand({
    id: 'EI-19342313216721918',
    // The marked word is in the BODY here, not the title — body matching is load-bearing.
    title: "[hypothesis] THE PLAN'S ITEM TEXT IS A HYPOTHESIS, NOT A SPEC — now 4-for-4 (D-010, D-011, D-013, D-014).",
    body: 'Every premise in the item text turned out to need checking before it could be built.',
    createdBy: 'agent-b',
    createdAt: '2026-07-30T10:00:00.000Z',
  }),
  cand({
    id: 'EI-19342092196943323',
    title: "[hypothesis] THE PLAN'S ITEM TEXT IS A HYPOTHESIS, NOT A SPEC — this is now 4-for-4 on this plan.",
    body: 'Every premise stated in an item has needed independent verification.',
    createdBy: 'agent-c',
    createdAt: '2026-07-30T09:00:00.000Z',
  }),
  cand({
    id: 'EI-19342962352488161',
    title: 'THE CARRY NOTE ITSELF PLANTED A FALSE PREMISE, AND I ALMOST BUILT A FIX ON IT.',
    createdBy: 'agent-d',
    createdAt: '2026-07-31T10:00:00.000Z',
  }),
  cand({
    id: 'EI-19372214294975623',
    title: '**The premise was checkable in ten minutes and stood unexamined for six days, across four plan items and one owner escalation.',
    createdBy: 'agent-e',
    createdAt: '2026-08-01T10:00:00.000Z',
  }),
  cand({
    id: 'EI-19366211923471677',
    title: "P-010's stated premise was PARTLY FALSE (the 7th on this plan) — recorded as D-019.",
    createdBy: 'agent-f',
    createdAt: '2026-08-01T11:00:00.000Z',
  }),
  cand({
    id: 'EI-19369955448231764',
    title: '1. P-005 WAS A FALSE PREMISE and the reasoning generalizes to the whole plan. BlockNote 0.51.3 loads emoji via emoji-mart.',
    createdBy: 'agent-g',
    createdAt: '2026-08-01T12:00:00.000Z',
  }),
];

describe('clusterByDiagnosis', () => {
  it('clusters the class the lexical + embedding keys both miss (7/7 recall)', () => {
    const report = clusterByDiagnosis(CLASS_MEMBERS);
    expect(report.clusters).toHaveLength(1);
    const [c] = report.clusters;
    expect(c.shape).toBe('false-premise');
    expect(c.rows).toBe(7);
    expect(c.distinctAuthors).toBe(7);
    expect(c.ids).toHaveLength(7);
    expect(report.unshaped).toBe(0);
  });

  it('matches the BODY, not only the title', () => {
    const bodyOnly = cand({
      id: 'EI-body',
      title: 'A completely unrelated headline about a queue',
      body: 'The premise turned out to be false once I checked it.',
    });
    const report = clusterByDiagnosis([bodyOnly]);
    expect(report.clusters[0]?.ids).toEqual(['EI-body']);
  });

  it('orders members newest-first and reports the span', () => {
    const c = clusterByDiagnosis(CLASS_MEMBERS).clusters[0];
    expect(c.ids[0]).toBe('EI-19375905555183196'); // 08-02, the newest
    expect(c.firstSeen).toBe('2026-07-30T09:00:00.000Z');
    expect(c.lastSeen).toBe('2026-08-02T10:00:00.000Z');
  });

  it('reports unshaped so a small result reads as "the key does not fit", not "no clusters"', () => {
    const offTopic = Array.from({ length: 20 }, (_, i) =>
      cand({ id: `EI-off-${i}`, title: `A flaky test in the deploy path #${i}` }),
    );
    const report = clusterByDiagnosis(offTopic);
    expect(report.clusters).toHaveLength(0);
    // The honest reading of zero clusters is available in the same result.
    expect(report.unshaped).toBe(20);
    expect(report.considered).toBe(20);
  });
});

describe('the ritual population is held out structurally', () => {
  // Measured: 1,326 rubric-graded scorecards filed by 1,208 DISTINCT authors, so
  // they pass a distinct-author rank on their own merits and would top the lane
  // forever. They are a per-agent ritual, not a diagnosis.
  const scorecard = cand({
    id: 'EI-scorecard',
    title: 'pot-coordination-health scorecard',
    body: 'the premise of this rubric is coordination health',
    observation: { rubricRef: 'pot-coordination-health' },
  } as Partial<ImprovementCandidate> & { id: string; title: string });

  it('excludes a rubric-graded scorecard even when it matches the shape', () => {
    const report = clusterByDiagnosis([...CLASS_MEMBERS, scorecard]);
    expect(report.ritualExcluded).toBe(1);
    expect(report.clusters[0].ids).not.toContain('EI-scorecard');
    expect(report.clusters[0].rows).toBe(7);
  });

  it('excludes by rubricRef, NOT by matching the word "scorecard" in the title', () => {
    // A genuine diagnosis that merely mentions scorecards must NOT be held out —
    // a title-text exclusion would silently eat it.
    const aboutScorecards = cand({
      id: 'EI-about',
      title: 'The scorecard emitter rests on a premise that is false under load',
    });
    const report = clusterByDiagnosis([aboutScorecards]);
    expect(report.ritualExcluded).toBe(0);
    expect(report.clusters[0]?.ids).toEqual(['EI-about']);
  });
});

describe('rankDiagnosisClusters — independent convergence, not volume', () => {
  it('ranks many-authors above many-rows', () => {
    const oneAgentRefiling: DiagnosisCluster = {
      shape: 'noisy',
      label: 'one agent, many filings',
      ids: Array.from({ length: 40 }, (_, i) => `x${i}`),
      rows: 40,
      distinctAuthors: 1,
    };
    const independentConvergence: DiagnosisCluster = {
      shape: 'signal',
      label: 'many agents, fewer filings',
      ids: Array.from({ length: 15 }, (_, i) => `y${i}`),
      rows: 15,
      distinctAuthors: 15,
    };
    const ranked = rankDiagnosisClusters([oneAgentRefiling, independentConvergence]);
    expect(ranked[0].shape).toBe('signal');
  });
});

describe('MEASURED results that must not be silently undone', () => {
  it('every registered shape states what it was measured to do', () => {
    // D-001: a prescriptive artifact must verify its prescription. A shape with no
    // measurement is an unchecked premise in the imperative voice.
    for (const s of DIAGNOSIS_SHAPES) {
      expect(s.measured.corpus).toMatch(/\d/);
      expect(s.measured.rows).toBeGreaterThan(0);
      expect(s.measured.distinctAuthors).toBeGreaterThan(1);
      expect(s.measured.sampled).toBeGreaterThanOrEqual(20);
      // Precision must be stated AND good enough to act on.
      expect(s.measured.truePositives / s.measured.sampled).toBeGreaterThan(0.9);
    }
  });

  it('TIGHTENING the marked term loses recall — the refuted "improvement", pinned', () => {
    // The first draft required an asserted falsity term near the marked word.
    // Re-measured against the real corpus it scored strictly worse in BOTH
    // directions: recall 7/7 -> 5/7, while removing almost nothing genuine.
    const FALSITY = '(?:false|wrong|incorrect|refuted|bogus|partly false)';
    const tightened = new RegExp(
      `\\b(?:false|wrong|unchecked|unverified|mistaken|stated)\\s+premise\\b|` +
        `\\bpremise\\b[^.!?\\n]{0,60}?\\b(?:was|is|turned out|proved)\\b[^.!?\\n]{0,30}?\\b${FALSITY}\\b`,
      'i',
    );
    const shipped = DIAGNOSIS_SHAPES.find((s) => s.key === 'false-premise')!.match;

    const text = (c: ImprovementCandidate) => `${c.title}\n${c.body ?? ''}`;
    const shippedHits = CLASS_MEMBERS.filter((c) => shipped.test(text(c)));
    const tightenedHits = CLASS_MEMBERS.filter((c) => tightened.test(text(c)));

    expect(shippedHits).toHaveLength(7);
    expect(tightenedHits.length).toBeLessThan(7);

    // Name the casualties: both are canonical members of the class.
    const missed = CLASS_MEMBERS.filter((c) => !tightened.test(text(c))).map((c) => c.id);
    expect(missed).toContain('EI-19375905555183196'); // "THE PREMISE WAS THE BUG"
    expect(missed).toContain('EI-19372214294975623'); // "The premise was checkable in ten minutes"
  });

  it('embedding cosine cannot separate this class — the wrong instrument, pinned', () => {
    const m = EMBEDDING_CANNOT_SEPARATE;
    // Every genuine class pair falls BELOW the embedding leg's clustering bar...
    expect(m.classPairCosineMax).toBeLessThan(m.legThreshold);
    // ...as does the pair that is literally the same observation filed twice.
    expect(m.duplicatePairCosine).toBeLessThan(m.legThreshold);
    // And no threshold rescues it: the class sits inside the random-pair
    // distribution, between its median and its 99th percentile.
    expect(m.classPairCosineMin).toBeGreaterThan(m.randomBaseline.p50);
    expect(m.classPairCosineMax).toBeLessThanOrEqual(m.randomBaseline.p99);
    // The module must therefore stay embedding-free.
    expect(m.note).toMatch(/no threshold separates them/i);
  });

  it('is NOT a dedup pass — members stay distinct', () => {
    // Merging them would destroy the "N different agents hit this" signal that
    // makes the cluster rankable in the first place.
    const report = clusterByDiagnosis(CLASS_MEMBERS);
    expect(report.clusters[0].ids).toHaveLength(CLASS_MEMBERS.length);
    expect(new Set(report.clusters[0].ids).size).toBe(CLASS_MEMBERS.length);
  });
});
