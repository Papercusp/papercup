/**
 * Unit guards for the fact-cap victim ordering (EI-19451909636567773).
 *
 * ── HOW THIS FILE PROVES ITSELF ────────────────────────────────────────────
 * A guard test that has never failed is a guard nobody has tested. The repo
 * rule for a MODULE you import is to prove falsifiability with a deliberately
 * WRONG implementation kept permanently in the test file — never by mutating
 * production code, because this tree is shared and git-sync commits the whole
 * working tree every few minutes (EI-19450431506682666).
 *
 * So every property below is applied TWICE: once to the real
 * `orderAsSweepWould` (must hold) and once to each wrong control (must NOT
 * hold). The controls are what make a green run meaningful — without them,
 * these assertions would pass just as happily against an ordering that does
 * nothing at all.
 *
 * ⚠ These controls check that the ordering is SELF-CONSISTENT and matches the
 * intended key order. They CANNOT check that it matches the real SQL — nothing
 * here touches a database. That is `store.integration.test.ts`'s
 * "survival-ranking-matches-sweep", which predicts a victim from this function
 * and then asserts the sweep destroys exactly that row.
 *
 * ── WHY THERE ARE NOW TWO PROPERTIES (EI-19483432832662150) ────────────────
 * Key 2 changed from `expires_at DESC` to the remaining FRACTION of the
 * declared TTL. `assertMirrorsSweepOrdering` alone CANNOT detect that change:
 * on its fixture both orderings agree, so it would pass just as happily
 * against the ranking that caused the bug. `assertPrefersFresherFraction`
 * exists solely to separate them, and `expiryDescendingAbsolute` — the actual
 * pre-fix production ordering — is kept as a permanent control so a silent
 * revert reds instead of passing.
 */
import { describe, it, expect } from 'vitest';
import {
  orderAsSweepWould,
  outranksForSweep,
  rankOfId,
  sweepConfidenceRank,
  sweepRemainingFraction,
  type SweepRankableRow,
} from './sweep-ranking';

const at = (days: number): string => new Date(Date.UTC(2026, 0, 1) + days * 86400_000).toISOString();

/** The instant every ordering below is evaluated at. Key 2 is time-dependent. */
const NOW = new Date(at(0)).getTime();

/**
 * A fixture built so that EVERY ranking key is load-bearing: confidence
 * separates the groups, remaining-fraction orders within a group, and no two
 * rows tie. Expected most-valuable-first order is A, B, D, E, C.
 */
const ROWS: SweepRankableRow[] = [
  { id: 'C', confidence: 'suspected', created_at: at(-1), expires_at: at(90), updated_at: at(0) },
  { id: 'B', confidence: 'verified', created_at: at(-1), expires_at: at(2), updated_at: at(0) },
  { id: 'E', confidence: 'provisional', created_at: at(-1), expires_at: at(1), updated_at: at(0) },
  { id: 'A', confidence: 'verified', created_at: at(-1), expires_at: at(30), updated_at: at(0) },
  { id: 'D', confidence: null, created_at: at(-1), expires_at: at(10), updated_at: at(0) },
];
const EXPECTED = ['A', 'B', 'D', 'E', 'C'];

/**
 * The pair that separates a FRACTION of declared TTL from ABSOLUTE expiry —
 * the two orderings disagree here, and only here.
 *
 * This is the real 2026-08-04 incident in miniature: an urgent 7-day
 * operational fact written seconds ago, against a 90-day fact most of the way
 * through its life. Absolute expiry keeps the 90-day row (it expires later) and
 * destroys the fresh one; the fraction keeps the fresh one, which is the point
 * of the fix.
 */
const FRESH_SHORT: SweepRankableRow = {
  id: 'fresh-7d', // remaining 7d of a 7d TTL  → fraction 1.00
  confidence: 'verified',
  created_at: at(0),
  expires_at: at(7),
  updated_at: at(0),
};
const AGING_LONG: SweepRankableRow = {
  id: 'aging-90d', // remaining 10d of a 90d TTL → fraction 0.11, but a LATER expiry
  confidence: 'verified',
  created_at: at(-80),
  expires_at: at(10),
  updated_at: at(0),
};

type Orderer = (rows: readonly SweepRankableRow[], nowMs: number) => SweepRankableRow[];

// ── THE CONTROLS ───────────────────────────────────────────────────────────
// Each is a plausible way to get the mirror wrong: one per ranking key, plus a
// swapped key priority, plus the ordering this one REPLACED. If a property
// below stops rejecting the controls listed for it, that property has stopped
// discriminating and the guard is vacuous.

/** WRONG: expiry ascending — the soonest-expiring fact treated as safest. */
const expiryAscending: Orderer = (rows) =>
  [...rows].sort(
    (a, b) =>
      sweepConfidenceRank(a.confidence) - sweepConfidenceRank(b.confidence) ||
      new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime(),
  );

/** WRONG: confidence descending — a 'suspected' hedge outranking a 'verified' finding. */
const confidenceDescending: Orderer = (rows) =>
  [...rows].sort(
    (a, b) =>
      sweepConfidenceRank(b.confidence) - sweepConfidenceRank(a.confidence) ||
      new Date(b.expires_at).getTime() - new Date(a.expires_at).getTime(),
  );

/** WRONG: TTL consulted before confidence — the documented key order inverted. */
const expiryBeforeConfidence: Orderer = (rows) =>
  [...rows].sort(
    (a, b) =>
      new Date(b.expires_at).getTime() - new Date(a.expires_at).getTime() ||
      sweepConfidenceRank(a.confidence) - sweepConfidenceRank(b.confidence),
  );

/**
 * WRONG, AND HISTORICALLY REAL: absolute `expires_at DESC` — the exact
 * production ordering before EI-19483432832662150. Kept permanently so that
 * reverting key 2 to absolute expiry fails loudly instead of passing.
 */
const expiryDescendingAbsolute: Orderer = (rows) =>
  [...rows].sort(
    (a, b) =>
      sweepConfidenceRank(a.confidence) - sweepConfidenceRank(b.confidence) ||
      new Date(b.expires_at).getTime() - new Date(a.expires_at).getTime() ||
      new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  );

/** WRONG: no ordering at all — the vacuity case a weak property would accept. */
const identity: Orderer = (rows) => [...rows];

/** Property 1: the documented key ORDER (confidence first, then key 2, then updated_at). */
function assertMirrorsSweepOrdering(order: Orderer): void {
  expect(order(ROWS, NOW).map((r) => r.id)).toEqual(EXPECTED);
}

/** Property 2: key 2 is a FRACTION of declared TTL, not an absolute expiry. */
function assertPrefersFresherFraction(order: Orderer): void {
  // Input deliberately puts the wrong answer first, so a no-op ordering fails.
  expect(order([AGING_LONG, FRESH_SHORT], NOW).map((r) => r.id)).toEqual(['fresh-7d', 'aging-90d']);
}

describe('orderAsSweepWould — the mirror of the cap sweep ORDER BY', () => {
  it('ranks by confidence, then remaining TTL fraction, most-valuable first', () => {
    expect(() => assertMirrorsSweepOrdering(orderAsSweepWould)).not.toThrow();
  });

  // ── falsifiability: the same property must REJECT each wrong ordering ────
  it.each([
    ['expiry ascending', expiryAscending],
    ['confidence descending', confidenceDescending],
    ['expiry consulted before confidence', expiryBeforeConfidence],
    ['no ordering applied at all', identity],
  ])('CONTROL — the key-order property REJECTS %s', (_label, wrong) => {
    expect(() => assertMirrorsSweepOrdering(wrong as Orderer)).toThrow();
  });

  it('keeps a FRESH short-TTL fact over an AGING long-TTL one with a later expiry', () => {
    // The regression guard for EI-19483432832662150. Measured on the live
    // scope 2026-08-04T01:19Z: an urgent 7-day operational fact was evicted
    // FIFTEEN SECONDS after it was written, because a 90-day incumbent held a
    // later absolute expiry. Under a fraction the fresh row outranks it.
    expect(() => assertPrefersFresherFraction(orderAsSweepWould)).not.toThrow();
  });

  it.each([
    ['absolute expires_at DESC (the pre-fix production ordering)', expiryDescendingAbsolute],
    ['confidence descending (falls through to absolute expiry)', confidenceDescending],
    ['no ordering applied at all', identity],
  ])('CONTROL — the fraction property REJECTS %s', (_label, wrong) => {
    expect(() => assertPrefersFresherFraction(wrong as Orderer)).toThrow();
  });

  it('an UNSET confidence ranks WITH provisional, not worst — legacy rows must not mass-evict', () => {
    // The whole legacy corpus predates the column. Ranking unset worst would
    // make the next assert into any scope evict all of it at once.
    expect(sweepConfidenceRank(null)).toBe(sweepConfidenceRank('provisional'));
    expect(sweepConfidenceRank(null)).toBeLessThan(sweepConfidenceRank('suspected'));
  });

  it('breaks an exact fraction tie on updated_at DESC, matching the SQL third key', () => {
    // Same created_at AND same expires_at ⇒ identical fraction, so the third
    // key is the only thing left to separate them.
    const tied: SweepRankableRow[] = [
      { id: 'older', confidence: 'verified', created_at: at(0), expires_at: at(5), updated_at: at(1) },
      { id: 'newer', confidence: 'verified', created_at: at(0), expires_at: at(5), updated_at: at(3) },
    ];
    expect(orderAsSweepWould(tied, NOW).map((r) => r.id)).toEqual(['newer', 'older']);
  });

  it('is TIME-DEPENDENT: the short-TTL row yields its slot only at the END of its life', () => {
    // Not a curiosity — it is the mechanism by which a short-lived fact serves
    // its purpose and then yields, and it is why `nowMs` is a real input rather
    // than a convenience.
    //
    // Both rows age together, so the crossover is later than it looks. Solving
    // (7-t)/7 < (10-t)/90  gives  t > 6.75 days: the fresh 7-day row outranks
    // the aging 90-day one for ~96% of its life, then hands the slot over.
    // At six days it is still ahead (0.143 vs 0.044) — an earlier draft of this
    // test asserted the opposite and was wrong.
    expect(orderAsSweepWould([AGING_LONG, FRESH_SHORT], NOW)[0].id).toBe('fresh-7d');
    expect(orderAsSweepWould([AGING_LONG, FRESH_SHORT], new Date(at(6)).getTime())[0].id).toBe(
      'fresh-7d',
    );
    expect(orderAsSweepWould([AGING_LONG, FRESH_SHORT], new Date(at(6.9)).getTime())[0].id).toBe(
      'aging-90d',
    );
  });

  it('does not mutate its input — the caller still holds the DB row order', () => {
    const before = ROWS.map((r) => r.id);
    orderAsSweepWould(ROWS, NOW);
    expect(ROWS.map((r) => r.id)).toEqual(before);
  });
});

describe('sweepRemainingFraction', () => {
  it('is ~1 for a just-written fact and ~0 for one about to expire', () => {
    expect(sweepRemainingFraction(FRESH_SHORT, NOW)).toBeCloseTo(1, 5);
    expect(sweepRemainingFraction(AGING_LONG, new Date(at(10)).getTime())).toBeCloseTo(0, 5);
  });

  it('is TTL-neutral: two facts equally far through their lives score equally', () => {
    // This is the property that removes the "a long TTL buys a slot" arbitrage.
    const halfOfSevenDays: SweepRankableRow = {
      id: 'short', confidence: 'verified', created_at: at(-3.5), expires_at: at(3.5), updated_at: at(0),
    };
    const halfOfNinetyDays: SweepRankableRow = {
      id: 'long', confidence: 'verified', created_at: at(-45), expires_at: at(45), updated_at: at(0),
    };
    expect(sweepRemainingFraction(halfOfSevenDays, NOW)).toBeCloseTo(
      sweepRemainingFraction(halfOfNinetyDays, NOW),
      5,
    );
  });

  it('survives a degenerate zero-length TTL instead of dividing by zero', () => {
    const degenerate: SweepRankableRow = {
      id: 'zero', confidence: 'verified', created_at: at(0), expires_at: at(0), updated_at: at(0),
    };
    expect(Number.isFinite(sweepRemainingFraction(degenerate, NOW))).toBe(true);
  });
});

describe('rankOfId — locating the written row in that ordering', () => {
  const ordered = orderAsSweepWould(ROWS, NOW);

  it('is 1-based, so rank 1 is the safest row', () => {
    expect(rankOfId(ordered, 'A')).toBe(1);
    expect(rankOfId(ordered, 'C')).toBe(ordered.length);
  });

  it('matches a NUMERIC id against a STRING row id — the bigint driver trap', () => {
    // `id` is a bigint column: the driver may return a JS number OR an
    // exact-precision string. A `===` across the two silently never matches,
    // which would report "not found" for every write and make the survival
    // signal vanish quietly instead of failing loudly.
    const numeric: SweepRankableRow[] = [
      { id: '4339', confidence: 'verified', created_at: at(-1), expires_at: at(9), updated_at: at(0) },
    ];
    expect(rankOfId(numeric, 4339)).toBe(1);
    expect(rankOfId(numeric, '4339')).toBe(1);
  });

  it('returns 0 for an absent or null id rather than a misleading rank', () => {
    expect(rankOfId(ordered, 'not-here')).toBe(0);
    expect(rankOfId(ordered, null)).toBe(0);
  });
});

/**
 * EI-21585375376448939 — the cross-author cap guard's one question.
 *
 * The guard picks its victim at OFFSET cap-1, i.e. the WORST-ranked row in the
 * scope, then refuses when that row is verified and belongs to someone else.
 * On a scope that has saturated with a 100%-verified population (the measured
 * steady state: 200/200 verified across 123-130 distinct authors), that test
 * matches for essentially every author, so the rail stops protecting one fact
 * and becomes a scope-wide WRITE LOCK.
 *
 * `outranksForSweep` is what lets the guard ask the question it should have
 * been asking — "is this write actually better than what it displaces?" — so
 * these cases pin the answer, and each is paired with a wrong control that
 * would re-open the lock or open it too far.
 */
describe('outranksForSweep — is the incoming fact better than the row it displaces?', () => {
  /** A fresh write: created now, so key 2 scores ~1.0, the maximum it can produce. */
  const incoming = (confidence: string | null, ttlDays: number): SweepRankableRow => ({
    id: null,
    confidence,
    created_at: at(0),
    expires_at: at(ttlDays),
    updated_at: at(0),
  });

  /**
   * The real victim shape: verified, but chosen precisely BECAUSE it is closest
   * to natural death — here ~13% of its declared life left, matching the
   * survivingFractionFloor measured live on the saturated workspace scope.
   */
  const nearDeathVerified: SweepRankableRow = {
    id: 'victim',
    confidence: 'verified',
    created_at: at(-7),
    expires_at: at(1),
    updated_at: at(-7),
  };

  it('a fresh VERIFIED write outranks a verified victim that is nearly expired', () => {
    // This is the exact case the guard refused: the store's own survival.rank
    // reported rank 1 of 200 (nextVictim false) for this write, while the row
    // it would displace ranked last. Refusing it protected the worst fact in
    // the scope by rejecting the best one.
    expect(outranksForSweep(incoming('verified', 90), nearDeathVerified, NOW)).toBe(true);
  });

  it('a PROVISIONAL write does NOT outrank a verified victim, however long its TTL', () => {
    // Key 1 dominates, so a weaker claim cannot buy its way past a stronger one
    // with a longer TTL — the protection the rail exists to provide is intact.
    expect(outranksForSweep(incoming('provisional', 90), nearDeathVerified, NOW)).toBe(false);
    expect(outranksForSweep(incoming(null, 90), nearDeathVerified, NOW)).toBe(false);
    expect(outranksForSweep(incoming('suspected', 90), nearDeathVerified, NOW)).toBe(false);
  });

  it('is STRICT: an exact tie keeps the refusal rather than favouring the writer', () => {
    // The SQL ordering specifies no total order, so tied rows are "one of these
    // goes next", not a decidable winner. A guard must read that as "no better
    // than" and decline to displace.
    const twin: SweepRankableRow = { ...nearDeathVerified, id: 'twin' };
    expect(outranksForSweep({ ...twin, id: null }, twin, NOW)).toBe(false);
  });

  it('agrees with orderAsSweepWould — the ordering and the pairwise test are one rule', () => {
    // The whole reason this lives beside the ordering: if the two ever disagree,
    // the guard refuses writes the sweep would have kept (or the reverse).
    for (const row of ROWS) {
      for (const conf of ['verified', 'provisional', 'suspected', null] as const) {
        const cand = incoming(conf, 30);
        const [first] = orderAsSweepWould([{ ...row }, { ...cand, id: '__cand__' }], NOW);
        expect(outranksForSweep(cand, row, NOW)).toBe(String(first?.id) === '__cand__');
      }
    }
  });

  // ── falsifiability: each control is a plausible way to get this wrong ──────
  // A control that stops being rejected means the property it pins has died.
  it.each([
    [
      'a NON-STRICT comparison (ties favour the writer) — would let a tied write evict',
      (c: SweepRankableRow, i: SweepRankableRow): boolean => !outranksForSweep(i, c, NOW),
    ],
    [
      'ignoring confidence (TTL only) — would let a suspected write evict a verified fact',
      (c: SweepRankableRow, i: SweepRankableRow): boolean =>
        sweepRemainingFraction(c, NOW) > sweepRemainingFraction(i, NOW),
    ],
  ])('CONTROL — %s disagrees with the real rule', (_label, wrong) => {
    const twin: SweepRankableRow = { ...nearDeathVerified, id: 'twin' };
    const cases: [SweepRankableRow, SweepRankableRow][] = [
      [incoming('suspected', 90), nearDeathVerified],
      [{ ...twin, id: null }, twin],
    ];
    // At least one case must diverge, or the control is not actually wrong and
    // this suite would pass against a broken implementation.
    expect(
      cases.some(([cand, inc]) => wrong(cand, inc) !== outranksForSweep(cand, inc, NOW)),
    ).toBe(true);
  });
});
