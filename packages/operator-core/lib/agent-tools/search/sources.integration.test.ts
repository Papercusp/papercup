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

  // ── session_turns (501-session-turns.sql) ──
  // P-017: the `session_turn` source is one of the two the corpus injection leg
  // reads, and one of the two `lexicalSql` was applied to. `text_tsv` mirrors
  // production's GENERATED expression exactly, so the coverage/anchor SQL below
  // is exercised against real tsvector semantics, not an approximation.
  await s.unsafe(`
    CREATE TABLE harness_shared.session_turns (
      workspace_id  TEXT        NOT NULL DEFAULT 'default',
      source_kind   TEXT        NOT NULL,
      session_id    TEXT        NOT NULL,
      turn_idx      INTEGER     NOT NULL,
      ts            TIMESTAMPTZ,
      owner         TEXT,
      harness_slug  TEXT,
      cwd           TEXT,
      speaker       TEXT        NOT NULL,
      text          TEXT        NOT NULL,
      text_tsv      tsvector GENERATED ALWAYS AS (to_tsvector('english', left(text, 20000))) STORED,
      ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, source_kind, session_id, turn_idx)
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

/**
 * P-017 / D-062 fixture — the corpus injection leg's two sources under both
 * lexical modes.
 *
 * The query is five distinct lexemes (`corpus recall pointer section clamp`),
 * and the corpus is built so every property under test is DECIDABLE rather than
 * incidental:
 *
 *   * `clamp` is the strict argmin of document frequency (5 vs 7/7/7/8 across
 *     the whole table), so the rarest-lexeme ANCHOR is deterministic. Note the
 *     DF probe is deliberately UNFILTERED — it counts the workspace-B decoy too
 *     — which is why that decoy is also a scope tripwire below.
 *   * `T_FOUR` matches four of five and CONTAINS the anchor: it is the document
 *     the AND query discards outright and coverage-graded retrieval recovers.
 *   * `T_TRAP` is the `ts_rank_cd` trap in miniature — one anchor occurrence
 *     plus a common term repeated 80×, so it outranks a short all-terms
 *     document on frequency alone. Coverage-first ordering must bury it. The
 *     test asserts BOTH halves (higher rank, lower position), so it cannot pass
 *     by accident on a fixture where the trap never fired.
 *   * `N1..N4` match up to four terms but LACK the anchor. Their absence from
 *     the graded result is the anchor's cost, asserted deliberately: it is what
 *     bounds the candidate set (23,011 → 1,669 on the real table), and it can
 *     never drop an AND hit, since every AND hit necessarily matches the anchor.
 */
const P17_QUERY = 'corpus recall pointer section clamp';
const P17_SESSION = 'sess-p017';
const stId = (turnIdx: number): string => `claude:${P17_SESSION}:${turnIdx}`;

const T_ALL_A = stId(1);
const T_ALL_B = stId(2);
const T_FOUR = stId(3);
const T_TRAP = stId(4);
const T_DECOY_B = stId(20);

async function seedP17(s: postgres.Sql): Promise<void> {
  const turn = async (
    ws: string,
    idx: number,
    text: string,
  ): Promise<void> => {
    await s`INSERT INTO harness_shared.session_turns
              (workspace_id, source_kind, session_id, turn_idx, speaker, text, ts)
            VALUES (${ws}, 'claude', ${P17_SESSION}, ${idx}, 'assistant', ${text},
                    ${`2026-08-03T00:00:${String(idx).padStart(2, '0')}Z`})`;
  };

  // 5 of 5 — the only documents the AND query can return.
  await turn(WS_A, 1, 'corpus recall pointer section clamp');
  await turn(WS_A, 2, 'the clamp applies once the corpus recall pointer section is built');
  // 4 of 5, WITH the anchor, WITHOUT `section` — recovered only by grading.
  await turn(WS_A, 3, 'corpus recall pointer clamp, discussed without the fifth term');
  // 2 of 5, anchor present, one common term repeated — the ts_rank_cd trap.
  await turn(WS_A, 4, `clamp ${'section '.repeat(80)}`);
  // Noise: up to 4 of 5 but NO anchor. Raises the common lexemes' DF above
  // `clamp`'s, and is excluded from the graded result by the anchor filter.
  await turn(WS_A, 10, 'corpus recall pointer section noise one');
  await turn(WS_A, 11, 'corpus recall section noise two');
  await turn(WS_A, 12, 'corpus pointer section noise three');
  await turn(WS_A, 13, 'recall pointer section noise four');
  // THE DECOY: all five terms, workspace B. Counted by the unfiltered DF probe,
  // but must never surface in an A-scoped result under EITHER mode.
  await turn(WS_B, 20, 'corpus recall pointer section clamp in another workspace');

  // engineer_issues — the OTHER source `lexicalSql` was applied to. Same shape:
  // `clamp` rarest (3) vs corpus/recall/pointer 4 and section 5.
  const issue = async (ws: string, id: string, title: string, body: string): Promise<void> => {
    await s`INSERT INTO harness_shared.engineer_issues
              (workspace_id, issue_id, scope, title, body, kind, state, severity)
            VALUES (${ws}, ${id}, 'harness:sheets', ${title}, ${body}, 'task', 'open', 'minor')`;
  };
  await issue(WS_A, 'EI-C1', 'corpus recall pointer', 'section clamp all five terms');
  await issue(WS_A, 'EI-C2', 'corpus recall pointer', 'clamp but not the fifth term');
  await issue(WS_A, 'EI-C3', 'clamp only', 'section only');
  await issue(WS_A, 'EI-N1', 'corpus recall', 'section noise, no anchor');
  await issue(WS_A, 'EI-N2', 'corpus pointer', 'section noise, no anchor');
  await issue(WS_A, 'EI-N3', 'recall pointer', 'section noise, no anchor');
  await issue(WS_B, 'EI-D9', 'corpus recall pointer', 'section clamp in another workspace');
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
  await seedP17(sql);
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

/**
 * P-017 / D-062 — `lexicalSql`, the corpus injection leg's term-combination mode.
 *
 * The regression this suite exists to prevent is asymmetric, so it is guarded in
 * both directions:
 *
 *   * `'and'` (the DEFAULT, and what every caller still gets) must be EXACTLY
 *     today's query. The first test asserts that against the literal pre-P-017
 *     SQL run side-by-side — same rows, same order, same rank floats, same
 *     highlight bytes — because the shared `sources.ts` registry backs
 *     `search:fulltext`, `search:semantic`, `sessions:search` and
 *     `ask-knowledge-tier` as well, and silently re-ranking those was never in
 *     scope.
 *   * `'coverage-graded'` must be a strict SUPERSET with the AND rows in the top
 *     tier — the no-regression property that let this ship as one query instead
 *     of a two-pass cascade.
 */
const p17Params = (over: Partial<SearchSourceParams> = {}): SearchSourceParams =>
  params({ query: P17_QUERY, ...over });

/** Mirrors `HEADLINE_OPTS` in sources.ts — duplicated on purpose: the point of
 *  the equivalence test is that the SHIPPED constant produces these bytes. */
const HEADLINE_OPTS_MIRROR =
  'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, FragmentDelimiter=" … ", MaxWords=18, MinWords=5, ShortWord=2';

describe('P-017 — session_turn.bm25 lexicalMode', () => {
  it("'and' mode is the PRE-P-017 query exactly — same rows, order, ranks and highlight bytes", async () => {
    // The literal query as it stood before `lexicalSql` was introduced.
    const legacy = (await sql`
      SELECT source_kind, session_id, turn_idx,
             ts_rank_cd(text_tsv, plainto_tsquery('english', ${P17_QUERY})) AS rank,
             ts_headline('english', left(text, 4000),
               plainto_tsquery('english', ${P17_QUERY}),
               ${HEADLINE_OPTS_MIRROR}) AS highlight
        FROM harness_shared.session_turns
       WHERE (workspace_id = ${WS_A} OR workspace_id = 'default')
         AND text_tsv @@ plainto_tsquery('english', ${P17_QUERY})
    ORDER BY rank DESC LIMIT 20
    `) as unknown as Array<{ source_kind: string; session_id: string; turn_idx: number; rank: number; highlight: string }>;

    const out = await byName('session_turn').bm25(p17Params());

    expect(out.map((r) => r.row.source_id)).toEqual(
      legacy.map((r) => `${r.source_kind}:${r.session_id}:${r.turn_idx}`),
    );
    expect(out.map((r) => r.score)).toEqual(legacy.map((r) => r.rank));
    expect(out.map((r) => r.row.highlight)).toEqual(legacy.map((r) => r.highlight));
    // …and it is the all-terms set, nothing more: AND cannot reach T_FOUR.
    expect(out.map((r) => r.row.source_id).sort()).toEqual([T_ALL_A, T_ALL_B]);
  });

  it("'coverage-graded' is a strict SUPERSET of 'and', with the AND rows in the top coverage tier", async () => {
    const and = await byName('session_turn').bm25(p17Params());
    const graded = await byName('session_turn').bm25(p17Params({ lexicalMode: 'coverage-graded' }));

    const andIds = and.map((r) => r.row.source_id);
    const gradedIds = graded.map((r) => r.row.source_id);

    // Containment — the property that makes this no-regression by construction.
    for (const id of andIds) expect(gradedIds).toContain(id);
    expect(gradedIds.length).toBeGreaterThan(andIds.length);

    // The AND set occupies the top tier — not merely present, but FIRST.
    expect(gradedIds.slice(0, andIds.length).sort()).toEqual([...andIds].sort());
  });

  it('recovers a 4-of-5 document the AND query discards outright', async () => {
    const and = await byName('session_turn').bm25(p17Params());
    const graded = await byName('session_turn').bm25(p17Params({ lexicalMode: 'coverage-graded' }));

    expect(and.map((r) => r.row.source_id)).not.toContain(T_FOUR);
    expect(graded.map((r) => r.row.source_id)).toContain(T_FOUR);
    // It sits directly below the coverage-5 tier, above the coverage-2 trap.
    expect(graded.map((r) => r.row.source_id)).toEqual([
      ...graded.slice(0, 2).map((r) => r.row.source_id),
      T_FOUR,
      T_TRAP,
    ]);
  });

  it('COVERAGE outranks ts_rank_cd — the frequency trap scores higher yet places last', async () => {
    const graded = await byName('session_turn').bm25(p17Params({ lexicalMode: 'coverage-graded' }));
    const byId = new Map(graded.map((r) => [r.row.source_id, r]));

    const trap = byId.get(T_TRAP);
    const allTerms = byId.get(T_ALL_A);
    expect(trap).toBeDefined();
    expect(allTerms).toBeDefined();

    // BOTH halves matter. If the first assertion ever fails the fixture has
    // stopped exercising the trap, and the second would pass vacuously.
    expect(trap!.score).toBeGreaterThan(allTerms!.score);
    expect(graded[graded.length - 1].row.source_id).toBe(T_TRAP);
  });

  it('the rarest-lexeme anchor is STRICT — 4-of-5 documents lacking it are excluded (the cost that bounds the scan)', async () => {
    const graded = await byName('session_turn').bm25(p17Params({ lexicalMode: 'coverage-graded' }));
    const ids = graded.map((r) => r.row.source_id);
    // stId(10) matches corpus+recall+pointer+section — coverage 4, no `clamp`.
    expect(ids).not.toContain(stId(10));
    expect(ids).toEqual([T_ALL_A, T_ALL_B, T_FOUR, T_TRAP].filter((id) => ids.includes(id)));
    expect(ids).toHaveLength(4);
  });

  it('graded highlights render against the DISJUNCTIVE query, so a partial match gets a real fragment', async () => {
    const graded = await byName('session_turn').bm25(p17Params({ lexicalMode: 'coverage-graded' }));
    const four = graded.find((r) => r.row.source_id === T_FOUR);
    expect(four?.row.highlight).toContain('<mark>');
  });

  it('SECURITY — the workspace-B decoy is counted by the unfiltered DF probe but leaks into NEITHER mode', async () => {
    for (const mode of ['and', 'coverage-graded'] as const) {
      const out = await byName('session_turn').bm25(p17Params({ lexicalMode: mode }));
      expect(out.map((r) => r.row.source_id)).not.toContain(T_DECOY_B);
      for (const r of out) expect(r.row.excerpt).not.toContain('another workspace');
    }
    // …and B still sees its OWN row, so this is scoping, not blanket hiding.
    const b = await byName('session_turn').bm25(
      p17Params({ workspaceId: WS_B, lexicalMode: 'coverage-graded' }),
    );
    expect(b.map((r) => r.row.source_id)).toEqual([T_DECOY_B]);
  });
});

describe('P-017 — work_item.bm25 lexicalMode (the second source the corpus leg reads)', () => {
  it("'and' returns only the all-terms issue; 'coverage-graded' is a superset ordered by coverage", async () => {
    const and = await byName('work_item').bm25(p17Params());
    const graded = await byName('work_item').bm25(p17Params({ lexicalMode: 'coverage-graded' }));

    expect(and.map((r) => r.row.source_id)).toEqual(['EI-C1']);
    // C2 is 4-of-5 with the anchor; C3 is 2-of-5 with the anchor; the N-rows
    // lack `clamp` entirely and the anchor excludes them.
    expect(graded.map((r) => r.row.source_id)).toEqual(['EI-C1', 'EI-C2', 'EI-C3']);
    for (const id of and.map((r) => r.row.source_id)) {
      expect(graded.map((r) => r.row.source_id)).toContain(id);
    }
  });

  it('SECURITY — the workspace-B issue never leaks under either mode', async () => {
    for (const mode of ['and', 'coverage-graded'] as const) {
      const out = await byName('work_item').bm25(p17Params({ lexicalMode: mode }));
      expect(out.map((r) => r.row.source_id)).not.toContain('EI-D9');
    }
  });
});
