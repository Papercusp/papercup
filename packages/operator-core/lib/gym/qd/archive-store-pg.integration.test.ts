/**
 * Live-PG tests for the QD archive store (P-010). Provisions a throwaway DB with the FULL
 * live baseline (so harness_shared.gym_qd_archive from migration 193 exists), then round-trips
 * the QdArchive over PgArchiveStore — proving the SQL/schema match the InMemoryArchiveStore
 * contract the unit tests pin — plus the loop recorder bridge end-to-end.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { getTestPg, teardownTestPg } from '@papercusp/test-config';
import { provisionGymDatabase } from '../gym-db-init';
import { QdArchive } from './archive';
import { PgArchiveStore } from './archive-store-pg';
import { makeLoopArchiveRecorder, makeGymArchive } from './archive-recorder';
import { coordsToFeatures, nicheKey, type BehaviorDescriptor, type NicheCoords } from './niche';

let sql: postgres.Sql;
let containerUri: string;
const dbName = `gymqd_${randomBytes(5).toString('hex')}`;
const WS = 'ws-qd-test';

function desc(scope: NicheCoords['scope'], domain: string, risk: NicheCoords['risk']): BehaviorDescriptor {
  const coords: NicheCoords = { scope, domain, risk };
  return { coords, features: coordsToFeatures(coords) };
}

beforeAll(async () => {
  containerUri = await getTestPg();
  const { databaseUri } = await provisionGymDatabase({ maintenanceUri: containerUri, dbName });
  sql = postgres(databaseUri, { max: 2, onnotice: () => {}, prepare: false });
}, 180_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try {
    await maint.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await maint.end({ timeout: 5 });
  }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('PgArchiveStore via QdArchive', () => {
  it('round-trips an elite: upsert → getElite → listElites', async () => {
    const a = new QdArchive(new PgArchiveStore(sql, { workspaceId: WS, harnessSlug: 'alpha' }));
    const d = desc('local', 'execution', 'low');
    const r = await a.upsertElite({ candidateId: 'v1', descriptor: d, fitness: 5, rationale: 'first' }, 1000);
    expect(r.admitted).toBe(true);
    expect(r.reason).toBe('new-niche');

    const got = await a.getElite(nicheKey(d.coords));
    expect(got).not.toBeNull();
    expect(got!.candidateId).toBe('v1');
    expect(got!.fitness).toBe(5);
    expect(got!.coords).toEqual(d.coords);
    expect(got!.descriptor.features).toEqual(d.features); // JSONB round-trip
    expect(got!.source).toBe('gym');
    expect(got!.rationale).toBe('first');
    expect(got!.updatedAt).toBe(1000);

    const list = await a.listElites();
    expect(list.map((e) => e.candidateId)).toEqual(['v1']);
  });

  it('enforces insert-if-better against the live row (dominated vs improved)', async () => {
    const a = new QdArchive(new PgArchiveStore(sql, { workspaceId: WS, harnessSlug: 'beta' }));
    const d = desc('module', 'quality', 'medium');
    await a.upsertElite({ candidateId: 'b1', descriptor: d, fitness: 7 }, 1);

    const dominated = await a.upsertElite({ candidateId: 'b2', descriptor: d, fitness: 4 }, 2);
    expect(dominated.admitted).toBe(false);
    expect((await a.getElite(nicheKey(d.coords)))!.candidateId).toBe('b1');

    const improved = await a.upsertElite({ candidateId: 'b3', descriptor: d, fitness: 9 }, 3);
    expect(improved.admitted).toBe(true);
    expect(improved.replaced).toBe('b1');
    expect((await a.getElite(nicheKey(d.coords)))!.candidateId).toBe('b3');
    expect((await a.getElite(nicheKey(d.coords)))!.fitness).toBe(9);
  });

  it('scopes by (workspace, harness) — a different harness sees nothing', async () => {
    const alpha = new QdArchive(new PgArchiveStore(sql, { workspaceId: WS, harnessSlug: 'iso-a' }));
    const other = new QdArchive(new PgArchiveStore(sql, { workspaceId: WS, harnessSlug: 'iso-b' }));
    await alpha.upsertElite({ candidateId: 'x', descriptor: desc('local', 'execution', 'low'), fitness: 5 }, 1);
    expect(await alpha.listElites()).toHaveLength(1);
    expect(await other.listElites()).toHaveLength(0);
  });

  it('filters by source', async () => {
    const a = new QdArchive(new PgArchiveStore(sql, { workspaceId: WS, harnessSlug: 'src' }));
    await a.upsertElite({ candidateId: 'g', descriptor: desc('local', 'execution', 'low'), fitness: 5, source: 'gym' }, 1);
    await a.upsertElite({ candidateId: 's', descriptor: desc('architectural', 'knowledge', 'high'), fitness: 2, source: 'scout' }, 2);
    expect((await a.listElites({ source: 'scout' })).map((e) => e.candidateId)).toEqual(['s']);
    expect((await a.listElites({ source: 'gym' })).map((e) => e.candidateId)).toEqual(['g']);
  });

  it('noveltyScore reads the live archive', async () => {
    const a = makeGymArchive(sql, { workspaceId: WS, harnessSlug: 'nov' });
    expect(await a.noveltyScore(desc('local', 'execution', 'low'))).toBe(1); // empty
    await a.upsertElite({ candidateId: 'n1', descriptor: desc('local', 'execution', 'low'), fitness: 5 }, 1);
    // a far descriptor is more novel than one adjacent to the single member
    const far = await a.noveltyScore(desc('architectural', 'knowledge', 'high'));
    const near = await a.noveltyScore(desc('module', 'execution', 'low'));
    expect(far).toBeGreaterThan(near);
  });
});

describe('makeLoopArchiveRecorder bridge', () => {
  it('derives the niche from the overlay pair and upserts a gym elite', async () => {
    const record = makeLoopArchiveRecorder(sql, { workspaceId: WS, harnessSlug: 'loop', now: () => 4242 });
    // baseline: empty overlay, no parent → (local, mixed, low)
    await record({ variantId: 'baseline', overlay: { promptOverrides: {} }, fitness: 5 });
    // a candidate that rewrites the worker prompt substantially → (local, execution, medium/high)
    await record({
      variantId: 'cand-c1',
      overlay: { promptOverrides: { worker: 'w'.repeat(900) } },
      parentOverlay: { promptOverrides: {} },
      fitness: 6,
      rationale: 'sharpen worker',
    });

    const a = makeGymArchive(sql, { workspaceId: WS, harnessSlug: 'loop' });
    const elites = await a.listElites();
    expect(elites.map((e) => e.candidateId).sort()).toEqual(['baseline', 'cand-c1']);
    const cand = elites.find((e) => e.candidateId === 'cand-c1')!;
    expect(cand.coords.domain).toBe('execution');
    expect(cand.coords.risk).toBe('medium'); // 900 chars ∈ [400, 1500)
    expect(cand.updatedAt).toBe(4242);
    expect(cand.rationale).toBe('sharpen worker');
  });
});
