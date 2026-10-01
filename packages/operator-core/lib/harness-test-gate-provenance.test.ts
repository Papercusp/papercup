import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * EI-19435123521651527 — the completion gate must SEE the provenance the mint path
 * actually records.
 *
 * `itemTestGate` resolved "which plan items was this feature promoted from?" by
 * selecting `harness_features_consolidated.source_plan_item_ids`. The mint path
 * (`plan-workitem-promotion-run.ts`) stopped writing that column when item-level
 * provenance moved to the `payload.plan_item` stamp — measured 2026-08-03 in
 * papercusp-workspace: 1 row carries the column, 1,239 carry the stamp. So `itemIds`
 * came back empty for every feature and the gate returned `{ ok: true }` on the next
 * line: a gate that CANNOT refuse, indistinguishable from one with nothing to refuse.
 * (It was graduated out of the dark-flag set as "verified live with zero blast
 * radius" — which is exactly what an always-open gate looks like.)
 *
 * The decisive test is the second one: a stamp-only feature whose plan item has a
 * test-requiring VAL with no passing test MUST be refused. That assertion fails
 * against the old column-only read, which is what makes it a guard rather than a
 * restatement.
 */

type SqlTag = (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown[]>;

let provenanceRows: unknown[] = [];
let assertionRows: Array<{
  plan_slug: string;
  val_id: string;
  item_id: string;
  requires_test: boolean;
}> = [];
let testRows: unknown[] = [];
let throwOnProvenance = false;
let assertionQueryValues: unknown[] = [];
// WI-10004463: what the spec-clause lookup returns (the VALs whose CURRENT clause revision is
// accepted|active). The lifecycle/current-revision filtering is SQL — `specClauseQueries` records
// the statement text + params so a test can pin that the predicates are present.
let specGovernedRows: Array<{ val_id: string }> = [];
let specClauseQueries: Array<{ text: string; vals: unknown[] }> = [];
let throwOnSpecClause = false;

const sql: SqlTag = Object.assign(
  async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join(' ');
    if (q.includes('harness_features_consolidated')) {
      if (throwOnProvenance) throw new Error('pg down');
      return provenanceRows;
    }
    if (q.includes('harness_plan_assertions')) {
      assertionQueryValues = vals;
      if (!q.includes('plan_slug =')) return assertionRows;
      return assertionRows.filter((row) => row.plan_slug === vals[2]);
    }
    if (q.includes('plan_spec_clauses')) {
      specClauseQueries.push({ text: q, vals });
      if (throwOnSpecClause) throw new Error('pg down');
      return specGovernedRows;
    }
    if (q.includes('harness_tests')) return testRows;
    throw new Error(`unexpected query in test: ${q}`);
  },
  { begin: vi.fn() },
);

vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql }) }));
vi.mock('./workspace-registry', () => ({
  activeWorkspaceId: () => 'papercusp-workspace',
  DEFAULT_WORKSPACE_ID: 'papercusp-workspace',
}));

const { itemTestGate } = await import('./harness-test-gate');
const { planItemProvenanceFromRow } = await import('./plan-item-provenance');

/** A feature row as the mint path actually leaves it: stamp set, legacy column NULL. */
const STAMPED_ROW = {
  source_plan_slug: 'some-plan-2026-08-03',
  source_plan_item_ids: null,
  stamped_plan_slug: 'some-plan-2026-08-03',
  stamped_item_id: 'P-001',
};

const REQUIRES_TEST_ASSERTION = {
  plan_slug: 'some-plan-2026-08-03',
  val_id: 'VAL-1',
  item_id: 'P-001',
  requires_test: true,
};

beforeEach(() => {
  provenanceRows = [];
  assertionRows = [];
  testRows = [];
  throwOnProvenance = false;
  assertionQueryValues = [];
  specGovernedRows = [];
  specClauseQueries = [];
  throwOnSpecClause = false;
});

describe('planItemProvenanceFromRow precedence', () => {
  it('prefers the legacy column when it is populated', () => {
    expect(
      planItemProvenanceFromRow({ ...STAMPED_ROW, source_plan_item_ids: ['P-007', 'P-008'] }),
    ).toEqual({ planSlug: 'some-plan-2026-08-03', itemIds: ['P-007', 'P-008'], source: 'column' });
  });

  it('falls back to the payload.plan_item stamp — the case the live mint path produces', () => {
    expect(planItemProvenanceFromRow(STAMPED_ROW)).toEqual({
      planSlug: 'some-plan-2026-08-03',
      itemIds: ['P-001'],
      source: 'stamp',
    });
  });

  it('treats an EMPTY column array as absent rather than as an answer', () => {
    // The distinction matters: `[]` is non-NULL, so a `WHERE ... IS NOT NULL` style
    // check would accept it and then resolve to zero items.
    expect(planItemProvenanceFromRow({ ...STAMPED_ROW, source_plan_item_ids: [] }).source).toBe(
      'stamp',
    );
  });

  it('recovers the plan slug from the stamp when the column-side slug is missing', () => {
    expect(
      planItemProvenanceFromRow({ ...STAMPED_ROW, source_plan_slug: null }).planSlug,
    ).toBe('some-plan-2026-08-03');
  });

  it('contrast: the OLD column-only rule resolves the live row to NOTHING', () => {
    // This is the whole defect in two lines, kept executable so the fix cannot be
    // quietly reverted to "read the column" without a red test. `?? []` is verbatim
    // what harness-test-gate and plan-context-for-feature used to do.
    expect(STAMPED_ROW.source_plan_item_ids ?? []).toEqual([]);
    expect(planItemProvenanceFromRow(STAMPED_ROW).itemIds).toEqual(['P-001']);
  });

  it('reports none for a work-item with no plan provenance at all', () => {
    expect(planItemProvenanceFromRow(null)).toEqual({ planSlug: null, itemIds: [], source: 'none' });
  });
});

describe('itemTestGate sees stamp-only provenance', () => {
  it('REFUSES a stamp-only feature whose required VAL has no passing test', async () => {
    provenanceRows = [STAMPED_ROW];
    assertionRows = [REQUIRES_TEST_ASSERTION];
    testRows = []; // nothing covers VAL-1

    const result = await itemTestGate('papercusp', 'F-1');

    // The whole point: under the old column-only read this was `{ ok: true }`.
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('VAL-1');
  });

  it('passes the same feature once a passing test covers the VAL', async () => {
    provenanceRows = [STAMPED_ROW];
    assertionRows = [REQUIRES_TEST_ASSERTION];
    // NB: the harness_tests vocabulary is 'passing'/'failing' (harness-test-rollup.ts:44),
    // not 'passed' — a 'passed' row derives to `validating`, i.e. still blocked.
    testRows = [{ status: 'passing', payload: { coversVALs: ['VAL-1'] } }];

    expect(await itemTestGate('papercusp', 'F-1')).toEqual({ ok: true });
  });

  it('ignores assertions from another plan that reuses the same item ID', async () => {
    provenanceRows = [STAMPED_ROW];
    assertionRows = [
      {
        plan_slug: 'another-plan-2026-08-20',
        val_id: 'VAL-FOREIGN',
        item_id: 'P-001',
        requires_test: true,
      },
    ];

    expect(await itemTestGate('papercusp', 'F-1')).toEqual({ ok: true });
    expect(assertionQueryValues).toEqual([
      'papercusp-workspace',
      'papercusp',
      'some-plan-2026-08-03',
      ['P-001'],
    ]);
  });

  it('fails open when item IDs exist without a resolvable plan slug', async () => {
    provenanceRows = [
      {
        source_plan_slug: null,
        source_plan_item_ids: ['P-001'],
        stamped_plan_slug: null,
        stamped_item_id: null,
      },
    ];
    assertionRows = [REQUIRES_TEST_ASSERTION];

    expect(await itemTestGate('papercusp', 'F-1')).toEqual({ ok: true });
    expect(assertionQueryValues).toEqual([]);
  });

  it('still passes a feature with genuinely no plan provenance (nothing to prove)', async () => {
    provenanceRows = [
      { source_plan_slug: null, source_plan_item_ids: null, stamped_plan_slug: null, stamped_item_id: null },
    ];
    assertionRows = [REQUIRES_TEST_ASSERTION];

    expect(await itemTestGate('papercusp', 'F-2')).toEqual({ ok: true });
  });

  it('FAILS OPEN when the provenance read throws — a gate bug must never block a completion', async () => {
    throwOnProvenance = true;

    expect(await itemTestGate('papercusp', 'F-3')).toEqual({ ok: true });
  });
});

/**
 * WI-10004463 — a requires_test VAL that a plan item promoted into an ENFORCEABLE spec clause is
 * judged by `specTestAdequacyCompletionGate` (current evidence bindings), not by the legacy
 * `harness_tests` table, which has had no writer since 2026-08-22. Before the fix this gate refused
 * EVERY new spec-era feature item (zero covering harness_tests rows, forever), forcing a
 * recordOnly+set_state bypass on each close of plan session-transcript-exact-fuzzy-search P-002..P-004.
 */
describe('itemTestGate: spec-governed VALs are judged by the spec-era gate', () => {
  it('PASSES a feature whose only required VAL is spec-governed, with zero harness_tests rows', async () => {
    provenanceRows = [STAMPED_ROW];
    assertionRows = [REQUIRES_TEST_ASSERTION];
    testRows = []; // the live state: nothing in harness_tests covers anything new
    specGovernedRows = [{ val_id: 'VAL-1' }];

    expect(await itemTestGate('papercusp', 'F-10')).toEqual({ ok: true });
  });

  it('still REFUSES a VAL with no enforceable clause, naming ONLY that VAL (the legacy path is intact)', async () => {
    provenanceRows = [STAMPED_ROW];
    assertionRows = [
      REQUIRES_TEST_ASSERTION,
      { plan_slug: 'some-plan-2026-08-03', val_id: 'VAL-2', item_id: 'P-001', requires_test: true },
    ];
    testRows = [];
    specGovernedRows = [{ val_id: 'VAL-1' }]; // VAL-2 has no enforceable clause

    const result = await itemTestGate('papercusp', 'F-11');

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('VAL-2');
    expect(result.reason).not.toContain('VAL-1');
  });

  it('a clause-less VAL is refused exactly as before when the lookup finds no governing clause', async () => {
    provenanceRows = [STAMPED_ROW];
    assertionRows = [REQUIRES_TEST_ASSERTION];
    testRows = [];
    specGovernedRows = []; // draft / exempt / retired / absent clause ⇒ nothing else judges it

    expect((await itemTestGate('papercusp', 'F-12')).ok).toBe(false);
  });

  it('scopes the clause lookup to workspace + harness + plan + the required VAL ids, CURRENT revision, accepted|active only', async () => {
    provenanceRows = [STAMPED_ROW];
    assertionRows = [REQUIRES_TEST_ASSERTION];
    specGovernedRows = [{ val_id: 'VAL-1' }];

    await itemTestGate('papercusp', 'F-13');

    expect(specClauseQueries).toHaveLength(1);
    expect(specClauseQueries[0]!.vals).toEqual([
      'papercusp-workspace',
      'papercusp',
      'some-plan-2026-08-03',
      ['VAL-1'],
    ]);
    // The SQL predicates ARE the semantics (the stub cannot execute them): current revision only,
    // and only a lifecycle the spec gate actually enforces. Dropping either would silently exempt
    // VALs that nothing else judges (a superseded revision / a draft clause).
    const text = specClauseQueries[0]!.text.replace(/\s+/g, ' ');
    expect(text).toContain('r.revision = c.current_revision');
    expect(text).toContain("r.lifecycle_status IN ('accepted', 'active')");
    expect(text).toContain('c.source_val_id = ANY(');
  });

  it('skips the clause lookup entirely when no VAL requires a test (no extra read on the common path)', async () => {
    provenanceRows = [STAMPED_ROW];
    assertionRows = [{ ...REQUIRES_TEST_ASSERTION, requires_test: false }];

    expect(await itemTestGate('papercusp', 'F-14')).toEqual({ ok: true });
    expect(specClauseQueries).toHaveLength(0);
  });

  it('FAILS OPEN when the clause lookup throws — a gate bug must never block a completion', async () => {
    provenanceRows = [STAMPED_ROW];
    assertionRows = [REQUIRES_TEST_ASSERTION];
    testRows = [];
    throwOnSpecClause = true; // documented fail-open rule: a throwing lookup is ok:true, never a refusal

    expect(await itemTestGate('papercusp', 'F-15')).toEqual({ ok: true });
  });
});
