/**
 * The attribution chain against REAL Postgres: observation -> buffer -> flush -> a
 * `coverage_evidence` row joined to the census surface P-003's providers wrote.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-004).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE UNIT TESTS. The unit tests cover what a row MEANS
 * (collapse, verdict merge, arming). They cannot cover the three things that can only be wrong
 * against a real database, and each of them fails SILENTLY rather than loudly:
 *
 *   1. THE `ON CONFLICT` TARGET. `coverage_evidence_dedup` is an EXPRESSION index
 *      (`COALESCE(test_file,''), COALESCE(test_case,''), COALESCE(test_run_id,-1)`), and
 *      Postgres matches an ON CONFLICT target to an expression index only by exact expression.
 *      A near-miss does not silently insert a duplicate — it raises, but only against real PG.
 *   2. THE SURFACE JOIN. Evidence is useless unless `surface_ref` resolves via the SAME
 *      (workspace, harness, kind, surface_id) identity the census writes. A mismatch inserts
 *      nothing and reports zero — indistinguishable from "no traffic happened".
 *   3. RETIRED SURFACES. Evidence must not attach to a surface the census has retired.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../../test/_org-test-db';
import { createPgEvidenceStore } from './pg-evidence-store';
import { ATTRIBUTION_ENV, resetAttributionArmingForTests, setAmbientTestContext } from './context';
import {
  flushTrafficEvidence,
  recordHttpTraffic,
  recordMcpTraffic,
  resetAttributionSinkForTests,
  setEvidenceStoreForTests,
  attributionStatus,
} from './sink';

const { createOrgTestDb } = await import('../../../test/_org-test-db');

let db: OrgTestDb;

/** Distinct per run so repeated local runs cannot collide in the shared template DB. */
const WS = `ws-attr-${Math.random().toString(36).slice(2, 10)}`;
const HARNESS = 'attribution-probe';

const ROUTE_ID = 'GET /api/widgets/:id';
const TOOL_ID = 'widgets:list';

async function seedSurface(kind: string, surfaceId: string, retired = false): Promise<number> {
  const [row] = await db.adminSql<{ id: string | number }[]>`
    INSERT INTO harness_shared.testing_surfaces
      (workspace_id, harness_slug, kind, surface_id, provider, fidelity, retired_at)
    VALUES (${WS}, ${HARNESS}, ${kind}, ${surfaceId}, 'test-seed', 'declared',
            ${retired ? db.adminSql`now()` : null})
    RETURNING id
  `;
  return Number(row.id);
}

async function evidenceFor(surfaceRef: number) {
  return db.adminSql<
    {
      id: string;
      verdict: string;
      generated: boolean;
      test_file: string | null;
      test_case: string | null;
      test_run_id: string | null;
      details: Record<string, unknown>;
      observed_at: Date;
    }[]
  >`
    SELECT id, verdict, generated, test_file, test_case, test_run_id, details, observed_at
      FROM harness_shared.coverage_evidence
     WHERE surface_ref = ${surfaceRef}
     ORDER BY id
  `;
}

beforeAll(async () => {
  db = await createOrgTestDb();
}, 180_000);

afterAll(async () => {
  if (db) {
    await db.adminSql`
      DELETE FROM harness_shared.testing_surfaces
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
    `;
    await db.close?.();
  }
});

beforeEach(() => {
  resetAttributionSinkForTests();
  setAmbientTestContext(null);
  process.env[ATTRIBUTION_ENV] = '1';
  process.env.PAPERCUSP_WORKSPACE_ID = WS;
  process.env.PAPERCUSP_TEST_RUN_HARNESS = HARNESS;
  process.env.PAPERCUSP_TEST_RUN_GROUP = 'run-attr-1';
  resetAttributionArmingForTests();
  // The store is pointed at the testcontainer handle. In production it resolves its own
  // connection to the canonical admin URL — see the store's file header for why it must.
  setEvidenceStoreForTests(createPgEvidenceStore({ getSql: () => db.adminSql }));
});

afterEach(() => {
  resetAttributionSinkForTests();
  setAmbientTestContext(null);
  delete process.env[ATTRIBUTION_ENV];
  delete process.env.PAPERCUSP_WORKSPACE_ID;
  delete process.env.PAPERCUSP_TEST_RUN_HARNESS;
  delete process.env.PAPERCUSP_TEST_RUN_GROUP;
  resetAttributionArmingForTests();
});

describe('http-route traffic', () => {
  it('writes one evidence row joined to the census surface', async () => {
    const ref = await seedSurface('http-route', ROUTE_ID);
    setAmbientTestContext({ file: 'packages/operator-core/lib/a.test.ts', case: 'serves a widget' });

    recordHttpTraffic({ method: 'get', path: '/api/widgets/:id', status: 'ok', httpStatus: 200 });
    await flushTrafficEvidence();

    const rows = await evidenceFor(ref);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      verdict: 'pass',
      generated: false,
      test_file: 'packages/operator-core/lib/a.test.ts',
      test_case: 'serves a widget',
      // NULL by design (D-010): the test_runs row does not exist yet at traffic time, and
      // resolving it opportunistically would make the row COUNT depend on flush timing.
      test_run_id: null,
    });
    expect(rows[0].details).toMatchObject({
      runGroupId: 'run-attr-1',
      routeStatus: 'ok',
      httpStatus: 200,
      calls: 1,
    });
  });

  it('an auth rejection is recorded as skip, NOT as coverage', async () => {
    const ref = await seedSurface('http-route', 'GET /api/guarded');
    setAmbientTestContext({ file: 'a.test.ts', case: 'rejects anonymous' });

    recordHttpTraffic({ method: 'GET', path: '/api/guarded', status: 'unauthorized', httpStatus: 401 });
    await flushTrafficEvidence();

    const rows = await evidenceFor(ref);
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('skip');
  });
});

describe('mcp-tool traffic', () => {
  it('writes one evidence row keyed by the bare tool name', async () => {
    const ref = await seedSurface('mcp-tool', TOOL_ID);
    setAmbientTestContext({ file: 'b.test.ts', case: 'lists widgets' });

    recordMcpTraffic({ toolName: TOOL_ID, status: 'ok' });
    await flushTrafficEvidence();

    const rows = await evidenceFor(ref);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verdict: 'pass', test_case: 'lists widgets' });
  });
});

describe('dedup — the expression-index ON CONFLICT target', () => {
  it('re-observing the SAME binding updates one row instead of inserting a second', async () => {
    const ref = await seedSurface('http-route', 'GET /api/dedup');
    setAmbientTestContext({ file: 'c.test.ts', case: 'hits it twice' });

    recordHttpTraffic({ method: 'GET', path: '/api/dedup', status: 'ok', httpStatus: 200 });
    await flushTrafficEvidence();
    const first = await evidenceFor(ref);
    expect(first).toHaveLength(1);

    // A SECOND flush, as a later run would produce — the row must be refreshed, not duplicated.
    recordHttpTraffic({ method: 'GET', path: '/api/dedup', status: 'error', httpStatus: 500 });
    await flushTrafficEvidence();

    const second = await evidenceFor(ref);
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
    expect(second[0].verdict).toBe('error');
    expect(second[0].observed_at.getTime()).toBeGreaterThanOrEqual(first[0].observed_at.getTime());
  });

  it('keeps SEPARATE rows for different test cases on one surface', async () => {
    const ref = await seedSurface('http-route', 'GET /api/two-cases');

    setAmbientTestContext({ file: 'd.test.ts', case: 'case one' });
    recordHttpTraffic({ method: 'GET', path: '/api/two-cases', status: 'ok' });
    setAmbientTestContext({ file: 'd.test.ts', case: 'case two' });
    recordHttpTraffic({ method: 'GET', path: '/api/two-cases', status: 'ok' });
    await flushTrafficEvidence();

    const rows = await evidenceFor(ref);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.test_case).sort()).toEqual(['case one', 'case two']);
  });

  it('dedups a NULL test case rather than inserting without limit', async () => {
    // The plain-UNIQUE hazard migration 846 calls out: PostgreSQL treats NULLs as distinct, so
    // without the COALESCE expressions every anonymous observation would insert a new row.
    const ref = await seedSurface('http-route', 'GET /api/anon');

    recordHttpTraffic({ method: 'GET', path: '/api/anon', status: 'ok' });
    await flushTrafficEvidence();
    recordHttpTraffic({ method: 'GET', path: '/api/anon', status: 'ok' });
    await flushTrafficEvidence();

    const rows = await evidenceFor(ref);
    expect(rows).toHaveLength(1);
    expect(rows[0].test_file).toBeNull();
    expect(rows[0].test_case).toBeNull();
  });
});

describe('surfaces the census does not know', () => {
  it('counts an unmatched surface and creates NO surface row for it', async () => {
    recordHttpTraffic({ method: 'GET', path: '/api/never-censused', status: 'ok' });
    await flushTrafficEvidence();

    expect(attributionStatus().unmatchedSurfaces).toBe(1);
    const [{ count }] = await db.adminSql<{ count: string }[]>`
      SELECT count(*)::text AS count
        FROM harness_shared.testing_surfaces
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
         AND surface_id = 'GET /api/never-censused'
    `;
    expect(count).toBe('0');
  });

  it('does not attach evidence to a RETIRED surface', async () => {
    const ref = await seedSurface('http-route', 'GET /api/retired', true);
    recordHttpTraffic({ method: 'GET', path: '/api/retired', status: 'ok' });
    await flushTrafficEvidence();

    expect(await evidenceFor(ref)).toHaveLength(0);
    expect(attributionStatus().unmatchedSurfaces).toBe(1);
  });
});

describe('scope refusal', () => {
  it('drops the buffer rather than guessing a scope when the workspace is unknown', async () => {
    // A guessed scope writes evidence that joins to no surface, or — far worse — to another
    // harness's surface of the same name. Refusing is the only safe direction.
    const ref = await seedSurface('http-route', 'GET /api/no-scope');
    delete process.env.PAPERCUSP_WORKSPACE_ID;

    recordHttpTraffic({ method: 'GET', path: '/api/no-scope', status: 'ok' });
    await flushTrafficEvidence();

    expect(await evidenceFor(ref)).toHaveLength(0);
    expect(attributionStatus().lastError).toContain('no attribution scope');
  });
});
