/**
 * Operator (chat) turns as a chunk surface (generic-rag-chunking P-010, D-017),
 * against real Postgres: the REAL registry entry over the REAL parent table
 * (harness_shared.operator_turns) and the shared store (migration 1242), driven
 * through papercusp's tick.
 *
 * Only two fields of the entry are replaced, both for isolation: the surface
 * name (so this file's text_chunks rows are its own) and an eligibility scope to
 * this file's conversation (so turns another file writes never enter the
 * stats). Splitter, cap, text, version and key are the registry's.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import postgres from 'postgres';
import { assertPgReachable } from '@papercusp/test-config/pg';
import type { ChunkSurface, ChunkSyncLogger, ChunkSyncResult } from '@papercusp/search';
import { OPERATOR_TURNS_CHUNK_SURFACE } from './registry';
import { runChunkSyncTick } from './tick';

const TAG = `${process.pid}_${Date.now()}`;
const CONV = randomUUID();
const SURFACE: ChunkSurface = {
  ...OPERATOR_TURNS_CHUNK_SURFACE,
  surface: `it-operator-turns-${TAG}`,
  eligibleSql: `p.conversation_id = '${CONV}'`,
};

function windowGeometry(): { size: number; step: number; cap: number } {
  const sp = OPERATOR_TURNS_CHUNK_SURFACE.splitter;
  if (sp.kind !== 'window') throw new Error(`operator turns splitter is ${sp.kind}, expected window (D-017)`);
  const cap = OPERATOR_TURNS_CHUNK_SURFACE.maxChunks;
  if (!cap) throw new Error('operator turns entry has no maxChunks (D-017 sets 8)');
  return { size: sp.size, step: sp.size - sp.overlap, cap };
}

/** Distinct words, so no two windows are byte-identical. */
const prose = (chars: number, seed: string) => {
  let s = '';
  for (let i = 0; s.length < chars; i++) s += `${seed}${i} `;
  return s.slice(0, chars);
};

describe('operator turns chunk surface (P-010, live SQL)', () => {
  let sql: postgres.Sql;
  const logged: { level: 'warn' | 'error'; message: string; meta?: Record<string, unknown> }[] = [];
  const logger: ChunkSyncLogger = {
    warn: (message, meta) => logged.push({ level: 'warn', message, meta }),
    error: (message, meta) => logged.push({ level: 'error', message, meta }),
  };
  const tick = async () => {
    const res = await runChunkSyncTick({ sql, surfaces: [SURFACE], logger });
    expect(res).toHaveProperty('surfaces');
    return (res as ChunkSyncResult).surfaces[0]!;
  };
  const chunkCount = async (id: string) => {
    const [r] = await sql.unsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM harness_shared.text_chunks WHERE surface = $1 AND parent_key = ARRAY[$2]`,
      [SURFACE.surface, id],
    );
    return r!.n;
  };

  beforeAll(async () => {
    const dsn = inject('baselineSchemaDsn');
    await assertPgReachable(dsn, 'chunks/operator-turns-chunks.integration');
    sql = postgres(dsn, { max: 1, onnotice: () => {} });
    await sql.unsafe(
      `INSERT INTO harness_shared.operator_conversations (id, workspace_id, started_at) VALUES ($1, 'ws-it', $2)`,
      [CONV, Date.now()],
    );
  });

  afterAll(async () => {
    expect(logged.filter((l) => l.level === 'error')).toEqual([]);
    if (!sql) return;
    await sql.unsafe(`DELETE FROM harness_shared.text_chunks WHERE surface = $1`, [SURFACE.surface]);
    await sql.unsafe(`DELETE FROM harness_shared.operator_conversations WHERE id = $1`, [CONV]);
    await sql.end();
  });

  it('the sync stats count the turns cut off by the chunk cap, and only those', async () => {
    const { size, step, cap } = windowGeometry();
    const covered = size + (cap - 1) * step; // characters the capped windows reach
    const now = Date.now();
    const turns = [
      { id: randomUUID(), seq: 1, text: prose(covered * 2, 'long') }, // cut off
      { id: randomUUID(), seq: 2, text: prose(covered + step * 3, 'over') }, // cut off
      { id: randomUUID(), seq: 3, text: prose(size + step * 2, 'mid') }, // three windows, fits
      { id: randomUUID(), seq: 4, text: 'a short turn' },
    ];
    for (const t of turns) {
      await sql.unsafe(
        `INSERT INTO harness_shared.operator_turns (id, conversation_id, workspace_id, seq, role, text, created_at)
         VALUES ($1, $2, 'ws-it', $3, 'assistant', $4, $5)`,
        [t.id, CONV, t.seq, t.text, now + t.seq],
      );
    }

    const st = await tick();
    expect(st).toMatchObject({ parentsTruncatedByMaxChunks: 2, errors: 0 });
    expect(await chunkCount(turns[0]!.id)).toBe(cap);
    expect(await chunkCount(turns[1]!.id)).toBe(cap);
    expect(await chunkCount(turns[2]!.id)).toBe(3);

    const cut = logged.filter((l) => l.level === 'warn' && l.meta?.surface === SURFACE.surface);
    expect(cut.map((l) => (l.meta?.key as string[])[0]).sort()).toEqual([turns[0]!.id, turns[1]!.id].sort());
    for (const l of cut) expect(l.meta).toMatchObject({ maxChunks: cap });

    // A turn's text never changes, so the next tick re-syncs nothing and
    // re-counts nothing: the count is per sync, not a running total.
    expect(await tick()).toMatchObject({ parentsSynced: 0, parentsTruncatedByMaxChunks: 0 });
  });
});
