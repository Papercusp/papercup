/**
 * rubrics-seed.integration.test.ts — verifies migration 327 seeds the founding
 * 'hive-coordination-health' rubric (rubric-driven-observations-2026-06-20 P-003 /
 * brief B6, su-5695e). Applies 326 (DDL) + 327 (seed) against REAL Postgres, then
 * asserts the seeded rubric is ACTIVE with the LOCKED 13 canonical criterion keys —
 * the interface the Overwatch scorecard (P-004) and Scout digest grouping (P-006)
 * reference. A drift in the criteria set (rename/drop/reorder) fails this test.
 *
 * Docker-gated (`*.integration.test.ts`). Mirrors the rubrics.integration.test.ts
 * harness (su-7ad93's B2 store test) so the two compose without interference: that
 * test applies ONLY 326 and truncates per-test; this one applies 326+327 and keeps
 * the seeded row.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');

// Strip psql metacommands (\set), GRANTs (no framework roles in the throwaway DB),
// and explicit txn markers (the pooled test client rejects them). Dollar-quoted
// multiline blocks ($desc$/$criteria$) carry none of those line shapes, so they
// pass through intact.
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter(
      (line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line),
    )
    .join('\n');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const rubrics = await import('./rubrics');

// The locked 13-criteria interface (rubric-driven-observations D-003) — 1:1 with the
// owner's Q1-Q13 scorecard. Kept here as the test's own copy so a seed-vs-interface
// drift is caught, not silently absorbed.
const CANONICAL_KEYS = [
  'end-to-end-flow',
  'ideation-quality',
  'queen-workitem-selection',
  'queen-plan-selection',
  'parallel-distribution',
  'bee-execution',
  'bee-observation-quality',
  'overwatch-observation-quality',
  'watchdog-determinism',
  'coordination-comms',
  'chatter-economy',
  'coordination-utilization',
  'tool-utilization',
];

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('rubrics-seed');
  h.sql = db.sql;
  await db.sql.unsafe(readMigration('326-rubrics-store.sql')).simple();
  await db.sql.unsafe(readMigration('327-seed-hive-coordination-health-rubric.sql')).simple();
}, 90_000);

afterAll(async () => {
  await db.cleanup();
});

describe('migration 327 — seed hive-coordination-health rubric', () => {
  it('seeds the founding rubric as ACTIVE with method_ref + the default rating scale', async () => {
    const r = await rubrics.getRubric('hive-coordination-health');
    expect(r).not.toBeNull();
    expect(r!.status).toBe('active'); // owner founding rubric, seeded ratified (D-002 owner #1)
    expect(r!.characteristic).toBe('hive-coordination');
    expect(r!.title).toBe('Hive coordination health');
    expect(r!.methodRef).toBe('hive-coordination-health'); // the agent-insights runbook slug
    expect(r!.ratingScale).toEqual(['healthy', 'degraded', 'broken', 'unknown']);
    expect(r!.ratifiedBy).toBe('aviynw@gmail.com');
    expect((r!.description ?? '').length).toBeGreaterThan(0);
  });

  it('carries exactly the 13 canonical criteria, in order, each fully specified', async () => {
    const r = await rubrics.getRubric('hive-coordination-health');
    expect(r!.criteria.map((c) => c.key)).toEqual(CANONICAL_KEYS);
    for (const c of r!.criteria) {
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.model.length).toBeGreaterThan(0);
      expect(c.method.length).toBeGreaterThan(0);
      expect(c.driftMarkers.length).toBeGreaterThan(0);
    }
  });

  it('appears in listRubrics(active) and is findable via the real FTS', async () => {
    expect((await rubrics.listRubrics({ status: 'active' })).map((x) => x.rubricId)).toContain(
      'hive-coordination-health',
    );
    expect((await rubrics.searchRubrics('coordination')).map((x) => x.rubricId)).toContain(
      'hive-coordination-health',
    );
  });

  it('re-applying the seed is idempotent (ON CONFLICT — no duplicate row)', async () => {
    await db.sql.unsafe(readMigration('327-seed-hive-coordination-health-rubric.sql')).simple();
    const all = await rubrics.listRubrics({});
    expect(all.filter((x) => x.rubricId === 'hive-coordination-health')).toHaveLength(1);
  });
});
