/**
 * pg-projection-store.integration.test.ts — the generic PgProjectionStore against
 * REAL Postgres (caching-layer-tag-eca-2026-06-22 P-016).
 *
 * Proves PgProjectionStore is a faithful, table-agnostic `ProjectionStore`: it
 * round-trips entries as real objects (not jsonb strings), its read semantics match
 * the lib's InMemoryProjectionStore reference, a full ProjectionIndex round-trip
 * (index → re-index diff → retag → remove) converges, and a poison record routed
 * through GuardedProjectionIndex is skipped without crashing the loop. Reuses the
 * `rationale_index` table (migration 154) as a conforming projection-index table.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ProjectionIndex,
  InMemoryProjectionStore,
  type Contribution,
} from '@papercusp/projection-index';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string): string =>
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

// Imported AFTER the mock so the store binds the mocked getOrgPg.
const { PgProjectionStore } = await import('./pg-projection-store');
const { GuardedProjectionIndex } = await import('./guarded-projection-index');

const TABLE = 'harness_shared.rationale_index';

// A toy domain: a doc tagged onto topics; each (doc, topic) is one contribution.
interface Doc {
  id: string;
  topics: string[];
  text: string;
  date: string;
}
const projector = (d: Doc): Contribution<{ text: string }>[] => {
  if (d.id.startsWith('BAD')) throw new Error(`poison ${d.id}`);
  return d.topics.map((t) => ({ key: t, entryId: `${d.id}@${t}`, entry: { text: d.text }, sortKey: d.date, kind: 'doc' }));
};

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('pgproj');
  h.sql = db.sql;
  await db.sql.unsafe(readMigration('154-rationale-index.sql'));
});

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.rationale_index`;
});

describe('PgProjectionStore — generic, table-agnostic ProjectionStore', () => {
  it('rejects a non schema.name table identifier (injection guard)', () => {
    expect(() => new PgProjectionStore({ table: 'rationale_index; DROP TABLE x' })).toThrow();
    expect(() => new PgProjectionStore({ table: 'no_schema' })).toThrow();
  });

  it('round-trips the entry as a real object, not a jsonb string', async () => {
    const store = new PgProjectionStore<{ text: string }>({ table: TABLE });
    await store.applyDelta('doc:1', {
      put: [{ sourceId: 'doc:1', key: 'coord', entryId: 'd1@coord', entry: { text: 'hello' }, sortKey: '2026-06-01', kind: 'doc' }],
      delete: [],
    });
    const rows = await store.byKey('coord');
    expect(rows).toHaveLength(1);
    expect(typeof rows[0]!.entry).toBe('object');
    expect(rows[0]!.entry.text).toBe('hello');
    const [{ t }] = await db.sql<{ t: string }[]>`
      SELECT jsonb_typeof(entry) AS t FROM harness_shared.rationale_index LIMIT 1`;
    expect(t).toBe('object');
  });

  it('byKey matches the InMemory reference for sort / kinds / limit', async () => {
    const pg = new PgProjectionStore<{ text: string }>({ table: TABLE });
    const mem = new InMemoryProjectionStore<{ text: string }>();
    const docs: Doc[] = [
      { id: 'a', topics: ['coord'], text: 'A', date: '2026-06-01' },
      { id: 'b', topics: ['coord'], text: 'B', date: '2026-06-03' },
      { id: 'c', topics: ['coord'], text: 'C', date: '2026-06-02' },
    ];
    for (const d of docs) {
      const put = projector(d).map((c) => ({ ...c, sourceId: `doc:${d.id}` }));
      await pg.applyDelta(`doc:${d.id}`, { put, delete: [] });
      await mem.applyDelta(`doc:${d.id}`, { put, delete: [] });
    }
    for (const opts of [
      undefined,
      { order: 'asc' as const },
      { order: 'desc' as const },
      { kinds: ['doc'] },
      { kinds: ['nonexistent'] },
      { limit: 2 },
    ]) {
      const a = await pg.byKey('coord', opts);
      const b = await mem.byKey('coord', opts);
      expect(a.map((r) => r.entryId)).toEqual(b.map((r) => r.entryId));
    }
  });

  it('full ProjectionIndex round-trip: re-index diffs, retag moves, remove empties', async () => {
    const idx = new ProjectionIndex<Doc, { text: string }>({
      projector,
      store: new PgProjectionStore<{ text: string }>({ table: TABLE }),
    });
    const doc: Doc = { id: 'p', topics: ['coord', 'db'], text: 'v1', date: '2026-06-01' };
    await idx.index('doc:p', doc);
    expect((await idx.query('coord')).map((r) => r.entryId)).toEqual(['p@coord']);
    expect((await idx.query('db')).map((r) => r.entryId)).toEqual(['p@db']);

    // retag: drop 'db', keep 'coord'
    await idx.index('doc:p', { ...doc, topics: ['coord'] });
    expect(await idx.query('db')).toEqual([]);
    expect((await idx.query('coord')).map((r) => r.entryId)).toEqual(['p@coord']);

    await idx.remove('doc:p');
    expect(await idx.query('coord')).toEqual([]);
  });

  it('GuardedProjectionIndex skips a poison record but keeps the index live', async () => {
    const errs: string[] = [];
    const guarded = new GuardedProjectionIndex(
      new ProjectionIndex<Doc, { text: string }>({
        projector,
        store: new PgProjectionStore<{ text: string }>({ table: TABLE }),
      }),
      { onError: (_e, c) => errs.push(c.sourceId) },
    );
    expect(await guarded.applyChange({ op: 'upsert', sourceId: 'doc:g1', record: { id: 'g1', topics: ['coord'], text: 'ok', date: '2026-06-01' } })).toBe(true);
    expect(await guarded.applyChange({ op: 'upsert', sourceId: 'doc:BAD', record: { id: 'BAD', topics: ['coord'], text: 'x', date: '2026-06-02' } })).toBe(false);
    expect(await guarded.applyChange({ op: 'upsert', sourceId: 'doc:g2', record: { id: 'g2', topics: ['coord'], text: 'ok2', date: '2026-06-03' } })).toBe(true);
    expect(errs).toEqual(['doc:BAD']);
    const rows = await guarded.query('coord');
    expect(rows.map((r) => r.entryId).sort()).toEqual(['g1@coord', 'g2@coord']);
  });
});
