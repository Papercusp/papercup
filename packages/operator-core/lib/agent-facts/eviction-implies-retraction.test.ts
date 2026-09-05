import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * EI-19445602578296984 — the recurrence guard for a CONFIDENT-WRONG-NUMBER class.
 *
 * The filed complaint was that counting standing facts naively (`expires_at > now()`)
 * over-reports the FOLDABLE population, because evicted / retracted / superseded rows
 * persist as audit records. Measured when filed: 925 vs 53 (~17x). Measured again on
 * 2026-09-05 against `harness:papercusp`: 628 naive vs 370 foldable (~1.7x). The gap
 * shrank but never closed, and its direction is the expensive one — a big number reads
 * as "loads of headroom, assert freely", which is how the filing agent came to assert a
 * `confidence:'verified'` fact stating the exact opposite of the truth.
 *
 * That is fixed: `facts:list` now reports `total` unconditionally from `countLiveFacts`,
 * which counts under `liveFactPredicate` — the fold's OWN predicate — so the shipped
 * census is the foldable count by construction.
 *
 * But its correctness rests on an invariant that was, until this file, both UNSTATED and
 * UNTESTED. Note what `liveFactPredicate` does NOT say:
 *
 *     AND superseded_at IS NULL
 *     AND retracted_at IS NULL AND expires_at > now()
 *
 * There is no `evicted_at IS NULL` term. It is nonetheless correct, because the single
 * eviction statement stamps `retracted_at` ALONGSIDE `evicted_at`, making evicted rows a
 * SUBSET of retracted ones. Verified empirically at the same time as the counts above:
 * rows with `evicted_at IS NOT NULL AND retracted_at IS NULL` numbered exactly 0, and the
 * fold predicate and the item's own hand-written "correct" query returned an identical
 * 370.
 *
 * So the census depends on a two-link chain, and BOTH links are invisible at the call
 * site:
 *
 *   1. eviction stamps `retracted_at` too  ⇒  evicted ⊆ retracted
 *   2. `liveFactPredicate` excludes retracted rows
 *
 * Break either link — make eviction stamp only `evicted_at`, or drop the `retracted_at`
 * term from the predicate — and the census silently resumes counting rows that will never
 * be folded again. Nothing throws. No existing test fails: the census tests in
 * `agent-tools/facts/list-census-disclosure.test.ts` MOCK `countLiveFacts`, so they cover
 * the disclosure plumbing and are blind to the predicate, and `store.test.ts` mentions
 * "evict" 14 times and "retracted" not once. The failure would resurface as a plausible,
 * larger number — the same shape as the original bug, which is precisely the shape that
 * does not announce itself.
 *
 * This guard is source-level on purpose. The invariant is a property of the SQL text
 * (which columns one UPDATE writes together), so reading the statement is a more direct
 * falsifier than a fixture round-trip, and it needs no database.
 */

/**
 * The subject is overridable so falsifiability can be proven against a COPY outside the
 * tree. This checkout is swept by git-sync every few minutes, so mutating `store.ts` in
 * place to watch the guard fail can get the mutant COMMITTED even when nothing goes wrong
 * and no handler fails — a race no `trap` closes. This one line is what keeps the probe
 * on the safe tier: `scripts/mutation-probe.sh --file <store.ts> --test 'FACTS_STORE_SRC={} …'`.
 */
const STORE_SRC = readFileSync(
  process.env.FACTS_STORE_SRC ?? new URL('./store.ts', import.meta.url),
  'utf8',
);

/**
 * Every `SET ... WHERE` clause in the file, as its assignment body.
 *
 * Scoping to the SET body is what keeps a comparison (`evicted_at IS NOT NULL` in a
 * WHERE, of which there are several) from being mistaken for a write.
 */
function setClauses(src: string): string[] {
  return [...src.matchAll(/\bSET\b([\s\S]*?)\bWHERE\b/g)].map((m) => m[1]);
}

const assigns = (clause: string, column: string): boolean =>
  new RegExp(`\\b${column}\\s*=`).test(clause);

describe('cap-eviction implies retraction (the invariant the foldable-fact census rests on)', () => {
  it('CALIBRATION: the parser still finds a statement that writes evicted_at', () => {
    // Without this, every assertion below passes vacuously the moment the eviction
    // statement is renamed, reformatted across lines, or moved to another module — a
    // guard that measured nothing, reporting green. It is the positive control for the
    // whole file, so it is asserted rather than assumed.
    const writers = setClauses(STORE_SRC).filter((c) => assigns(c, 'evicted_at'));

    expect(
      writers.length,
      'No SET clause in store.ts writes evicted_at. Either cap-eviction moved out of ' +
        'this module (move this guard with it) or the parser above no longer matches ' +
        'the statement — do NOT delete this test to make it pass.',
    ).toBeGreaterThan(0);
  });

  it('LINK 1: every statement that stamps evicted_at also stamps retracted_at', () => {
    for (const clause of setClauses(STORE_SRC).filter((c) => assigns(c, 'evicted_at'))) {
      expect(
        assigns(clause, 'retracted_at'),
        'A statement stamps evicted_at WITHOUT retracted_at:\n\n' +
          `    SET ${clause.trim()}\n\n` +
          'That breaks evicted ⊆ retracted, which is the only reason liveFactPredicate ' +
          'may omit an `evicted_at IS NULL` term. Cap-evicted rows would start counting ' +
          'as live: facts:list `total` and facts:assert `survival.liveCount` would both ' +
          'over-report, in the direction that reads as spare headroom (EI-19445602578296984). ' +
          'Either stamp retracted_at here too, or add `evicted_at IS NULL` to ' +
          'liveFactPredicate and update LINK 2 below.',
      ).toBe(true);
    }
  });

  it('LINK 2: liveFactPredicate excludes retracted rows, or filters evicted ones directly', () => {
    const predicate = /function liveFactPredicate[\s\S]*?\n}/.exec(STORE_SRC)?.[0];

    expect(
      predicate,
      'liveFactPredicate not found in store.ts — the census predicate moved; re-point ' +
        'this guard at it rather than dropping the check.',
    ).toBeDefined();

    const excludesRetracted = /retracted_at\s+IS\s+NULL/.test(predicate!);
    const excludesEvicted = /evicted_at\s+IS\s+NULL/.test(predicate!);

    expect(
      excludesRetracted || excludesEvicted,
      'liveFactPredicate filters neither retracted_at nor evicted_at, so cap-evicted ' +
        'facts now count as live. This is the counting bug of EI-19445602578296984 ' +
        'reintroduced at the predicate instead of at the caller: countLiveFacts backs ' +
        'the facts:list census AND facts:assert survival.liveCount, so both would ' +
        'over-report at once.',
    ).toBe(true);
  });
});
