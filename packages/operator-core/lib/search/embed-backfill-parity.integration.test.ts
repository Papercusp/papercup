/**
 * R-9 parity golden for the backfill-engine move (shared-vector-search-libraries-2026-09-29
 * P-005 / D-004; P-006 must keep this file green WITHOUT editing its expectations).
 *
 * One `runBackfillSweep()` over a fresh PostgreSQL, through papercusp's real TARGETS and
 * hooks (embedder resolution, admission, resource profile), with only the network
 * (`fetch`), the preference/credential reads and the SQL client substituted. Three real
 * targets are seeded with rows whose vector is MISSING, rows whose vector is in the WRONG
 * embedding space, an already-correct row, an ineligible (empty-body) row and a row the
 * embedder rejects. The expectations below were recorded from the pre-move engine:
 *
 *  - the exact sequence of texts sent to the embedder (round-robin across targets, one
 *    batch per live target per round, a target's own ORDER BY, the failed-row OFFSET, and
 *    the re-attempt of a failed row on the next round);
 *  - the per-target stats (scanned / embedded / errors) for EVERY target in TARGETS;
 *  - the resulting rows: vector + mode label written for stale rows only.
 *
 * `durationMs` is excluded because it is wall-clock.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

const h = vi.hoisted(() => ({
  sql: null as unknown,
  attempts: [] as string[],
}));

vi.mock('@papercusp/db-org', async (importActual) => ({
  ...(await importActual<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../voice-prefs', () => ({
  loadVoicePrefs: async () => ({ memoryEmbedderMode: 'openai' }),
}));
vi.mock('../credentials', () => ({
  readCredentials: async () => ({ openai_api_key: 'test-key' }),
}));
// Pin the batch size so the round-robin interleaving does not depend on the host's
// resource profile (it is read once, at embed-backfill module load).
vi.mock('../resource-profile', async (importActual) => {
  const actual = await importActual<typeof import('../resource-profile')>();
  return {
    ...actual,
    getResourceProfile: () => ({ ...actual.getResourceProfile(), embedBatchSize: 2 }),
  };
});

import * as realSubject from './embed-backfill';
import { PROSE_VECTOR_DIMS } from './prose-vector-dims';

// Copy-out mutation probes (scripts/mutation-probe.sh) point this at a mutant in a repo
// mirror, so falsifiability is proven without ever dirtying the shared tree.
const subjectPath = process.env.PAPERCUSP_EMBED_BACKFILL_PARITY_SUBJECT;
const subject: typeof realSubject = subjectPath
  ? ((await import(subjectPath)) as typeof realSubject)
  : realSubject;
const { runBackfillSweep, resetSweepStateForTest, TARGETS } = subject;

/** Deterministic vector for a text, so the written vector proves WHICH body was embedded. */
function vectorFor(text: string): number[] {
  let seed = 7;
  for (const ch of text) seed = (seed * 31 + ch.charCodeAt(0)) % 100_003;
  return Array.from({ length: PROSE_VECTOR_DIMS }, (_, i) => ((seed * (i + 1)) % 997) / 997);
}

function fetchStub(_url: unknown, init?: { body?: string }): Promise<Response> {
  const { input } = JSON.parse(String(init?.body ?? '{}')) as { input: string };
  h.attempts.push(input);
  if (input.includes('REJECTED')) {
    return Promise.resolve(new Response('{"error":"bad input"}', { status: 400 }));
  }
  return Promise.resolve(
    new Response(JSON.stringify({ data: [{ embedding: vectorFor(input) }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

const OLD = `[${new Array(PROSE_VECTOR_DIMS).fill(0.5).join(',')}]`;

let db: FreshPgDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshPgDb('embed-backfill-parity');
  sql = db.sql;
  h.sql = sql;
  await sql.unsafe(`
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE harness_shared.harness_brainstorm (
      harness_slug text NOT NULL,
      phase text NOT NULL,
      content text,
      updated_at bigint,
      content_embedding vector(${PROSE_VECTOR_DIMS}),
      content_embedding_mode text,
      PRIMARY KEY (harness_slug, phase)
    );
    INSERT INTO harness_shared.harness_brainstorm (harness_slug, phase, content, content_embedding, content_embedding_mode) VALUES
      ('h', 'b1', 'brainstorm one (missing)', NULL, NULL),
      ('h', 'b2', 'brainstorm two (wrong space)', '${OLD}', 'local'),
      ('h', 'b3', 'brainstorm three (missing)', NULL, NULL),
      ('h', 'b4', 'brainstorm four (already correct)', '${OLD}', 'openai'),
      ('h', 'b5', '', NULL, NULL);

    CREATE TABLE harness_shared.operator_turns (
      id text PRIMARY KEY,
      text text,
      created_at bigint,
      text_embedding vector(${PROSE_VECTOR_DIMS}),
      text_embedding_mode text
    );
    INSERT INTO harness_shared.operator_turns (id, text, text_embedding, text_embedding_mode) VALUES
      ('t1', 'turn one (missing)', NULL, NULL),
      ('t2', 'turn two (wrong space)', '${OLD}', 'gemma'),
      ('tx', 'turn REJECTED by the embedder', NULL, NULL),
      ('t3', 'turn three (missing)', NULL, NULL);

    CREATE TABLE harness_shared.code_recipes (
      id text PRIMARY KEY,
      title text,
      description text,
      created_at timestamptz NOT NULL,
      embedding vector(${PROSE_VECTOR_DIMS}),
      embedding_mode text
    );
    INSERT INTO harness_shared.code_recipes (id, title, description, created_at, embedding, embedding_mode) VALUES
      ('r1', 'recipe one', 'oldest, missing', '2026-01-01T00:00:00Z', NULL, NULL),
      ('r2', 'recipe two', 'middle, wrong space', '2026-01-02T00:00:00Z', '${OLD}', 'local'),
      ('r3', 'recipe three', 'newest, missing', '2026-01-03T00:00:00Z', NULL, NULL),
      ('r4', 'recipe four', 'already correct', '2026-01-04T00:00:00Z', '${OLD}', 'openai');
  `);
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await db?.cleanup();
}, 60_000);

describe('embed backfill parity golden (R-9, D-004)', () => {
  it('one sweep embeds the same rows, in the same order, with the same per-target stats', async () => {
    vi.stubGlobal('fetch', vi.fn(fetchStub));
    resetSweepStateForTest();

    const result = await runBackfillSweep();
    expect(Array.isArray(result)).toBe(true);
    const stats = result as Array<{ table: string; scanned: number; embedded: number; errors: number }>;

    // 1. Embed order: round 1 gives each live target (in TARGETS order) one batch of 2;
    //    code_recipes follows its ORDER BY created_at DESC; the rejected turn is retried
    //    on the next round, and a round that embeds nothing drains its target.
    expect(h.attempts).toEqual([
      'brainstorm one (missing)',
      'brainstorm two (wrong space)',
      'turn one (missing)',
      'turn two (wrong space)',
      'recipe three\nnewest, missing',
      'recipe two\nmiddle, wrong space',
      'brainstorm three (missing)',
      'turn REJECTED by the embedder',
      'turn three (missing)',
      'recipe one\noldest, missing',
      'turn REJECTED by the embedder',
    ]);

    // 2. Per-target stats for every target, in TARGETS order.
    const seeded: Record<string, { scanned: number; embedded: number; errors: number }> = {
      'harness_shared.harness_brainstorm': { scanned: 3, embedded: 3, errors: 0 },
      'harness_shared.operator_turns': { scanned: 5, embedded: 3, errors: 2 },
      'harness_shared.code_recipes': { scanned: 3, embedded: 3, errors: 0 },
    };
    expect(stats.map((s) => s.table)).toEqual(TARGETS.map((t) => t.table));
    for (const s of stats) {
      expect({ table: s.table, scanned: s.scanned, embedded: s.embedded, errors: s.errors }).toEqual({
        table: s.table,
        ...(seeded[s.table] ?? { scanned: 0, embedded: 0, errors: 0 }),
      });
    }

    // 3. Resulting rows: stale rows carry the vector of their own body and the active
    //    mode; the correct, ineligible and rejected rows are untouched.
    const rows = await sql.unsafe<Array<{ k: string; body: string; v: string | null; mode: string | null }>>(`
      SELECT 'b:' || phase AS k, content AS body, content_embedding::text AS v, content_embedding_mode AS mode
        FROM harness_shared.harness_brainstorm
      UNION ALL
      SELECT 't:' || id, text, text_embedding::text, text_embedding_mode FROM harness_shared.operator_turns
      UNION ALL
      SELECT 'r:' || id, title || E'\\n' || description, embedding::text, embedding_mode FROM harness_shared.code_recipes
      ORDER BY 1`);
    const asVec = (v: string | null) => (v === null ? null : (JSON.parse(v) as number[]));
    const untouched = new Set(['b:b4', 'b:b5', 't:tx', 'r:r4']);
    for (const r of rows) {
      if (untouched.has(r.k)) {
        const before = r.k === 'b:b4' || r.k === 'r:r4' ? JSON.parse(OLD) : null;
        expect({ k: r.k, v: asVec(r.v) }).toEqual({ k: r.k, v: before });
        continue;
      }
      expect(r.mode, r.k).toBe('openai');
      const got = asVec(r.v)!;
      const want = vectorFor(r.body);
      expect(got.length, r.k).toBe(want.length);
      expect(Math.max(...got.map((x, i) => Math.abs(x - want[i]!))), r.k).toBeLessThan(1e-6);
    }
    expect(rows.map((r) => r.k)).toEqual([
      'b:b1', 'b:b2', 'b:b3', 'b:b4', 'b:b5',
      'r:r1', 'r:r2', 'r:r3', 'r:r4',
      't:t1', 't:t2', 't:t3', 't:tx',
    ]);
  }, 60_000);
});
