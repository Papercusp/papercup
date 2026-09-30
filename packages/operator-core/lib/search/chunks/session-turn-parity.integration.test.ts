/**
 * R-21 (generic-rag-chunking-2026-09-29, P-007, D-002): moving session turns
 * onto the generic chunk engine must not rebuild the chunks that already
 * exist. harness_shared.session_turn_chunks holds ~1.21M rows cut and embedded
 * by the old hand-written writer; re-syncing those turns through the engine
 * (./session-turn-store.ts, driven by ./tick.ts with the real registry entry)
 * must change zero chunk rows and clear zero embeddings.
 *
 * The seed rows are written the way the OLD writer wrote them, so the test is
 * about the stored data, not about rows the new store wrote itself. The SQL in
 * oldWriterWrite() is the old syncTurnChunks write path verbatim (turn-chunk-
 * sync.ts at aedca3d785f3864b3dfdd0544483ab3b7e22b891): DELETE, then INSERT of
 * (key, chunk_idx, content, turn_sha) with content = splitWindows(text,
 * TURN_WINDOW) and turn_sha = turnSha(text), then chunked_at = now(). The
 * embed-backfill sweep then fills embedding / mode / profile.
 *
 * "Changes zero rows" is checked with each row's xmin as well as its values:
 * any UPDATE or DELETE+INSERT gives the row a new xmin even when every value
 * is written back unchanged, so an engine that rewrote identical rows would
 * still fail here.
 *
 * Isolation: the store has no eligibleSql (see its header), so it selects any
 * long unchunked turn in the database. The fixture turns carry an ingested_at
 * in 2099 and the tick's batch equals the fixture size, so the freshest-first
 * scan selects exactly them. That holds only while no OTHER run of this file
 * has 2099 turns in the same database: a concurrent run's freshly inserted
 * (still unchunked) turns would be selected instead. So the whole file holds a
 * session advisory lock from before it seeds until after it cleans up, which
 * serializes concurrent runs against a shared test database.
 *
 * Mutation-probe seam: PAPERCUSP_SESSION_TURN_STORE_SUBJECT is an absolute path
 * to a copy of ./session-turn-store.ts (scripts/mutation-probe.sh points it at a
 * mutant, so the tracked file is never modified). Unset, the real store runs.
 */

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import postgres from 'postgres';
import { assertPgReachable } from '@papercusp/test-config/pg';
import { splitWindows, type ChunkSurface, type ChunkSurfaceSyncStats, type ChunkSyncLogger } from '@papercusp/search';
import { PROSE_VECTOR_DIMS, PROSE_VECTOR_STORAGE_PROFILE } from '../prose-vector-dims';
import { SESSION_TURN_CHUNK_SURFACE, TURN_WINDOW, turnSha } from '../turn-chunk-sync';
import { runChunkSyncTick } from './tick';
import * as realStore from './session-turn-store';

const TAG = `${process.pid}_${Date.now()}`;
const WS = `r21-ws-${TAG}`;
const HARNESS = `r21-h-${TAG}`;
const SOURCE = 'claude';
const PROFILE_ID = PROSE_VECTOR_STORAGE_PROFILE.acceptedProfileIds[0]!;
const MODE = 'gemma';
/** Session advisory lock serializing runs of this file (see the header). */
const FILE_LOCK = 'papercusp:test:session-turn-parity.integration';

/** A distinct unit vector per (turn, chunk), so a swapped or rewritten vector is visible. */
function vec(turn: number, chunk: number): string {
  const r = ((turn * 17 + chunk * 3 + 1) * Math.PI) / 180;
  const v = new Array<number>(PROSE_VECTOR_DIMS).fill(0);
  v[0] = Math.cos(r);
  v[1] = Math.sin(r);
  return `[${v.join(',')}]`;
}

/**
 * Deterministic prose of exactly `len` UTF-16 code units. Only BMP characters,
 * so a window boundary never splits a surrogate pair. Includes non-ASCII and a
 * backslash: the store computes chunk_sha in SQL over convert_to(content,
 * 'UTF8'), which must agree with the engine's JS sha256 for reuse to work.
 */
function prose(seed: string, len: number): string {
  const words = ['turn', 'héllo', 'chunk', 'a\\x41b', 'vector', '中文', 'recall', '✓', 'session', 'window'];
  let out = '';
  let i = 0;
  while (out.length < len) out += `${seed}-${words[i++ % words.length]} `;
  return out.slice(0, len);
}

interface FixtureTurn {
  idx: number;
  text: string;
}

// Lengths: just over the 2000 cut, typical, the ingest cap, and one long
// enough to exceed maxChunks (16 windows cover 20,250 code units).
const UNCHANGED: FixtureTurn[] = [
  { idx: 0, text: prose('t0', 2001) },
  { idx: 1, text: prose('t1', 4321) },
  { idx: 2, text: prose('t2', 8000) },
  { idx: 3, text: prose('t3', 25_000) },
];

// Control: stored chunks were cut from OLD_TEXT, but the turn's text is
// RECUT_TEXT (same first 3000 code units, different tail). The engine must
// re-cut it, reuse the embeddings of chunks whose content is unchanged, and
// leave only the changed chunks unembedded.
const RECUT_IDX = 10;
const SHARED_PREFIX = prose('shared', 3000);
const RECUT_TEXT = SHARED_PREFIX + prose('new-tail', 2600);
const OLD_TEXT = SHARED_PREFIX + prose('old-tail', 3100);

function ingestedAt(idx: number): string {
  return new Date(Date.UTC(2099, 0, 1, 0, idx)).toISOString();
}

interface ChunkRow {
  turn_idx: number;
  chunk_idx: number;
  content: string;
  turn_sha: string;
  embedding: string | null;
  embedding_mode: string | null;
  embedding_profile: string | null;
  updated_at: string;
  xmin: string;
}

describe('session-turn engine parity: re-sync rebuilds nothing (R-21)', () => {
  let sql: postgres.Sql;
  let surface: ChunkSurface = SESSION_TURN_CHUNK_SURFACE;
  const logged: { level: 'warn' | 'error'; message: string; meta?: Record<string, unknown> }[] = [];
  const logger: ChunkSyncLogger = {
    warn: (message, meta) => logged.push({ level: 'warn', message, meta }),
    error: (message, meta) => logged.push({ level: 'error', message, meta }),
  };

  const chunkRows = (turnIdxs: readonly number[]) =>
    sql.unsafe<ChunkRow[]>(
      `SELECT turn_idx, chunk_idx, content, turn_sha, embedding::text AS embedding, embedding_mode,
              embedding_profile, updated_at::text AS updated_at, xmin::text AS xmin
         FROM harness_shared.session_turn_chunks
        WHERE workspace_id = $1 AND source_kind = $2 AND session_id = $3 AND turn_idx = ANY($4::int[])
        ORDER BY turn_idx, chunk_idx`,
      [WS, SOURCE, `r21-session-${TAG}`, [...turnIdxs]],
    );

  const chunkedAt = (turnIdxs: readonly number[]) =>
    sql.unsafe<{ turn_idx: number; chunked: boolean }[]>(
      `SELECT turn_idx, chunked_at IS NOT NULL AS chunked FROM harness_shared.session_turns
        WHERE workspace_id = $1 AND source_kind = $2 AND session_id = $3 AND turn_idx = ANY($4::int[])
        ORDER BY turn_idx`,
      [WS, SOURCE, `r21-session-${TAG}`, [...turnIdxs]],
    );

  async function insertTurn(idx: number, text: string): Promise<void> {
    await sql.unsafe(
      `INSERT INTO harness_shared.session_turns
         (workspace_id, source_kind, session_id, turn_idx, speaker, text, harness_slug, ts, ingested_at)
       VALUES ($1, $2, $3, $4, 'assistant', $5, $6, $7::timestamptz, $7::timestamptz)`,
      [WS, SOURCE, `r21-session-${TAG}`, idx, text, HARNESS, ingestedAt(idx)],
    );
  }

  /** The old syncTurnChunks write for one turn (see the header), then the embed sweep. */
  async function oldWriterWrite(idx: number, cutFrom: string): Promise<void> {
    const key = [WS, SOURCE, `r21-session-${TAG}`, idx] as const;
    const sha = turnSha(cutFrom);
    const chunks = splitWindows(cutFrom, TURN_WINDOW);
    await sql.unsafe(
      `DELETE FROM harness_shared.session_turn_chunks
        WHERE workspace_id = $1 AND source_kind = $2 AND session_id = $3 AND turn_idx = $4`,
      [...key],
    );
    const params: Array<string | number> = [];
    const values = chunks
      .map((content, i) => {
        params.push(...key, i, content, sha);
        const b = i * 7;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
      })
      .join(', ');
    await sql.unsafe(
      `INSERT INTO harness_shared.session_turn_chunks
         (workspace_id, source_kind, session_id, turn_idx, chunk_idx, content, turn_sha)
       VALUES ${values}
       ON CONFLICT (workspace_id, source_kind, session_id, turn_idx, chunk_idx)
       DO UPDATE SET content = EXCLUDED.content,
                     turn_sha = EXCLUDED.turn_sha,
                     updated_at = now(),
                     embedding = NULL,
                     embedding_mode = NULL,
                     embedding_profile = NULL`,
      params,
    );
    await sql.unsafe(
      `UPDATE harness_shared.session_turns SET chunked_at = now()
        WHERE workspace_id = $1 AND source_kind = $2 AND session_id = $3 AND turn_idx = $4`,
      [...key],
    );
    for (let i = 0; i < chunks.length; i++) {
      await sql.unsafe(
        `UPDATE harness_shared.session_turn_chunks
            SET embedding = $6::vector, embedding_mode = $7, embedding_profile = $8
          WHERE workspace_id = $1 AND source_kind = $2 AND session_id = $3 AND turn_idx = $4 AND chunk_idx = $5`,
        [...key, i, vec(idx, i), MODE, PROFILE_ID],
      );
    }
  }

  /** Re-open a turn for the engine, as migration 1117 does for its backlog. */
  async function reopen(idxs: readonly number[]): Promise<void> {
    await sql.unsafe(
      `UPDATE harness_shared.session_turns SET chunked_at = NULL
        WHERE workspace_id = $1 AND source_kind = $2 AND session_id = $3 AND turn_idx = ANY($4::int[])`,
      [WS, SOURCE, `r21-session-${TAG}`, [...idxs]],
    );
  }

  async function syncOnce(batch: number): Promise<ChunkSurfaceSyncStats> {
    const res = await runChunkSyncTick({ sql, surfaces: [surface], batchPerSurface: batch, pruneBatch: 0, logger });
    expect(res, JSON.stringify(res)).toHaveProperty('surfaces');
    const s = (res as { surfaces: ChunkSurfaceSyncStats[] }).surfaces[0];
    expect(s, 'the tick synced the session-turn surface').toBeDefined();
    return s!;
  }

  beforeAll(async () => {
    const subject = process.env.PAPERCUSP_SESSION_TURN_STORE_SUBJECT;
    if (subject) {
      const mod = (await import(subject)) as typeof realStore;
      surface = { ...SESSION_TURN_CHUNK_SURFACE, store: mod.sessionTurnChunkStore() };
    } else {
      surface = { ...SESSION_TURN_CHUNK_SURFACE, store: realStore.sessionTurnChunkStore() };
    }
    const dsn = inject('baselineSchemaDsn');
    await assertPgReachable(dsn, 'chunks/session-turn-parity.integration');
    // max 1: the advisory lock is held by the session, so every query of this
    // file (the engine's included) must run on the one connection that holds it.
    sql = postgres(dsn, { max: 1, onnotice: () => {} });
    await sql`SELECT pg_advisory_lock(hashtext(${FILE_LOCK}))`;
    // Holding the lock, no other run of this file is live, so any fixture turns
    // left here were stranded by a run killed before its afterAll. Left in
    // place, their 2099 stamps would win the freshest-first scan over ours.
    await sql`DELETE FROM harness_shared.session_turns WHERE harness_slug LIKE 'r21-h-%'`;
    for (const t of UNCHANGED) {
      await insertTurn(t.idx, t.text);
      await oldWriterWrite(t.idx, t.text);
    }
    await insertTurn(RECUT_IDX, RECUT_TEXT);
    await oldWriterWrite(RECUT_IDX, OLD_TEXT);
  });

  afterAll(async () => {
    if (!sql) return;
    // Chunks cascade with their turns (the parent FK).
    try {
      await sql`DELETE FROM harness_shared.session_turns WHERE harness_slug = ${HARNESS}`;
    } finally {
      // Ending the session would release it too; unlocking first frees a waiting run sooner.
      await sql`SELECT pg_advisory_unlock(hashtext(${FILE_LOCK}))`.catch(() => {});
      await sql.end({ timeout: 5 });
    }
  });

  it('seeds old-writer rows that are fully embedded, including a turn truncated at maxChunks', async () => {
    const rows = await chunkRows(UNCHANGED.map((t) => t.idx));
    const expected = UNCHANGED.reduce((n, t) => n + splitWindows(t.text, TURN_WINDOW).length, 0);
    expect(rows).toHaveLength(expected);
    expect(rows.every((r) => r.embedding !== null && r.embedding_profile === PROFILE_ID)).toBe(true);
    expect(rows.filter((r) => r.turn_idx === 3)).toHaveLength(TURN_WINDOW.maxChunks);
  });

  it('re-syncing old-writer turns takes the unchanged path: zero rows rewritten, zero embeddings cleared', async () => {
    const idxs = UNCHANGED.map((t) => t.idx);
    const before = await chunkRows(idxs);
    await reopen(idxs);
    logged.length = 0;

    const s = await syncOnce(UNCHANGED.length);
    const after = await chunkRows(idxs);

    const cleared = after.filter((r, i) => before[i]?.embedding !== null && r.embedding === null).length;
    expect(cleared, 'embeddings cleared by the re-sync').toBe(0);
    // Byte-identical, and never written: the same xmin means no UPDATE and no DELETE+INSERT touched the row.
    expect(after).toEqual(before);
    expect(s).toMatchObject({
      parentsUnchanged: UNCHANGED.length,
      parentsSynced: 0,
      parentsEmpty: 0,
      chunksWritten: 0,
      embeddingsReused: 0,
      errors: 0,
    });
    expect(logged.filter((l) => l.level === 'error')).toEqual([]);
    // Every re-opened turn is retired from detection again.
    expect((await chunkedAt(idxs)).map((r) => r.chunked)).toEqual(idxs.map(() => true));
  });

  it('control: a turn whose stored cut is stale is re-cut, keeping the embeddings of unchanged chunks only', async () => {
    const newCut = splitWindows(RECUT_TEXT, TURN_WINDOW);
    const oldCut = splitWindows(OLD_TEXT, TURN_WINDOW);
    const sameContent = newCut.map((c, i) => oldCut[i] === c);
    // The fixture must exercise both branches, or this control proves nothing.
    expect(sameContent.filter(Boolean).length).toBeGreaterThan(0);
    expect(sameContent.filter((x) => !x).length).toBeGreaterThan(0);

    const before = await chunkRows([RECUT_IDX]);
    await reopen([RECUT_IDX]);
    logged.length = 0;

    const s = await syncOnce(1);
    const after = await chunkRows([RECUT_IDX]);

    expect(s).toMatchObject({ parentsSynced: 1, parentsUnchanged: 0, chunksWritten: newCut.length, errors: 0 });
    expect(s.embeddingsReused).toBe(sameContent.filter(Boolean).length);
    expect(after.map((r) => r.content)).toEqual(newCut);
    expect(after.every((r) => r.turn_sha === turnSha(RECUT_TEXT))).toBe(true);
    for (const [i, row] of after.entries()) {
      if (sameContent[i]) {
        // Reused by content, so the vector, mode and profile carry over exactly.
        expect(row.embedding, `chunk ${i} keeps its vector`).toBe(before[i]!.embedding);
        expect(row.embedding_mode).toBe(MODE);
        expect(row.embedding_profile).toBe(PROFILE_ID);
      } else {
        expect(row.embedding, `chunk ${i} changed, so it is re-embedded`).toBeNull();
        expect(row.embedding_profile).toBeNull();
      }
    }
    // The rows WERE rewritten here, which is what shows the xmin check in the parity case can see a rewrite.
    expect(after[0]!.xmin).not.toBe(before[0]!.xmin);
    expect((await chunkedAt([RECUT_IDX]))[0]?.chunked).toBe(true);
  });
});
