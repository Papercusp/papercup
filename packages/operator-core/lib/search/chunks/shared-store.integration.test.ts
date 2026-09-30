/**
 * The shared chunk store's SQL against real Postgres (migration 1242's
 * harness_shared.text_chunks), driven through papercusp's tick.
 *
 * The engine's own tests (libs/generic/search/src/chunks/engine.test.ts) use
 * an in-memory store; this file proves the SQL store behaves the same way:
 * selection, the SQL parent-sha form agreeing with the JS one, embedding
 * reuse across a re-split, the bigint key cast in the prune anti-join, and the
 * version-stamped freshness check.
 */

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import postgres from 'postgres';
import { assertPgReachable } from '@papercusp/test-config/pg';
import {
  embeddedChunkText,
  parentShaOf,
  type ChunkSurface,
  type ChunkSyncLogger,
  type ChunkSyncResult,
} from '@papercusp/search';
import { PROSE_VECTOR_DIMS } from '../prose-vector-dims';
import { CHUNK_STORES, TEXT_CHUNKS_TABLE } from './registry';
import { runChunkSyncTick, sha256Hex } from './tick';

const TAG = `${process.pid}_${Date.now()}`;
const TABLE = `public.chunk_it_parents_${TAG}`;
const VECTOR = `[${Array.from({ length: PROSE_VECTOR_DIMS }, (_, i) => ((i % 5) + 1) / 10).join(',')}]`;

// Each test owns ids [lo, lo + 9] of the shared fixture table, so one test's
// surface never picks up another test's rows.
const surface = (name: string, lo: number, over: Partial<ChunkSurface> = {}): ChunkSurface => ({
  surface: `it-${name}-${TAG}`,
  parent: { table: TABLE, key: [{ column: 'id', type: 'bigint' }] },
  textSql: 'p.body',
  headerSql: 'p.title',
  eligibleSql: `NOT p.hidden AND p.id BETWEEN ${lo} AND ${lo + 9}`,
  versionSql: 'p.updated_at',
  minChars: 100,
  splitter: { kind: 'window', size: 60, overlap: 10 },
  maxChunks: 8,
  ...over,
});

function stats(res: unknown) {
  expect(res).toHaveProperty('surfaces');
  return (res as ChunkSyncResult).surfaces[0]!;
}

describe('shared chunk store (live SQL, harness_shared.text_chunks)', () => {
  let sql: postgres.Sql;
  const chunks = (s: ChunkSurface) =>
    sql.unsafe<
      { parent_key: string[]; chunk_idx: number; header: string | null; content: string; chunk_sha: string; parent_sha: string; has_embedding: boolean }[]
    >(
      `SELECT parent_key, chunk_idx, header, content, chunk_sha, parent_sha, embedding IS NOT NULL AS has_embedding
         FROM harness_shared.text_chunks WHERE surface = $1 ORDER BY parent_key, chunk_idx`,
      [s.surface],
    );
  const logged: { level: 'warn' | 'error'; message: string; meta?: Record<string, unknown> }[] = [];
  const logger: ChunkSyncLogger = {
    warn: (message, meta) => logged.push({ level: 'warn', message, meta }),
    error: (message, meta) => logged.push({ level: 'error', message, meta }),
  };
  const tick = (s: ChunkSurface) => runChunkSyncTick({ sql, surfaces: [s], logger });
  let chunkStores: readonly (typeof CHUNK_STORES)[number][] = CHUNK_STORES;

  beforeAll(async () => {
    // Mutation-probe seam: PAPERCUSP_CHUNK_REGISTRY_SUBJECT is an absolute path
    // to a copy of ./registry.ts (scripts/mutation-probe.sh points it at a
    // mutant, so the tracked file is never modified). Unset, the real
    // CHUNK_STORES is read by the R-38 embed-text check.
    const subject = process.env.PAPERCUSP_CHUNK_REGISTRY_SUBJECT;
    if (subject) chunkStores = ((await import(subject)) as { CHUNK_STORES: typeof CHUNK_STORES }).CHUNK_STORES;
    const dsn = inject('baselineSchemaDsn');
    await assertPgReachable(dsn, 'chunks/shared-store.integration');
    sql = postgres(dsn, { max: 1, onnotice: () => {} });
    await sql.unsafe(
      `CREATE TABLE ${TABLE} (id bigint PRIMARY KEY, title text, body text NOT NULL,
         updated_at timestamptz NOT NULL DEFAULT now(), hidden boolean NOT NULL DEFAULT false)`,
    );
  });

  afterAll(async () => {
    // No test except the cap test expects a warning, and none expects an error.
    expect(logged.filter((l) => l.level === 'error')).toEqual([]);
    if (!sql) return;
    await sql.unsafe(`DELETE FROM harness_shared.text_chunks WHERE surface LIKE $1`, [`it-%-${TAG}`]);
    await sql.unsafe(`DROP TABLE IF EXISTS ${TABLE}`);
    await sql.end();
  });

  it('writes the chunks of long, eligible parents with the embedded header and hashes', async () => {
    const s = surface('write', 1);
    await sql.unsafe(`INSERT INTO ${TABLE} (id, title, body) VALUES (1, 'Note one', $1), (2, 'Short', 'tiny'), (3, 'Hidden', $1)`, [
      'a'.repeat(150),
    ]);
    await sql.unsafe(`UPDATE ${TABLE} SET hidden = true WHERE id = 3`);
    const st = stats(await tick(s));
    expect(st).toMatchObject({ parentsSynced: 1, chunksWritten: 3, errors: 0 });
    const rows = await chunks(s);
    expect(rows.map((r) => [r.parent_key, r.chunk_idx])).toEqual([
      [['1'], 0],
      [['1'], 1],
      [['1'], 2],
    ]);
    expect(rows[0]!.header).toBe('Note one');
    expect(rows[0]!.chunk_sha).toBe(sha256Hex(embeddedChunkText('Note one', 'a'.repeat(60))));
    expect(rows[0]!.parent_sha).toBe(parentShaOf(sha256Hex, 'a'.repeat(150), 'Note one'));
    // The stored version keeps the parent's microseconds (postgres-js would
    // truncate a timestamptz parameter to milliseconds).
    const [v] = await sql.unsafe<{ same: boolean }[]>(
      `SELECT bool_and(c.updated_at = p.updated_at) AS same FROM harness_shared.text_chunks c
         JOIN ${TABLE} p ON c.parent_key = ARRAY[p.id::text] WHERE c.surface = $1`,
      [s.surface],
    );
    expect(v!.same).toBe(true);
    // Up to date now: a second tick selects nothing.
    expect(stats(await tick(s))).toMatchObject({ parentsSynced: 0, parentsUnchanged: 0 });
  });

  it('without versionSql, the SQL parent sha equals the JS one (no endless re-selection)', async () => {
    const s = surface('unversioned', 10, { versionSql: undefined });
    await sql.unsafe(`INSERT INTO ${TABLE} (id, title, body) VALUES (10, 'Hdr', $1), (11, NULL, $2), (12, '', $2)`, [
      'é'.repeat(130),
      'ü'.repeat(140),
    ]);
    expect(stats(await tick(s)).parentsSynced).toBeGreaterThanOrEqual(3);
    expect(stats(await tick(s))).toMatchObject({ parentsSynced: 0, parentsUnchanged: 0, errors: 0 });
    // An edit is detected through the SQL hash.
    await sql.unsafe(`UPDATE ${TABLE} SET body = $1 WHERE id = 11`, ['ö'.repeat(140)]);
    expect(stats(await tick(s))).toMatchObject({ parentsSynced: 1 });
  });

  it('a re-split copies the embeddings of unchanged chunks and leaves changed ones for the sweep', async () => {
    const s = surface('reuse', 20, { splitter: { kind: 'markdown', maxChars: 400 }, maxChunks: 16 });
    const doc = (b: string) => `## Alpha\n\n${'alpha '.repeat(30)}\n\n## Beta\n\n${b}\n\n## Gamma\n\n${'gamma '.repeat(30)}\n`;
    await sql.unsafe(`INSERT INTO ${TABLE} (id, title, body, updated_at) VALUES (20, 'Doc', $1, now() - interval '1 hour')`, [
      doc('beta '.repeat(30)),
    ]);
    expect(stats(await tick(s))).toMatchObject({ parentsSynced: 1, chunksWritten: 3 });
    await sql.unsafe(`UPDATE harness_shared.text_chunks SET embedding = $2::vector, embedding_mode = 'gemma' WHERE surface = $1`, [
      s.surface,
      VECTOR,
    ]);
    await sql.unsafe(`UPDATE ${TABLE} SET body = $1, updated_at = now() WHERE id = 20`, [doc('beta EDITED '.repeat(30))]);
    const st = stats(await tick(s));
    expect(st).toMatchObject({ parentsSynced: 1, chunksWritten: 3, embeddingsReused: 2, errors: 0 });
    expect((await chunks(s)).map((r) => r.has_embedding)).toEqual([true, false, true]);
    const [copied] = await sql.unsafe<{ same: boolean }[]>(
      `SELECT embedding = $2::vector AS same FROM harness_shared.text_chunks WHERE surface = $1 AND chunk_idx = 0`,
      [s.surface, VECTOR],
    );
    expect(copied!.same).toBe(true);
  });

  it('a version bump without a text change only advances updated_at', async () => {
    const s = surface('touch', 30);
    await sql.unsafe(`INSERT INTO ${TABLE} (id, title, body, updated_at) VALUES (30, 'T', $1, now() - interval '1 hour')`, [
      'c'.repeat(150),
    ]);
    await tick(s);
    await sql.unsafe(`UPDATE ${TABLE} SET updated_at = now() WHERE id = 30`);
    expect(stats(await tick(s))).toMatchObject({ parentsUnchanged: 1, parentsSynced: 0 });
    expect(stats(await tick(s))).toMatchObject({ parentsUnchanged: 0, parentsSynced: 0 });
  });

  it('prunes deleted, hidden and shrunken parents through the bigint key cast', async () => {
    const s = surface('prune', 40);
    await sql.unsafe(
      `INSERT INTO ${TABLE} (id, title, body) VALUES (40, 'A', $1), (41, 'B', $1), (42, 'C', $1), (43, 'D', $1)`,
      ['d'.repeat(150)],
    );
    expect(stats(await tick(s)).chunksWritten).toBe(12);
    await sql.unsafe(`DELETE FROM ${TABLE} WHERE id = 40`);
    await sql.unsafe(`UPDATE ${TABLE} SET hidden = true, updated_at = now() WHERE id = 41`);
    await sql.unsafe(`UPDATE ${TABLE} SET body = 'short now', updated_at = now() WHERE id = 42`);
    expect(stats(await tick(s))).toMatchObject({ pruned: 9, errors: 0 });
    expect([...new Set((await chunks(s)).map((r) => r.parent_key[0]))]).toEqual(['43']);
  });

  it('R-38: only parents over 2,000 chars are chunked by default, and the sweep embeds header, one newline, content', async () => {
    // Default floor: resolveChunkSurface's minChars is 2,000 when a surface sets none.
    const s = surface('r38', 60, { minChars: undefined, splitter: { kind: 'window', size: 1500, overlap: 100 } });
    await sql.unsafe(
      `INSERT INTO ${TABLE} (id, title, body) VALUES (60, 'Head', $1), (61, NULL, $1), (62, '', $1), (63, 'Exact', $2)`,
      ['f'.repeat(2001), 'g'.repeat(2000)],
    );
    expect(stats(await tick(s))).toMatchObject({ parentsSynced: 3, errors: 0 });
    const rows = await chunks(s);
    expect([...new Set(rows.map((r) => r.parent_key[0]))]).toEqual(['60', '61', '62']);
    // The embed sweep's text for this store, evaluated on the stored rows. It
    // must be exactly what chunk_sha hashes and what the P-001 bench embedded.
    const store = chunkStores.find((c) => c.table === TEXT_CHUNKS_TABLE);
    expect(store).toBeDefined();
    const embedded = await sql.unsafe<{ header: string | null; content: string; text: string }[]>(
      `SELECT header, content, ${store!.embeddedTextSql} AS text FROM harness_shared.text_chunks WHERE surface = $1`,
      [s.surface],
    );
    expect(embedded.length).toBe(rows.length);
    expect(embedded.map((r) => r.header ?? null).sort()).toEqual(expect.arrayContaining(['Head', null]));
    for (const r of embedded) expect(r.text).toBe(embeddedChunkText(r.header, r.content));
    expect(embedded.find((r) => r.header === 'Head')!.text.startsWith('Head\nf')).toBe(true);
  });

  it('caps a long parent at maxChunks and reports it', async () => {
    const s = surface('cap', 50, { maxChunks: 4 });
    await sql.unsafe(`INSERT INTO ${TABLE} (id, title, body) VALUES (50, 'Long', $1)`, ['e'.repeat(2000)]);
    expect(stats(await tick(s))).toMatchObject({ parentsSynced: 1, chunksWritten: 4, parentsTruncatedByMaxChunks: 1 });
    expect(await chunks(s)).toHaveLength(4);
    const warned = logged.filter((l) => l.level === 'warn' && l.meta?.surface === s.surface);
    expect(warned).toHaveLength(1);
    expect(warned[0]!.meta).toMatchObject({ key: ['50'], maxChunks: 4 });
  });
});
