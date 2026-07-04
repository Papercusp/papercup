/**
 * GAP 10 — per-source SQL coverage + CROSS-WORKSPACE LEAK guard (testcontainer PG).
 *
 * `sources.ts` is the ONE place the real table/tsvector/cosine SQL, the scope
 * filter, and the source_id/scope/excerpt/rankers row-mapping live for all four
 * prose surfaces (escalations / brainstorm / turns / decisions). The engine
 * unit-tests run against fakes, so until now this SQL had ZERO coverage. This
 * suite runs the REAL `SEARCH_SOURCES` SQL against a real Postgres (pgvector),
 * seeding each surface in workspace **A** plus a query-matching **DECOY in
 * workspace B**, and asserts:
 *
 *   (a) SCOPE ISOLATION — a search scoped to workspace A returns ONLY A's rows.
 *       Critical for `turns`, which has NO workspace_id column and is scoped via
 *       a JOIN to operator_conversations.workspace_id. If B's prose leaks into an
 *       A-scoped search, that is a CROSS-WORKSPACE security bug.
 *   (b) harness_slug `scopeFilter` further narrows the ws-scoped sources.
 *   (c) source_id / scope / excerpt / rankers row-mapping (escalations &
 *       decisions use composite keys; turns carries no scope).
 *   (d) embedding ranker: cosine sim = 1 - (emb <=> qVec), nearest-first order.
 *
 * Schema note: rather than apply the full 000-baseline (heavy), we create just
 * the five tables this SQL touches with the exact columns + tsvector triggers
 * the production migrations define (059/061/063 + baseline column sets). The
 * tsvector columns are filled by the same trigger expressions production uses,
 * so `body_tsv @@ plainto_tsquery(...)` behaves identically.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { SEARCH_SOURCES } from './sources';
import type { SearchSource, SearchSourceParams } from '@papercusp/search';

const WS_A = 'ws-A';
const WS_B = 'ws-B'; // the decoy workspace — its rows must NEVER appear in an A-scoped search

const byName = (n: string): SearchSource => {
  const s = SEARCH_SOURCES.find((x) => x.name === n);
  if (!s) throw new Error(`source ${n} not registered`);
  return s;
};

/** All four sources define `embedding`; narrow the optional method for the test. */
type EmbeddingFn = NonNullable<SearchSource['embedding']>;
const embeddingOf = (n: string): EmbeddingFn => {
  const fn = byName(n).embedding;
  if (!fn) throw new Error(`source ${n} has no embedding ranker`);
  return fn;
};

/**
 * 384-d unit vectors built from a single "direction" angle so cosine order is
 * exactly predictable: v(θ) = [cos θ, sin θ, 0, 0, …]. Cosine sim between v(a)
 * and v(b) = cos(a−b), so a smaller |angle gap| ⇒ nearer ⇒ higher sim. The
 * query vector is v(0); a row at angle θ has sim = cos θ.
 */
function dirVec(theta: number): number[] {
  const v = new Array(384).fill(0);
  v[0] = Math.cos(theta);
  v[1] = Math.sin(theta);
  return v;
}
const Q_THETA = 0;
const QVEC = `[${dirVec(Q_THETA).join(',')}]`;
const vecLit = (theta: number): string => `[${dirVec(theta).join(',')}]`;

let db: FreshPgDb;
let sql: postgres.Sql;

/** Build exactly the columns + tsvector/embedding triggers the four sources read. */
async function setupSchema(s: postgres.Sql): Promise<void> {
  await s.unsafe('CREATE EXTENSION IF NOT EXISTS vector');

  // ── harness_escalations (059 tsv trigger, 061 embedding) ──
  await s.unsafe(`
    CREATE TABLE harness_shared.harness_escalations (
      harness_slug TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'staging',
      escalation TEXT,
      supervisor_notes TEXT,
      workspace_id TEXT NOT NULL DEFAULT '',
      body_tsv tsvector,
      body_embedding vector(384),
      PRIMARY KEY (harness_slug, phase, workspace_id)
    );
    CREATE OR REPLACE FUNCTION harness_shared.he_tsv() RETURNS trigger AS $$
    BEGIN
      NEW.body_tsv :=
        setweight(to_tsvector('english', coalesce(NEW.escalation, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(NEW.supervisor_notes, '')), 'B');
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER he_tsv_trg BEFORE INSERT OR UPDATE ON harness_shared.harness_escalations
      FOR EACH ROW EXECUTE FUNCTION harness_shared.he_tsv();
  `);

  // ── harness_brainstorm (059 tsv trigger, 061 embedding) ──
  await s.unsafe(`
    CREATE TABLE harness_shared.harness_brainstorm (
      harness_slug TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'staging',
      content TEXT NOT NULL DEFAULT '',
      workspace_id TEXT NOT NULL DEFAULT '',
      content_tsv tsvector,
      content_embedding vector(384),
      PRIMARY KEY (harness_slug, phase, workspace_id)
    );
    CREATE OR REPLACE FUNCTION harness_shared.hb_tsv() RETURNS trigger AS $$
    BEGIN NEW.content_tsv := to_tsvector('english', coalesce(NEW.content, '')); RETURN NEW; END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER hb_tsv_trg BEFORE INSERT OR UPDATE ON harness_shared.harness_brainstorm
      FOR EACH ROW EXECUTE FUNCTION harness_shared.hb_tsv();
  `);

  // ── harness_decisions (063 tsv trigger, 063 embedding) ──
  await s.unsafe(`
    CREATE TABLE harness_shared.harness_decisions (
      harness_slug TEXT NOT NULL,
      line_hash TEXT NOT NULL,
      iso TEXT NOT NULL DEFAULT '',
      verb TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '',
      workspace_id TEXT NOT NULL DEFAULT '',
      body_tsv tsvector,
      body_embedding vector(384),
      PRIMARY KEY (harness_slug, line_hash, workspace_id)
    );
    CREATE OR REPLACE FUNCTION harness_shared.hd_tsv() RETURNS trigger AS $$
    BEGIN NEW.body_tsv := to_tsvector('english', coalesce(NEW.verb,'') || ' ' || coalesce(NEW.args,'')); RETURN NEW; END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER hd_tsv_trg BEFORE INSERT OR UPDATE ON harness_shared.harness_decisions
      FOR EACH ROW EXECUTE FUNCTION harness_shared.hd_tsv();
  `);

  // ── operator_conversations + operator_turns. turns has NO workspace_id —
  //    it is scoped through the conversation JOIN. This is the leak surface. ──
  await s.unsafe(`
    CREATE TABLE harness_shared.operator_conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id TEXT NOT NULL DEFAULT '',
      started_at BIGINT NOT NULL DEFAULT 0
    );
    CREATE TABLE harness_shared.operator_turns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id uuid NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT 0,
      text_tsv tsvector,
      text_embedding vector(384)
    );
    CREATE OR REPLACE FUNCTION harness_shared.ot_tsv() RETURNS trigger AS $$
    BEGIN NEW.text_tsv := to_tsvector('english', coalesce(NEW.text,'')); RETURN NEW; END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER ot_tsv_trg BEFORE INSERT OR UPDATE ON harness_shared.operator_turns
      FOR EACH ROW EXECUTE FUNCTION harness_shared.ot_tsv();
  `);

  // ── engineer_issues (131 baseline: GENERATED _search, no embedding column) ──
  // EI-6984: the `work_item` search source. Mirrors production's generated
  // tsvector expression exactly (title weight A / body weight B) so this test
  // exercises the real ranking behavior, not an approximation.
  await s.unsafe(`
    CREATE TABLE harness_shared.engineer_issues (
      workspace_id TEXT NOT NULL DEFAULT 'default',
      issue_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'operator',
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'bug',
      severity TEXT NOT NULL DEFAULT 'minor',
      state TEXT NOT NULL DEFAULT 'open',
      _search tsvector GENERATED ALWAYS AS (
        (setweight(to_tsvector('english', coalesce(title, '')), 'A')
         || setweight(to_tsvector('english', coalesce(body, '')), 'B'))
      ) STORED,
      PRIMARY KEY (workspace_id, issue_id)
    );
  `);
}

/**
 * Seed every surface in workspace A AND a query-matching DECOY in workspace B.
 * All rows share the matchable token "kubernetes" so a bm25/embedding query
 * would surface BOTH workspaces' rows if the scope filter were missing — the
 * decoy is the leak tripwire.
 */
async function seed(s: postgres.Sql): Promise<{ convA: string; convB: string }> {
  // escalations: A (two harnesses) + B decoy
  await s`INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, supervisor_notes, workspace_id, body_embedding)
          VALUES ('sheets', 'staging', 'kubernetes scaling escalation', 'reviewed by lead', ${WS_A}, ${vecLit(0.1)}::vector)`;
  await s`INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, supervisor_notes, workspace_id, body_embedding)
          VALUES ('docs', 'staging', 'kubernetes networking escalation', 'pending', ${WS_A}, ${vecLit(0.9)}::vector)`;
  await s`INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, supervisor_notes, workspace_id, body_embedding)
          VALUES ('decoy', 'staging', 'kubernetes secret from another workspace', 'leak', ${WS_B}, ${vecLit(0.01)}::vector)`;

  // brainstorm
  await s`INSERT INTO harness_shared.harness_brainstorm (harness_slug, phase, content, workspace_id, content_embedding)
          VALUES ('sheets', 'staging', 'brainstorm about kubernetes autoscaling', ${WS_A}, ${vecLit(0.2)}::vector)`;
  await s`INSERT INTO harness_shared.harness_brainstorm (harness_slug, phase, content, workspace_id, content_embedding)
          VALUES ('decoy', 'staging', 'kubernetes brainstorm in another workspace', ${WS_B}, ${vecLit(0.02)}::vector)`;

  // decisions
  await s`INSERT INTO harness_shared.harness_decisions (harness_slug, line_hash, iso, verb, args, workspace_id, body_embedding)
          VALUES ('sheets', 'h1', '2026-01-01', 'ADOPT', 'kubernetes for orchestration', ${WS_A}, ${vecLit(0.15)}::vector)`;
  await s`INSERT INTO harness_shared.harness_decisions (harness_slug, line_hash, iso, verb, args, workspace_id, body_embedding)
          VALUES ('decoy', 'h9', '2026-01-02', 'LEAK', 'kubernetes decision in another workspace', ${WS_B}, ${vecLit(0.03)}::vector)`;

  // turns — via conversations in A and B (the no-workspace_id-column surface)
  const [{ id: convA }] = await s<Array<{ id: string }>>`
    INSERT INTO harness_shared.operator_conversations (workspace_id, started_at) VALUES (${WS_A}, 1) RETURNING id`;
  const [{ id: convB }] = await s<Array<{ id: string }>>`
    INSERT INTO harness_shared.operator_conversations (workspace_id, started_at) VALUES (${WS_B}, 2) RETURNING id`;
  await s`INSERT INTO harness_shared.operator_turns (conversation_id, seq, role, text, text_embedding)
          VALUES (${convA}, 0, 'user', 'we should run kubernetes for this', ${vecLit(0.25)}::vector)`;
  await s`INSERT INTO harness_shared.operator_turns (conversation_id, seq, role, text, text_embedding)
          VALUES (${convA}, 1, 'assistant', 'kubernetes is a good fit here', ${vecLit(0.5)}::vector)`;
  // THE DECOY: a B-workspace turn with the SAME matchable token. Must never leak.
  await s`INSERT INTO harness_shared.operator_turns (conversation_id, seq, role, text, text_embedding)
          VALUES (${convB}, 0, 'user', 'kubernetes secret discussion in another workspace', ${vecLit(0.04)}::vector)`;

  // engineer_issues (EI-6984's work_item source): A (two harness scopes) + B decoy.
  await s`INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, scope, title, body, kind, state, severity)
          VALUES (${WS_A}, 'EI-1', 'harness:sheets', 'kubernetes scaling bug', 'pods do not autoscale', 'bug', 'open', 'major')`;
  await s`INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, scope, title, body, kind, state, severity)
          VALUES (${WS_A}, 'EI-2', 'harness:docs', 'kubernetes networking change', 'wants a service mesh', 'change', 'resolved', 'minor')`;
  await s`INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, scope, title, body, kind, state, severity)
          VALUES (${WS_B}, 'EI-9', 'harness:decoy', 'kubernetes secret issue from another workspace', 'leak', 'bug', 'open', 'critical')`;

  return { convA, convB };
}

const params = (over: Partial<SearchSourceParams> = {}): SearchSourceParams => ({
  sql,
  query: 'kubernetes',
  workspaceId: WS_A,
  scopeFilter: null,
  limit: 20,
  ...over,
});

beforeAll(async () => {
  db = await createFreshPgDb('search-sources');
  sql = db.sql;
  await setupSchema(sql);
  await seed(sql);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('GAP 10 — per-source bm25 SQL: scope isolation + row mapping', () => {
  it('escalations.bm25: only workspace A; composite source_id `${slug}:${phase}`, scope=slug, rankers=[bm25]', async () => {
    const out = await byName('escalations').bm25(params());
    const ids = out.map((r) => r.row.source_id).sort();
    expect(ids).toEqual(['docs:staging', 'sheets:staging']);
    // No B/decoy row leaked in.
    expect(out.some((r) => r.row.source_id.startsWith('decoy'))).toBe(false);

    const sheets = out.find((r) => r.row.source_id === 'sheets:staging')!;
    expect(sheets.row.source).toBe('escalations');
    expect(sheets.row.scope).toBe('sheets');
    expect(sheets.row.rankers).toEqual(['bm25']);
    expect(sheets.row.excerpt).toContain('kubernetes scaling escalation');
    expect(sheets.row.excerpt).toContain('reviewed by lead'); // escalation + supervisor_notes joined
    expect(sheets.row.highlight).toContain('<mark>');
    expect(sheets.key).toBe('escalations:sheets:staging');
  });

  it('brainstorm.bm25: only A; source_id=`${slug}:${phase}`, scope=slug', async () => {
    const out = await byName('brainstorm').bm25(params());
    expect(out.map((r) => r.row.source_id)).toEqual(['sheets:staging']);
    expect(out[0].row.scope).toBe('sheets');
    expect(out[0].row.source).toBe('brainstorm');
    expect(out[0].row.excerpt).toContain('kubernetes autoscaling');
  });

  it('decisions.bm25: only A; source_id=`${slug}:${line_hash}`, excerpt prefixed with [iso]', async () => {
    const out = await byName('decisions').bm25(params());
    expect(out.map((r) => r.row.source_id)).toEqual(['sheets:h1']);
    expect(out[0].row.scope).toBe('sheets');
    expect(out[0].row.excerpt).toBe('[2026-01-01] ADOPT kubernetes for orchestration');
    expect(out[0].key).toBe('decisions:sheets:h1');
  });

  it('SECURITY — turns.bm25: workspace A ONLY via the conversation JOIN; the B-workspace decoy turn does NOT leak', async () => {
    const out = await byName('turns').bm25(params());
    // Exactly the two A turns; NOT the B decoy.
    expect(out).toHaveLength(2);
    for (const r of out) {
      expect(r.row.source).toBe('turns');
      expect(r.row.scope).toBeUndefined(); // turns carries no scope (no harness_slug)
      expect(r.row.rankers).toEqual(['bm25']);
      // role-prefixed excerpt/highlight
      expect(r.row.excerpt).toMatch(/^\[(user|assistant)\] /);
      expect(r.row.highlight).toMatch(/^\[(user|assistant)\] /);
    }
    // The decoy's distinctive phrase must be absent from every excerpt.
    expect(out.some((r) => r.row.excerpt.includes('another workspace'))).toBe(false);
  });

  // EI-6984: the work_item source — no embedding method (engineer_issues has no
  // embedding column yet), so only bm25 is exercised here.
  it('SECURITY — work_item.bm25: only workspace A; source_id=issue_id, scope=the harness:<slug> scope column, excerpt prefixed [kind/state/severity]', async () => {
    const out = await byName('work_item').bm25(params());
    const ids = out.map((r) => r.row.source_id).sort();
    expect(ids).toEqual(['EI-1', 'EI-2']);
    expect(out.some((r) => r.row.source_id === 'EI-9')).toBe(false); // the B decoy never leaks

    const ei1 = out.find((r) => r.row.source_id === 'EI-1')!;
    expect(ei1.row.source).toBe('work_item');
    expect(ei1.row.scope).toBe('harness:sheets');
    expect(ei1.row.rankers).toEqual(['bm25']);
    expect(ei1.row.excerpt).toBe('[bug/open/major] kubernetes scaling bug\npods do not autoscale');
    expect(ei1.row.highlight).toContain('<mark>');
    expect(ei1.key).toBe('work_item:EI-1');
  });

  it('work_item.bm25 with scopeFilter=sheets → only EI-1 (scope column stores harness:<slug>)', async () => {
    const out = await byName('work_item').bm25(params({ scopeFilter: 'sheets' }));
    expect(out.map((r) => r.row.source_id)).toEqual(['EI-1']);
  });

  it('a B-scoped work_item.bm25 returns ONLY the B decoy, never the A issues', async () => {
    const out = await byName('work_item').bm25(params({ workspaceId: WS_B }));
    expect(out.map((r) => r.row.source_id)).toEqual(['EI-9']);
  });
});

describe('GAP 10 — harness_slug scopeFilter narrows the ws-scoped sources', () => {
  it('escalations.bm25 with scopeFilter=sheets → only the sheets row', async () => {
    const out = await byName('escalations').bm25(params({ scopeFilter: 'sheets' }));
    expect(out.map((r) => r.row.source_id)).toEqual(['sheets:staging']);
  });

  it('escalations.bm25 with scopeFilter=docs → only the docs row', async () => {
    const out = await byName('escalations').bm25(params({ scopeFilter: 'docs' }));
    expect(out.map((r) => r.row.source_id)).toEqual(['docs:staging']);
  });

  it('decisions.bm25 with a non-matching scopeFilter → empty', async () => {
    const out = await byName('decisions').bm25(params({ scopeFilter: 'no-such-harness' }));
    expect(out).toEqual([]);
  });
});

describe('GAP 10 — embedding SQL: cosine sim = 1 - (emb <=> qVec), nearest-first, scope-isolated', () => {
  it('escalations.embedding: A-only, ordered nearest-first, score = cos(angle gap)', async () => {
    const out = await embeddingOf('escalations')({ ...params(), qVec: QVEC });
    // A rows at angles 0.1 (sheets) and 0.9 (docs); decoy is angle 0.01 in B.
    // Nearest to the query (angle 0) is sheets (0.1) then docs (0.9). Decoy,
    // though angularly NEAREST of all (0.01), is in workspace B and must be absent.
    expect(out.map((r) => r.row.source_id)).toEqual(['sheets:staging', 'docs:staging']);
    expect(out.some((r) => r.row.source_id.startsWith('decoy'))).toBe(false);

    expect(out[0].row.rankers).toEqual(['embeddings']);
    // sim of the first row ≈ cos(0.1). 1-(<=>) is the cosine sim by construction.
    expect(out[0].row.score).toBeCloseTo(Math.cos(0.1), 5);
    expect(out[1].row.score).toBeCloseTo(Math.cos(0.9), 5);
    // Descending similarity (nearest-first).
    expect(out[0].row.score).toBeGreaterThan(out[1].row.score);
  });

  it('SECURITY — turns.embedding: A-only via the JOIN; the angularly-nearest decoy (B) does NOT leak', async () => {
    const out = await embeddingOf('turns')({ ...params(), qVec: QVEC });
    expect(out).toHaveLength(2); // the two A turns only
    // A turns at angles 0.25 and 0.5 → nearest-first = 0.25 then 0.5.
    expect(out[0].row.score).toBeCloseTo(Math.cos(0.25), 5);
    expect(out[1].row.score).toBeCloseTo(Math.cos(0.5), 5);
    expect(out[0].row.score).toBeGreaterThan(out[1].row.score);
    // The B decoy (angle 0.04, the closest of all) is excluded by the ws JOIN.
    expect(out.some((r) => r.row.excerpt.includes('another workspace'))).toBe(false);
  });

  it('brainstorm.embedding + decisions.embedding: A-only, score = cosine sim', async () => {
    const bs = await embeddingOf('brainstorm')({ ...params(), qVec: QVEC });
    expect(bs.map((r) => r.row.source_id)).toEqual(['sheets:staging']);
    expect(bs[0].row.score).toBeCloseTo(Math.cos(0.2), 5);
    expect(bs[0].row.rankers).toEqual(['embeddings']);

    const dec = await embeddingOf('decisions')({ ...params(), qVec: QVEC });
    expect(dec.map((r) => r.row.source_id)).toEqual(['sheets:h1']);
    expect(dec[0].row.score).toBeCloseTo(Math.cos(0.15), 5);
    expect(dec[0].row.excerpt.startsWith('[2026-01-01]')).toBe(true);
  });

  it('embedding scopeFilter narrows too (escalations → docs only)', async () => {
    const out = await embeddingOf('escalations')({ ...params({ scopeFilter: 'docs' }), qVec: QVEC });
    expect(out.map((r) => r.row.source_id)).toEqual(['docs:staging']);
  });
});

describe('GAP 10 — workspace B sees its OWN rows (proves the filter is scoping, not just hiding)', () => {
  it('a B-scoped escalations.bm25 returns ONLY the B decoy, never the A rows', async () => {
    const out = await byName('escalations').bm25(params({ workspaceId: WS_B }));
    expect(out.map((r) => r.row.source_id)).toEqual(['decoy:staging']);
  });

  it('a B-scoped turns.bm25 returns ONLY the B turn, never the two A turns', async () => {
    const out = await byName('turns').bm25(params({ workspaceId: WS_B }));
    expect(out).toHaveLength(1);
    expect(out[0].row.excerpt).toContain('another workspace');
  });
});
