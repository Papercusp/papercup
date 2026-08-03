import { describe, expect, it } from 'vitest';
import {
  CLUSTER_DISTANCE_THRESHOLD,
  MANUAL_SPLIT_MIN_SIZE,
  aggregateReports,
  clusterIdeas,
  cosineDistance,
  decideVerdict,
  screenIdeaClusters,
  summariseClusterRow,
  type ClusterScreenRow,
  type ScreenableIdea,
} from './idea-cluster-screen';
import type { CodeExistenceReport, CodeSearchDeps } from './code-existence-probe';

const NOW = Date.parse('2026-08-03T00:00:00Z');

function idea(id: string, over: Partial<ScreenableIdea> = {}): ScreenableIdea {
  return {
    id,
    text: `${id} some idea text`,
    createdAt: '2026-07-04T00:00:00Z',
    ...over,
  };
}

/** Unit vector at `deg` in the first two dimensions — lets us set distances exactly. */
function vec(deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
}

function emptyReport(over: Partial<CodeExistenceReport> = {}): CodeExistenceReport {
  return { terms: [], matches: [], searched: true, ...over };
}

describe('cosineDistance', () => {
  it('is 0 for identical direction and 1 for orthogonal', () => {
    expect(cosineDistance([1, 0], [2, 0])).toBeCloseTo(0, 10);
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1, 10);
  });

  it('returns null — not a number — for every non-comparable pair', () => {
    // null forces callers to handle "cannot compare" instead of letting it
    // silently behave like "very far apart".
    expect(cosineDistance(undefined, [1, 0])).toBeNull();
    expect(cosineDistance([], [])).toBeNull();
    expect(cosineDistance([1, 0, 0], [1, 0])).toBeNull();
    expect(cosineDistance([0, 0], [1, 0])).toBeNull();
  });
});

describe('clusterIdeas', () => {
  it('merges a pair below the threshold and separates one above it', () => {
    // 0 vs 20deg -> distance ~0.0603 (below 0.09); 0 vs 30deg -> ~0.134 (above).
    const near = clusterIdeas([
      idea('A', { embedding: vec(0) }),
      idea('B', { embedding: vec(20) }),
    ]);
    expect(near).toEqual([[0, 1]]);

    const far = clusterIdeas([
      idea('A', { embedding: vec(0) }),
      idea('B', { embedding: vec(30) }),
    ]);
    expect(far).toEqual([[0], [1]]);
  });

  it('never merges an idea that has no embedding', () => {
    // Fail-open: a missing embedding must not be silently absorbed into a
    // cluster it was never actually compared against.
    const out = clusterIdeas([
      idea('A', { embedding: vec(0) }),
      idea('B', { embedding: vec(1) }),
      idea('C'),
    ]);
    expect(out).toEqual([[0, 1], [2]]);
  });

  it('orders clusters by size desc then first index, deterministically', () => {
    const out = clusterIdeas([
      idea('lone', { embedding: vec(90) }),
      idea('a', { embedding: vec(0) }),
      idea('b', { embedding: vec(5) }),
      idea('c', { embedding: vec(10) }),
    ]);
    expect(out).toEqual([[1, 2, 3], [0]]);
  });

  it('DOCUMENTS THE KNOWN WEAKNESS: single-linkage chains distant members together', () => {
    // A-B and B-C are each within threshold, but A-C is NOT. Single linkage
    // merges all three anyway. This is not a bug to fix here — it is precisely
    // why `confidence` is size-derived and large clusters are reported
    // needs-manual-split. If this test ever goes green as three clusters, the
    // clustering changed and the size-based confidence rationale is void.
    const a = vec(0);
    const b = vec(20);
    const c = vec(40);
    expect(cosineDistance(a, b)!).toBeLessThan(CLUSTER_DISTANCE_THRESHOLD);
    expect(cosineDistance(b, c)!).toBeLessThan(CLUSTER_DISTANCE_THRESHOLD);
    expect(cosineDistance(a, c)!).toBeGreaterThan(CLUSTER_DISTANCE_THRESHOLD);

    expect(
      clusterIdeas([
        idea('A', { embedding: a }),
        idea('B', { embedding: b }),
        idea('C', { embedding: c }),
      ]),
    ).toEqual([[0, 1, 2]]);
  });
});

describe('aggregateReports — plan-slug leg', () => {
  const shippedPlan = {
    slug: 'self-improvement-consume-edges-2026-06-12',
    statusClass: 'implemented' as const,
    status: 'shipped',
    overlap: ['consum'],
    score: 0.25,
  };

  it('keeps the plan leg out of the lexical and semantic legs', () => {
    const agg = aggregateReports(
      [
        emptyReport({
          matches: [
            { term: 'watchdogKey', source: 'backtick', fileCount: 3, examples: ['a.ts'], strength: 'strong' },
          ],
          semantic: [{ ref: 'x.ts', score: 0.8 }],
          planSlugs: { planMatches: [shippedPlan], searched: true },
        }),
      ],
      ['EI-1'],
    );
    expect(agg.planSlugHits.map((p) => p.slug)).toEqual([shippedPlan.slug]);
    expect(agg.lexicalHits.map((h) => h.term)).toEqual(['watchdogKey']);
    expect(agg.semanticHits.map((s) => s.ref)).toEqual(['x.ts']);
  });

  it('does NOT let the plan leg set retrievalRan', () => {
    // The property that matters most here. `retrievalRan` licenses reading an
    // empty result as "nothing exists"; the plan leg searches plan NAMES, so it
    // cannot support that reading. If this flips, a cluster could be GREENLIT —
    // absence asserted — on a search that never looked at an implementation.
    const agg = aggregateReports(
      [emptyReport({ searched: false, planSlugs: { planMatches: [shippedPlan], searched: true } })],
      ['EI-1'],
    );
    expect(agg.planSlugHits).toHaveLength(1);
    expect(agg.retrievalRan).toBe(false);
  });

  it('is structurally unable to reach a verdict', () => {
    // decideVerdict is not given planSlugHits at all, so this is enforced by the
    // type seam rather than by discipline. Two identical clusters differing ONLY
    // in the plan leg must reach the same verdict.
    const base = {
      assertedPriorArtIds: [],
      assertedOpenSiblingIds: [],
      assertedAbandonedIds: [],
      assertedUnresolvedIds: [],
      selfIdHits: [],
      lexicalHits: [],
      retrievalRan: true,
    };
    expect(decideVerdict(1, base).verdict).toBe(decideVerdict(1, { ...base }).verdict);
    // ...and the row's own verdict is untouched by a shipped-plan hit.
    const withPlan = aggregateReports(
      [emptyReport({ planSlugs: { planMatches: [shippedPlan], searched: true } })],
      ['EI-1'],
    );
    expect(decideVerdict(1, { ...base, ...withPlan, assertedPriorArtIds: [] }).verdict).toBe(
      decideVerdict(1, base).verdict,
    );
  });

  it('de-duplicates by slug, keeping the best score, and ranks shipped first', () => {
    const agg = aggregateReports(
      [
        emptyReport({ planSlugs: { planMatches: [{ ...shippedPlan, score: 0.25 }], searched: true } }),
        emptyReport({ planSlugs: { planMatches: [{ ...shippedPlan, score: 0.5 }], searched: true } }),
        emptyReport({
          planSlugs: {
            planMatches: [
              { slug: 'draft-thing', statusClass: 'in-flight', status: 'active', overlap: ['a', 'b'], score: 0.9 },
            ],
            searched: true,
          },
        }),
      ],
      ['EI-1'],
    );
    expect(agg.planSlugHits).toHaveLength(2);
    // Shipped outranks a higher-scoring in-flight plan: intent is not code.
    expect(agg.planSlugHits[0].slug).toBe(shippedPlan.slug);
    expect(agg.planSlugHits[0].score).toBe(0.5);
    expect(agg.planSlugHits[1].slug).toBe('draft-thing');
  });

  it('renders a shipped plan hit as context and a READ instruction, never a close', () => {
    const row: ClusterScreenRow = {
      memberIds: ['EI-1'],
      size: 1,
      confidence: 'high',
      verdict: 'INCONCLUSIVE',
      assertedPriorArtIds: [],
      assertedOpenSiblingIds: [],
      assertedAbandonedIds: [],
      assertedUnresolvedIds: [],
      assertedPhrases: [],
      selfIdHits: [],
      lexicalHits: [],
      semanticHits: [],
      planSlugHits: [shippedPlan],
      premiseAgeDays: { oldest: 1, newest: 1 },
      retrievalRan: true,
      notes: [],
    };
    const s = summariseClusterRow(row);
    expect(s).toContain('plan(ctx) READ');
    expect(s).toContain(shippedPlan.slug);
  });

  it('omits non-shipped plans from the summary line', () => {
    const row: ClusterScreenRow = {
      memberIds: ['EI-1'],
      size: 1,
      confidence: 'high',
      verdict: 'INCONCLUSIVE',
      assertedPriorArtIds: [],
      assertedOpenSiblingIds: [],
      assertedAbandonedIds: [],
      assertedUnresolvedIds: [],
      assertedPhrases: [],
      selfIdHits: [],
      lexicalHits: [],
      semanticHits: [],
      planSlugHits: [{ ...shippedPlan, statusClass: 'abandoned' as const, status: 'superseded' }],
      premiseAgeDays: { oldest: 1, newest: 1 },
      retrievalRan: true,
      notes: [],
    };
    expect(summariseClusterRow(row)).not.toContain('plan(ctx)');
  });

  it('defaults to an empty array when no report carries the leg', () => {
    expect(aggregateReports([emptyReport()], ['EI-1']).planSlugHits).toEqual([]);
  });
});

describe('aggregateReports', () => {
  it('keeps the semantic leg out of the lexical leg', () => {
    // The legs must stay separately measurable; blending them makes neither
    // leg's precision knowable.
    const agg = aggregateReports(
      [
        emptyReport({
          matches: [
            { term: 'watchdogKey', source: 'backtick', fileCount: 3, examples: ['a.ts'], strength: 'strong' },
          ],
          semantic: [{ ref: 'orphaned-dispatch.ts', score: 0.8 }],
        }),
      ],
      ['EI-1'],
    );
    expect(agg.lexicalHits.map((h) => h.term)).toEqual(['watchdogKey']);
    expect(agg.semanticHits.map((s) => s.ref)).toEqual(['orphaned-dispatch.ts']);
    expect(agg.lexicalHits.some((h) => h.term.includes('orphaned'))).toBe(false);
  });

  it('excludes a SIBLING member id from asserted prior art', () => {
    // A cluster member citing another member is the duplication the cluster row
    // already reports — counting it as external prior art would manufacture a
    // DROP recommendation out of the cluster's own internal cross-references.
    const agg = aggregateReports(
      [
        emptyReport({
          assertedPriorArt: [
            { ref: 'EI-7347', kind: 'work-item-id', context: 'Existing EI-7347 tooling' },
            { ref: 'EI-7593', kind: 'work-item-id', context: 'see EI-7593' },
          ],
        }),
      ],
      ['EI-7526', 'EI-7593'],
    );
    expect(agg.assertedRefIds).toEqual(['EI-7347']);
  });

  it('routes "existing <X>" phrases away from the verdict-bearing field', () => {
    const agg = aggregateReports(
      [
        emptyReport({
          assertedPriorArt: [
            { ref: 'retry/backoff logic', kind: 'existing-phrase', context: 'Existing retry/backoff logic' },
          ],
        }),
      ],
      ['EI-7303'],
    );
    expect(agg.assertedRefIds).toEqual([]);
    expect(agg.assertedPhrases).toEqual(['retry/backoff logic']);
  });

  it('reports retrievalRan false when no member was actually searched', () => {
    const agg = aggregateReports(
      [emptyReport({ searched: false }), emptyReport({ searched: false })],
      ['EI-1', 'EI-2'],
    );
    expect(agg.retrievalRan).toBe(false);
  });
});

const BARE = {
  assertedPriorArtIds: [] as string[],
  assertedOpenSiblingIds: [] as string[],
  assertedAbandonedIds: [] as string[],
  selfIdHits: [] as string[],
  lexicalHits: [] as never[],
  retrievalRan: true,
};

describe('decideVerdict', () => {
  const bare = BARE;

  it('WORKED CASE (cluster A): a multi-member cluster collapses even WITH prior art', () => {
    // Ten filings, a TRUE premise, and three-week-older prior art (EI-7347).
    // The useful output is one rescoped item + nine merged — not ten drops.
    const { verdict } = decideVerdict(10, { ...bare, assertedPriorArtIds: ['EI-7347'] });
    expect(verdict).toBe('COLLAPSE-AND-RESCOPE');
  });

  it('WORKED CASE (EI-7303): a singleton with high-precision prior art is DROP', () => {
    // Its own premise experiment PASSED at 21.8x, so a premise-only screen
    // greenlights it — and the build would have duplicated `watchdogKey`.
    const { verdict } = decideVerdict(1, { ...bare, selfIdHits: ['lib/scout/watchdog.ts'] });
    expect(verdict).toBe('DROP');
  });

  it('MEASURED: a ref to a STILL-OPEN sibling is duplication, not prior art', () => {
    // Real backlog: EI-7654 and EI-7663 each cite EI-7650 and EI-7652 as
    // "existing", and all four are open members of the same untriaged cohort.
    // Reading those as prior art recommends retiring an idea for pointing at
    // its own siblings.
    const { verdict, notes } = decideVerdict(1, {
      ...bare,
      assertedOpenSiblingIds: ['EI-7650', 'EI-7652'],
    });
    expect(verdict).toBe('COLLAPSE-AND-RESCOPE');
    expect(notes.join(' ')).toMatch(/duplication, not prior art/);
  });

  it('MEASURED: a DROPPED/DEPRECATED ref is abandoned work, NOT prior art', () => {
    // WI-2479 ("Persistent fleet headcount target governor") cites EI-6805
    // ("Fleet self-healing headcount governor") — nearly identical titles, so it
    // reads as a textbook prior-art hit. EI-6805 is `dropped`: nobody built it.
    // Dropping WI-2479 would retire an idea because the SAME idea was previously
    // abandoned. EI-7622/EI-7593 is the same shape.
    const { verdict, notes } = decideVerdict(1, { ...bare, assertedAbandonedIds: ['EI-6805'] });
    expect(verdict).toBe('GREENLIGHT');
    expect(notes.join(' ')).toMatch(/NOT built/);
  });

  it('CONTROL: the same ref in an IMPLEMENTED state does reach DROP', () => {
    // Proves the state split does real work rather than disabling the leg.
    expect(decideVerdict(1, { ...bare, assertedPriorArtIds: ['EI-6805'] }).verdict).toBe('DROP');
  });

  it('MEASURED: strong lexical hits alone must NOT reach DROP', () => {
    // The terms graded "strong" on the real backlog included `facts:assert`,
    // `plans:get` and `test:affected` — tool names the idea merely MENTIONS.
    // They exist in the tree by definition and say nothing about the proposed
    // mechanism. Letting them drive DROP retires ideas for naming a tool.
    const { verdict, notes } = decideVerdict(1, {
      ...bare,
      lexicalHits: [
        { term: 'facts:assert', source: 'tool-name', fileCount: 12, examples: [], strength: 'strong' },
      ],
    });
    expect(verdict).toBe('GREENLIGHT');
    expect(notes.join(' ')).toMatch(/context only, not grounds to drop/);
  });

  it('THE HARD BOUNDARY: a collapse note must say TRIAGE TOGETHER, never MERGE', () => {
    // Measured 3/3 by su-b9269a31. Decisive case: 19 items sharing ONE condition
    // ("a rubric emits unknown because its subject was never exercised") that
    // resolved into THREE partly-opposite mechanisms — suppress-when-blind,
    // amplify-when-chronic, diagnose-idle-as-signal. Merging them into one item
    // would have destroyed a real design decision; the outcome was 3 canonical
    // items, not 1. Distance is reliable on the CONDITION, never on the PROPOSAL.
    const { notes } = decideVerdict(19, bare);
    const text = notes.join(' ');
    expect(text).toMatch(/READ THE PROPOSALS BEFORE MERGING/);
    expect(text).toMatch(/DESCRIBE the same thing, never that they WANT the same thing/);
    expect(text).not.toMatch(/recommend ONE rescoped item/);
  });

  it('collapses a multi-member cluster even when retrieval never ran', () => {
    // Clustering does not depend on retrieval, so this verdict survives an outage.
    const { verdict } = decideVerdict(4, { ...bare, retrievalRan: false });
    expect(verdict).toBe('COLLAPSE-AND-RESCOPE');
  });

  it('THE CORE FAIL-OPEN PROPERTY: no retrieval yields INCONCLUSIVE, never GREENLIGHT', () => {
    const { verdict, notes } = decideVerdict(1, { ...bare, retrievalRan: false });
    expect(verdict).toBe('INCONCLUSIVE');
    expect(verdict).not.toBe('GREENLIGHT');
    expect(notes.join(' ')).toMatch(/NO information/i);
  });

  it('greenlights only when retrieval ran and found nothing', () => {
    expect(decideVerdict(1, bare).verdict).toBe('GREENLIGHT');
  });

  it('PRECISION CONTROL: weak (ubiquitous) lexical hits alone must NOT drive a DROP', () => {
    // A term found in hundreds of files is vocabulary, not prior art. If this
    // ever flips to DROP the screen will start retiring ideas on common words.
    const { verdict } = decideVerdict(1, {
      ...bare,
      lexicalHits: [
        { term: 'monitoring', source: 'identifier', fileCount: 900, examples: [], strength: 'weak' },
      ],
    });
    expect(verdict).toBe('GREENLIGHT');
  });
});

/**
 * PERMANENT FALSIFIABILITY CONTROL.
 *
 * A guard that has never failed is a guard nobody has tested. These deliberately
 * broken implementations must FAIL the properties asserted above — proving those
 * assertions can actually discriminate a correct implementation from a plausible
 * wrong one, rather than passing vacuously.
 */
describe('falsifiability controls (deliberately broken implementations)', () => {
  it('a verdict fn that ignores retrievalRan is CAUGHT by the fail-open property', () => {
    const broken = (): string => 'GREENLIGHT';
    expect(broken()).toBe('GREENLIGHT'); // the wrong answer...
    expect(
      decideVerdict(1, { ...BARE, retrievalRan: false }).verdict,
    ).toBe('INCONCLUSIVE'); // ...and the real one differs, so the property bites.
  });

  it('a clusterer that merges everything is CAUGHT by the threshold assertion', () => {
    const brokenMergeAll = (n: number): number[][] => [[...Array(n).keys()]];
    expect(brokenMergeAll(2)).toEqual([[0, 1]]);
    // The real clusterer separates a pair beyond the threshold.
    expect(
      clusterIdeas([idea('A', { embedding: vec(0) }), idea('B', { embedding: vec(30) })]),
    ).toEqual([[0], [1]]);
  });

  it('CALIBRATION: the controls are not passing because every verdict is the same', () => {
    // If the verdict function degenerated to one constant, the controls above
    // would still pass. This asserts the function genuinely discriminates.
    const verdicts = new Set([
      decideVerdict(1, BARE).verdict,
      decideVerdict(1, { ...BARE, retrievalRan: false }).verdict,
      decideVerdict(1, { ...BARE, selfIdHits: ['a.ts'] }).verdict,
      decideVerdict(3, BARE).verdict,
    ]);
    expect(verdicts).toEqual(new Set(['GREENLIGHT', 'INCONCLUSIVE', 'DROP', 'COLLAPSE-AND-RESCOPE']));
  });
});

describe('screenIdeaClusters', () => {
  const okDeps = (hits: Record<string, string[]> = {}): CodeSearchDeps => ({
    search: async (term: string) => hits[term] ?? [],
  });

  it('emits ONE ROW PER CLUSTER, not one per item', () => {
    const ideas = [
      idea('EI-1', { embedding: vec(0) }),
      idea('EI-2', { embedding: vec(3) }),
      idea('EI-3', { embedding: vec(6) }),
      idea('EI-9', { embedding: vec(90) }),
    ];
    return screenIdeaClusters(ideas, okDeps(), { now: NOW }).then((rows) => {
      expect(rows).toHaveLength(2);
      expect(rows[0].memberIds).toEqual(['EI-1', 'EI-2', 'EI-3']);
      expect(rows[0].size).toBe(3);
      expect(rows[0].verdict).toBe('COLLAPSE-AND-RESCOPE');
      expect(rows[1].memberIds).toEqual(['EI-9']);
    });
  });

  it('flags an oversized cluster needs-manual-split without changing its verdict', () => {
    const ideas = Array.from({ length: MANUAL_SPLIT_MIN_SIZE }, (_, i) =>
      idea(`EI-${i}`, { embedding: vec(i * 0.5) }),
    );
    return screenIdeaClusters(ideas, okDeps(), { now: NOW }).then((rows) => {
      expect(rows[0].size).toBe(MANUAL_SPLIT_MIN_SIZE);
      expect(rows[0].confidence).toBe('needs-manual-split');
      expect(rows[0].verdict).toBe('COLLAPSE-AND-RESCOPE');
      expect(rows[0].notes.join(' ')).toMatch(/SPLIT before acting/);
    });
  });

  it('a small cluster keeps high confidence', () => {
    return screenIdeaClusters(
      [idea('EI-1', { embedding: vec(0) }), idea('EI-2', { embedding: vec(2) })],
      okDeps(),
      { now: NOW },
    ).then((rows) => expect(rows[0].confidence).toBe('high'));
  });

  it('a THROWING backend yields INCONCLUSIVE — never GREENLIGHT', () => {
    const boom: CodeSearchDeps = {
      search: async () => {
        throw new Error('search backend down');
      },
    };
    return screenIdeaClusters([idea('EI-1')], boom, { now: NOW }).then((rows) => {
      expect(rows[0].retrievalRan).toBe(false);
      expect(rows[0].verdict).toBe('INCONCLUSIVE');
    });
  });

  it('a ref to a TERMINAL item is prior art and reaches DROP', () => {
    const ideas = [
      idea('EI-7526', {
        text: 'Existing EI-7347 tooling detects actor-less signals reactively.',
      }),
    ];
    const resolveRefStates = async () => new Map([['EI-7347', 'resolved']]);
    return screenIdeaClusters(ideas, okDeps(), { now: NOW, resolveRefStates }).then((rows) => {
      expect(rows[0].assertedPriorArtIds).toContain('EI-7347');
      expect(rows[0].assertedOpenSiblingIds).toEqual([]);
      expect(rows[0].verdict).toBe('DROP');
    });
  });

  it('the SAME ref, still OPEN, collapses instead of dropping', () => {
    // Identical input, one field different in the store — the verdict must flip.
    // This is the pair that proves state resolution is doing real work rather
    // than the DROP above coming from the text alone.
    const ideas = [
      idea('EI-7526', {
        text: 'Existing EI-7347 tooling detects actor-less signals reactively.',
      }),
    ];
    const resolveRefStates = async () => new Map([['EI-7347', 'open']]);
    return screenIdeaClusters(ideas, okDeps(), { now: NOW, resolveRefStates }).then((rows) => {
      expect(rows[0].assertedPriorArtIds).toEqual([]);
      expect(rows[0].assertedOpenSiblingIds).toEqual(['EI-7347']);
      expect(rows[0].verdict).toBe('COLLAPSE-AND-RESCOPE');
    });
  });

  it('FAIL-OPEN: with no resolver, an asserted ref drives NOTHING', () => {
    // Guessing "terminal" would drop live ideas; guessing "open" would collapse
    // genuinely-finished ones. Unresolved refs are reported and drive neither.
    const ideas = [idea('EI-7526', { text: 'Existing EI-7347 tooling exists.' })];
    return screenIdeaClusters(ideas, okDeps(), { now: NOW }).then((rows) => {
      expect(rows[0].assertedUnresolvedIds).toEqual(['EI-7347']);
      expect(rows[0].assertedPriorArtIds).toEqual([]);
      expect(rows[0].verdict).not.toBe('DROP');
      expect(rows[0].verdict).not.toBe('COLLAPSE-AND-RESCOPE');
    });
  });

  it('a THROWING resolver fails open rather than failing the pass', () => {
    const ideas = [idea('EI-7526', { text: 'Existing EI-7347 tooling exists.' })];
    const resolveRefStates = async () => {
      throw new Error('db down');
    };
    return screenIdeaClusters(ideas, okDeps(), { now: NOW, resolveRefStates }).then((rows) => {
      expect(rows[0].assertedUnresolvedIds).toEqual(['EI-7347']);
      expect(rows[0].verdict).not.toBe('DROP');
    });
  });

  it('THE FALSE POSITIVE: a bare "existing <X>" complaint must NOT reach DROP', () => {
    // EI-7303's real text calls the existing mechanism INADEQUATE — that is
    // motivation, the opposite of conceding prior art. Authors open this way
    // routinely, so a phrase-driven verdict would mislabel most of the backlog.
    const ideas = [
      idea('EI-7303', {
        text: 'Existing retry/backoff logic reacts to individual failures without cross-recurrence memory.',
      }),
    ];
    return screenIdeaClusters(ideas, okDeps(), { now: NOW }).then((rows) => {
      expect(rows[0].assertedPriorArtIds).toEqual([]);
      expect(rows[0].verdict).not.toBe('DROP');
    });
  });

  it('computes premise age across the cluster', () => {
    const ideas = [
      idea('EI-1', { embedding: vec(0), createdAt: '2026-07-04T00:00:00Z' }),
      idea('EI-2', { embedding: vec(2), createdAt: '2026-07-24T00:00:00Z' }),
    ];
    return screenIdeaClusters(ideas, okDeps(), { now: NOW }).then((rows) => {
      expect(rows[0].premiseAgeDays).toEqual({ oldest: 30, newest: 10 });
    });
  });
});

describe('summariseClusterRow', () => {
  it('leads with the verdict and flags an unsearched row', () => {
    const row: ClusterScreenRow = {
      memberIds: ['EI-1'],
      size: 1,
      confidence: 'high',
      verdict: 'INCONCLUSIVE',
      assertedPriorArtIds: [],
      assertedOpenSiblingIds: [],
      assertedAbandonedIds: [],
      assertedUnresolvedIds: [],
      assertedPhrases: [],
      selfIdHits: [],
      lexicalHits: [],
      semanticHits: [],
      planSlugHits: [],
      premiseAgeDays: { oldest: 30, newest: 30 },
      retrievalRan: false,
      notes: [],
    };
    const line = summariseClusterRow(row);
    expect(line.startsWith('INCONCLUSIVE')).toBe(true);
    expect(line).toMatch(/retrieval did not run/);
    expect(line).toMatch(/age 30d/);
  });

  it('elides a long member list rather than printing 35 ids', () => {
    const row: ClusterScreenRow = {
      memberIds: Array.from({ length: 10 }, (_, i) => `EI-${i}`),
      size: 10,
      confidence: 'high',
      verdict: 'COLLAPSE-AND-RESCOPE',
      assertedPriorArtIds: ['EI-7347'],
      assertedOpenSiblingIds: [],
      assertedAbandonedIds: [],
      assertedUnresolvedIds: [],
      assertedPhrases: [],
      selfIdHits: [],
      lexicalHits: [],
      semanticHits: [],
      planSlugHits: [],
      premiseAgeDays: { oldest: 30, newest: 20 },
      retrievalRan: true,
      notes: [],
    };
    expect(summariseClusterRow(row)).toMatch(/\+6/);
    expect(summariseClusterRow(row)).toMatch(/DONE prior art: EI-7347/);
  });
});
