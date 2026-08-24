/**
 * spec-reconciliation-legacy-val-pattern.integration.test.ts
 *
 * Pins LEGACY_VAL_TEXT_PATTERN against a REAL Postgres regex engine.
 *
 * WHY THIS NEEDS REAL PG: the pattern uses `\m` (a Postgres word-START anchor). JavaScript's
 * RegExp has no such construct, so a JS-only assertion would either not compile the pattern
 * or would silently test different semantics than production. The detector runs inside a
 * SQL `~` predicate, so the only honest oracle is Postgres itself.
 *
 * WHY IT EXISTS AT ALL (measured 2026-08-24): the first cut of this detector was
 * `VAL-[0-9]`, which is wrong in BOTH directions, and both failures are silent:
 *
 *   · too narrow — misses plan-scoped ids (`VAL-<slug>-001`, a LETTER after the dash), which
 *     hid an ACTIVE zero-clause plan (universal-schema-2026-05-30) behind the
 *     `no-behavior-declared` state. That is the silent waiver the ledger exists to prevent.
 *   · too broad (if naively widened to a bare `VAL-` substring) — would match inside `EVAL-`
 *     and `RETRIEVAL-`, manufacturing legacy signal from unrelated prose.
 *
 * Both directions are load-bearing, and both were MEASURED over all 1,391 live plans
 * (2026-08-24): the naive `VAL-` substring flags 16 plans where the anchored pattern flags
 * 9. Of those seven false positives, ONE comes from the word-anchor
 * (`bettor-evaluation-framework-2026-06-25`, via `EVAL-FRAMEWORK`) and SIX from requiring an
 * id character after the dash (shipped plans that merely discuss the `VAL-` convention in
 * prose). So the negative cases below are not hypothetical hygiene — each guards a
 * misclassification that a careless widening would actually produce today.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { getTestPg } from '@papercusp/test-config/pg';

import { LEGACY_VAL_TEXT_PATTERN } from './spec-reconciliation';

let sql: postgres.Sql;

beforeAll(async () => {
  const uri = await getTestPg();
  sql = postgres(uri, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/** Evaluate the production pattern through Postgres' own `~` operator. */
const matches = async (text: string): Promise<boolean> => {
  const [row] = await sql<{ m: boolean }[]>`
    SELECT ${text}::text ~ ${LEGACY_VAL_TEXT_PATTERN}::text AS m`;
  return row.m;
};

describe('LEGACY_VAL_TEXT_PATTERN', () => {
  describe('MUST detect (missing these re-creates the silent waiver)', () => {
    const positives: [string, string][] = [
      ['plan-scoped id — the case the original pattern missed', '[VAL-production-readiness-acceptance-2026-06-10-001]'],
      ['plan-scoped id, bare in prose', 'covered by VAL-universal-schema-2026-05-30-004 today'],
      ['bare numeric reference', 'see VAL-028 also'],
      ['numeric-segmented id', 'VAL-007-01'],
      ['at the very start of the text', 'VAL-001 opens this plan'],
    ];
    for (const [label, text] of positives) {
      it(label, async () => {
        expect(await matches(text)).toBe(true);
      });
    }
  });

  describe('MUST NOT detect (missing these manufactures legacy signal)', () => {
    const negatives: [string, string][] = [
      ['EVAL- with a digit — the naive-widening trap', 'the EVAL-1 optimizer'],
      ['EVAL- inside a slug', 'harness-gym-EVAL-optimizer'],
      // A REAL corpus instance, not a constructed one: this token is why
      // bettor-evaluation-framework-2026-06-25 would be misflagged by a bare `VAL-` substring.
      ['EVAL-FRAMEWORK — the live false positive the anchor excludes', 'see the EVAL-FRAMEWORK notes'],
      ['RETRIEVAL- with a digit', 'RETRIEVAL-2 thing'],
      ['lowercase word containing val-', 'interval-based backoff'],
      ['VAL- with no id character after the dash', 'a bare VAL- and nothing else'],
    ];
    for (const [label, text] of negatives) {
      it(label, async () => {
        expect(await matches(text)).toBe(false);
      });
    }
  });

  it('is anchored at a word start rather than matching any VAL- substring', async () => {
    // The distinguishing pair: identical trailing text, differing only by a leading letter.
    expect(await matches('VAL-9')).toBe(true);
    expect(await matches('EVAL-9')).toBe(false);
  });
});
