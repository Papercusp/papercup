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
 */
import { describe, it, expect } from 'vitest';
import { orderAsSweepWould, rankOfId, sweepConfidenceRank, type SweepRankableRow } from './sweep-ranking';

const at = (days: number): string => new Date(Date.UTC(2026, 0, 1) + days * 86400_000).toISOString();

/**
 * A fixture built so that EVERY ranking key is load-bearing: confidence
 * separates the groups, expiry orders within a group, and no two rows tie.
 * Expected most-valuable-first order is A, B, D, E, C.
 */
const ROWS: SweepRankableRow[] = [
  { id: 'C', confidence: 'suspected', expires_at: at(90), updated_at: at(0) },
  { id: 'B', confidence: 'verified', expires_at: at(2), updated_at: at(0) },
  { id: 'E', confidence: 'provisional', expires_at: at(1), updated_at: at(0) },
  { id: 'A', confidence: 'verified', expires_at: at(30), updated_at: at(0) },
  { id: 'D', confidence: null, expires_at: at(10), updated_at: at(0) },
];
const EXPECTED = ['A', 'B', 'D', 'E', 'C'];

type Orderer = (rows: readonly SweepRankableRow[]) => SweepRankableRow[];

// ── THE CONTROLS ───────────────────────────────────────────────────────────
// Each is a plausible way to get the mirror wrong: one per ranking key, plus a
// swapped key priority. If the property below stops rejecting ANY of these, the
// property has stopped discriminating and the guard is vacuous.

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

/** WRONG: no ordering at all — the vacuity case a weak property would accept. */
const identity: Orderer = (rows) => [...rows];

/** The property every correct mirror of the sweep's ORDER BY must satisfy. */
function assertMirrorsSweepOrdering(order: Orderer): void {
  expect(order(ROWS).map((r) => r.id)).toEqual(EXPECTED);
}

describe('orderAsSweepWould — the mirror of the cap sweep ORDER BY', () => {
  it('ranks by confidence, then TTL descending, most-valuable first', () => {
    expect(() => assertMirrorsSweepOrdering(orderAsSweepWould)).not.toThrow();
  });

  // ── falsifiability: the same property must REJECT each wrong ordering ────
  it.each([
    ['expiry ascending', expiryAscending],
    ['confidence descending', confidenceDescending],
    ['expiry consulted before confidence', expiryBeforeConfidence],
    ['no ordering applied at all', identity],
  ])('CONTROL — the property REJECTS %s', (_label, wrong) => {
    expect(() => assertMirrorsSweepOrdering(wrong as Orderer)).toThrow();
  });

  it('an UNSET confidence ranks WITH provisional, not worst — legacy rows must not mass-evict', () => {
    // The whole legacy corpus predates the column. Ranking unset worst would
    // make the next assert into any scope evict all of it at once.
    expect(sweepConfidenceRank(null)).toBe(sweepConfidenceRank('provisional'));
    expect(sweepConfidenceRank(null)).toBeLessThan(sweepConfidenceRank('suspected'));
  });

  it('breaks an exact TTL tie on updated_at DESC, matching the SQL third key', () => {
    const tied: SweepRankableRow[] = [
      { id: 'older', confidence: 'verified', expires_at: at(5), updated_at: at(1) },
      { id: 'newer', confidence: 'verified', expires_at: at(5), updated_at: at(3) },
    ];
    expect(orderAsSweepWould(tied).map((r) => r.id)).toEqual(['newer', 'older']);
  });

  it('does not mutate its input — the caller still holds the DB row order', () => {
    const before = ROWS.map((r) => r.id);
    orderAsSweepWould(ROWS);
    expect(ROWS.map((r) => r.id)).toEqual(before);
  });
});

describe('rankOfId — locating the written row in that ordering', () => {
  const ordered = orderAsSweepWould(ROWS);

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
      { id: '4339', confidence: 'verified', expires_at: at(9), updated_at: at(0) },
    ];
    expect(rankOfId(numeric, 4339)).toBe(1);
    expect(rankOfId(numeric, '4339')).toBe(1);
  });

  it('returns 0 for an absent or null id rather than a misleading rank', () => {
    expect(rankOfId(ordered, 'not-here')).toBe(0);
    expect(rankOfId(ordered, null)).toBe(0);
  });
});
