/**
 * The consumer-admission gates (EI-10666).
 *
 * These gates decide what an agent ACTUALLY receives from a recall. The tests that matter here
 * are the ones about BLACKING OUT: which gates can reduce a non-empty retrieval to nothing, and
 * which must never be able to.
 */
import { describe, expect, it } from 'vitest';
import {
  admitRecallHits,
  collapseNearDuplicates,
  isNearDuplicateText,
  jaccardSimilarity,
  normalizeForDedup,
  MEMORY_SCORE_FLOOR,
  MEMORY_TEXT_CAP,
} from './recall-admission';

// Distinct-but-same-length text per id: these gate tests exercise floor/withhold/budget, so the
// fixtures must NOT be collapsed by the P-008 near-duplicate gate (identical `'x'.repeat` text
// would be — correctly — collapsed). Length stays exactly `chars` so the budget math is unchanged.
const hit = (id: string, score?: number, chars = 10) => ({
  id,
  memory: `${id} `.padEnd(chars, 'x'),
  score,
});

describe('admitRecallHits', () => {
  describe('the relevance floor is DEGRADED-REGIME ONLY (EI-10372)', () => {
    // The live incident: a healthy hybrid backend returns RRF rank-fusion scores on the SAME
    // 0.01-0.03 band as degraded lexical noise (rank-1 both-legs ≈ 0.0328 — a STRONG hit). A
    // blanket floor therefore ate EVERY healthy hit and orient's fold went silently empty.
    const healthyRrf = [hit('a', 0.0328), hit('b', 0.0164), hit('c', 0.0164)];

    it('a HEALTHY response keeps every hit, even on the low RRF band', () => {
      const r = admitRecallHits(healthyRrf, { degraded: false });
      expect(r.admitted).toHaveLength(3);
      expect(r.filteredLowScore).toBe(0);
    });

    it('the SAME scores on a DEGRADED response are floored as noise', () => {
      const r = admitRecallHits(healthyRrf, { degraded: true, scoreScale: 'cosine' });
      expect(r.admitted).toHaveLength(0);
      expect(r.filteredLowScore).toBe(3);
    });

    it.each(['rrf', 'lexical', 'unknown', undefined] as const)(
      'a degraded response on %s scores fails open instead of applying the cosine floor',
      (scoreScale) => {
        const r = admitRecallHits(healthyRrf, { degraded: true, scoreScale });
        expect(r.admitted).toHaveLength(3);
        expect(r.filteredLowScore).toBe(0);
        expect(r.decisions.some((d) => d.gate === 'orient.recall.relevance-floor')).toBe(false);
      },
    );

    it('a hit with NO numeric score passes even when degraded (fail-open)', () => {
      const r = admitRecallHits([hit('a', undefined)], { degraded: true, scoreScale: 'cosine' });
      expect(r.admitted).toHaveLength(1);
      expect(r.filteredLowScore).toBe(0);
    });

    it('a strong hit survives the floor when degraded', () => {
      const r = admitRecallHits([hit('a', MEMORY_SCORE_FLOOR), hit('b', 0.01)], {
        degraded: true,
        scoreScale: 'cosine',
      });
      expect(r.admitted.map((h) => h.id)).toEqual(['a']);
      expect(r.filteredLowScore).toBe(1);
    });
  });

  describe('the budget can never blank a fold', () => {
    // The FIRST hit is always admitted. A budget smaller than one hit must degrade the fold,
    // never empty it — otherwise a config value could black out recall system-wide.
    it('admits the first hit even when it alone busts the budget', () => {
      const r = admitRecallHits([hit('a', 0.9, 5000), hit('b', 0.8, 5000)], { budgetChars: 10 });
      expect(r.admitted.map((h) => h.id)).toEqual(['a']);
      expect(r.withheldBudget).toBe(1);
    });

    it('drops hits past the budget, in relevance order, and counts them', () => {
      const r = admitRecallHits([hit('a', 0.9, 100), hit('b', 0.8, 100), hit('c', 0.7, 100)], {
        budgetChars: 300,
      });
      expect(r.admitted.map((h) => h.id)).toEqual(['a', 'b']);
      expect(r.withheldBudget).toBe(1);
    });
  });

  it('applies the caller withhold between the floor and the budget, and counts it', () => {
    const r = admitRecallHits([hit('a', 0.9), hit('b', 0.8)], {
      withhold: (hs) => ({ kept: hs.filter((h) => h.id !== 'b'), withheld: [hs[1]] }),
    });
    expect(r.admitted.map((h) => h.id)).toEqual(['a']);
    expect(r.withheld).toBe(1);
  });

  it('every discard is COUNTED — a gate that drops a hit silently is how a blackout hides', () => {
    const r = admitRecallHits([hit('lo', 0.01), hit('w', 0.9, 100), hit('big', 0.8, 5000)], {
      degraded: true,
      scoreScale: 'cosine',
      budgetChars: 200,
      withhold: (hs) => ({ kept: hs.filter((h) => h.id !== 'w'), withheld: [hit('w', 0.9)] }),
    });
    expect(r.filteredLowScore).toBe(1); // floored
    expect(r.withheld).toBe(1); // caller policy
    expect(r.admitted.map((h) => h.id)).toEqual(['big']); // first-hit rule still admits one
    expect(r.withheldBudget).toBe(0);
  });

  it('exports the text cap the budget is charged against (canary must truncate identically)', () => {
    expect(MEMORY_TEXT_CAP).toBe(200);
  });
});

// ── P-008 / WI-4538: near-duplicate collapse ────────────────────────────────────────────────
// A limited recall budget was being spent on the SAME fact under multiple ids (coord:orient
// returned one owner directive 3× under 3 ids), crowding distinct facts out and then reporting
// "the memory budget is full". These tests pin the collapse AND its safety boundary: it must
// never fold two genuinely-distinct memories that merely share boilerplate.
describe('near-duplicate collapse — pure helpers', () => {
  it('normalizeForDedup lowercases, collapses whitespace, trims', () => {
    expect(normalizeForDedup('  The   QUICK\n brown ')).toBe('the quick brown');
  });

  it('jaccardSimilarity is a token-overlap ratio; two empty sets are identical', () => {
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(jaccardSimilarity(new Set(['a', 'b', 'c', 'd']), new Set(['a', 'b', 'c', 'e']))).toBeCloseTo(3 / 5);
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
    expect(jaccardSimilarity(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('isNearDuplicateText: exact-normalized-equal OR high token overlap; distinct stays distinct', () => {
    expect(isNearDuplicateText('Put yourself on AUTO mode', 'put yourself on auto mode')).toBe(true); // norm-equal
    expect(
      isNearDuplicateText(
        'the vitest 4 mock paradox note about hoisting and factory scope',
        'the vitest 4 mock paradox note about hoisting and the factory scope',
      ),
    ).toBe(true); // one-word paraphrase
    expect(
      isNearDuplicateText(
        '[owner verbatim] save the age benchmark for the next release',
        '[owner verbatim] flip the memory backend to hybrid-pg after review',
      ),
    ).toBe(false); // shared boilerplate, DIFFERENT directive → must not collapse
  });

  it('collapseNearDuplicates keeps the FIRST of each cluster and never folds empty-text items', () => {
    const { kept, droppedIndices } = collapseNearDuplicates(
      [
        { id: '1', t: 'alpha fact one two three' },
        { id: '2', t: 'ALPHA fact one two three' }, // dup of 1
        { id: '3', t: 'beta a different fact entirely here' },
        { id: '4', t: '' }, // empty — never collapsed
        { id: '5', t: '' }, // empty — never collapsed even against id4
      ],
      (x) => x.t,
    );
    expect(kept.map((x) => x.id)).toEqual(['1', '3', '4', '5']);
    expect(droppedIndices).toEqual([1]);
  });
});

describe('admitRecallHits — near-duplicate collapse gate', () => {
  const memHit = (id: string, memory: string, score = 0.9) => ({ id, memory, score });

  it('collapses exact-duplicate memories under different ids, keeping the highest-ranked', () => {
    const r = admitRecallHits([
      memHit('id1', 'put yourself on auto mode and continue the plan', 0.9),
      memHit('id2', 'put yourself on auto mode and continue the plan', 0.8), // same text, diff id
      memHit('id3', 'a completely different distinct fact about migrations', 0.7),
    ]);
    expect(r.admitted.map((h) => h.id)).toEqual(['id1', 'id3']);
    expect(r.collapsedDuplicates).toBe(1);
  });

  it('collapses near-paraphrases above the Jaccard threshold', () => {
    const r = admitRecallHits([
      memHit('id1', 'the vitest 4 mock paradox note about hoisting and factory scope', 0.9),
      memHit('id2', 'the vitest 4 mock paradox note about hoisting and the factory scope', 0.8),
    ]);
    expect(r.admitted.map((h) => h.id)).toEqual(['id1']);
    expect(r.collapsedDuplicates).toBe(1);
  });

  it('keeps genuinely distinct memories that merely share boilerplate framing', () => {
    const r = admitRecallHits([
      memHit('id1', '[owner 2026-07-11, verbatim] save the age benchmark for the next release', 0.9),
      memHit('id2', '[owner 2026-07-11, verbatim] flip the memory backend to hybrid-pg after review', 0.8),
    ]);
    expect(r.admitted.map((h) => h.id)).toEqual(['id1', 'id2']);
    expect(r.collapsedDuplicates).toBe(0);
  });

  it('collapses BEFORE the budget — the dupe must not crowd out a distinct fact', () => {
    const dup = 'the same owner directive repeated verbatim across three memory ids';
    const distinct = 'a genuinely distinct second fact worth keeping in budget';
    // Budget fits exactly two hits. If dedup ran AFTER the budget, slot 2 would go to the dupe
    // and the distinct fact would be crowded out (admitted would be ['a']); running it BEFORE
    // admits the distinct fact.
    const budgetChars = 2 * (dup.length + 25);
    const r = admitRecallHits(
      [
        memHit('a', dup, 0.9),
        memHit('b', dup, 0.85), // dupe of a
        memHit('c', distinct, 0.8),
      ],
      { budgetChars },
    );
    expect(r.admitted.map((h) => h.id)).toEqual(['a', 'c']);
    expect(r.collapsedDuplicates).toBe(1);
    expect(r.withheldBudget).toBe(0);
  });

  it('a threshold >= 1 disables the fuzzy match (exact-equality still collapses)', () => {
    const r = admitRecallHits(
      [
        memHit('id1', 'nearly the same sentence about caching behavior here', 0.9),
        memHit('id2', 'nearly the same sentence about caching behavior now', 0.8), // 1 word diff
      ],
      { dedupeThreshold: 1.01 },
    );
    expect(r.admitted).toHaveLength(2); // fuzzy off → the paraphrase is kept
    expect(r.collapsedDuplicates).toBe(0);
  });
});
