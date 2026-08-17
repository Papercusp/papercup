/**
 * coverage-census-schema.integration.test.ts — migration 846's relations against REAL
 * Postgres (testcontainer), pinned to the full migrated baseline.
 * Plan: deterministic-coverage-census-2026-08-17 (P-001), decisions D-002, D-003.
 *
 * WHAT THIS FILE IS FOR. The depth view is the verdict surface the whole system rests on:
 * a rubric refusal, a checkpoint red, and the agent gap queue all read it. A grading bug
 * here does not throw — it silently grades an untested surface as covered, which is the
 * exact failure this plan exists to remove. So every rung is exercised with a surface that
 * SHOULD reach it and, where the distinction matters, one that should NOT.
 *
 * WHY THE NEGATIVE CASES ARE THE POINT. A view that returns "covered" for everything passes
 * any test that only ever asserts a positive. Three negatives are load-bearing here:
 *   - `naked` has NO evidence and must stay depth 0 (the gap the census exists to expose);
 *   - `fuzz-only` has a GENERATED pass and must reach L2 but NOT L3 (if a fuzzer could
 *     satisfy L3, the intent rung would be meaningless — that is the whole `generated` flag);
 *   - `stale` has a real authored pass that is 90 days old and must fall BACK to depth 0
 *     (evidence is a claim about the current tree; a deleted test must stop counting).
 *
 * The constraint block asserts the schema REFUSES malformed rows. A CHECK constraint nobody
 * has ever seen reject anything is not known to work — same discipline as the repo's
 * mutation-probe rule, applied to DDL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';

const { createOrgTestDb } = await import('../test/_org-test-db');

let db: OrgTestDb;

/** Distinct per run so repeated local runs cannot collide in the shared template DB. */
const WS = `ws-census-${Math.random().toString(36).slice(2, 10)}`;
const HARNESS = 'census-probe';

/** Insert a surface and return its id. */
async function surface(kind: string, surfaceId: string, sourceFile?: string): Promise<number> {
  const [row] = await db.adminSql<{ id: number }[]>`
    INSERT INTO harness_shared.testing_surfaces
      (workspace_id, harness_slug, kind, surface_id, source_file, provider, fidelity)
    VALUES (${WS}, ${HARNESS}, ${kind}, ${surfaceId}, ${sourceFile ?? null}, 'test-provider', 'declared')
    RETURNING id`;
  return row.id;
}

/** The graded row for one surface. */
async function depthOf(id: number) {
  const [row] = await db.adminSql<
    {
      depth: number;
      meets_l1: boolean;
      meets_l2: boolean;
      meets_l3: boolean;
      meets_l4: boolean;
      mutation_score: number | null;
      waived: boolean;
      authored_evidence: number;
    }[]
  >`SELECT depth, meets_l1, meets_l2, meets_l3, meets_l4, mutation_score, waived, authored_evidence
      FROM harness_shared.testing_surface_depth WHERE id = ${id}`;
  return row;
}

beforeAll(async () => {
  db = await createOrgTestDb();
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('migration 846 — census relations exist', () => {
  it('creates all four tables and the grading view', async () => {
    const rows = await db.adminSql<{ relname: string; relkind: string }[]>`
      SELECT c.relname, c.relkind
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'harness_shared'
         AND c.relname IN ('testing_surfaces','coverage_evidence','census_provider_registrations',
                           'coverage_waivers','testing_surface_depth')
       ORDER BY c.relname`;
    expect(rows.map((r) => r.relname)).toEqual([
      'census_provider_registrations',
      'coverage_evidence',
      'coverage_waivers',
      'testing_surface_depth',
      'testing_surfaces',
    ]);
    // The verdict surface must be a VIEW: a materialized table would go stale into a
    // false pass, which is the one failure mode the census cannot tolerate (D-002).
    expect(rows.find((r) => r.relname === 'testing_surface_depth')?.relkind).toBe('v');
  });
});

describe('the depth ladder grades from evidence', () => {
  it('a censused surface with no evidence is depth 0 — the gap', async () => {
    const id = await surface('http-route', 'POST /naked');
    const row = await depthOf(id);
    expect(row.depth).toBe(0);
    expect(row.meets_l1).toBe(false);
    expect(row.meets_l3).toBe(false);
    expect(row.authored_evidence).toBe(0);
  });

  it('GENERATED evidence reaches L2 but must NOT satisfy L3', async () => {
    const id = await surface('http-route', 'POST /fuzzed-only');
    await db.adminSql`
      INSERT INTO harness_shared.coverage_evidence
        (surface_ref, evidence_kind, verdict, generated, test_file)
      VALUES (${id}, 'fuzz', 'pass', true, 'fuzz-harness.test.ts')`;
    const row = await depthOf(id);
    expect(row.meets_l2).toBe(true);
    // The load-bearing assertion of this whole file: a machine-written test can never
    // stand in for one that encodes intended behaviour.
    expect(row.meets_l3).toBe(false);
    expect(row.depth).toBe(2);
  });

  it('AUTHORED attributed evidence reaches L3', async () => {
    const id = await surface('http-route', 'POST /intent-tested');
    await db.adminSql`
      INSERT INTO harness_shared.coverage_evidence
        (surface_ref, evidence_kind, verdict, generated, test_file, test_case)
      VALUES (${id}, 'traffic', 'pass', false, 'widgets.integration.test.ts', 'notifies subscribers')`;
    const row = await depthOf(id);
    expect(row.meets_l1).toBe(true);
    expect(row.meets_l3).toBe(true);
    expect(row.depth).toBe(3);
  });

  it('a passing mutation score reaches L4', async () => {
    const id = await surface('mcp-tool', 'hardened:tool');
    await db.adminSql`
      INSERT INTO harness_shared.coverage_evidence
        (surface_ref, evidence_kind, verdict, generated, test_file)
      VALUES (${id}, 'traffic', 'pass', false, 'hardened.test.ts')`;
    await db.adminSql`
      INSERT INTO harness_shared.coverage_evidence
        (surface_ref, evidence_kind, verdict, generated, score)
      VALUES (${id}, 'mutation', 'pass', false, 0.82)`;
    const row = await depthOf(id);
    expect(row.meets_l4).toBe(true);
    expect(row.depth).toBe(4);
    expect(Number(row.mutation_score)).toBeCloseTo(0.82, 5);
  });

  it('a mutation score BELOW the floor does not reach L4', async () => {
    const id = await surface('mcp-tool', 'weakly-tested:tool');
    await db.adminSql`
      INSERT INTO harness_shared.coverage_evidence
        (surface_ref, evidence_kind, verdict, generated, test_file)
      VALUES (${id}, 'traffic', 'pass', false, 'weak.test.ts')`;
    await db.adminSql`
      INSERT INTO harness_shared.coverage_evidence
        (surface_ref, evidence_kind, verdict, generated, score)
      VALUES (${id}, 'mutation', 'pass', false, 0.20)`;
    const row = await depthOf(id);
    expect(row.meets_l4).toBe(false);
    expect(row.depth).toBe(3); // still intent-tested, just not hardened
  });

  it('STALE evidence stops counting — the surface falls back to depth 0', async () => {
    const id = await surface('mcp-tool', 'stale:tool');
    await db.adminSql`
      INSERT INTO harness_shared.coverage_evidence
        (surface_ref, evidence_kind, verdict, generated, test_file, observed_at)
      VALUES (${id}, 'traffic', 'pass', false, 'ancient.test.ts', now() - interval '90 days')`;
    const row = await depthOf(id);
    expect(row.depth).toBe(0);
    expect(row.meets_l3).toBe(false);
  });

  it('FAILING evidence never grants a rung', async () => {
    const id = await surface('http-route', 'POST /red');
    await db.adminSql`
      INSERT INTO harness_shared.coverage_evidence
        (surface_ref, evidence_kind, verdict, generated, test_file)
      VALUES (${id}, 'traffic', 'fail', false, 'broken.test.ts')`;
    const row = await depthOf(id);
    expect(row.depth).toBe(0);
    expect(row.meets_l1).toBe(false);
  });
});

describe('waivers are visible and time-bounded', () => {
  it('an unexpired waiver shows on the surface; an expired one does not', async () => {
    const waived = await surface('http-route', 'POST /third-party');
    await db.adminSql`
      INSERT INTO harness_shared.coverage_waivers (surface_ref, reason, added_by, expires_at)
      VALUES (${waived}, 'third-party route, upstream owns its tests', 'test', now() + interval '30 days')`;
    expect((await depthOf(waived)).waived).toBe(true);

    const lapsed = await surface('http-route', 'POST /lapsed-waiver');
    await db.adminSql`
      INSERT INTO harness_shared.coverage_waivers (surface_ref, reason, added_by, expires_at)
      VALUES (${lapsed}, 'temporary exemption that has since lapsed', 'test', now() - interval '1 day')`;
    // The gate must speak again on its own once a waiver lapses — that is the whole
    // reason expires_at is NOT NULL (KNOWN_DARK_FLAGS governance).
    expect((await depthOf(lapsed)).waived).toBe(false);
  });
});

describe('the schema REFUSES malformed rows', () => {
  it('rejects a fidelity value outside the declared ladder', async () => {
    await expect(db.adminSql`
      INSERT INTO harness_shared.testing_surfaces
        (workspace_id, harness_slug, kind, surface_id, provider, fidelity)
      VALUES (${WS}, ${HARNESS}, 'http-route', 'POST /bogus-fidelity', 'p', 'made-up')`)
      .rejects.toThrow(/testing_surfaces_fidelity_check/);
  });

  it('rejects mutation evidence with no score, and a score outside 0..1', async () => {
    const id = await surface('mcp-tool', 'score-guard:tool');
    // A scoreless mutation row is an unreadable verdict.
    await expect(db.adminSql`
      INSERT INTO harness_shared.coverage_evidence (surface_ref, evidence_kind, verdict)
      VALUES (${id}, 'mutation', 'pass')`).rejects.toThrow(/coverage_evidence_score_check/);
    // 82 instead of 0.82 is the percent-vs-fraction unit confusion that produces a
    // confidently wrong report; the schema refuses it rather than storing it.
    await expect(db.adminSql`
      INSERT INTO harness_shared.coverage_evidence (surface_ref, evidence_kind, verdict, score)
      VALUES (${id}, 'mutation', 'pass', 82)`).rejects.toThrow(/coverage_evidence_score_check/);
  });

  it('rejects an unknown evidence kind and an unknown verdict', async () => {
    const id = await surface('mcp-tool', 'kind-guard:tool');
    await expect(db.adminSql`
      INSERT INTO harness_shared.coverage_evidence (surface_ref, evidence_kind, verdict)
      VALUES (${id}, 'vibes', 'pass')`).rejects.toThrow(/coverage_evidence_kind_check/);
    await expect(db.adminSql`
      INSERT INTO harness_shared.coverage_evidence (surface_ref, evidence_kind, verdict)
      VALUES (${id}, 'traffic', 'probably')`).rejects.toThrow(/coverage_evidence_verdict_check/);
  });

  it('deduplicates the same evidence edge — including when nullable columns are NULL', async () => {
    const id = await surface('http-route', 'POST /dedup');
    await db.adminSql`
      INSERT INTO harness_shared.coverage_evidence
        (surface_ref, evidence_kind, verdict, generated, test_file)
      VALUES (${id}, 'traffic', 'pass', false, 'same.test.ts')`;
    await expect(db.adminSql`
      INSERT INTO harness_shared.coverage_evidence
        (surface_ref, evidence_kind, verdict, generated, test_file)
      VALUES (${id}, 'traffic', 'pass', false, 'same.test.ts')`)
      .rejects.toThrow(/coverage_evidence_dedup/);

    // The NULL case is the one a plain UNIQUE would miss: PostgreSQL treats NULLs as
    // distinct, so without the COALESCE index the attribution middleware would insert
    // an unbounded number of identical file-less edges.
    const bare = await surface('http-route', 'POST /dedup-nulls');
    await db.adminSql`
      INSERT INTO harness_shared.coverage_evidence (surface_ref, evidence_kind, verdict)
      VALUES (${bare}, 'traffic', 'pass')`;
    await expect(db.adminSql`
      INSERT INTO harness_shared.coverage_evidence (surface_ref, evidence_kind, verdict)
      VALUES (${bare}, 'traffic', 'pass')`).rejects.toThrow(/coverage_evidence_dedup/);
  });

  it('rejects a waiver whose reason is too thin to be a reason', async () => {
    const id = await surface('http-route', 'POST /lazy-waiver');
    await expect(db.adminSql`
      INSERT INTO harness_shared.coverage_waivers (surface_ref, reason, added_by, expires_at)
      VALUES (${id}, 'meh', 'test', now() + interval '1 day')`)
      .rejects.toThrow(/coverage_waivers_reason_check/);
  });

  it('rejects a provider registration with an unknown source', async () => {
    await expect(db.adminSql`
      INSERT INTO harness_shared.census_provider_registrations
        (workspace_id, harness_slug, provider, source)
      VALUES (${WS}, ${HARNESS}, 'hono-routes', 'vibes')`)
      .rejects.toThrow(/census_provider_registrations_source_check/);
  });

  it('keeps surface identity unique per (workspace, harness, kind, surface_id)', async () => {
    await surface('http-route', 'POST /unique');
    await expect(surface('http-route', 'POST /unique')).rejects.toThrow(/testing_surfaces_identity/);
    // ...but the SAME surface_id under a different kind is a different surface.
    await expect(surface('mcp-tool', 'POST /unique')).resolves.toBeGreaterThan(0);
  });
});

describe('evidence survives run pruning', () => {
  it('keeps the evidence row when its test_run is deleted (SET NULL, not CASCADE)', async () => {
    const [run] = await db.adminSql<{ id: number }[]>`
      INSERT INTO harness_shared.test_runs (file_path, framework, status)
      VALUES ('prune-me.test.ts', 'vitest', 'pass') RETURNING id`;
    const id = await surface('http-route', 'POST /prune');
    await db.adminSql`
      INSERT INTO harness_shared.coverage_evidence
        (surface_ref, evidence_kind, verdict, generated, test_file, test_run_id)
      VALUES (${id}, 'traffic', 'pass', false, 'prune-me.test.ts', ${run.id})`;

    await db.adminSql`DELETE FROM harness_shared.test_runs WHERE id = ${run.id}`;

    // Pruning run history must not silently erase coverage the gates read.
    const [row] = await db.adminSql<{ test_run_id: number | null }[]>`
      SELECT test_run_id FROM harness_shared.coverage_evidence WHERE surface_ref = ${id}`;
    expect(row.test_run_id).toBeNull();
    expect((await depthOf(id)).meets_l3).toBe(true);
  });
});
