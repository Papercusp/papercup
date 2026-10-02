/**
 * Real-Postgres coverage for plan session-transcript-exact-fuzzy-search-2026-09-14 P-002
 * (migration 1273 + the deferred build body). Covers the D-005 rule-4 matrix: migration applied
 * twice, index absent / present / invalid, vocabulary absent / mid-build / stale lease /
 * incremental — plus the SPEC-P002-MIGRATION-INDEX probe (replay the migration, inspect the
 * resulting index, EXPLAIN the intended predicate).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  SESSION_SEARCH_INDEXES,
  SESSION_TURN_TRGM_EXPR,
  createIndexConcurrentlySql,
  readSessionSearchReadiness,
  runSessionSearchIndexBuildOnce as runSessionSearchIndexBuildOnceRaw,
  sessionSearchTierAvailability,
  type SessionSearchReadiness,
} from './session-search-index-build';

/**
 * The build never throws for a per-step failure (it records the failure on the entry and carries
 * on), so every test would otherwise read a swallowed SQL error as an unrelated assertion miss.
 * Fail loudly, with the recorded message, the moment any step reports `failed`.
 */
const runSessionSearchIndexBuildOnce: typeof runSessionSearchIndexBuildOnceRaw = async (s, o) => {
  const r = await runSessionSearchIndexBuildOnceRaw(s, o);
  const failed = [...r.indexes, ...r.vocab].filter((e) => e.action === 'failed');
  expect(failed, 'no build step may report failed').toEqual([]);
  return r;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.resolve(here, '../../../libs/papercusp/libs/db/sql');
const M501 = path.join(SQL_DIR, '501-session-turns.sql');
// The migration under test. scripts/mutation-probe.sh points this at a mutated COPY (copy-out mode)
// so the falsifiability of these assertions is proven without ever mutating the tracked file.
const M1273 =
  process.env.P002_MIGRATION_SQL_UNDER_TEST ?? path.join(SQL_DIR, '1273-session-turns-trigram-exact-fuzzy-index.sql');
const GENERATED_SCHEMA = path.resolve(here, '../../../libs/papercusp/libs/db/src/schema/generated.ts');

const TRGM = 'session_turns_text_trgm_idx';
const TS_DESC = 'session_turns_ts_desc_idx';
const VOCAB_TRGM = 'session_turn_vocab_word_trgm_idx';
const OPTS = { minFreeDiskBytes: 0 };

let db: FreshPgDb;
let sql: postgres.Sql;

async function indexValid(name: string): Promise<boolean | null> {
  const [r] = await sql<Array<{ valid: boolean }>>`
    SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = ${name}`;
  return r ? r.valid : null;
}

async function dropAllIndexes(): Promise<void> {
  for (const i of SESSION_SEARCH_INDEXES) await sql.unsafe(`DROP INDEX IF EXISTS harness_shared.${i.name}`);
}

async function seed(
  ws: string,
  texts: string[],
  opts: { ingestedOffsetSec?: number } = {},
): Promise<void> {
  const base = Math.floor(Math.random() * 1e9);
  for (let i = 0; i < texts.length; i++) {
    await sql`
      INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, speaker, text, ts, ingested_at)
      VALUES (${ws}, 'claude', ${`s-${base}`}, ${i}, 'user', ${texts[i]!}, now(),
              now() + (${opts.ingestedOffsetSec ?? 0} * interval '1 second'))`;
  }
}

async function vocabOf(ws: string): Promise<Map<string, number>> {
  const rows = await sql<Array<{ word: string; ndoc: number }>>`
    SELECT word, ndoc FROM harness_shared.session_turn_vocab WHERE workspace_id = ${ws}`;
  return new Map(rows.map((r) => [r.word, r.ndoc]));
}

async function explain(query: string): Promise<string> {
  return sql.begin(async (tx) => {
    await tx.unsafe('SET LOCAL enable_seqscan = off');
    const rows = await tx.unsafe(`EXPLAIN ${query}`);
    return rows.map((r) => String(r['QUERY PLAN'])).join('\n');
  });
}

beforeAll(async () => {
  db = await createFreshPgDb('sess-search');
  sql = db.sql;
  // 501 indexes harness_shared.coord_event_log (an unrelated coord leg); stub ONLY that table so
  // the real session_turns DDL replays unmodified.
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (surface text, body jsonb)`,
  );
  await applyMigrationForTest(sql, M501);
  await applyMigrationForTest(sql, M1273);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql.unsafe(
    `TRUNCATE harness_shared.session_turns, harness_shared.session_turn_vocab, harness_shared.session_turn_vocab_state`,
  );
  await dropAllIndexes();
});

describe('migration 1273 — replay safety + the index/EXPLAIN probe (SPEC-P002-MIGRATION-INDEX)', () => {
  it('is idempotent: applying it repeatedly on a small table leaves one valid copy of each index', async () => {
    await applyMigrationForTest(sql, M1273);
    await applyMigrationForTest(sql, M1273);
    await applyMigrationForTest(sql, M1273);
    for (const n of [TRGM, TS_DESC, VOCAB_TRGM]) expect(await indexValid(n)).toBe(true);
    const [{ n }] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'harness_shared'
         AND indexname IN (${TRGM}, ${TS_DESC}, ${VOCAB_TRGM})`;
    expect(n).toBe(3);
  });

  it('a replayed database serves the exact-tier predicate, the newest-first walk and the vocabulary lookup from the indexes', async () => {
    await applyMigrationForTest(sql, M1273);
    await seed('w1', Array.from({ length: 40 }, (_, i) => `turn ${i} about furnishedfinder and papercusp`));
    // The planner needs a vocabulary big enough that the trigram GIN beats the (workspace_id, word)
    // primary key: on a two-row table it correctly prefers the pkey bitmap scan.
    await sql`INSERT INTO harness_shared.session_turn_vocab (workspace_id, word, ndoc)
              SELECT 'w1', 'w' || md5(g::text), 1 FROM generate_series(1, 20000) g`;
    await sql`INSERT INTO harness_shared.session_turn_vocab (workspace_id, word, ndoc)
              VALUES ('w1', 'furnishedfinder', 40), ('w1', 'papercusp', 40)`;
    await sql.unsafe('ANALYZE harness_shared.session_turn_vocab');
    await sql.unsafe('ANALYZE harness_shared.session_turns');

    const exactPlan = await explain(
      `SELECT session_id FROM harness_shared.session_turns
        WHERE ${SESSION_TURN_TRGM_EXPR} LIKE '%furnishedfinder%'`,
    );
    expect(exactPlan).toContain(TRGM);

    const walkPlan = await explain(
      `SELECT session_id FROM harness_shared.session_turns ORDER BY ts DESC NULLS LAST LIMIT 10`,
    );
    expect(walkPlan).toContain(TS_DESC);

    const vocabPlan = await explain(
      `SELECT word FROM harness_shared.session_turn_vocab WHERE workspace_id = 'w1' AND word % 'furnisedfinder'`,
    );
    expect(vocabPlan).toContain(VOCAB_TRGM);
  });

  it('on a table past the size guard creates the tables but NO index (they are left to the deferred job)', async () => {
    await sql`
      INSERT INTO harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx, speaker, text)
      SELECT 'big', 'claude', 's-big', g, 'user', 'row ' || g FROM generate_series(1, 10001) g`;
    await applyMigrationForTest(sql, M1273);
    for (const n of [TRGM, TS_DESC, VOCAB_TRGM]) expect(await indexValid(n)).toBeNull();
    const [{ t }] = await sql<Array<{ t: string | null }>>`
      SELECT to_regclass('harness_shared.session_turn_vocab_state')::text AS t`;
    expect(t).toBe('harness_shared.session_turn_vocab_state');
  });

  it('schema drift: the Drizzle projection (generated.ts) declares exactly the columns, nullability and constraints the replayed tables have', async () => {
    const generated = readFileSync(GENERATED_SCHEMA, 'utf8');
    for (const table of ['session_turn_vocab', 'session_turn_vocab_state']) {
      const start = generated.indexOf(`harnessShared.table("${table}", {`);
      expect(start, `${table} must be declared in generated.ts`).toBeGreaterThanOrEqual(0);
      const end = generated.indexOf('\n]);', start);
      const block = generated.slice(start, end);
      // `key: type("col_name")` or, when the column name needs no casing, `col: type()`.
      const declared = new Map<string, boolean>(); // column → declared NOT NULL / primary key
      for (const m of block.matchAll(/^\t(\w+): \w+\((?:"([^"]+)")?[^\n]*$/gm)) {
        const line = m[0];
        declared.set(m[2] ?? m[1]!, /\.notNull\(\)|\.primaryKey\(\)/.test(line));
      }
      const live = await sql<Array<{ column_name: string; is_nullable: string }>>`
        SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_schema = 'harness_shared' AND table_name = ${table}`;
      expect([...declared.keys()].sort(), `${table}: generated.ts columns`).toEqual(
        live.map((c) => c.column_name).sort(),
      );
      for (const c of live) {
        expect(declared.get(c.column_name), `${table}.${c.column_name} NOT NULL agrees`).toBe(
          c.is_nullable === 'NO',
        );
      }
    }
    // The status CHECK is part of the contract the build module and the read path rely on.
    expect(generated).toContain('session_turn_vocab_state_status_check');
    const checks = await sql<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
       WHERE conrelid = 'harness_shared.session_turn_vocab_state'::regclass AND contype = 'c'`;
    expect(checks.map((c) => c.conname)).toContain('session_turn_vocab_state_status_check');
  });

  it('spec table and migration text agree on every index name and definition (drift pin)', () => {
    const migration = readFileSync(M1273, 'utf8').replace(/\s+/g, ' ');
    // Stage 'windows' indexes live in migration 1334 (pinned in session-turn-windows.integration.test.ts).
    for (const spec of SESSION_SEARCH_INDEXES.filter((s) => s.stage !== 'windows')) {
      expect(migration).toContain(spec.name);
      // The migration splits the DDL over string literals; compare the definition body.
      expect(migration.replace(/' \|\| '/g, '')).toContain(spec.definition);
    }
    expect(createIndexConcurrentlySql(SESSION_SEARCH_INDEXES[0])).toBe(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS session_turns_text_trgm_idx ON harness_shared.session_turns USING gin (lower(text) gin_trgm_ops)',
    );
  });
});

describe('readSessionSearchReadiness / sessionSearchTierAvailability (the read path degrade contract)', () => {
  it('reports absent → invalid → ready from catalog truth, and vocab status from the state row', async () => {
    // w1 HAS transcript rows the build owes a vocabulary for, so no state row reads `absent`
    // (an `empty` verdict is reserved for a workspace with no rows at all — see the next test).
    await seed('w1', ['plan the furnished finder listing']);
    let r = await readSessionSearchReadiness(sql, ['w1']);
    expect(r.indexes[TRGM]).toBe('absent');
    expect(r.vocab.w1).toBe('absent');

    await sql.unsafe(createIndexConcurrentlySql(SESSION_SEARCH_INDEXES[0]));
    r = await readSessionSearchReadiness(sql, ['w1']);
    expect(r.indexes[TRGM]).toBe('ready');

    await sql.unsafe(
      `UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'harness_shared.${TRGM}'::regclass`,
    );
    r = await readSessionSearchReadiness(sql, ['w1']);
    expect(r.indexes[TRGM]).toBe('invalid');

    await sql`INSERT INTO harness_shared.session_turn_vocab_state (workspace_id, status) VALUES ('w1', 'building')`;
    expect((await readSessionSearchReadiness(sql, ['w1'])).vocab.w1).toBe('building');
  });

  it('skips a tier with a named reason instead of allowing a scan', () => {
    const ready = (over: Partial<SessionSearchReadiness['indexes']>, vocab: SessionSearchReadiness['vocab']) =>
      sessionSearchTierAvailability(
        {
          indexes: { [TRGM]: 'ready', [TS_DESC]: 'ready', [VOCAB_TRGM]: 'ready', ...over },
          vocab,
        } as SessionSearchReadiness,
        ['w1', 'default'],
      );
    // No windows readiness (migration 1334 not applied / backfill incomplete) => the legacy whole-turn route.
    expect(ready({}, { w1: 'ready', default: 'ready' })).toEqual({
      exact: { available: true, route: 'legacy' },
      fuzzy: { available: true },
    });
    expect(ready({ [TRGM]: 'absent' }, { w1: 'ready', default: 'ready' })).toEqual({
      exact: { available: false, skipReason: 'exact-index-absent' },
      fuzzy: { available: false, skipReason: 'exact-index-absent' },
    });
    expect(ready({ [TRGM]: 'invalid' }, {}).exact.skipReason).toBe('exact-index-invalid');
    expect(ready({ [VOCAB_TRGM]: 'absent' }, { w1: 'ready', default: 'ready' }).fuzzy.skipReason).toBe(
      'vocab-index-absent',
    );
    const mid = ready({}, { w1: 'ready', default: 'building' });
    expect(mid.exact.available).toBe(true);
    expect(mid.fuzzy).toEqual({ available: false, skipReason: 'vocab-default:building' });
    expect(ready({}, { w1: 'ready' }).fuzzy.skipReason).toBe('vocab-default:absent');
    // `empty` (no rows, so nothing to build) satisfies the tier exactly like `ready`; `absent` and `failed` do not.
    expect(ready({}, { w1: 'ready', default: 'empty' }).fuzzy).toEqual({ available: true });
    expect(ready({}, { w1: 'empty', default: 'empty' }).fuzzy).toEqual({ available: true });
    expect(ready({}, { w1: 'ready', default: 'failed' }).fuzzy.skipReason).toBe('vocab-default:failed');
  });

  it('a workspace with NO transcript rows reads `empty`, never `absent`: the host-global `default` workspace must not wedge the fuzzy tier forever', async () => {
    // Regression: the fuzzy tier always asks for [workspace, 'default']. The build only creates a vocab
    // state row for a workspace that has rows, so on an install whose 'default' workspace holds no
    // transcripts the state row never appears and `absent` skipped the tier permanently.
    await seed('w1', ['plan the furnished finder listing']);
    await sql.unsafe(createIndexConcurrentlySql(SESSION_SEARCH_INDEXES[0]));
    await runSessionSearchIndexBuildOnce(sql, OPTS);

    const r = await readSessionSearchReadiness(sql, ['w1', 'default']);
    expect(r.vocab.w1).toBe('ready');
    expect(r.vocab.default).toBe('empty');
    expect(sessionSearchTierAvailability(r, ['w1', 'default']).fuzzy).toEqual({ available: true });

    // Control: the same workspace the moment it gains a row (before the build catches up) is `absent`
    // again, so a real vocabulary gap still skips the tier instead of being read as "nothing to build".
    await seed('default', ['a turn the vocabulary has not seen yet']);
    const afterRow = await readSessionSearchReadiness(sql, ['w1', 'default']);
    expect(afterRow.vocab.default).toBe('absent');
    expect(sessionSearchTierAvailability(afterRow, ['w1', 'default']).fuzzy).toEqual({
      available: false,
      skipReason: 'vocab-default:absent',
    });
  });
});

describe('runSessionSearchIndexBuildOnce', () => {
  it('skips with tables-missing on a database the migration has not reached', async () => {
    const bare = await createFreshPgDb('sess-search-bare');
    try {
      expect((await runSessionSearchIndexBuildOnce(bare.sql, OPTS)).skipped).toBe('tables-missing');
    } finally {
      await bare.cleanup();
    }
  }, 60_000);

  it('builds absent indexes concurrently, then is a no-op once everything is current', async () => {
    await seed('w1', ['alpha furnishedfinder text', 'beta papercusp session']);
    const first = await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect(first.skipped).toBeUndefined();
    expect(first.indexes.map((i) => [i.name, i.action])).toEqual([
      [TRGM, 'built'],
      [TS_DESC, 'built'],
      [VOCAB_TRGM, 'built'],
    ]);
    for (const n of [TRGM, TS_DESC, VOCAB_TRGM]) expect(await indexValid(n)).toBe(true);

    const second = await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect(second.indexes.every((i) => i.action === 'present')).toBe(true);
    expect(second.vocab.every((v) => v.action === 'current')).toBe(true);
  }, 60_000);

  it('drops an invalid leftover (interrupted CONCURRENTLY build) and rebuilds it valid', async () => {
    await seed('w1', ['alpha furnishedfinder text']);
    await sql.unsafe(createIndexConcurrentlySql(SESSION_SEARCH_INDEXES[0]));
    await sql.unsafe(
      `UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'harness_shared.${TRGM}'::regclass`,
    );
    const r = await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect(r.invalidDropped).toContain(TRGM);
    expect(r.indexes.find((i) => i.name === TRGM)?.action).toBe('built');
    expect(await indexValid(TRGM)).toBe(true);
  }, 60_000);

  it('builds a per-workspace vocabulary: 4-40 char tokens only, exact doc counts, no cross-workspace words', async () => {
    await seed('w1', ['furnishedfinder session', 'furnishedfinder the and abc', 'session x']);
    await seed('other', ['secretword zzzzzzzz']);
    const r = await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect(r.vocab.filter((v) => v.action === 'full').map((v) => v.workspaceId).sort()).toEqual(['other', 'w1']);

    const w1 = await vocabOf('w1');
    expect(w1.get('furnishedfinder')).toBe(2);
    expect(w1.get('session')).toBe(2);
    for (const short of ['the', 'and', 'abc']) expect(w1.has(short)).toBe(false);
    expect(w1.has('secretword')).toBe(false);
    expect((await vocabOf('other')).get('secretword')).toBe(1);

    const [st] = await sql<Array<{ status: string; word_count: number; watermark_ingested_at: Date | null }>>`
      SELECT status, word_count, watermark_ingested_at FROM harness_shared.session_turn_vocab_state
       WHERE workspace_id = 'w1'`;
    expect(st!.status).toBe('ready');
    expect(Number(st!.word_count)).toBe(w1.size);
    expect(st!.watermark_ingested_at).not.toBeNull();
  }, 60_000);

  it('covers rows whose ingested_at has sub-millisecond precision (the watermark must not round-trip through a JS Date)', async () => {
    // A Date truncates .123999 to .123, which would exclude this row from the full build's
    // `ingested_at <= watermark` bound and re-count it on the next incremental.
    await sql`
      INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, speaker, text, ts, ingested_at)
      VALUES ('w1', 'claude', 's-micro', 0, 'user', 'microsecondword here', now(),
              timestamptz '2026-01-01 00:00:00.123999+00')`;
    const first = await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect(first.vocab.find((v) => v.workspaceId === 'w1')).toMatchObject({ action: 'full' });
    expect((await vocabOf('w1')).get('microsecondword')).toBe(1);
    const quiet = await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect(quiet.vocab.find((v) => v.workspaceId === 'w1')?.action).toBe('current');
    expect((await vocabOf('w1')).get('microsecondword')).toBe(1);
  }, 60_000);

  it('refreshes incrementally: only rows newer than the watermark are added, and a quiet pass is current', async () => {
    await seed('w1', ['furnishedfinder session']);
    await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect((await vocabOf('w1')).get('furnishedfinder')).toBe(1);

    await seed('w1', ['furnishedfinder brandnewword'], { ingestedOffsetSec: 5 });
    const r = await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect(r.vocab.find((v) => v.workspaceId === 'w1')?.action).toBe('incremental');
    const after = await vocabOf('w1');
    expect(after.get('brandnewword')).toBe(1);
    expect(after.get('furnishedfinder')).toBe(2);
    expect(after.get('session')).toBe(1);

    const quiet = await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect(quiet.vocab.find((v) => v.workspaceId === 'w1')?.action).toBe('current');
    expect((await vocabOf('w1')).get('furnishedfinder')).toBe(2);
  }, 60_000);

  it('a full rebuild removes words whose last turn was deleted by retention', async () => {
    await seed('w1', ['gonewords keepwords']);
    await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect((await vocabOf('w1')).has('gonewords')).toBe(true);
    await sql`TRUNCATE harness_shared.session_turns`;
    await seed('w1', ['keepwords only']);
    await runSessionSearchIndexBuildOnce(sql, {
      ...OPTS,
      vocabFullRebuildAfterMs: -1, // force the periodic full rebuild
    });
    const v = await vocabOf('w1');
    expect(v.has('gonewords')).toBe(false);
    expect(v.get('keepwords')).toBe(1);
  }, 60_000);

  it('does not build a workspace whose lease is live (another pass is mid-build) and reclaims a stale lease', async () => {
    await seed('w1', ['leasedword one']);
    await sql`INSERT INTO harness_shared.session_turn_vocab_state (workspace_id, status, build_started_at)
              VALUES ('w1', 'building', now())`;
    let r = await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect(r.vocab.find((v) => v.workspaceId === 'w1')?.action).toBe('in-flight');
    expect((await vocabOf('w1')).size).toBe(0);

    await sql`UPDATE harness_shared.session_turn_vocab_state
                 SET build_started_at = now() - interval '3 hours' WHERE workspace_id = 'w1'`;
    r = await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect(r.vocab.find((v) => v.workspaceId === 'w1')?.action).toBe('full');
    expect((await vocabOf('w1')).get('leasedword')).toBe(1);
  }, 60_000);

  it('dryRun reports what it would build and changes nothing', async () => {
    await seed('w1', ['dryrunword here']);
    const r = await runSessionSearchIndexBuildOnce(sql, { ...OPTS, dryRun: true });
    expect(r.indexes.every((i) => i.action === 'would-build')).toBe(true);
    expect(r.vocab.every((v) => v.action === 'would-build')).toBe(true);
    for (const n of [TRGM, TS_DESC, VOCAB_TRGM]) expect(await indexValid(n)).toBeNull();
    expect((await vocabOf('w1')).size).toBe(0);
  }, 60_000);
});
