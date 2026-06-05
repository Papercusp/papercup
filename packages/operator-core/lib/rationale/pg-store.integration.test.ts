/**
 * pg-store.integration.test.ts — PgRationaleStore against REAL Postgres
 * (docs-and-memory-as-projections-2026-06-05 P0).
 *
 * Drives the store over the production-faithful client (prepare:false + the org
 * pool's jsonb-binding constraints) so the `${JSON.stringify}::text::jsonb` write is
 * validated exactly as in production — a `sql.json()` / bare-object write would store
 * a jsonb STRING and reads would come back as a string (the dock white-screen bug).
 * Also asserts the store is a faithful `ProjectionStore`: its read semantics match the
 * lib's InMemoryProjectionStore reference, and a full ProjectionIndex round-trip
 * (index → re-index diff → remove) converges.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ProjectionIndex,
  InMemoryProjectionStore,
  type IndexedEntry,
} from '@papercusp/projection-index';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { rationaleProjector } from './projector';
import { sourceIdOf, type RationaleEntry, type RationaleSource } from './types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
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

// Imported AFTER the mock is declared so the store binds the mocked getOrgPg.
const { PgRationaleStore } = await import('./pg-store');

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('rationale');
  h.sql = db.sql;
  await db.sql.unsafe(readMigration('154-rationale-index.sql'));
});

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.rationale_index`;
});

const plan: RationaleSource = {
  kind: 'plan',
  slug: 'p',
  planStatus: 'active',
  topics: ['coord', 'db'],
  decisions: [
    { id: 'D-001', title: 'First', body: 'Body one.', date: '2026-06-01' },
    { id: 'D-002', title: 'Second', body: 'Body two.', date: '2026-06-02' },
  ],
};

describe('PgRationaleStore — jsonb binding + reads', () => {
  it('round-trips the entry as a real object, not a jsonb string', async () => {
    const store = new PgRationaleStore();
    await store.applyDelta('plan:p', {
      put: rationaleProjector(plan).map((c) => ({ ...c, sourceId: 'plan:p' })),
      delete: [],
    });
    const rows = await store.byKey('coord');
    expect(rows.length).toBe(2);
    // The entry must be a parsed object with real fields — a jsonb-string mis-bind
    // would surface here as a string.
    expect(typeof rows[0]!.entry).toBe('object');
    expect(rows[0]!.entry.kind).toBe('decision');
    // jsonb_typeof must be 'object', not 'string'.
    const [{ t }] = await db.sql<{ t: string }[]>`
      SELECT jsonb_typeof(entry) AS t FROM harness_shared.rationale_index LIMIT 1`;
    expect(t).toBe('object');
  });

  it('contributionsOf returns all rows for a source across keys', async () => {
    const store = new PgRationaleStore();
    await store.applyDelta('plan:p', {
      put: rationaleProjector(plan).map((c) => ({ ...c, sourceId: 'plan:p' })),
      delete: [],
    });
    const rows = await store.contributionsOf('plan:p');
    expect(rows.length).toBe(4); // 2 decisions × 2 topics
  });

  it('byKey matches the InMemory reference for sort / kinds / limit', async () => {
    const pg = new PgRationaleStore();
    const mem = new InMemoryProjectionStore<RationaleEntry>();
    const wi: RationaleSource = {
      kind: 'work_item', id: 'WI-1', title: 'wi', summary: 's', state: 'open',
      topics: ['coord'], createdAt: '2026-06-03',
    };
    const put = (src: RationaleSource): IndexedEntry<RationaleEntry>[] =>
      rationaleProjector(src).map((c) => ({ ...c, sourceId: sourceIdOf(src) }));
    for (const src of [plan, wi]) {
      const entries = put(src);
      await pg.applyDelta(sourceIdOf(src), { put: entries, delete: [] });
      await mem.applyDelta(sourceIdOf(src), { put: entries, delete: [] });
    }
    for (const opts of [
      undefined,
      { order: 'asc' as const },
      { order: 'desc' as const },
      { kinds: ['decision'] },
      { kinds: ['work_item'] },
      { limit: 2 },
    ]) {
      const a = await pg.byKey('coord', opts);
      const b = await mem.byKey('coord', opts);
      expect(a.map((r) => r.entryId)).toEqual(b.map((r) => r.entryId));
    }
  });
});

describe('PgRationaleStore — full ProjectionIndex round-trip', () => {
  it('re-indexing diffs away removed decisions; remove() empties', async () => {
    const idx = new ProjectionIndex<RationaleSource, RationaleEntry>({
      projector: rationaleProjector,
      store: new PgRationaleStore(),
    });
    await idx.index(sourceIdOf(plan), plan);
    // Store/index default order is asc over sortKey (the date); the service read
    // path (queryTopic) flips this to desc — here we drive the index directly.
    expect((await idx.query('coord')).map((r) => r.entryId)).toEqual(['D-001', 'D-002']);

    // Drop D-002 → it must disappear from the index.
    const planV2: RationaleSource = { ...plan, decisions: [plan.decisions[0]!] } as RationaleSource;
    await idx.index(sourceIdOf(planV2), planV2);
    expect((await idx.query('coord')).map((r) => r.entryId)).toEqual(['D-001']);

    // Retag to a new topic → old topic empties, new one fills.
    const retagged: RationaleSource = { ...planV2, topics: ['fresh'] } as RationaleSource;
    await idx.index(sourceIdOf(retagged), retagged);
    expect(await idx.query('coord')).toEqual([]);
    expect((await idx.query('fresh')).map((r) => r.entryId)).toEqual(['D-001']);

    await idx.remove(sourceIdOf(plan));
    expect(await idx.query('fresh')).toEqual([]);
  });
});
