/**
 * pg-store.integration.test.ts — the census store against REAL Postgres (testcontainer).
 * Plan: deterministic-coverage-census-2026-08-17 (P-002).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE PURE DIFF TESTS. The diff decides WHAT to write and
 * is fully covered by unit tests. This file covers the one class of bug those cannot see: an
 * UPDATE that touches a column it must not. `first_seen` is the column in question — the
 * green-checkpoint NEW-surface guard is scoped by it, so an upsert that refreshed it would make
 * every surface look new on every census run. No assertion over the pure diff can observe that;
 * only a real row, updated twice, can.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createPgCensusStore } from './pg-store';

const { createOrgTestDb } = await import('../../test/_org-test-db');

let db: OrgTestDb;
let store: ReturnType<typeof createPgCensusStore>;

/** Distinct per run so repeated local runs cannot collide in the shared template DB. */
const WS = `ws-census-store-${Math.random().toString(36).slice(2, 10)}`;
const HARNESS = 'census-store-probe';
const scope = { workspaceId: WS, harnessSlug: HARNESS };

const upsert = (surfaceId: string, overrides: Record<string, unknown> = {}) => ({
  kind: 'http-route',
  surfaceId,
  provider: 'hono-routes',
  fidelity: 'declared' as const,
  sourceFile: 'apps/operator/routes/a.ts',
  schemaRef: null,
  attrs: {},
  unretire: false,
  ...overrides,
});

async function readRow(surfaceId: string) {
  const [row] = await db.adminSql<
    { id: string; first_seen: Date; last_seen: Date; retired_at: Date | null; provider: string }[]
  >`
    SELECT id, first_seen, last_seen, retired_at, provider
      FROM harness_shared.testing_surfaces
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND surface_id = ${surfaceId}
  `;
  return row;
}

beforeAll(async () => {
  db = await createOrgTestDb();
  store = createPgCensusStore({ getSql: () => db.adminSql });
}, 180_000);

afterAll(async () => {
  // NOT `db?.adminSql\`...\`` — a tagged template is not permitted in an optional chain (TS1358),
  // and an unparseable file here is bundled into the staging/release hosts by bundle-host.sh
  // straight from the working tree, with no commit required.
  if (db) {
    await db.adminSql`DELETE FROM harness_shared.testing_surfaces WHERE workspace_id = ${WS}`;
    await db.cleanup();
  }
});

describe('createPgCensusStore — first_seen is write-once', () => {
  it('an ordinary re-upsert advances last_seen but NEVER first_seen', async () => {
    await store.applyDiff(scope, { upserts: [upsert('GET /api/stable')], retires: [] });
    const first = await readRow('GET /api/stable');

    // Force a measurable clock gap so an accidental first_seen write would be visible.
    await db.adminSql`SELECT pg_sleep(0.05)`;
    await store.applyDiff(scope, {
      upserts: [upsert('GET /api/stable', { provider: 'openapi-spec' })],
      retires: [],
    });
    const second = await readRow('GET /api/stable');

    expect(second.id).toBe(first.id); // upserted in place, not re-inserted
    expect(second.first_seen.getTime()).toBe(first.first_seen.getTime());
    expect(second.last_seen.getTime()).toBeGreaterThan(first.last_seen.getTime());
    expect(second.provider).toBe('openapi-spec'); // the mutable columns DID update
  });

  it('a returning surface keeps its ORIGINAL first_seen through retire -> unretire', async () => {
    await store.applyDiff(scope, { upserts: [upsert('GET /api/round-trip')], retires: [] });
    const born = await readRow('GET /api/round-trip');

    await store.applyDiff(scope, {
      upserts: [],
      retires: [{ id: Number(born.id), kind: 'http-route', surfaceId: 'GET /api/round-trip', provider: 'hono-routes' }],
    });
    expect((await readRow('GET /api/round-trip')).retired_at).not.toBeNull();

    await db.adminSql`SELECT pg_sleep(0.05)`;
    await store.applyDiff(scope, {
      upserts: [upsert('GET /api/round-trip', { unretire: true })],
      retires: [],
    });
    const back = await readRow('GET /api/round-trip');

    expect(back.retired_at).toBeNull();
    // The whole point: a surface that went away and came back is NOT a new surface, so the
    // new-surface gate must not fire on it.
    expect(back.first_seen.getTime()).toBe(born.first_seen.getTime());
  });

  it('an upsert WITHOUT unretire does not resurrect a retired row', async () => {
    await store.applyDiff(scope, { upserts: [upsert('GET /api/still-gone')], retires: [] });
    const row = await readRow('GET /api/still-gone');
    await store.applyDiff(scope, {
      upserts: [],
      retires: [{ id: Number(row.id), kind: 'http-route', surfaceId: 'GET /api/still-gone', provider: 'hono-routes' }],
    });

    await store.applyDiff(scope, {
      upserts: [upsert('GET /api/still-gone', { unretire: false })],
      retires: [],
    });

    // Only the diff may decide a surface is back; a plain refresh must not clear retired_at,
    // or a concurrent run's retirement would be silently undone.
    expect((await readRow('GET /api/still-gone')).retired_at).not.toBeNull();
  });
});

describe('createPgCensusStore — retirement', () => {
  it('retires only rows that are not already retired, and reports the true count', async () => {
    await store.applyDiff(scope, {
      upserts: [upsert('GET /api/r1'), upsert('GET /api/r2')],
      retires: [],
    });
    const r1 = await readRow('GET /api/r1');
    const r2 = await readRow('GET /api/r2');

    const first = await store.applyDiff(scope, {
      upserts: [],
      retires: [
        { id: Number(r1.id), kind: 'http-route', surfaceId: 'GET /api/r1', provider: 'hono-routes' },
        { id: Number(r2.id), kind: 'http-route', surfaceId: 'GET /api/r2', provider: 'hono-routes' },
      ],
    });
    expect(first.retired).toBe(2);

    // Re-retiring the same ids is a no-op, not a double count — the count feeds the mass-
    // retirement breaker's telemetry, so an inflated number would misreport a quiet run.
    const again = await store.applyDiff(scope, {
      upserts: [],
      retires: [
        { id: Number(r1.id), kind: 'http-route', surfaceId: 'GET /api/r1', provider: 'hono-routes' },
      ],
    });
    expect(again.retired).toBe(0);
  });
});

describe('createPgCensusStore — reads', () => {
  it('loadExisting returns retired rows too, so a returning surface can be matched', async () => {
    await store.applyDiff(scope, { upserts: [upsert('GET /api/listed')], retires: [] });
    const row = await readRow('GET /api/listed');
    await store.applyDiff(scope, {
      upserts: [],
      retires: [{ id: Number(row.id), kind: 'http-route', surfaceId: 'GET /api/listed', provider: 'hono-routes' }],
    });

    const existing = await store.loadExisting(scope);
    const found = existing.find((e) => e.surfaceId === 'GET /api/listed');

    // If this read filtered retired rows out, diffCensus would treat the surface as brand new on
    // its return and re-insert it with a fresh first_seen — the bug the store exists to avoid.
    expect(found).toBeDefined();
    expect(found?.retiredAt).not.toBeNull();
  });

  it('loadRegistrations round-trips an enabled flag and config', async () => {
    await db.adminSql`
      INSERT INTO harness_shared.census_provider_registrations
        (workspace_id, harness_slug, provider, config, enabled, source)
      VALUES (${WS}, ${HARNESS}, 'hono-routes', ${db.adminSql.json({ globs: ['a/**'] })}, false, 'template')
      ON CONFLICT (workspace_id, harness_slug, provider) DO NOTHING
    `;

    const regs = await store.loadRegistrations(scope);
    const hono = regs.find((r) => r.provider === 'hono-routes');

    expect(hono?.enabled).toBe(false);
    expect(hono?.config).toEqual({ globs: ['a/**'] });
    expect(hono?.source).toBe('template');

    await db.adminSql`DELETE FROM harness_shared.census_provider_registrations WHERE workspace_id = ${WS}`;
  });
});
