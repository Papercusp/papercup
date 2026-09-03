/**
 * feature-views.ts getAudit (per-harness fallback) + brainstorm.ts promote
 * (feature target) — WI-5381 (WI-4995 part b) regression tests.
 *
 * Proves the harnessQuery migration resolves BOTH `feature_audit` and
 * `harness_features` to the CORRECT per-harness schema (never a sibling
 * harness's same-named table) in BOTH connection modes, mirroring
 * archives-clear-features.integration.test.ts's method. Also proves
 * brainstorm.ts's promote-to-feature id-increment (SELECT next F-IDEA-###
 * then INSERT, now wrapped in one `sql.begin` transaction) is scoped
 * per-harness, not computed across schemas. Real Postgres (testcontainer;
 * Docker required). Run:
 *   npx vitest run --config vitest.integration.config.ts lib/endpoint-route/routes/harness/feature-views-audit-and-brainstorm-promote.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { slugToSchemaName, _resetForTests } from '@papercusp/db-org';
import { _resetUrlCacheForTests } from '../../../../../../libs/papercusp/libs/db/src/connection';
import type { ProjectEntry } from '../../../harness-registry';

const SLUG_A = 'fvbp-test-a';
const SLUG_B = 'fvbp-test-b';
const SCHEMA_A = slugToSchemaName(SLUG_A);
const SCHEMA_B = slugToSchemaName(SLUG_B);

// Both feature-views.ts and brainstorm.ts resolve their project via
// harness-core's resolveProject/resolvePhasedProject, which hit the
// filesystem-backed harness registry — irrelevant to the DB-scoping
// property under test, so stub just those two exports and keep every
// other real export (harnessDir, safeRead, ...) via importActual, so a
// route file's other unused imports still resolve normally.
vi.mock('../../../harness-core', async () => {
  const actual = await vi.importActual<typeof import('../../../harness-core')>('../../../harness-core');
  const projectFor = (slug: string): ProjectEntry => ({ slug, path: `/tmp/fvbp-${slug}` });
  return {
    ...actual,
    resolveProject: vi.fn(async (slug: string) => projectFor(slug)),
    resolvePhasedProject: vi.fn(async (slug: string) => projectFor(slug)),
  };
});

import feature_views_routes from './feature-views';
import brainstorm_routes from './brainstorm';

type Route = { path: string; handler: (req: Request, ctx: unknown) => Promise<Response> };
const byPath = (routes: unknown[], path: string): Route => {
  const r = (routes as Route[]).find((x) => x.path === path);
  if (!r) throw new Error(`no route for ${path}`);
  return r;
};

const getAuditRoute = byPath(feature_views_routes, '/harness/:slug/features/:id/audit');
const promoteRoute = byPath(brainstorm_routes, '/harness/:slug/brainstorm/promote');

async function getAudit(slug: string, id: string) {
  const req = new Request(`http://127.0.0.1/api/harness/${slug}/features/${id}/audit`);
  const res = await getAuditRoute.handler(req, { params: { slug, id } });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function promoteFeature(slug: string, content: string) {
  const req = new Request(`http://127.0.0.1/api/harness/${slug}/brainstorm/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 'feature', content }),
  });
  const res = await promoteRoute.handler(req, { params: { slug } });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

let db: MigratedTestDb;
let obs: Sql;

const savedEnv = {
  url: process.env.HARNESS_DATABASE_URL,
  pgbouncer: process.env.PAPERCUSP_PGBOUNCER,
};

async function provisionSchema(schema: string) {
  await obs.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await obs.unsafe(`
    CREATE TABLE IF NOT EXISTS ${schema}.harness_features (
      feature_id text PRIMARY KEY,
      harness_slug text NOT NULL,
      title text,
      summary text,
      status text,
      attempts int,
      claims jsonb,
      notes text,
      metadata jsonb,
      kind text,
      project_id text,
      expected_cost_cents bigint,
      tags jsonb,
      needs_human_review boolean,
      ts bigint,
      created_ts bigint,
      updated_ts bigint
    )`);
  await obs.unsafe(`
    CREATE TABLE IF NOT EXISTS ${schema}.feature_audit (
      id serial PRIMARY KEY,
      harness_slug text NOT NULL,
      feature_id text NOT NULL,
      ts bigint,
      field text,
      old_value text,
      new_value text,
      actor text
    )`);
}

async function resetSchemas() {
  for (const schema of [SCHEMA_A, SCHEMA_B]) {
    await obs.unsafe(`TRUNCATE ${schema}.harness_features, ${schema}.feature_audit`);
  }
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'fvbp' });
  process.env.HARNESS_DATABASE_URL = db.url;
  process.env.PAPERCUSP_PGBOUNCER = '0';
  _resetUrlCacheForTests();
  await _resetForTests();

  obs = postgres(db.url, { max: 1, onnotice: () => {} });
  await provisionSchema(SCHEMA_A);
  await provisionSchema(SCHEMA_B);
}, 120_000);

afterEach(async () => {
  await resetSchemas();
});

afterAll(async () => {
  await _resetForTests().catch(() => {});
  await obs?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
  if (savedEnv.url === undefined) delete process.env.HARNESS_DATABASE_URL;
  else process.env.HARNESS_DATABASE_URL = savedEnv.url;
  if (savedEnv.pgbouncer === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
  else process.env.PAPERCUSP_PGBOUNCER = savedEnv.pgbouncer;
  _resetUrlCacheForTests();
});

describe.each([
  ['DIRECT', '0'],
  ['POOLED', '1'],
] as const)('%s mode', (_label, pgbouncer) => {
  beforeAll(async () => {
    process.env.PAPERCUSP_PGBOUNCER = pgbouncer;
    await _resetForTests();
  });
  afterAll(async () => {
    process.env.PAPERCUSP_PGBOUNCER = '0';
    await _resetForTests();
  });

  describe('getAudit (feature-views.ts, per-harness fallback)', () => {
    it('returns only the target harness schema\'s audit rows, leaving a sibling harness\'s same-id rows unseen', async () => {
      await obs.unsafe(`
        INSERT INTO ${SCHEMA_A}.feature_audit (harness_slug, feature_id, ts, field, old_value, new_value, actor)
        VALUES ('${SLUG_A}', 'F-001', 1000, 'status', '"todo"', '"open"', 'agent-a')`);
      await obs.unsafe(`
        INSERT INTO ${SCHEMA_B}.feature_audit (harness_slug, feature_id, ts, field, old_value, new_value, actor)
        VALUES ('${SLUG_B}', 'F-001', 2000, 'status', '"todo"', '"closed"', 'agent-b')`);

      const { status, body } = await getAudit(SLUG_A, 'F-001');
      expect(status).toBe(200);
      expect(body.count).toBe(1);
      expect(body.audit).toMatchObject([{ actor: 'agent-a', new: 'open' }]);
    });

    it('returns an empty (not error) result for a harness/feature with no audit rows', async () => {
      const { status, body } = await getAudit(SLUG_B, 'F-none');
      expect(status).toBe(200);
      expect(body.count).toBe(0);
      expect(body.audit).toEqual([]);
    });
  });

  describe('promote (brainstorm.ts, target=feature)', () => {
    it('creates the F-IDEA row ONLY in the target harness schema, sibling harness untouched', async () => {
      const { status, body } = await promoteFeature(SLUG_A, 'A brand new idea\nsome more detail');
      expect(status).toBe(200);
      expect(body).toMatchObject({ ok: true, id: 'F-IDEA-001', target: 'feature' });

      const [rowA] = await obs.unsafe(
        `SELECT feature_id, title, notes, status, metadata FROM ${SCHEMA_A}.harness_features WHERE feature_id = 'F-IDEA-001'`,
      ) as unknown as Array<{ feature_id: string; title: string; notes: string; status: string; metadata: unknown }>;
      expect(rowA).toMatchObject({ feature_id: 'F-IDEA-001', title: 'A brand new idea', notes: 'some more detail', status: 'todo' });
      expect(rowA.metadata).toMatchObject({ source: 'brainstorm' });

      const [{ n: sideB }] = await obs.unsafe(`SELECT count(*)::int AS n FROM ${SCHEMA_B}.harness_features`) as unknown as { n: number }[];
      expect(sideB).toBe(0); // sibling harness schema untouched — proves schema scoping
    });

    it('computes the next id from the TARGET harness\'s own rows, not a sibling\'s (per-harness id sequencing)', async () => {
      // Seed 2 existing ideas in A only; B starts empty. If id computation ever
      // leaked cross-schema, promoting into B would wrongly continue A's sequence.
      await obs.unsafe(`
        INSERT INTO ${SCHEMA_A}.harness_features (feature_id, harness_slug, title, status, attempts, needs_human_review, ts, created_ts, updated_ts)
        VALUES ('F-IDEA-001', '${SLUG_A}', 'old idea 1', 'todo', 0, false, 1, 1, 1),
               ('F-IDEA-002', '${SLUG_A}', 'old idea 2', 'todo', 0, false, 1, 1, 1)`);

      const { body: bodyB } = await promoteFeature(SLUG_B, 'fresh idea in B');
      expect(bodyB).toMatchObject({ ok: true, id: 'F-IDEA-001' }); // B's own sequence starts at 1

      const { body: bodyA } = await promoteFeature(SLUG_A, 'third idea in A');
      expect(bodyA).toMatchObject({ ok: true, id: 'F-IDEA-003' }); // A continues its own sequence (max existing + 1)
    });
  });
});
