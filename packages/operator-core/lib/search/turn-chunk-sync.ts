/**
 * turn-chunk-sync — derive per-chunk rows for LONG session turns into
 * harness_shared.session_turn_chunks (migration 749) so the embed-backfill
 * sweep can vectorize them for the transcript search semantic leg (P-034,
 * semantic-search-fingerprint-coverage-2026-08-03, decision D-016).
 *
 * THE DEFECT THIS CLOSES. `session_turns.text_embedding` is built from
 * `left(text, 2000)`. Everything past that cut has no vector and is
 * unretrievable by the semantic leg — measured 2026-08-03, 33,232 turns (8.1%)
 * carry ~90.5M invisible characters, and a probe drawn from past the cut ranks
 * its true parent turn at MRR ~0.25 / recall@1 ~14% against 59 distractors.
 * Chunking lifts the SAME corpus and SAME queries to MRR 0.73-0.84 / recall@1
 * 60-75% (+216% to +230%).
 *
 * Responsibility split mirrors doc-embed-sync.ts (and session-ingest.ts before
 * it): THIS module only derives chunk TEXT into PG (sha-keyed change detection,
 * no network, never blocks a writer) — embeddings are filled by the
 * embed-backfill sweep's session_turn_chunks TARGETS entry (bench admission
 * lane, space-aware re-embed on mode flips).
 *
 * ⚠ THE SPLITTER IS THE MEASURED ONE, NOT A REIMPLEMENTATION OF IT.
 * `splitTurnChunks` below is the exact algorithm D-016's numbers came from, and
 * the bench that produced them (memory/bench/turn-truncation-width-cli.ts) now
 * IMPORTS it rather than carrying its own copy. That is deliberate: a benchmark
 * that measures a private copy of the algorithm stops being evidence about the
 * shipped path the moment the two drift, and the drift is silent — both keep
 * "working". Re-running the bench now re-measures production.
 */

import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

/**
 * Chunk width, in characters. 1500 is the measured arm from D-016 — not a
 * round number picked for looks.
 */
export const TURN_CHUNK_CHARS = 1500;

/**
 * Overlap between consecutive chunks. Keeps a probe that STRADDLES a chunk
 * boundary from being split across two vectors and diluted in both — without
 * it, retrieval quality depends on where the boundary happens to fall relative
 * to the content, which is the same position-dependence that disqualified every
 * fixed truncation width.
 */
export const TURN_CHUNK_OVERLAP = 250;

/**
 * Only turns LONGER than this are chunked.
 *
 * This is the parent's own `left(text, 2000)` embed width, and the equality is
 * the whole point: a turn at or below it is ALREADY fully covered by its own
 * `session_turns.text_embedding`, so chunking it would add rows, vectors, and
 * sweep cost for exactly zero recall. Raising the parent's cut would require
 * raising this in lockstep — they are one number wearing two hats.
 */
export const TURN_CHUNK_MIN_TEXT_CHARS = 2000;

/**
 * Hard bound on chunks derived from ONE turn.
 *
 * Measured 2026-08-03: `max(length(text))` over the live 409,002-row
 * session_turns is exactly 8000 (turns are capped at ingest), which yields 7
 * chunks at the constants above. 16 is therefore pure headroom against that cap
 * being raised later — it exists so a pathological turn can never emit an
 * unbounded INSERT, not because it is expected to bind.
 */
export const MAX_CHUNKS_PER_TURN = 16;

/** How many parent turns one sync pass processes. */
const DEFAULT_BATCH = 200;

export interface TurnChunkSyncStats {
  /** Parent turns whose chunks were (re)written this pass. */
  turns: number;
  /** Chunk rows inserted this pass. */
  chunks: number;
  errors: number;
  /** True when the pass filled its batch — i.e. there is more work waiting. */
  more: boolean;
}

/**
 * Split a turn's text into overlapping chunks.
 *
 * THE EXACT ALGORITHM D-016 MEASURED. Step is `size - overlap`, and the loop
 * stops as soon as a chunk reaches the end of the text, so the final chunk is
 * whatever remains rather than a padded or re-anchored window.
 *
 * A turn is scored at query time by the MAX over its chunk vectors, never the
 * mean — a turn is relevant if ANY part of it is, which is how a chunked index
 * is queried. Averaging would reintroduce exactly the dilution chunking exists
 * to remove.
 */
export function splitTurnChunks(
  text: string,
  opts: { size?: number; overlap?: number; maxChunks?: number } = {},
): string[] {
  const size = opts.size ?? TURN_CHUNK_CHARS;
  const overlap = opts.overlap ?? TURN_CHUNK_OVERLAP;
  const maxChunks = opts.maxChunks ?? MAX_CHUNKS_PER_TURN;
  if (text.length === 0) return [];
  const step = Math.max(1, size - overlap);
  const out: string[] = [];
  for (let s = 0; s < text.length; s += step) {
    out.push(text.slice(s, s + size));
    if (out.length >= maxChunks) break;
    if (s + size >= text.length) break;
  }
  return out;
}

/**
 * sha256 of a turn's full text — the change key.
 *
 * MUST agree with the SQL side's `encode(sha256(text::bytea),'hex')`, which is
 * what the staleness filter compares against. Verified equal against the live
 * database 2026-08-03: both produce
 * 2cf24dba…938b9824 for 'hello'. They agree because Postgres casts `text` to
 * `bytea` in the database encoding (UTF8 here) and Node's `update(string)`
 * defaults to utf8 — if either side ever changes encoding, every turn reads as
 * permanently stale and the sync re-writes the whole table every pass.
 */
export function turnSha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface StaleTurnRow {
  workspace_id: string;
  source_kind: string;
  session_id: string;
  turn_idx: number;
  text: string;
  sha: string;
}

/**
 * One sync pass: find chunkable turns whose chunks are missing or stale, and
 * replace them.
 *
 * FRESHEST-FIRST (P-005 discipline, matching the embed sweep): a newly-written
 * long turn is chunked — and therefore searchable — within one tick, while the
 * historical backlog drains underneath it. The alternative (unordered) samples
 * the backlog arbitrarily, which is what made new-row coverage read 7% while
 * the sweep was in fact keeping up: that number measured the ORDERING, not the
 * drain rate.
 *
 * Staleness is `no chunk row for this turn carries the current text sha`, so an
 * edited or re-ingested turn re-chunks wholesale and an unchanged one costs a
 * single PK probe. Per-turn fail-open: one bad turn is counted and skipped,
 * never poisoning the pass.
 */
export async function syncTurnChunks(
  sql: Sql,
  opts: { batch?: number; minChars?: number } = {},
): Promise<TurnChunkSyncStats> {
  const batch = opts.batch ?? DEFAULT_BATCH;
  const minChars = opts.minChars ?? TURN_CHUNK_MIN_TEXT_CHARS;
  const stats: TurnChunkSyncStats = { turns: 0, chunks: 0, errors: 0, more: false };

  const stale = await sql.unsafe<StaleTurnRow[]>(
    `SELECT st.workspace_id, st.source_kind, st.session_id, st.turn_idx, st.text,
            encode(sha256(st.text::bytea), 'hex') AS sha
       FROM harness_shared.session_turns st
      WHERE length(st.text) > $1
        AND NOT EXISTS (
              SELECT 1 FROM harness_shared.session_turn_chunks c
               WHERE c.workspace_id = st.workspace_id
                 AND c.source_kind  = st.source_kind
                 AND c.session_id   = st.session_id
                 AND c.turn_idx     = st.turn_idx
                 AND c.turn_sha     = encode(sha256(st.text::bytea), 'hex')
            )
      ORDER BY st.ingested_at DESC
      LIMIT $2`,
    [minChars, batch],
  );
  stats.more = stale.length >= batch;

  for (const t of stale) {
    try {
      const chunks = splitTurnChunks(t.text);
      // Replace wholesale: a shorter re-ingested turn must not leave its old
      // tail chunks behind, and an ON CONFLICT upsert cannot delete them.
      await sql.unsafe(
        `DELETE FROM harness_shared.session_turn_chunks
          WHERE workspace_id = $1 AND source_kind = $2 AND session_id = $3 AND turn_idx = $4`,
        [t.workspace_id, t.source_kind, t.session_id, t.turn_idx],
      );
      if (chunks.length > 0) {
        const params: unknown[] = [];
        const values = chunks
          .map((content, i) => {
            params.push(t.workspace_id, t.source_kind, t.session_id, t.turn_idx, i, content, t.sha);
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
                         embedding_mode = NULL`,
          params,
        );
        stats.chunks += chunks.length;
      }
      stats.turns += 1;
    } catch {
      stats.errors += 1;
    }
  }
  return stats;
}

async function turnChunksTableExists(sql: Sql): Promise<boolean> {
  const t = await sql.unsafe<Array<{ c: number }>>(
    `SELECT 1 AS c FROM information_schema.tables
      WHERE table_schema = 'harness_shared' AND table_name = 'session_turn_chunks'`,
  );
  return t.length > 0;
}

// State pinned to globalThis (perf rule A18, mirrors embed-backfill's and
// doc-embed-sync's sweep state): tsx / dual-path imports can instantiate this
// module twice.
interface TurnChunkSyncState {
  running: boolean;
  fails: number;
}
const __turnChunkStateKey = Symbol.for('papercusp.turnChunkSyncState');
const __turnChunkState: TurnChunkSyncState = (() => {
  const g = globalThis as typeof globalThis & { [__turnChunkStateKey]?: TurnChunkSyncState };
  if (!g[__turnChunkStateKey]) g[__turnChunkStateKey] = { running: false, fails: 0 };
  return g[__turnChunkStateKey]!;
})();

/** Persistent-failure bound — stops re-paying a failing pass every tick. */
const MAX_SYNC_FAILURES = 5;

/**
 * One sync pass per sweep tick, called from the periodic embed-backfill tick.
 *
 * Unlike doc-embed-sync's ONCE-per-process contract, this runs EVERY tick: its
 * source is a table that grows continuously, not a filesystem corpus frozen
 * behind a process-lifetime memoized adapter. Re-probes migration 749 each tick
 * until it exists, so a live-applied migration is picked up without a restart.
 * VITEST-inert — unrelated tests must never pay a corpus pass (the WI-3792
 * load-scar class).
 */
export async function runTurnChunkSyncTick(
  opts: { batch?: number } = {},
): Promise<TurnChunkSyncStats | { skipped: string }> {
  if (process.env.VITEST) return { skipped: 'vitest' };
  if (__turnChunkState.running) return { skipped: 'already_running' };
  if (__turnChunkState.fails >= MAX_SYNC_FAILURES) return { skipped: 'too_many_failures' };
  __turnChunkState.running = true;
  try {
    const { sql } = getOrgPg();
    if (!(await turnChunksTableExists(sql))) return { skipped: 'migration_749_absent' };
    const stats = await syncTurnChunks(sql, opts);
    if (stats.turns > 0) {
      console.log(
        `[turn-chunk-sync] ${stats.turns} turns -> ${stats.chunks} chunks` +
          `${stats.errors > 0 ? `, ${stats.errors} errors` : ''}${stats.more ? ' (more pending)' : ''}`,
      );
    }
    return stats;
  } catch (err) {
    __turnChunkState.fails += 1;
    console.warn('[turn-chunk-sync] sync failed:', (err as Error).message);
    return { skipped: 'error' };
  } finally {
    __turnChunkState.running = false;
  }
}
