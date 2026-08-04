/**
 * The fact-cap victim ordering, as a pure function (EI-19451909636567773).
 *
 * ── WHY THIS IS ITS OWN MODULE ─────────────────────────────────────────────
 * `assertFact` needs to tell a writer where their OWN row landed in the victim
 * ranking ("is my fact next?"). The ranking itself lives in SQL, inside the
 * sweep's `ORDER BY`. Answering the writer's question means evaluating that
 * same ordering in TypeScript — which creates a MIRROR, and a mirror that can
 * drift from the thing it reflects is worse than no answer at all: it reports a
 * confident survival verdict the sweep then contradicts.
 *
 * Extracted here so the mirror is a NAMED, pure, directly-testable thing rather
 * than an anonymous comparator buried in a 2,000-line store. Two guards hold it
 * to the SQL, and they fail in different ways on purpose:
 *
 *   • `sweep-ranking.test.ts` (unit, no DB) pins the ordering against a
 *     deliberately-WRONG control implementation kept permanently in the test
 *     file. That control is what proves the assertions can fail at all — a
 *     guard that has never failed is a guard nobody has tested, and the repo
 *     rule is to prove it with a permanent control rather than by mutating
 *     production code in a shared tree.
 *   • `store.integration.test.ts` ("survival-ranking-matches-sweep") pins it
 *     against the REAL SQL: it predicts a victim from this function and then
 *     causes an actual eviction, asserting the row the sweep destroys is the
 *     row this function named. That is the only check that can catch the two
 *     drifting apart, because it runs both.
 *
 * ⚠ If you change the `ORDER BY` in `store.ts`'s eviction sweep, change this
 * function in the same edit. The integration guard will red if you do not.
 */

/** A `FactConfidence`-shaped value, kept loose so a raw DB row is accepted. */
type ConfidenceLike = string | null;

/**
 * The columns the sweep's `ORDER BY` reads. Deliberately snake_case: these are
 * raw DB rows, and re-mapping them would add a second place to make a mistake.
 */
export interface SweepRankableRow {
  id: string | number | null;
  confidence: ConfidenceLike;
  expires_at: string | Date;
  /**
   * Required since EI-19483432832662150: key 2 is a fraction of the DECLARED
   * TTL, and the declared TTL is only recoverable as `expires_at - created_at`.
   */
  created_at: string | Date;
  updated_at: string | Date;
}

/**
 * The confidence key, as the SQL `CASE` expression computes it.
 *
 * An UNSET confidence ranks WITH 'provisional' (1), not worst — most rows
 * predate the column, and ranking them worst would mass-evict the entire legacy
 * corpus on the next assert. This mirrors WI-6935 (c); see the sweep comment.
 */
export function sweepConfidenceRank(confidence: ConfidenceLike): number {
  return confidence === 'verified' ? 0 : confidence === 'suspected' ? 2 : 1;
}

const epochMs = (v: string | Date): number => new Date(v).getTime();

/**
 * Order rows MOST-valuable-first — the same order the sweep ranks victims in,
 * where the tail past the cap is what gets evicted.
 *
 * Mirrors, key for key:
 *   ORDER BY CASE confidence ... END ASC, expires_at DESC, updated_at DESC
 *
 * Returns a new array; the input is not mutated.
 *
 * ⚠ Exact three-key ties are ORDER-AMBIGUOUS in SQL (no total order is
 * specified), so this function does not invent a tiebreak to look more precise
 * than the thing it mirrors. Callers must treat a tied tail as "one of these
 * goes next", not "this exact one goes next".
 */
export function orderAsSweepWould<T extends SweepRankableRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const byConfidence = sweepConfidenceRank(a.confidence) - sweepConfidenceRank(b.confidence);
    if (byConfidence !== 0) return byConfidence;
    // DESC on both remaining keys: the later timestamp ranks first (survives).
    const byExpiry = epochMs(b.expires_at) - epochMs(a.expires_at);
    if (byExpiry !== 0) return byExpiry;
    return epochMs(b.updated_at) - epochMs(a.updated_at);
  });
}

/**
 * Where `id` sits in that ordering, 1-based; 0 when the id is not present.
 *
 * ⚠ Compares ids as STRINGS. `id` is a bigint column, so the driver may hand
 * back either a JS number or an exact-precision string, and a `===` across the
 * two silently never matches — which would report "not found" for every write
 * and make the whole survival signal quietly disappear rather than fail loudly.
 */
export function rankOfId(ordered: readonly SweepRankableRow[], id: string | number | null): number {
  if (id === null || id === undefined) return 0;
  const idx = ordered.findIndex((r) => String(r.id) === String(id));
  return idx + 1;
}
