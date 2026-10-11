/**
 * Legacy tsvector column retirement (plan bm25-lexical-search-evoke-adoption-2026-10-10:
 * requirement R-14 with R-10 kept working, item P-009, decisions D-011 and D-012).
 *
 * Migration 1452's `bm25_retire_legacy_columns()` against a preloaded pg_textsearch server:
 * on a corpus whose BM25 index is valid it swaps the stored legacy tsvector column for a
 * same-named VIRTUAL generated column, which drops the GIN index and the tsv trigger. The
 * values, the bare and qualified legacy queries, and every dependent view (grants, triggers,
 * reloptions, views of views) are unchanged. A busy table and a corpus without a valid BM25
 * index keep their stored column and retire on a later run; a host without the library
 * retires nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { runBm25Maintenance } from './bm25-maintenance';
import { resetBm25Availability } from './rank';
import { migrationSql, rankWorkItemIds, seedBm25Corpus, startBm25TestDb, type Bm25TestDb } from './test-pg/bm25-test-db';

/** The production generation expression of work_items._search (pg_attrdef, PG 18.4). */
const WORK_ITEMS_SEARCH = `setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(summary, '')), 'B') || setweight(to_tsvector('english', coalesce(notes, '')), 'C')`;

let db: Bm25TestDb;
let sql: Sql;

interface Snapshot { rows: string; bare: number[]; qualified: number[]; views: Record<string, string> }

const VIEWS = ['engineer_issues', 'harness_features_consolidated', 'features_open', 'personal_items'] as const;

async function snapshot(): Promise<Snapshot> {
  const rows = await sql<{ id: number; s: string }[]>`SELECT id, _search::text AS s FROM harness_shared.work_items ORDER BY id`;
  // The legacy fallback fragments reference the column both bare and alias-qualified.
  const bare = await sql<{ id: number }[]>`
    SELECT id FROM harness_shared.work_items WHERE _search @@ to_tsquery('english', 'quokka | routine')
     ORDER BY ts_rank_cd(_search, to_tsquery('english', 'quokka | routine')) DESC, id LIMIT 25`;
  const qualified = await sql<{ id: number }[]>`
    SELECT w.id FROM harness_shared.work_items w WHERE w._search @@ to_tsquery('english', 'axolotl | item')
     ORDER BY ts_rank_cd(w._search, to_tsquery('english', 'axolotl | item')) DESC, w.id LIMIT 25`;
  const views: Record<string, string> = {};
  for (const v of VIEWS) {
    views[v] = JSON.stringify(await sql.unsafe(`SELECT id, _search::text AS s FROM harness_shared.${v} ORDER BY id`));
  }
  return { rows: JSON.stringify(rows), bare: bare.map(r => r.id), qualified: qualified.map(r => r.id), views };
}

const generated = async (table: string, column: string): Promise<string> =>
  (await sql<{ g: string }[]>`
    SELECT a.attgenerated::text AS g FROM pg_attribute a
     WHERE a.attrelid = ${`harness_shared.${table}`}::regclass AND a.attname = ${column} AND NOT a.attisdropped`)[0]!.g;

const exists = async (qualifiedName: string): Promise<boolean> =>
  (await sql<{ e: boolean }[]>`SELECT to_regclass(${qualifiedName}) IS NOT NULL AS e`)[0]!.e;

const retire = (dryRun = false) => sql<{ table_name: string | null; outcome: string; detail: string | null; freed_index_bytes: string | null }[]>`
  SELECT table_name, outcome, detail, freed_index_bytes FROM harness_shared.bm25_retire_legacy_columns(${dryRun})`;

const outcomeOf = (rows: Array<{ table_name: string | null; outcome: string }>, table: string) =>
  rows.find(r => r.table_name === table)?.outcome;

let before: Snapshot;
let brainstormBefore: string;
let reader: string;

beforeAll(async () => {
  db = await startBm25TestDb();
  sql = db.sql;
  await seedBm25Corpus(sql);
  reader = `${db.runTag}_reader`;
  await sql.unsafe(`
    ALTER TABLE harness_shared.work_items ADD COLUMN _search tsvector GENERATED ALWAYS AS (${WORK_ITEMS_SEARCH}) STORED;
    CREATE INDEX hfc_search_idx ON harness_shared.work_items USING gin (_search);
    COMMENT ON COLUMN harness_shared.work_items._search IS 'legacy weighted tsvector';
    ALTER TABLE harness_shared.code_recipes ADD COLUMN title_tsv tsvector GENERATED ALWAYS AS
      (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))) STORED;
    CREATE INDEX code_recipes_title_tsv_idx ON harness_shared.code_recipes USING gin (title_tsv);
    CREATE TABLE harness_shared.goals (id int PRIMARY KEY, title text, body text,
      _search tsvector GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(body, '')), 'B')) STORED);
    CREATE INDEX goals_search_idx ON harness_shared.goals USING gin (_search);
    INSERT INTO harness_shared.goals VALUES (1, 'Ship BM25', 'retire the legacy columns');

    -- trigger-maintained, exactly as 000-baseline defines harness_brainstorm
    CREATE TABLE harness_shared.harness_brainstorm (id int PRIMARY KEY, content text, content_tsv tsvector);
    CREATE FUNCTION harness_shared.harness_brainstorm_tsv_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.content_tsv := to_tsvector('english', coalesce(NEW.content, ''));
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER harness_brainstorm_tsv_trigger BEFORE INSERT OR UPDATE OF content ON harness_shared.harness_brainstorm
      FOR EACH ROW EXECUTE FUNCTION harness_shared.harness_brainstorm_tsv_update();
    CREATE INDEX harness_brainstorm_tsv_idx ON harness_shared.harness_brainstorm USING gin (content_tsv);
    INSERT INTO harness_shared.harness_brainstorm VALUES (1, 'wombats burrow at night'), (2, 'running the routines');

    -- the dependent-view shapes production has: a bare single-table view with an INSTEAD OF
    -- trigger and grants, a qualified multi-table view with a view of its own, and a
    -- security_invoker view
    CREATE VIEW harness_shared.engineer_issues AS SELECT id, ws AS workspace_id, title, _search FROM harness_shared.work_items;
    CREATE FUNCTION harness_shared.engineer_issues_view_dml() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE harness_shared.work_items SET title = NEW.title WHERE id = NEW.id;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER engineer_issues_view_dml INSTEAD OF UPDATE ON harness_shared.engineer_issues
      FOR EACH ROW EXECUTE FUNCTION harness_shared.engineer_issues_view_dml();
    CREATE VIEW harness_shared.harness_features_consolidated AS
      SELECT w.id, w.title, w._search FROM harness_shared.work_items w JOIN (SELECT 1 AS one) o ON o.one = 1;
    CREATE VIEW harness_shared.features_open AS SELECT id, _search FROM harness_shared.harness_features_consolidated;
    CREATE VIEW harness_shared.personal_items WITH (security_invoker = true) AS SELECT id, _search FROM harness_shared.work_items;
    CREATE ROLE "${reader}";
    GRANT USAGE ON SCHEMA harness_shared TO "${reader}";
    GRANT SELECT ON harness_shared.engineer_issues, harness_shared.features_open TO "${reader}";
  `);
  await sql`SELECT * FROM harness_shared.bm25_ensure_indexes()`;
  // carry_notes appears only after ensure, so it has no BM25 index: the per-corpus gate.
  await sql.unsafe(`
    CREATE TABLE harness_shared.carry_notes (id int PRIMARY KEY, note text,
      note_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(note, ''))) STORED);
    INSERT INTO harness_shared.carry_notes VALUES (1, 'carry the quokka');
    ANALYZE;
  `);
  resetBm25Availability();
  before = await snapshot();
  brainstormBefore = JSON.stringify(await sql`SELECT id, content_tsv::text AS s FROM harness_shared.harness_brainstorm ORDER BY id`);
}, 600_000);

afterAll(async () => {
  await db?.close();
});

describe('legacy tsvector retirement (R-14, D-011, D-012)', () => {
  it('migration 1452 retires every gated corpus, skips a busy table, and keeps values, legacy queries and views', async () => {
    const holder = await sql.reserve();
    try {
      await holder.unsafe('BEGIN');
      await holder.unsafe('LOCK TABLE harness_shared.goals IN ACCESS SHARE MODE');
      await sql.unsafe(migrationSql(1452));
    } finally {
      await holder.unsafe('COMMIT');
      holder.release();
    }

    for (const [table, column] of [['work_items', '_search'], ['code_recipes', 'title_tsv'], ['harness_plans', '_search'], ['harness_brainstorm', 'content_tsv']]) {
      expect(await generated(table!, column!), `${table}.${column}`).toBe('v');
    }
    expect(await generated('goals', '_search')).toBe('s'); // lock_timeout skip
    expect(await generated('carry_notes', 'note_tsv')).toBe('s'); // no BM25 index

    for (const gin of ['hfc_search_idx', 'code_recipes_title_tsv_idx', 'harness_brainstorm_tsv_idx']) {
      expect(await exists(`harness_shared.${gin}`), gin).toBe(false);
    }
    expect(await exists('harness_shared.goals_search_idx')).toBe(true);
    const [{ triggers }] = await sql<{ triggers: number }[]>`
      SELECT count(*)::int AS triggers FROM pg_trigger WHERE tgname = 'harness_brainstorm_tsv_trigger'`;
    expect(triggers).toBe(0);
    expect(await sql`SELECT to_regprocedure('harness_shared.harness_brainstorm_tsv_update()') AS f`).toEqual([{ f: null }]);

    // R-10 after retirement: identical values, identical bare and qualified legacy orderings
    expect(await snapshot()).toEqual(before);
    expect(JSON.stringify(await sql`SELECT id, content_tsv::text AS s FROM harness_shared.harness_brainstorm ORDER BY id`)).toBe(brainstormBefore);
    const [{ comment }] = await sql<{ comment: string | null }[]>`
      SELECT col_description('harness_shared.work_items'::regclass,
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'harness_shared.work_items'::regclass AND attname = '_search')) AS comment`;
    expect(comment).toBe('legacy weighted tsvector');

    // views keep their grants, INSTEAD OF trigger, reloptions and dependents
    const [privs] = await sql<{ ei: boolean; fo: boolean }[]>`
      SELECT has_table_privilege(${reader}, 'harness_shared.engineer_issues', 'SELECT') AS ei,
             has_table_privilege(${reader}, 'harness_shared.features_open', 'SELECT') AS fo`;
    expect(privs).toEqual({ ei: true, fo: true });
    expect(await sql`SELECT reloptions FROM pg_class WHERE oid = 'harness_shared.personal_items'::regclass`)
      .toEqual([{ reloptions: ['security_invoker=true'] }]);
    await sql`UPDATE harness_shared.engineer_issues SET title = 'item 3 about the axolotl, renamed' WHERE id = 3`;
    expect(await sql`SELECT _search @@ to_tsquery('english', 'renamed') AS hit FROM harness_shared.work_items WHERE id = 3`)
      .toEqual([{ hit: true }]);

    // new writes compute the virtual column; BM25 ranking is untouched
    await sql`INSERT INTO harness_shared.work_items (id, ws, title, summary) VALUES (9001, 'w1', 'a zebra crossing', 'stripes')`;
    await sql`INSERT INTO harness_shared.harness_brainstorm (id, content) VALUES (3, 'zebra stripes')`;
    expect(await sql`SELECT id FROM harness_shared.work_items WHERE _search @@ to_tsquery('english', 'zebra')`).toEqual([{ id: 9001 }]);
    expect(await sql`SELECT id FROM harness_shared.harness_brainstorm WHERE content_tsv @@ to_tsquery('english', 'zebra')`).toEqual([{ id: 3 }]);
    expect((await rankWorkItemIds(sql, 'quokka'))[0]).toBe(1);
  });

  it('a later run is idempotent, retires the table that was busy, and reports the freed index bytes', async () => {
    const rows = await retire();
    expect(outcomeOf(rows, 'work_items')).toBe('already-retired');
    expect(outcomeOf(rows, 'carry_notes')).toBe('skipped:bm25-index-not-valid');
    expect(outcomeOf(rows, 'session_turns')).toBe('skipped:table-missing');
    const goals = rows.find(r => r.table_name === 'goals')!;
    expect(goals.outcome).toBe('retired');
    expect(Number(goals.freed_index_bytes)).toBeGreaterThanOrEqual(8192);
    expect(goals.detail).toContain('heap bytes are reclaimed as rows are rewritten');
    expect(await generated('goals', '_search')).toBe('v');
  });

  it('a dry run changes nothing; the maintenance workflow retires a corpus once its BM25 index is valid', async () => {
    await sql`SELECT * FROM harness_shared.bm25_ensure_indexes()`;
    expect(outcomeOf(await retire(true), 'carry_notes')).toBe('would-retire');
    expect(await generated('carry_notes', 'note_tsv')).toBe('s');

    const report = await runBm25Maintenance(sql, { maxCompactionSteps: 0 });
    expect(report.errors).toEqual([]);
    expect(report.retired).toEqual([
      expect.objectContaining({ table: 'carry_notes', column: 'note_tsv', outcome: 'retired' }),
    ]);
    expect(await generated('carry_notes', 'note_tsv')).toBe('v');
    expect(await sql`SELECT id FROM harness_shared.carry_notes WHERE note_tsv @@ to_tsquery('english', 'quokka')`).toEqual([{ id: 1 }]);
  });

  it('nulls only the column references in a transient view definition', async () => {
    const def = ` SELECT id,\n    _search,\n    w._search AS s2,\n    '_search' AS lit,\n    my_search\n   FROM t w\n  WHERE (_search @@ q)`;
    const [{ out }] = await sql<{ out: string }[]>`SELECT harness_shared.bm25_view_def_without_column(${def}, '_search') AS out`;
    expect(out).toBe(` SELECT id,\n    NULL::tsvector AS _search,\n    NULL::tsvector AS s2,\n    '_search' AS lit,\n    my_search\n   FROM t w\n  WHERE (NULL::tsvector @@ q)`);
  });
});

describe('legacy tsvector retirement without the library (D-011 §2)', () => {
  it('retires nothing on a host where pg_textsearch is not preloaded', async () => {
    const plain = await startBm25TestDb({ preload: false });
    try {
      await seedBm25Corpus(plain.sql);
      await plain.sql.unsafe(migrationSql(1452));
      expect(await plain.sql`SELECT table_name, outcome FROM harness_shared.bm25_retire_legacy_columns()`)
        .toEqual([{ table_name: null, outcome: 'skipped:library-not-preloaded' }]);
      expect(await plain.sql`
        SELECT a.attgenerated::text AS g FROM pg_attribute a
         WHERE a.attrelid = 'harness_shared.harness_plans'::regclass AND a.attname = '_search'`).toEqual([{ g: 's' }]);
    } finally {
      await plain.close();
    }
  }, 600_000);
});
