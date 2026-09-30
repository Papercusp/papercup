/**
 * R-20 (generic-rag-chunking-2026-09-29, P-006): moving the session-turn
 * semantic leg onto the shared chunkAwareVectorLeg helper must not change what
 * it returns. For a fixed query set over a fixed fixture, the leg must return
 * the same ids, in the same order, with the same scores, as the leg did BEFORE
 * the move.
 *
 * The expected results are NOT computed by the helper. They were captured by
 * running this file with SESSION_TURN_PARITY_CAPTURE=1 against the pre-move
 * sources.ts, whose blob and last commit are recorded in the fixture's
 * generatedFrom. A normal run only compares. Re-capturing after the move would
 * make the test compare the helper with itself, so the capture path refuses to
 * overwrite an existing fixture unless SESSION_TURN_PARITY_RECAPTURE=1.
 *
 * Fixture geometry: every vector lies in the plane of the first two dimensions
 * at a distinct angle, so cosine distance is 1 - cos(angle difference) and no
 * two candidates tie for any query. The cases cover a parent-only match, a
 * chunk-only match (t1's parent points away, its chunk points at the query), a
 * parent whose chunk beats its own vector, a parent with no vector but a
 * matching chunk (t4), a speaker filter, per-leg LIMIT truncation, and a row in
 * another workspace that must never appear.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import postgres from 'postgres';
import { assertPgReachable } from '@papercusp/test-config/pg';
import type { PgHandle, SearchFilters } from '@papercusp/search';
import { PROSE_VECTOR_DIMS, PROSE_VECTOR_STORAGE_PROFILE } from '../../search/prose-vector-dims';
import { SEARCH_SOURCES } from './sources';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '__fixtures__', 'session-turn-leg-parity.v1.json');
const SOURCES = join(HERE, 'sources.ts');

const TAG = `${process.pid}_${Date.now()}`;
const WS = `parity-ws-${TAG}`;
const OTHER_WS = `parity-other-${TAG}`;
const HARNESS = `parity-h-${TAG}`;
const SESSION = 'parity-session';
const PROFILE_ID = PROSE_VECTOR_STORAGE_PROFILE.acceptedProfileIds[0]!;

function vec(deg: number): string {
  const r = (deg * Math.PI) / 180;
  const v = new Array<number>(PROSE_VECTOR_DIMS).fill(0);
  v[0] = Math.cos(r);
  v[1] = Math.sin(r);
  return `[${v.join(',')}]`;
}

interface FixtureTurn {
  idx: number;
  speaker: 'user' | 'assistant';
  /** Parent vector angle; null = the turn has no parent vector. */
  parent: number | null;
  /** Chunk vector angles, in chunk order. */
  chunks: number[];
  workspace?: string;
}

// Stable identity of each case; changing this changes what the capture measured.
const TURNS: FixtureTurn[] = [
  { idx: 0, speaker: 'user', parent: 10, chunks: [] },
  { idx: 1, speaker: 'assistant', parent: 80, chunks: [5, 60] },
  { idx: 2, speaker: 'user', parent: 30, chunks: [20] },
  { idx: 3, speaker: 'assistant', parent: 45, chunks: [] },
  { idx: 4, speaker: 'user', parent: null, chunks: [12] },
  { idx: 5, speaker: 'assistant', parent: 72, chunks: [27] },
  { idx: 6, speaker: 'user', parent: 1, chunks: [2], workspace: OTHER_WS },
];

interface ParityQuery {
  name: string;
  angle: number;
  limit: number;
  filters?: SearchFilters;
}

const QUERIES: ParityQuery[] = [
  { name: 'q0-limit10', angle: 0, limit: 10 },
  { name: 'q0-limit3', angle: 0, limit: 3 },
  { name: 'q50-limit10', angle: 50, limit: 10 },
  { name: 'q0-assistant', angle: 0, limit: 10, filters: { speaker: 'assistant' } },
  { name: 'q90-limit4', angle: 90, limit: 4 },
];

interface CapturedRow { key: string; score: number }
interface ParityFixture {
  generatedFrom: { path: string; blobSha: string; lastCommit: string; capturedAt: string };
  queries: Record<string, CapturedRow[]>;
}

/*
 * Mutation-probe seam: PAPERCUSP_SOURCES_SUBJECT is an absolute path to a copy
 * of sources.ts (scripts/mutation-probe.sh points it at a mutant, so the
 * tracked file is never modified). Unset, the real SEARCH_SOURCES runs.
 */
let sessionTurn = SEARCH_SOURCES.find((s) => s.name === 'session_turn');

describe('session-turn semantic leg parity (R-20)', () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    const subject = process.env.PAPERCUSP_SOURCES_SUBJECT;
    if (subject) {
      const mod = (await import(subject)) as { SEARCH_SOURCES: typeof SEARCH_SOURCES };
      sessionTurn = mod.SEARCH_SOURCES.find((s) => s.name === 'session_turn');
    }
    const dsn = inject('baselineSchemaDsn');
    await assertPgReachable(dsn, 'search/session-turn-leg-parity.integration');
    sql = postgres(dsn, { max: 2, onnotice: () => {} });
    for (const t of TURNS) {
      const ws = t.workspace ?? WS;
      await sql`
        INSERT INTO harness_shared.session_turns
          (workspace_id, source_kind, session_id, turn_idx, speaker, text, harness_slug,
           text_embedding, text_embedding_profile, ts)
        VALUES (${ws}, 'claude', ${SESSION}, ${t.idx}, ${t.speaker}, ${`parity turn ${t.idx}`}, ${HARNESS},
                ${t.parent === null ? null : vec(t.parent)}::vector, ${t.parent === null ? null : PROFILE_ID},
                ${new Date(Date.UTC(2026, 8, 1, 0, t.idx)).toISOString()}::timestamptz)`;
      for (const [chunkIdx, angle] of t.chunks.entries()) {
        await sql`
          INSERT INTO harness_shared.session_turn_chunks
            (workspace_id, source_kind, session_id, turn_idx, chunk_idx, content, turn_sha, updated_at,
             embedding, embedding_profile)
          VALUES (${ws}, 'claude', ${SESSION}, ${t.idx}, ${chunkIdx}, ${`chunk ${chunkIdx}`}, 'parity-sha', now(),
                  ${vec(angle)}::vector, ${PROFILE_ID})`;
      }
    }
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM harness_shared.session_turns WHERE harness_slug = ${HARNESS}`;
    await sql.end({ timeout: 5 });
  });

  async function runQuery(q: ParityQuery): Promise<CapturedRow[]> {
    const rows = await sessionTurn!.embedding!({
      sql: sql as unknown as PgHandle,
      query: 'parity',
      workspaceId: WS,
      scopeFilter: HARNESS,
      embeddingProfile: { profileId: PROFILE_ID, legacyMode: null },
      limit: q.limit,
      filters: q.filters,
      wantHighlight: false,
      qVec: vec(q.angle),
    });
    // Keys carry the session id, which is fixed, so they are stable across runs.
    return rows.map((r) => ({ key: r.key, score: Number(r.score) }));
  }

  it('the session-turn source exposes a semantic leg', () => {
    expect(sessionTurn?.embedding).toBeTypeOf('function');
  });

  if (process.env.SESSION_TURN_PARITY_CAPTURE === '1') {
    it('captures the pre-move leg results', async () => {
      if (existsSync(FIXTURE) && process.env.SESSION_TURN_PARITY_RECAPTURE !== '1') {
        throw new Error(`${FIXTURE} exists; re-capturing would compare the new leg with itself`);
      }
      const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: HERE, encoding: 'utf8' }).trim();
      const rel = relative(repoRoot, SOURCES);
      const fixture: ParityFixture = {
        generatedFrom: {
          path: rel,
          blobSha: execFileSync('git', ['hash-object', SOURCES], { encoding: 'utf8' }).trim(),
          lastCommit: execFileSync('git', ['log', '-1', '--format=%H', '--', rel], { cwd: repoRoot, encoding: 'utf8' }).trim(),
          capturedAt: new Date().toISOString(),
        },
        queries: {},
      };
      for (const q of QUERIES) fixture.queries[q.name] = await runQuery(q);
      writeFileSync(FIXTURE, JSON.stringify(fixture, null, 1) + '\n');
    });
    return;
  }

  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as ParityFixture;

  it('the fixture was captured from a different sources.ts than the one under test', () => {
    // A capture from the current file would mean the expectations came from the new leg.
    const current = execFileSync('git', ['hash-object', SOURCES], { encoding: 'utf8' }).trim();
    expect(fixture.generatedFrom.blobSha).toMatch(/^[0-9a-f]{40}$/);
    expect(fixture.generatedFrom.blobSha).not.toBe(current);
  });

  it('the fixture exercises every case: chunk-only, no-parent-vector and cross-workspace exclusion', () => {
    const top = fixture.queries['q0-limit10']!.map((r) => r.key);
    expect(top[0]).toBe(`session_turn:claude:${SESSION}:1`);
    expect(top).toContain(`session_turn:claude:${SESSION}:4`);
    expect(top).not.toContain(`session_turn:claude:${SESSION}:6`);
  });

  for (const q of QUERIES) {
    it(`${q.name} returns the pre-move ids, order and scores`, async () => {
      const expected = fixture.queries[q.name]!;
      const actual = await runQuery(q);
      expect(actual.map((r) => r.key)).toEqual(expected.map((r) => r.key));
      for (const [i, row] of actual.entries()) expect(row.score).toBeCloseTo(expected[i]!.score, 9);
    });
  }
});
