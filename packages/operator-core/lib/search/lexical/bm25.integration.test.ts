/**
 * BM25 lexical ranking against a real pg_textsearch server (plan
 * bm25-lexical-search-evoke-adoption-2026-10-10: P-003 migration, P-005 seam, P-007 guards).
 *
 * Runs in its own container built from ./test-pg/Dockerfile (PG 18 + pg_textsearch 1.5.1,
 * preloaded), so the shared integration container is untouched. It applies migration 1447
 * exactly as armed, then checks the migration outcomes, the seam's engine choice and
 * fallback, the measured pg_textsearch behaviours the seam depends on, and two ranking
 * properties of real BM25 (a rare term outranks a common one; a known-item MRR floor).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import postgres, { type Sql } from 'postgres';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bm25Health, bm25Leg, lexicalEngine, lexicalLeg, resetBm25Availability, rrfTerm } from './rank';
import { bm25Corpus } from './corpora';
import type { SearchSourceParams } from '@papercusp/search';
import { createPlanSearchSource } from '../../agent-tools/search/knowledge-sources';

const SQL_DIR = path.resolve(__dirname, '../../../../../libs/papercusp/libs/db/sql');
const IMAGE = 'papercusp-pgts-test:1.5.1';

function migration1447(): string {
  const file = readdirSync(SQL_DIR).find(f => /^1447-.*\.sql$/.test(f));
  if (!file) throw new Error('migration 1447 is not armed');
  return readFileSync(path.join(SQL_DIR, file), 'utf8');
}

let container: StartedTestContainer;
let sql: Sql;

// Topic words appear in exactly one item each; "routine" appears in every item.
const TOPICS = ['quokka', 'marmoset', 'axolotl', 'pangolin', 'narwhal', 'okapi', 'tapir', 'wombat'];

beforeAll(async () => {
  const built = await GenericContainer.fromDockerfile(path.join(__dirname, 'test-pg')).build(IMAGE, { deleteOnExit: false });
  container = await built
    .withEnvironment({ POSTGRES_HOST_AUTH_METHOD: 'trust' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    // TEMPORARY MITIGATION: under host IO pressure initdb plus the restart took longer than
    // testcontainers' default 60s (measured 2026-10-11). Root cause (slow dockerd and IO
    // starvation) is tracked on EI-25658543783887821; the hook's own budget is 600s.
    .withStartupTimeout(300_000)
    .start();
  sql = postgres({
    host: container.getHost(), port: container.getMappedPort(5432),
    user: 'postgres', database: 'postgres', max: 2, onnotice: () => {},
  });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.work_items (id int PRIMARY KEY, ws text, title text, summary text, notes text);
    CREATE TABLE harness_shared.code_recipes (id int PRIMARY KEY, title text, description text);
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL,
      template_slug text, title text, content text, status text DEFAULT 'active',
      archived boolean NOT NULL DEFAULT false, superseded_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      _search tsvector GENERATED ALWAYS AS
        (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))) STORED,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug));
    INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, template_slug, title, content) VALUES
      ('ws1', 'h', 'kangaroo-plan', NULL, 'Kangaroo relocation', 'Move the kangaroo enclosure before the quarterly review.'),
      ('ws1', 'h', 'quarterly-plan', NULL, 'Budget', 'Prepare the quarterly figures for the board.'),
      ('ws1', 'h', 'other-plan', NULL, 'Unrelated', 'Nothing about marsupials here.'),
      ('ws2', 'h', 'foreign-plan', NULL, 'Kangaroo elsewhere', 'A kangaroo plan in another workspace.'),
      ('ws1', 'h', 'template-plan', 'tpl', 'Kangaroo template', 'A kangaroo template, not a plan.');
  `);
  const rows = Array.from({ length: 400 }, (_, i) => {
    const id = i + 1;
    const topic = id <= TOPICS.length ? ` about the ${TOPICS[id - 1]}` : '';
    return { id, ws: `w${id % 2}`, title: `item ${id}${topic}`, summary: `routine summary for item ${id}`, notes: null };
  });
  await sql`INSERT INTO harness_shared.work_items ${sql(rows)}`;
  await sql.unsafe(migration1447());
}, 600_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await container?.stop();
});

describe('migration 1447', () => {
  it('builds the index for every present corpus and reports absent tables', async () => {
    const out = await sql<{ corpus_index: string; outcome: string }[]>`SELECT * FROM harness_shared.bm25_ensure_indexes()`;
    const by = new Map(out.map(r => [r.corpus_index, r.outcome]));
    expect(by.get('work_items_bm25')).toBe('present');
    expect(by.get('code_recipes_bm25')).toBe('present');
    expect(by.get('harness_plans_bm25')).toBe('present');
    expect(by.get('documents_bm25')).toBe('skipped:table-missing');
  });

  it('detects the library through a GUC every role may read', async () => {
    await sql.unsafe(`CREATE ROLE bm25_nosu LOGIN; GRANT USAGE ON SCHEMA harness_shared TO bm25_nosu;`);
    const [r] = await sql.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE bm25_nosu');
      return tx<{ loaded: boolean }[]>`SELECT harness_shared.bm25_library_preloaded() AS loaded`;
    });
    expect(r?.loaded).toBe(true);
  });

  it('reports a second BM25 index on the same expression as a duplicate', async () => {
    await sql.unsafe(`CREATE INDEX wi_twin ON harness_shared.work_items USING bm25
      ((coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(notes, ''))) WITH (text_config = 'english')`);
    try {
      const out = await sql<{ outcome: string }[]>`
        SELECT outcome FROM harness_shared.bm25_ensure_indexes() WHERE corpus_index = 'work_items_bm25'`;
      expect(out.map(r => r.outcome).sort()).toEqual(['duplicate:wi_twin', 'present']);
    } finally {
      await sql.unsafe('DROP INDEX harness_shared.wi_twin');
    }
  });
});

async function rankIds(query: string, ws?: string): Promise<number[]> {
  const leg = await lexicalLeg(sql, {
    table: 'work_items', query, alias: 'w',
    legacy: { score: sql`0::float8`, match: sql`false` },
  });
  const rows = await sql<{ id: number }[]>`
    SELECT w.id FROM harness_shared.work_items w
     WHERE ${ws ? sql`w.ws = ${ws} AND` : sql``} ${leg.match}
     ORDER BY ${leg.order}, w.id LIMIT 10`;
  return rows.map(r => r.id);
}

describe('lexical seam on BM25', () => {
  it('chooses BM25 when the corpus index exists', async () => {
    resetBm25Availability();
    expect(await lexicalEngine(sql, 'work_items')).toBe('bm25');
  });

  it('ranks the item holding a rare term first, ahead of items matching only a common term', async () => {
    expect((await rankIds('routine quokka'))[0]).toBe(1);
  });

  it('drops the zero-distance rows a filtered index scan returns', async () => {
    // Item 1 (quokka) is in workspace w1; workspace w0 has no quokka at all.
    expect(await rankIds('quokka', 'w0')).toEqual([]);
    expect(await rankIds('quokka', 'w1')).toEqual([1]);
  });

  it('scores higher-is-better and survives prepared (generic-plan) reuse', async () => {
    const leg = bm25Leg(sql, bm25Corpus('work_items'), 'pangolin');
    for (let i = 0; i < 7; i++) {
      const [top] = await sql<{ id: number; score: number }[]>`
        SELECT id, ${leg.score} AS score FROM harness_shared.work_items WHERE ${leg.match} ORDER BY ${leg.order} LIMIT 1`;
      expect(top?.id).toBe(4);
      expect(top?.score).toBeGreaterThan(0);
    }
  });

  it('meets a known-item MRR@10 floor over the topic items', async () => {
    let mrr = 0;
    for (const [i, topic] of TOPICS.entries()) {
      const rank = (await rankIds(`the ${topic} item`)).indexOf(i + 1);
      mrr += rank < 0 ? 0 : 1 / (rank + 1);
    }
    expect(mrr / TOPICS.length).toBeGreaterThanOrEqual(0.9);
  });

  it('accepts operator characters in user input', async () => {
    expect((await rankIds('quokka & (routine'))[0]).toBe(1);
  });
});

describe('plan knowledge source on BM25 (P-005)', () => {
  const lexical = (query: string) => createPlanSearchSource().lexical({
    sql, query, workspaceId: 'ws1', scopeFilter: null, limit: 10,
  } as unknown as SearchSourceParams);

  it('ranks with BM25: any-term match, both-term plan first, fences kept', async () => {
    resetBm25Availability();
    const listing = await lexical('kangaroo quarterly');
    const keys = listing.map(h => h.key);
    // The legacy AND query matches only kangaroo-plan; quarterly-plan holds one of the
    // two terms, so only BM25's any-term match admits it.
    expect(keys).toEqual(['plan:h:kangaroo-plan', 'plan:h:quarterly-plan']);
    expect(listing[0]!.score).toBeGreaterThan(listing[1]!.score);
    expect(listing[1]!.score).toBeGreaterThan(0);
  });

  it('highlights a row that matches only some of the query terms', async () => {
    const listing = await lexical('kangaroo quarterly');
    const partial = listing.find(h => h.key === 'plan:h:quarterly-plan');
    expect(String(partial?.row.highlight)).toContain('<mark>quarterly</mark>');
  });
});

describe('websearch operator syntax under BM25 (plan D-007)', () => {
  async function websearchIds(query: string, querySyntax?: 'websearch'): Promise<number[]> {
    const tsv = sql`to_tsvector('english', coalesce(w.title, '') || ' ' || coalesce(w.summary, ''))`;
    const leg = await lexicalLeg(sql, {
      table: 'work_items', query, alias: 'w', ...(querySyntax ? { querySyntax } : {}),
      legacy: { score: sql`0::float8`, match: sql`${tsv} @@ websearch_to_tsquery('english', ${query})` },
    });
    const rows = await sql<{ id: number }[]>`
      SELECT w.id FROM harness_shared.work_items w WHERE ${leg.match} ORDER BY ${leg.order}, w.id LIMIT 10`;
    return rows.map(r => r.id);
  }

  it('without the websearch request, BM25 reads -quokka as a positive term', async () => {
    expect((await websearchIds('routine -quokka'))[0]).toBe(1);
  });

  it('with it, a negated term excludes its rows and BM25 still orders the rest', async () => {
    const ids = await websearchIds('routine -quokka', 'websearch');
    expect(ids).toHaveLength(10);
    expect(ids).not.toContain(1);
  });

  it('honours a quoted phrase: the reversed phrase matches nothing', async () => {
    expect(await websearchIds('"summary routine"')).toHaveLength(10);
    expect(await websearchIds('"summary routine"', 'websearch')).toEqual([]);
    expect(await websearchIds('"routine summary" pangolin', 'websearch')).toEqual([4]);
  });

  it('keeps BM25 any-term matching for a plain query', async () => {
    expect((await websearchIds('quokka marmoset', 'websearch')).sort((a, b) => a - b)).toEqual([1, 2]);
  });
});

describe('rank fusion with a BM25 leg (plan D-004)', () => {
  // BM25 matches items 1 (quokka) and 2 (marmoset) only; the stand-in second leg matches
  // items 2 and 3, best = 3. The OR in WHERE keeps the planner off the BM25 index scan, so
  // the distance is computed per row inside the window.
  async function fused(scale: number): Promise<{ id: number; score: number }[]> {
    const leg = bm25Leg(sql, bm25Corpus('work_items'), 'quokka marmoset', 'w');
    const otherMatch = sql`w.id IN (2, 3)`;
    return sql<{ id: number; score: number }[]>`
      SELECT w.id,
             (${rrfTerm(sql, leg.match, leg.score)} + ${rrfTerm(sql, otherMatch, sql`w.id * ${scale}::float8`)})::float8 AS score
        FROM harness_shared.work_items w
       WHERE ${leg.match} OR ${otherMatch}
       ORDER BY score DESC, w.id`;
  }

  it('ranks the row both legs match first and admits only rows some leg matches', async () => {
    const rows = await fused(1);
    expect(rows.map(r => r.id).sort()).toEqual([1, 2, 3]);
    expect(rows[0]?.id).toBe(2);
    // Item 2 is second in the other leg and first or second (a tie with item 1) in BM25.
    expect(rows[0]!.score).toBeGreaterThanOrEqual(1 / 62 + 1 / 62 - 1e-12);
    expect(rows[0]!.score).toBeLessThanOrEqual(1 / 61 + 1 / 62 + 1e-12);
    for (const r of rows.slice(1)) expect(r.score).toBeGreaterThan(0);
  });

  it('depends on positions only, so rescaling a leg changes nothing', async () => {
    expect(await fused(1_000_000)).toEqual(await fused(1));
  });
});

describe('fallback and health', () => {
  it('is ok while every present corpus has its index', async () => {
    const health = await bm25Health(sql);
    expect(health).toMatchObject({ status: 'ok', libraryLoaded: true, extensionInstalled: true, missingIndexes: [] });
    expect(health.presentIndexes.sort()).toEqual(['code_recipes_bm25', 'work_items_bm25']);
  });

  it('falls back to the legacy ranking and reports degraded when an index is missing', async () => {
    await sql.unsafe('DROP INDEX harness_shared.code_recipes_bm25');
    try {
      resetBm25Availability();
      expect(await lexicalEngine(sql, 'code_recipes')).toBe('legacy');
      const legacy = { score: sql`1::float8`, match: sql`true` };
      const leg = await lexicalLeg(sql, { table: 'code_recipes', query: 'x', legacy });
      expect(leg.engine).toBe('legacy');
      expect(leg.score).toBe(legacy.score);
      const health = await bm25Health(sql);
      expect(health.status).toBe('degraded');
      expect(health.missingIndexes).toEqual(['code_recipes_bm25']);
      expect(health.reason).toContain('code_recipes_bm25');
    } finally {
      await sql`SELECT harness_shared.bm25_ensure_indexes()`;
      resetBm25Availability();
    }
  });
});
