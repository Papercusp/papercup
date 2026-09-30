/**
 * chunkAwareVectorLeg against a real Postgres + pgvector (generic-rag-chunking P-006).
 *
 * The helper lives in @papercusp/search, which is a standalone public package and
 * cannot depend on this repo's PG test harness, so its SQL is proven here instead:
 * the fixtures are self-contained tables in a throwaway schema, never host tables.
 *
 * Vectors are 2-D unit vectors given by an angle in degrees, so cosine distance is
 * 1 - cos(angle difference) and every expected ranking can be read off the angles.
 *
 *   R-16  retrieve mode returns a parent whose only match lies in one of its chunks
 *   R-17  gist mode ranks parents by the parent vector alone
 *   R-41  the chunk margin lowers a chunk's similarity before pooling
 */
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import postgres from 'postgres';
import { assertPgReachable } from '@papercusp/test-config/pg';
import * as searchLib from '@papercusp/search';
import { sharedChunkStore, type ChunkAwareVectorLegOptions, type ChunkSurface, type PgHandle } from '@papercusp/search';

/**
 * Mutation-probe seam: PAPERCUSP_VECTOR_LEG_SUBJECT is an absolute path to a
 * copy of libs/generic/search/src/chunks/vector-leg.ts (scripts/mutation-probe.sh
 * points it at a mutant, so the tracked file is never modified). Unset, the real
 * library export runs. The binding is NOT named chunkAwareVectorLeg: R-8's
 * placement scan reads `let <library symbol>:` as a fork, and this is an alias.
 */
let legUnderTest: typeof searchLib.chunkAwareVectorLeg = searchLib.chunkAwareVectorLeg;

const SCHEMA = `vleg_${process.pid}_${Date.now()}`;
const DOCS = `${SCHEMA}.docs`;
const SHARED = `${SCHEMA}.chunks`;
const TYPED = `${SCHEMA}.doc_chunks`;

const vec = (deg: number): string => {
  const r = (deg * Math.PI) / 180;
  return `[${Math.cos(r)},${Math.sin(r)}]`;
};
const dist = (a: number, b: number): number => 1 - Math.cos(((a - b) * Math.PI) / 180);

interface Doc {
  id: string;
  tenant: string;
  /** Parent vector angle; null = the parent has no vector. */
  parent: number | null;
  chunks: number[];
}

// Query angle 0 throughout.
const DOCS_FIXTURE: Doc[] = [
  { id: 'near-parent', tenant: 't1', parent: 20, chunks: [] },
  { id: 'chunk-only', tenant: 't1', parent: 85, chunks: [70, 5] }, // R-16: parent far, chunk 1 near
  { id: 'no-parent-vec', tenant: 't1', parent: null, chunks: [10] }, // R-16: only a chunk exists
  { id: 'mid-parent', tenant: 't1', parent: 40, chunks: [] },
  { id: 'other-tenant', tenant: 't2', parent: 1, chunks: [1] }, // filtered out before LIMIT
];

const surface = (store = sharedChunkStore({ table: SHARED })): ChunkSurface => ({
  surface: 'docs',
  parent: { table: DOCS, key: ['id'] },
  textSql: 'body',
  splitter: { kind: 'window', size: 100, overlap: 10 },
  maxChunks: 8,
  store,
  parentVector: { column: 'emb', profileColumn: 'emb_profile' },
});

describe('chunkAwareVectorLeg (P-006)', () => {
  let sql: postgres.Sql;

  const run = (over: Partial<ChunkAwareVectorLegOptions>) =>
    legUnderTest(sql as unknown as PgHandle, {
      surface: surface(),
      qVec: vec(0),
      limit: 10,
      mode: 'retrieve',
      parentAlias: 'd',
      parentFilter: sql`d.tenant = 't1'`,
      ...over,
    });
  const ids = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.id);

  beforeAll(async () => {
    const subject = process.env.PAPERCUSP_VECTOR_LEG_SUBJECT;
    if (subject) legUnderTest = ((await import(subject)) as typeof searchLib).chunkAwareVectorLeg;
    const dsn = inject('baselineSchemaDsn');
    await assertPgReachable(dsn, 'search/chunks/vector-leg.integration');
    sql = postgres(dsn, { max: 2, onnotice: () => {} });
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
    await sql.unsafe(`CREATE SCHEMA ${SCHEMA}`);
    await sql.unsafe(`CREATE TABLE ${DOCS} (id text PRIMARY KEY, tenant text NOT NULL, body text NOT NULL,
                        emb vector(2), emb_profile text)`);
    await sql.unsafe(`CREATE TABLE ${SHARED} (surface text NOT NULL, parent_key text[] NOT NULL, chunk_idx int NOT NULL,
                        anchor text, embedding vector(2), embedding_profile text, embedding_mode text,
                        PRIMARY KEY (surface, parent_key, chunk_idx))`);
    await sql.unsafe(`CREATE TABLE ${TYPED} (id text NOT NULL, chunk_idx int NOT NULL, embedding vector(2),
                        embedding_profile text, embedding_mode text, PRIMARY KEY (id, chunk_idx))`);
    for (const d of DOCS_FIXTURE) {
      await sql.unsafe(`INSERT INTO ${DOCS} (id, tenant, body, emb, emb_profile) VALUES ($1, $2, $3, $4::vector, $5)`, [
        d.id, d.tenant, `doc ${d.id}`, d.parent === null ? null : vec(d.parent), d.parent === null ? null : 'p1',
      ]);
      for (const [i, angle] of d.chunks.entries()) {
        await sql.unsafe(
          `INSERT INTO ${SHARED} (surface, parent_key, chunk_idx, anchor, embedding, embedding_profile)
           VALUES ('docs', $1::text[], $2, $3, $4::vector, 'p1')`,
          [[d.id], i, `#part-${i}`, vec(angle)],
        );
        await sql.unsafe(
          `INSERT INTO ${TYPED} (id, chunk_idx, embedding, embedding_profile) VALUES ($1, $2, $3::vector, 'p1')`,
          [d.id, i, vec(angle)],
        );
      }
    }
  });

  afterAll(async () => {
    if (!sql) return;
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql.end({ timeout: 5 });
  });

  it('R-16: retrieve mode returns a parent whose only match lies in one of its chunks', async () => {
    const rows = await run({});
    // Pooled best distance per parent: chunk-only 5°, no-parent-vec 10°, near-parent 20°, mid-parent 40°.
    expect(ids(rows)).toEqual(['chunk-only', 'no-parent-vec', 'near-parent', 'mid-parent']);
    const chunkOnly = rows.find((r) => r.id === 'chunk-only')!;
    expect(chunkOnly.matched_anchor).toBe('#part-1');
    // pgvector stores float4 components, so distances match float64 math to ~1e-8, not 1e-9.
    expect(chunkOnly.distance).toBeCloseTo(dist(0, 5), 6);
    expect(rows.find((r) => r.id === 'near-parent')!.matched_anchor).toBeNull();
    // The tenant filter applies inside each leg: the 1° row of t2 never appears.
    expect(ids(rows)).not.toContain('other-tenant');
  });

  it('R-16: the same holds for a per-surface ("typed") chunk table keyed by the parent columns', async () => {
    const rows = await run({ chunks: { table: TYPED, keying: 'typed' } });
    expect(ids(rows)).toEqual(['chunk-only', 'no-parent-vec', 'near-parent', 'mid-parent']);
    expect(rows[0]!.matched_anchor).toBeNull(); // typed tables carry no anchor
  });

  it('R-16: the caller filter is applied BEFORE each leg\'s LIMIT', async () => {
    // With limit 1 and the filter applied after the LIMIT, t2's 1° parent and chunk would take
    // both slots and the leg would return nothing for t1.
    const rows = await run({ limit: 1 });
    expect(ids(rows)).toEqual(['chunk-only']);
  });

  it('R-17: gist mode ranks parents by the parent vector alone', async () => {
    const rows = await run({ mode: 'gist' });
    // Parent angles: near-parent 20°, mid-parent 40°, chunk-only 85°; no-parent-vec has none.
    expect(ids(rows)).toEqual(['near-parent', 'mid-parent', 'chunk-only']);
    for (const r of rows) expect(r.matched_anchor).toBeNull();
    expect(rows[2]!.distance).toBeCloseTo(dist(0, 85), 6);
  });

  it('R-41: a chunk that beats a competitor by less than the margin no longer lifts its parent above it', async () => {
    // no-parent-vec's chunk (10°) beats near-parent's own vector (20°) by
    // dist(0,20) - dist(0,10) ≈ 0.0452. A margin of 0.06 exceeds that, 0.04 does not.
    const gap = dist(0, 20) - dist(0, 10);
    expect(gap).toBeGreaterThan(0.04);
    expect(gap).toBeLessThan(0.06);

    const noMargin = ids(await run({ chunkMargin: 0 }));
    expect(noMargin.indexOf('no-parent-vec')).toBeLessThan(noMargin.indexOf('near-parent'));

    const small = ids(await run({ chunkMargin: 0.04 }));
    expect(small.indexOf('no-parent-vec')).toBeLessThan(small.indexOf('near-parent'));

    const margined = await run({ chunkMargin: 0.06 });
    const order = ids(margined);
    expect(order.indexOf('near-parent')).toBeLessThan(order.indexOf('no-parent-vec'));
    const hit = margined.find((r) => r.id === 'no-parent-vec')!;
    expect(hit.distance).toBeCloseTo(dist(0, 10) + 0.06, 6);
  });

  it('R-41: the margin defaults to the surface\'s chunkMargin', async () => {
    const rows = await run({ surface: { ...surface(), chunkMargin: 0.06 } });
    const order = ids(rows);
    expect(order.indexOf('near-parent')).toBeLessThan(order.indexOf('no-parent-vec'));
  });

  it('applies the injected embedding-space filter to both legs (D-011)', async () => {
    const seen: Array<{ profileColumn: string | null; modeColumn: string | null }> = [];
    const rows = await run({
      spaceFilter: (cols) => {
        seen.push(cols);
        return cols.profileColumn ? sql`${sql.unsafe(cols.profileColumn)} = 'p-other'` : sql`TRUE`;
      },
    });
    expect(rows).toEqual([]);
    expect(seen).toEqual([
      { profileColumn: 'd.emb_profile', modeColumn: null },
      { profileColumn: 'c.embedding_profile', modeColumn: 'c.embedding_mode' },
    ]);
  });

  it('refuses identifiers that are not plain SQL names', async () => {
    await expect(run({ parentAlias: 'd; DROP TABLE x' })).rejects.toThrow(/not a plain identifier/);
    await expect(run({ parentVector: { column: 'emb) OR (1=1' } })).rejects.toThrow(/not a plain identifier/);
  });
});
