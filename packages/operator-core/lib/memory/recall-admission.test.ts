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
      const r = admitRecallHits(healthyRrf, { degraded: true });
      expect(r.admitted).toHaveLength(0);
      expect(r.filteredLowScore).toBe(3);
    });

    it('a hit with NO numeric score passes even when degraded (fail-open)', () => {
      const r = admitRecallHits([hit('a', undefined)], { degraded: true });
      expect(r.admitted).toHaveLength(1);
      expect(r.filteredLowScore).toBe(0);
    });

    it('a strong hit survives the floor when degraded', () => {
      const r = admitRecallHits([hit('a', MEMORY_SCORE_FLOOR), hit('b', 0.01)], { degraded: true });
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
