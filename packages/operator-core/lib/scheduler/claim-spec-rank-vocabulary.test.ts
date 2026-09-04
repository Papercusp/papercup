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
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CLAIM_SPEC,
  FILTERABLE_ITEM_FIELDS,
  NUMERIC_ITEM_FIELDS,
  RANKABLE_ITEM_FIELDS,
  RANK_FUNCTIONS,
  validateClaimSpec,
  type ClaimSpec,
} from './claim-spec';

const GET_NEXT_SOURCE = readFileSync(new URL('./get-next.ts', import.meta.url), 'utf8');

function requiredSourceSpan(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end <= start) throw new Error(`missing source marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

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

describe('severity_rank is the ORDINAL severity term (EI-19286355119013384)', () => {
  it('is in the rank vocabulary as a FUNCTION, not as a bare field', () => {
    // The pairing is the whole design: the bare field stays unrankable (lexical = inverted),
    // and the ordinal function is the supported replacement. Asserting only one half would
    // let a future edit "fix" the gap by re-admitting the broken bare form.
    expect(RANK_FUNCTIONS).toContain('severity_rank');
    expect(RANKABLE_ITEM_FIELDS).not.toContain('severity');
  });

  it('ACCEPTS `rank: [{ expr: severity_rank }]` — the gap the severity fix deliberately left', () => {
    expect(validateClaimSpec(specWithRank('lexicographic', [{ expr: 'severity_rank', dir: 'desc' }])).ok).toBe(true);
  });

  it('ACCEPTS severity_rank in WEIGHTED mode — it compiles to integers, so the ::numeric cast is safe', () => {
    // This is the property that distinguishes it from the bare `severity` field, whose text
    // column makes the same weighted spec a hard PG error that aborts the claim query.
    expect(validateClaimSpec(specWithRank('weighted', [{ expr: 'severity_rank', dir: 'desc', weight: 2 }])).ok).toBe(
      true,
    );
  });

  it('still REJECTS the bare `severity` field in both modes', () => {
    expect(validateClaimSpec(specWithRank('lexicographic', [{ expr: 'severity', dir: 'desc' }])).ok).toBe(false);
    expect(validateClaimSpec(specWithRank('weighted', [{ expr: 'severity', dir: 'desc', weight: 1 }])).ok).toBe(false);
  });

  it('pins WHY the ordinal is needed: the lexical order it replaces is exactly backwards', () => {
    // Descending lexical sort of the severity vocabulary puts the LEAST severe first — the
    // silent inversion `severity_rank` exists to correct. Arithmetic, not assertion.
    expect(['critical', 'major', 'minor', 'nit'].sort().reverse()).toEqual(['nit', 'minor', 'major', 'critical']);
    // The ordinal the CASE in get-next.ts assigns, sorted DESC, is the intended priority order.
    const ordinal: Record<string, number> = { critical: 4, major: 3, minor: 2, nit: 1 };
    expect(['nit', 'critical', 'minor', 'major'].sort((a, b) => ordinal[b] - ordinal[a])).toEqual([
      'critical',
      'major',
      'minor',
      'nit',
    ]);
  });
});

describe('dependency_unlock_score is the one-hop dependency-leverage term (Phase 5)', () => {
  it('is a numeric rank function accepted in lexicographic and weighted modes', () => {
    expect(RANK_FUNCTIONS).toContain('dependency_unlock_score');
    expect(
      validateClaimSpec(specWithRank('lexicographic', [{ expr: 'dependency_unlock_score', dir: 'desc' }])).ok,
    ).toBe(true);
    expect(
      validateClaimSpec(specWithRank('weighted', [{ expr: 'dependency_unlock_score', dir: 'desc', weight: 3 }])).ok,
    ).toBe(true);
  });

  it('keeps the default policy unchanged until a leader deliberately authors the term', () => {
    expect(DEFAULT_CLAIM_SPEC.rank.terms.map((t) => t.expr)).not.toContain('dependency_unlock_score');
  });
});

describe('cluster_priority is the persisted resolver-cluster leverage term (P-008)', () => {
  it('is a numeric rank function accepted in lexicographic and weighted modes', () => {
    expect(RANK_FUNCTIONS).toContain('cluster_priority');
    expect(validateClaimSpec(specWithRank('lexicographic', [{ expr: 'cluster_priority', dir: 'desc' }])).ok).toBe(true);
    expect(validateClaimSpec(specWithRank('weighted', [{ expr: 'cluster_priority', dir: 'desc', weight: 4 }])).ok).toBe(
      true,
    );
  });

  it('keeps the default policy unchanged until a drain-fleet leader authors the term', () => {
    expect(DEFAULT_CLAIM_SPEC.rank.terms.map((t) => t.expr)).not.toContain('cluster_priority');
  });

  it('reads the persisted payload projection without reconstructing cluster topology at claim time', () => {
    const clusterSql = requiredSourceSpan(
      GET_NEXT_SOURCE,
      'function clusterPrioritySql',
      '\nfunction specUsesRankTerm',
    );
    const compilerBranch = requiredSourceSpan(
      GET_NEXT_SOURCE,
      "if (head === 'cluster_priority')",
      '// Descoped-but-validated function terms',
    );

    // Positive controls: the supported term and its SQL still exist and read the
    // resolver-owned projection. Without these, every absence assertion below
    // would pass if cluster_priority were simply deleted.
    expect(compilerBranch).toContain('value: clusterPrioritySql(sql)');
    expect(clusterSql).toContain("payload->'clusterPriority'");
    expect(clusterSql).toContain("payload->>'clusterPriority'");

    // D-004's architectural boundary is load-bearing: the scheduler consumes a
    // number and never rebuilds the resolver's graph. Keep this guard local to
    // clusterPrioritySql because get-next legitimately aggregates unrelated
    // claimability diagnostics elsewhere in the same module.
    expect(clusterSql).not.toMatch(/\b(?:SELECT|FROM|JOIN|GROUP\s+BY|HAVING)\b/i);
    expect(clusterSql).not.toMatch(/\b(?:COUNT|SUM|AVG|MAX|MIN|array_agg|jsonb_agg)\s*\(/i);

    // Catch a cluster-topology lookup moved outside the small rank helper while
    // ignoring comments that merely explain why those concepts stay absent.
    expect(withoutComments(GET_NEXT_SOURCE)).not.toMatch(
      /\b(?:resolverCluster|clusterKey|suspectedGenerator|relates)\b/,
    );
  });
});

describe('the DEFAULT spec actually ranks on severity (EI-19286355119013384)', () => {
  const termExprs = () => DEFAULT_CLAIM_SPEC.rank.terms.map((t) => (t as { expr: string }).expr);

  it('includes severity_rank — without it the default IGNORED severity on issue-family rows', () => {
    // The regression this guards is silent and total, not partial: the other three terms all
    // go inert on an issue-family row (affinity is neutral for a pathless bee, priority is
    // feature_order which is NULL there), so dropping severity_rank collapses the ordering
    // back to plain oldest-first and criticals queue behind whatever is older.
    expect(termExprs()).toContain('severity_rank');
  });

  it('ranks severity DESC — the direction is the whole point', () => {
    const sev = DEFAULT_CLAIM_SPEC.rank.terms.find((t) => (t as { expr: string }).expr === 'severity_rank');
    expect((sev as { dir: string }).dir).toBe('desc');
  });

  it('orders severity AFTER affinity but BEFORE priority/age', () => {
    // Slot matters, so pin it rather than mere membership: affinity first keeps bee
    // path-locality winning; placing it before `age` is what makes severity beat arrival
    // order, which is the entire behavioral change.
    const exprs = termExprs();
    const affinity = exprs.findIndex((e) => e.startsWith('affinity'));
    const severity = exprs.indexOf('severity_rank');
    const age = exprs.indexOf('age');
    expect(affinity).toBeGreaterThanOrEqual(0);
    expect(severity).toBeGreaterThan(affinity);
    expect(severity).toBeLessThan(age);
  });

  it('the default spec still validates with the new term', () => {
    expect(validateClaimSpec(DEFAULT_CLAIM_SPEC).ok).toBe(true);
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
    // NOTE: this case used to use `severity_rank` as its stand-in for "unknown", which was
    // fragile — that term was the documented not-yet-shipped future work, so shipping it
    // (EI-19286355119013384) silently invalidated the test's premise rather than its intent.
    // Use a term that is fictional by construction, so this guards the error-reporting rule
    // and nothing else.
    const result = validateClaimSpec(specWithRank('weighted', [{ expr: 'no_such_rank_term', dir: 'desc', weight: 1 }]));
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
