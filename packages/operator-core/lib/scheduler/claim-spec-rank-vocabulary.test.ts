/**
 * claim-spec-rank-vocabulary.test.ts — which fields may be a RANK term, and why the
 * answer is not "all of the filterable ones".
 *
 * WHY THIS EXISTS. `RANKABLE_ITEM_FIELDS` is derived by SUBTRACTION from
 * `FILTERABLE_ITEM_FIELDS`, so every field added to the vocabulary becomes rankable
 * AUTOMATICALLY, and the compiler's failure mode for a bad rank term is never a loud
 * one. Two distinct silent failures live in that gap; both are pinned here.
 *
 *  1. LEXICAL INVERSION (EI-19286311763526137, and WI-6675 before it). A TEXT column
 *     sorts as text. `severity desc` orders nit > minor > major > critical — backwards,
 *     while reading as though it prioritizes criticals. `risk_tier` is the same shape:
 *     it lives in `payload` jsonb, so `payload->>'risk_tier'` is TEXT however numeric
 *     the authored tier looks, and a bare sort puts '10' ahead of '2'. When severity was
 *     excluded, risk_tier was explicitly left as "the next domino"; this is that domino.
 *
 *  2. THE WEIGHTED CAST ERROR (found 2026-08-01 while verifying #1). `weighted` mode
 *     compiles Σ wᵢ·termᵢ and casts EVERY term to `::numeric`. On a non-numeric column
 *     that is not a mis-sort — it is a hard Postgres error that aborts the whole claim
 *     query, from a spec that VALIDATED. Measured against the live tables:
 *       (source_plan_item_ids)::numeric     ⇒ cannot cast type text[] to numeric
 *       (COALESCE(item_kind,kind))::numeric ⇒ invalid input syntax for type numeric: "feature"
 *     The text legs are worse: they cast fine while the column is NULL and start erroring
 *     the moment a row carries data — green on an empty fixture, red in production.
 *     4 live specs rank on `plan_item` today (lexicographic, so they are fine); flipping
 *     one to `weighted` was a ONE-WORD edit away from that error.
 *
 * Both are closed the same way severity was: REJECT at validation rather than accept and
 * neutralize. An unknown rank head compiles to NEUTRAL in get-next.ts's compileRankExpr,
 * so "accept it and do nothing" is itself one of the silent failures, not a safe default.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CLAIM_SPEC,
  FILTERABLE_ITEM_FIELDS,
  NUMERIC_ITEM_FIELDS,
  RANKABLE_ITEM_FIELDS,
  validateClaimSpec,
  type ClaimSpec,
} from './claim-spec';

function specWithRank(mode: 'lexicographic' | 'weighted', terms: unknown[], specId = 'rank-vocab'): ClaimSpec {
  return { ...DEFAULT_CLAIM_SPEC, specId, rank: { mode, terms } } as unknown as ClaimSpec;
}

describe('risk_tier is filterable but NOT rankable (EI-19286311763526137)', () => {
  it('is excluded from RANKABLE_ITEM_FIELDS while staying filterable', () => {
    expect(FILTERABLE_ITEM_FIELDS).toContain('risk_tier');
    expect(RANKABLE_ITEM_FIELDS).not.toContain('risk_tier');
  });

  it('REJECTS `rank: [{ expr: risk_tier }]` instead of sorting lexically', () => {
    const result = validateClaimSpec(specWithRank('lexicographic', [{ expr: 'risk_tier', dir: 'asc' }]));
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('risk_tier');
  });

  it('still ACCEPTS risk_tier as a filter — the only way it has ever been used', () => {
    // Regression guard on the scope of the fix: 0 of 292 live specs rank on risk_tier,
    // but the filter form is part of the documented grammar and must keep validating.
    const spec = {
      ...DEFAULT_CLAIM_SPEC,
      specId: 'risk-filtered',
      view: { filter: { field: 'risk_tier', op: '<=', value: 2 } },
    } as unknown as ClaimSpec;
    expect(validateClaimSpec(spec).ok).toBe(true);
  });

  it('the lexical order a bare risk_tier sort WOULD have produced is in fact wrong', () => {
    // Pins the premise as arithmetic rather than assertion, both ways the field is authored:
    // numeric-looking tiers sort by digit string, and word tiers sort alphabetically.
    expect(['1', '2', '3', '10'].sort()).toEqual(['1', '10', '2', '3']);
    expect(['high', 'low', 'medium'].sort()).toEqual(['high', 'low', 'medium']);
  });
});

describe('weighted rank requires numerically-orderable terms (the ::numeric cast error)', () => {
  it('every NUMERIC_ITEM_FIELDS member is rankable — the allowlist is a subset, not a rival list', () => {
    for (const f of NUMERIC_ITEM_FIELDS) expect(RANKABLE_ITEM_FIELDS).toContain(f);
  });

  it.each(['plan_item', 'kind', 'assignee', 'plan', 'tags', 'paths'])(
    'REJECTS weighted rank on the non-numeric field %s',
    (field) => {
      const result = validateClaimSpec(specWithRank('weighted', [{ expr: field, dir: 'desc', weight: 1 }]));
      expect(result.ok).toBe(false);
      expect(result.errors.join(' ')).toContain('numerically-orderable');
    },
  );

  it.each([...NUMERIC_ITEM_FIELDS])('ACCEPTS weighted rank on the numeric field %s', (field) => {
    const result = validateClaimSpec(specWithRank('weighted', [{ expr: field, dir: 'desc', weight: 1 }]));
    expect(result.ok).toBe(true);
  });

  it('ACCEPTS a weighted affinity() term — functions are exempt by construction', () => {
    // affinity compiles to a count(); the descoped heads compile to NEUTRAL and are
    // dropped before the cast. Neither can produce the error the rule exists to stop.
    const result = validateClaimSpec(
      specWithRank('weighted', [
        { expr: 'affinity(bee.held_paths,item.paths)', dir: 'desc', weight: 2 },
        { expr: 'priority', dir: 'desc', weight: 1 },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it('leaves LEXICOGRAPHIC ranking on a non-numeric field alone — 4 live specs rank on plan_item', () => {
    // The cast only exists in weighted mode. ORDER BY on a text/array column is
    // well-defined, so narrowing lexicographic too would have broken live lanes for no
    // safety gain. This is the blast-radius guard for that decision.
    const result = validateClaimSpec(specWithRank('lexicographic', [{ expr: 'plan_item', dir: 'asc' }]));
    expect(result.ok).toBe(true);
  });

  it('reports an unknown weighted term ONCE, as unknown — not also as non-numeric', () => {
    // Two errors for one typo reads as two problems. The numeric rule defers to the
    // unknown-head error, which is the actionable one.
    const result = validateClaimSpec(specWithRank('weighted', [{ expr: 'severity_rank', dir: 'desc', weight: 1 }]));
    expect(result.ok).toBe(false);
    expect(result.errors.filter((e) => e.includes('rank.terms[0]'))).toHaveLength(1);
    expect(result.errors.join(' ')).toContain('unknown rank term');
  });
});

describe('the shipped default spec is unaffected', () => {
  it('DEFAULT_CLAIM_SPEC still validates', () => {
    expect(validateClaimSpec({ ...DEFAULT_CLAIM_SPEC }).ok).toBe(true);
  });
});
