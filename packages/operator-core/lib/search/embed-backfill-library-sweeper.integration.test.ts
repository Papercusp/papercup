/**
 * D-004's direct run for the backfill-engine move (shared-vector-search-libraries-2026-09-29
 * P-006): the SAME fixture and the SAME recorded expectations as the R-9 parity golden
 * (embed-backfill-parity.integration.test.ts), but driven through @papercusp/search's
 * `createBackfillSweeper` with papercusp's exported config (`proseBackfillSweeperConfig`:
 * TARGETS, embedder resolution, admission, resource profile, prose width and profile
 * rules) and a fresh, unpinned sweep state.
 *
 * The golden proves papercusp's `runBackfillSweep` still behaves as the pre-move engine
 * did. This file proves the library entry point, given papercusp's hooks, is that engine:
 * a host that wires the sweeper itself gets the recorded behaviour, and the run does not
 * touch papercusp's pinned latch.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createBackfillSweepState, createBackfillSweeper } from '@papercusp/search';
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
// Same pinned batch size as the golden, read once at embed-backfill module load.
vi.mock('../resource-profile', async (importActual) => {
  const actual = await importActual<typeof import('../resource-profile')>();
  return {
    ...actual,
    getResourceProfile: () => ({ ...actual.getResourceProfile(), embedBatchSize: 2 }),
  };
});

import { TARGETS, __sweepStateForTest, proseBackfillSweeperConfig } from './embed-backfill';
import { fitsProseColumns, PROSE_VECTOR_DIMS } from './prose-vector-dims';

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
  db = await createFreshPgDb('embed-backfill-library-sweeper');
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

describe('library sweeper with papercusp hooks (D-004 direct run)', () => {
  it('papercusp config wires its own targets and prose width rules', () => {
    const config = proseBackfillSweeperConfig(createBackfillSweepState());
    expect(config.getTargets()).toBe(TARGETS);
    expect(config.acceptsWidth).toBe(fitsProseColumns);
    expect(config.logLabel).toBe('embed-backfill');
  });

  it('reproduces the parity golden: same embed order, same per-target stats, same rows', async () => {
    vi.stubGlobal('fetch', vi.fn(fetchStub));
    const pinned = __sweepStateForTest();
    const pinnedBefore = { ...pinned };

    const state = createBackfillSweepState();
    const sweeper = createBackfillSweeper(proseBackfillSweeperConfig(state));
    const result = await sweeper.run();
    expect(Array.isArray(result)).toBe(true);
    const stats = result as Array<{ table: string; scanned: number; embedded: number; errors: number }>;

    // 1. Embed order, verbatim from the golden.
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

    // 2. Per-target stats for every target, in TARGETS order, verbatim from the golden.
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

    // 3. Stale rows carry their own body's vector and the active mode; the correct,
    //    ineligible and rejected rows are untouched.
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

    // 4. The direct run used its own latch: papercusp's pinned state is untouched,
    //    and the fresh state advanced its rotation and cleared its latch.
    expect({ ...pinned }).toEqual(pinnedBefore);
    expect(state).toMatchObject({ running: false, startedAt: null, sweepCounter: 1 });
    expect(sweeper.lastResult()).toBe(result);
  }, 60_000);
});
