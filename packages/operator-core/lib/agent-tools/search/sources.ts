/**
 * The Papercusp prose search surfaces, as `@papercusp/search`
 * `SearchSource`s. Each owns its own SQL (table, tsvector/embedding
 * columns, ts_headline, row→hit mapping); both `search:fulltext` (BM25)
 * and `search:semantic` (hybrid) consume this one registry, so the BM25
 * SQL lives in exactly one place.
 *
 * Extraction per papercusp-systems-abstraction-2026-05-29 (P-013/P-020).
 * session_turn + coord_message added per session-search-scope-2026-07-05
 * (D-001: new data source = new SearchSource here; a new WAY OF SCOPING =
 * a filter in the shared filter bag, never a new search verb).
 */

import type { SearchSource, SearchSourceParams, Listing } from '@papercusp/search';

/** Standard ts_headline options for all four surfaces. */
const HEADLINE_OPTS =
  'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, FragmentDelimiter=" … ", MaxWords=18, MinWords=5, ShortWord=2';

const trunc = (s: string): string => s.slice(0, 200) + (s.length > 200 ? '…' : '');

/**
 * How many rows a per-lexeme document-frequency probe will count before it
 * stops. We only need the ARGMIN — which lexeme is rarest — so a lexeme that
 * exceeds the cap is simply "common", and capping makes the probe's cost
 * predictable instead of proportional to the table. Measured 2026-08-03 on
 * `session_turns` (421k rows, 5 lexemes): 121ms capped vs 159ms uncapped, same
 * anchor chosen, with the three common lexemes saturating at the cap exactly as
 * intended.
 */
const DF_PROBE_CAP = 2000;

/**
 * P-017 / D-062 — the lexical leg's term-combination mode, as SQL fragments.
 *
 * Both modes share ONE query shape (`ORDER BY coverage DESC, rank DESC`), which
 * is what keeps the AND path byte-identical rather than merely similar: in
 * `'and'` mode `coverage` is the constant 1, so the ordering degenerates to
 * `rank DESC` — today's query, exactly.
 *
 * ⚠ THE ORDERING IS THE WHOLE POINT, AND THE OBVIOUS VERSION IS WRONG.
 * `ts_rank_cd` scores term frequency and cover density; it cannot express how
 * many DISTINCT query lexemes a document matched. Under AND that never
 * mattered — the filter guaranteed full coverage — so removing the filter
 * leaves NOTHING expressing coverage, and an 8,000-char document repeating one
 * common term outranks a short one containing every term. Measured live on
 * `session_turns` for `corpus recall pointer section clamp`: plain disjunction
 * scored by `ts_rank_cd` put all seven all-terms documents at positions
 * 36/41/64/153/213/277/427 while the corpus leg admits SIX. Coverage-first
 * ordering puts the same seven at 1-7 and a four-of-five document — one the AND
 * query discards outright — at 8.
 *
 * The RAREST-lexeme anchor is what makes it affordable. Grading every
 * disjunctive match is correct but cost 745ms on one source against the corpus
 * leg's 2s WHOLE-leg bound; anchoring first cuts the candidate set from 23,011
 * to 1,669 and the query to 105ms, and — because every AND row necessarily
 * matches the anchor — it cannot drop a row the AND query would have returned.
 *
 * Injection-safety: the disjunctive query is derived by rewriting
 * `plainto_tsquery`'s OWN output, so Postgres does all parsing, normalisation
 * and stop-word removal and we only swap the operator. No user text is ever
 * interpolated into tsquery grammar.
 */
function lexicalSql(
  p: SearchSourceParams,
  /** The source's tsvector column, as a fragment: `p.sql\`text_tsv\``. */
  tsv: ReturnType<SearchSourceParams['sql']>,
  /** The source's table, as a fragment: `p.sql\`harness_shared.session_turns\``. */
  table: ReturnType<SearchSourceParams['sql']>,
) {
  const sql = p.sql;
  const orText = sql`replace(plainto_tsquery('english', ${p.query})::text, ' & ', ' | ')`;

  if (p.lexicalMode !== 'coverage-graded') {
    return {
      with: sql`WITH q AS (SELECT plainto_tsquery('english', ${p.query}) AS andq)`,
      join: sql`, q`,
      coverage: sql`1`,
      rank: sql`ts_rank_cd(${tsv}, q.andq)`,
      match: sql`${tsv} @@ q.andq`,
      headlineQuery: sql`q.andq`,
    };
  }

  return {
    with: sql`
      WITH q AS (
        SELECT ${orText}::tsquery       AS orq,
               string_to_array(${orText}, ' | ') AS lexemes
      ), df AS (
        SELECT l, (SELECT count(*) FROM (
                     SELECT 1 FROM ${table} d
                      WHERE d.${tsv} @@ l::tsquery
                      LIMIT ${DF_PROBE_CAP}
                   ) capped) AS n
          FROM q, unnest(q.lexemes) AS l
      ), anchor AS (
        SELECT l::tsquery AS a FROM df ORDER BY n ASC, l ASC LIMIT 1
      )`,
    join: sql`, q, anchor`,
    coverage: sql`(SELECT count(*) FROM unnest(q.lexemes) AS cl WHERE ${tsv} @@ cl::tsquery)`,
    rank: sql`ts_rank_cd(${tsv}, q.orq)`,
    match: sql`${tsv} @@ anchor.a AND ${tsv} @@ q.orq`,
    // Highlight against the DISJUNCTIVE query on purpose: a four-of-five
    // document has no fragment matching all five terms, and highlighting it
    // with the AND query would return the document's lead instead of the part
    // that actually matched.
    headlineQuery: sql`q.orq`,
  };
}

const escalations: SearchSource = {
  name: 'escalations',
  async bm25({ sql, query, workspaceId, scopeFilter, limit }: SearchSourceParams): Promise<Listing> {
    const rows = (await sql`
      SELECT harness_slug, phase, escalation, supervisor_notes,
             ts_rank_cd(body_tsv, plainto_tsquery('english', ${query})) AS rank,
             ts_headline('english',
               COALESCE(escalation, '') || E'\n' || COALESCE(supervisor_notes, ''),
               plainto_tsquery('english', ${query}),
               ${HEADLINE_OPTS}
             ) AS highlight
        FROM harness_shared.harness_escalations
       WHERE workspace_id = ${workspaceId}
         AND (${scopeFilter}::text IS NULL OR harness_slug = ${scopeFilter})
         AND body_tsv @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC LIMIT ${limit}
    `) as unknown as Array<{ harness_slug: string; phase: string; escalation: string | null; supervisor_notes: string | null; rank: number; highlight: string }>;
    return rows.map((r) => {
      const body = `${r.escalation ?? ''}\n${r.supervisor_notes ?? ''}`.trim();
      return {
        key: `escalations:${r.harness_slug}:${r.phase}`,
        score: r.rank,
        row: {
          source: 'escalations',
          source_id: `${r.harness_slug}:${r.phase}`,
          scope: r.harness_slug,
          excerpt: trunc(body),
          highlight: r.highlight,
          score: r.rank,
          rankers: ['bm25'],
        },
      };
    });
  },
  async embedding({ sql, query, workspaceId, scopeFilter, limit, qVec }): Promise<Listing> {
    const rows = (await sql`
      SELECT harness_slug, phase, escalation, supervisor_notes,
             1 - (body_embedding <=> ${qVec}::vector) AS sim,
             ts_headline('english',
               COALESCE(escalation, '') || E'\n' || COALESCE(supervisor_notes, ''),
               plainto_tsquery('english', ${query}),
               ${HEADLINE_OPTS}) AS highlight
        FROM harness_shared.harness_escalations
       WHERE workspace_id = ${workspaceId}
         AND (${scopeFilter}::text IS NULL OR harness_slug = ${scopeFilter})
         AND body_embedding IS NOT NULL
    ORDER BY body_embedding <=> ${qVec}::vector
       LIMIT ${limit}
    `) as unknown as Array<{ harness_slug: string; phase: string; escalation: string | null; supervisor_notes: string | null; sim: number; highlight: string }>;
    return rows.map((r) => {
      const body = `${r.escalation ?? ''}\n${r.supervisor_notes ?? ''}`.trim();
      return {
        key: `escalations:${r.harness_slug}:${r.phase}`,
        score: r.sim,
        row: {
          source: 'escalations',
          source_id: `${r.harness_slug}:${r.phase}`,
          scope: r.harness_slug,
          excerpt: trunc(body),
          highlight: r.highlight,
          score: r.sim,
          rankers: ['embeddings'],
        },
      };
    });
  },
};

const brainstorm: SearchSource = {
  name: 'brainstorm',
  async bm25({ sql, query, workspaceId, scopeFilter, limit }: SearchSourceParams): Promise<Listing> {
    const rows = (await sql`
      SELECT harness_slug, phase, content,
             ts_rank_cd(content_tsv, plainto_tsquery('english', ${query})) AS rank,
             ts_headline('english', content,
               plainto_tsquery('english', ${query}),
               ${HEADLINE_OPTS}) AS highlight
        FROM harness_shared.harness_brainstorm
       WHERE workspace_id = ${workspaceId}
         AND (${scopeFilter}::text IS NULL OR harness_slug = ${scopeFilter})
         AND content_tsv @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC LIMIT ${limit}
    `) as unknown as Array<{ harness_slug: string; phase: string; content: string; rank: number; highlight: string }>;
    return rows.map((r) => ({
      key: `brainstorm:${r.harness_slug}:${r.phase}`,
      score: r.rank,
      row: {
        source: 'brainstorm',
        source_id: `${r.harness_slug}:${r.phase}`,
        scope: r.harness_slug,
        excerpt: trunc(r.content),
        highlight: r.highlight,
        score: r.rank,
        rankers: ['bm25'],
      },
    }));
  },
  async embedding({ sql, query, workspaceId, scopeFilter, limit, qVec }): Promise<Listing> {
    const rows = (await sql`
      SELECT harness_slug, phase, content,
             1 - (content_embedding <=> ${qVec}::vector) AS sim,
             ts_headline('english', content,
               plainto_tsquery('english', ${query}),
               ${HEADLINE_OPTS}) AS highlight
        FROM harness_shared.harness_brainstorm
       WHERE workspace_id = ${workspaceId}
         AND (${scopeFilter}::text IS NULL OR harness_slug = ${scopeFilter})
         AND content_embedding IS NOT NULL
    ORDER BY content_embedding <=> ${qVec}::vector
       LIMIT ${limit}
    `) as unknown as Array<{ harness_slug: string; phase: string; content: string; sim: number; highlight: string }>;
    return rows.map((r) => ({
      key: `brainstorm:${r.harness_slug}:${r.phase}`,
      score: r.sim,
      row: {
        source: 'brainstorm',
        source_id: `${r.harness_slug}:${r.phase}`,
        scope: r.harness_slug,
        excerpt: trunc(r.content),
        highlight: r.highlight,
        score: r.sim,
        rankers: ['embeddings'],
      },
    }));
  },
};

const turns: SearchSource = {
  // operator_turns has no workspace_id column — it joins through
  // operator_conversations.workspace_id via the conversation_id FK.
  name: 'turns',
  async bm25({ sql, query, workspaceId, limit }: SearchSourceParams): Promise<Listing> {
    const rows = (await sql`
      SELECT t.id, t.role, t.text,
             ts_rank_cd(t.text_tsv, plainto_tsquery('english', ${query})) AS rank,
             ts_headline('english', t.text,
               plainto_tsquery('english', ${query}),
               ${HEADLINE_OPTS}) AS highlight
        FROM harness_shared.operator_turns t
        JOIN harness_shared.operator_conversations c ON c.id = t.conversation_id
       WHERE c.workspace_id = ${workspaceId}
         AND t.text_tsv @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC LIMIT ${limit}
    `) as unknown as Array<{ id: string; role: string; text: string; rank: number; highlight: string }>;
    return rows.map((r) => ({
      key: `turns:${r.id}`,
      score: r.rank,
      row: {
        source: 'turns',
        source_id: r.id,
        excerpt: `[${r.role}] ${trunc(r.text)}`,
        highlight: `[${r.role}] ${r.highlight}`,
        score: r.rank,
        rankers: ['bm25'],
      },
    }));
  },
  async embedding({ sql, query, workspaceId, limit, qVec }): Promise<Listing> {
    const rows = (await sql`
      SELECT t.id, t.role, t.text,
             1 - (t.text_embedding <=> ${qVec}::vector) AS sim,
             ts_headline('english', t.text,
               plainto_tsquery('english', ${query}),
               ${HEADLINE_OPTS}) AS highlight
        FROM harness_shared.operator_turns t
        JOIN harness_shared.operator_conversations c ON c.id = t.conversation_id
       WHERE c.workspace_id = ${workspaceId}
         AND t.text_embedding IS NOT NULL
    ORDER BY t.text_embedding <=> ${qVec}::vector
       LIMIT ${limit}
    `) as unknown as Array<{ id: string; role: string; text: string; sim: number; highlight: string }>;
    return rows.map((r) => ({
      key: `turns:${r.id}`,
      score: r.sim,
      row: {
        source: 'turns',
        source_id: r.id,
        excerpt: `[${r.role}] ${trunc(r.text)}`,
        highlight: `[${r.role}] ${r.highlight}`,
        score: r.sim,
        rankers: ['embeddings'],
      },
    }));
  },
};

const decisions: SearchSource = {
  name: 'decisions',
  async bm25({ sql, query, workspaceId, scopeFilter, limit }: SearchSourceParams): Promise<Listing> {
    const rows = (await sql`
      SELECT harness_slug, line_hash, verb, args, iso,
             ts_rank_cd(body_tsv, plainto_tsquery('english', ${query})) AS rank,
             ts_headline('english',
               coalesce(verb, '') || ' ' || coalesce(args, ''),
               plainto_tsquery('english', ${query}),
               ${HEADLINE_OPTS}) AS highlight
        FROM harness_shared.harness_decisions
       WHERE workspace_id = ${workspaceId}
         AND (${scopeFilter}::text IS NULL OR harness_slug = ${scopeFilter})
         AND body_tsv @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC LIMIT ${limit}
    `) as unknown as Array<{ harness_slug: string; line_hash: string; verb: string; args: string; iso: string; rank: number; highlight: string }>;
    return rows.map((r) => {
      const body = `${r.verb} ${r.args}`.trim();
      return {
        key: `decisions:${r.harness_slug}:${r.line_hash}`,
        score: r.rank,
        row: {
          source: 'decisions',
          source_id: `${r.harness_slug}:${r.line_hash}`,
          scope: r.harness_slug,
          excerpt: `[${r.iso}] ${trunc(body)}`,
          highlight: r.highlight,
          score: r.rank,
          rankers: ['bm25'],
        },
      };
    });
  },
  async embedding({ sql, query, workspaceId, scopeFilter, limit, qVec }): Promise<Listing> {
    const rows = (await sql`
      SELECT harness_slug, line_hash, verb, args, iso,
             1 - (body_embedding <=> ${qVec}::vector) AS sim,
             ts_headline('english',
               coalesce(verb, '') || ' ' || coalesce(args, ''),
               plainto_tsquery('english', ${query}),
               ${HEADLINE_OPTS}) AS highlight
        FROM harness_shared.harness_decisions
       WHERE workspace_id = ${workspaceId}
         AND (${scopeFilter}::text IS NULL OR harness_slug = ${scopeFilter})
         AND body_embedding IS NOT NULL
    ORDER BY body_embedding <=> ${qVec}::vector
       LIMIT ${limit}
    `) as unknown as Array<{ harness_slug: string; line_hash: string; verb: string; args: string; iso: string; sim: number; highlight: string }>;
    return rows.map((r) => {
      const body = `${r.verb} ${r.args}`.trim();
      return {
        key: `decisions:${r.harness_slug}:${r.line_hash}`,
        score: r.sim,
        row: {
          source: 'decisions',
          source_id: `${r.harness_slug}:${r.line_hash}`,
          scope: r.harness_slug,
          excerpt: `[${r.iso}] ${trunc(body)}`,
          highlight: r.highlight,
          score: r.sim,
          rankers: ['embeddings'],
        },
      };
    });
  },
};

/**
 * EI-6984: `search:fulltext` had no work-item scope at all, so an agent filing a new
 * tracker (EI-*) had no cheap existence check before creating a likely duplicate —
 * `work_items:list` doesn't scale past ~500 rows and has no text search. Bm25-only
 * (`harness_shared.engineer_issues` has no embedding column yet, so this source is
 * absent from search:semantic's hybrid fusion — see SearchSource.embedding being
 * optional). Reuses the table's EXISTING generated `_search` tsvector (title
 * weight A / body weight B) + its GIN index — no migration needed.
 */
const workItem: SearchSource = {
  name: 'work_item',
  async bm25(p: SearchSourceParams): Promise<Listing> {
    const { sql, workspaceId, scopeFilter, limit } = p;
    // P-017 / D-062 — see lexicalSql. Byte-identical without `lexicalMode`.
    const lex = lexicalSql(p, sql`_search`, sql`harness_shared.engineer_issues`);
    const rows = (await sql`
      ${lex.with}
      SELECT issue_id, scope, title, body, kind, state, severity,
             ${lex.coverage} AS coverage,
             ${lex.rank} AS rank,
             ts_headline('english', coalesce(title, '') || E'\n' || coalesce(body, ''),
               ${lex.headlineQuery},
               ${HEADLINE_OPTS}) AS highlight
        FROM harness_shared.engineer_issues ${lex.join}
       WHERE workspace_id = ${workspaceId}
         -- the scope column stores 'operator' | 'harness:<slug>' — a bare harness_slug
         -- filter (as the other sources take it) maps to the 'harness:<slug>' form.
         AND (${scopeFilter}::text IS NULL OR scope = 'harness:' || ${scopeFilter}::text)
         AND ${lex.match}
    ORDER BY coverage DESC, rank DESC LIMIT ${limit}
    `) as unknown as Array<{
      issue_id: string;
      scope: string;
      title: string;
      body: string;
      kind: string;
      state: string;
      severity: string;
      rank: number;
      highlight: string;
    }>;
    return rows.map((r) => {
      const body = `${r.title}\n${r.body}`.trim();
      return {
        key: `work_item:${r.issue_id}`,
        score: r.rank,
        row: {
          source: 'work_item',
          source_id: r.issue_id,
          scope: r.scope,
          excerpt: `[${r.kind}/${r.state}/${r.severity}] ${trunc(body)}`,
          highlight: r.highlight,
          score: r.rank,
          rankers: ['bm25'],
        },
      };
    });
  },
};

/**
 * session_turn — the episodic verbatim transcript index (session-search-scope-
 * 2026-07-05 P-004 / D-003): claude/omp/codex JSONL + agent_chat transcripts,
 * ingested by search/session-ingest.ts into harness_shared.session_turns.
 *
 * Notes:
 *   * workspace predicate is (workspace_id = $ws OR workspace_id = 'default'):
 *     local transcript files carry no workspace identity and are stamped
 *     'default' (the agent_chats_consolidated convention) — host-global data,
 *     visible from any workspace-scoped search on this box.
 *   * FULL filter-bag support (P-002): owners / speaker / sessionId /
 *     sourceKind / since / until — each null-guarded so an absent filter
 *     never narrows.
 *   * scopeFilter (harness_slug) narrows agent_chat rows; file-sourced rows
 *     have NULL harness_slug and are excluded by a harness-scoped search —
 *     intentional: "search this harness" should not surface unrelated
 *     desktop-session chatter.
 */
const sessionTurnFilterSql = (p: SearchSourceParams) => {
  const f = p.filters ?? {};
  return {
    owners: f.owners && f.owners.length ? f.owners : null,
    speaker: f.speaker ?? null,
    sessionId: f.sessionId ?? null,
    sourceKind: f.sourceKind ?? null,
    since: f.since ?? null,
    until: f.until ?? null,
  };
};

const sessionTurn: SearchSource = {
  name: 'session_turn',
  async bm25(p: SearchSourceParams): Promise<Listing> {
    const f = sessionTurnFilterSql(p);
    // WI-4734: under the engine's highlight-deferral (wantHighlight === false)
    // skip ts_headline entirely — it costs ~1.4ms/row and the engine hydrates
    // the final top-N via hydrateHighlights below instead of paying it for the
    // whole limit*3 over-fetch pool.
    // P-017 / D-062: `lex` supplies the term-combination fragments. Without
    // `lexicalMode: 'coverage-graded'` this is byte-identical to the pre-P-017
    // query — `coverage` is the constant 1, so the ordering is `rank DESC`.
    const lex = lexicalSql(p, p.sql`text_tsv`, p.sql`harness_shared.session_turns`);
    const rows = (await p.sql`
      ${lex.with}
      SELECT source_kind, session_id, turn_idx, speaker, owner, harness_slug, ts, text,
             ${lex.coverage} AS coverage,
             ${lex.rank} AS rank,
             ${p.wantHighlight === false
               ? p.sql`''`
               : p.sql`ts_headline('english', left(text, 4000),
                   ${lex.headlineQuery},
                   ${HEADLINE_OPTS})`} AS highlight
        FROM harness_shared.session_turns ${lex.join}
       WHERE (workspace_id = ${p.workspaceId} OR workspace_id = 'default')
         AND (${p.scopeFilter}::text IS NULL OR harness_slug = ${p.scopeFilter})
         AND (${f.owners}::text[] IS NULL OR owner = ANY(${f.owners}::text[]))
         AND (${f.speaker}::text IS NULL OR speaker = ${f.speaker})
         AND (${f.sessionId}::text IS NULL OR session_id = ${f.sessionId})
         AND (${f.sourceKind}::text IS NULL OR source_kind = ${f.sourceKind})
         AND (${f.since}::timestamptz IS NULL OR COALESCE(ts, ingested_at) >= ${f.since}::timestamptz)
         AND (${f.until}::timestamptz IS NULL OR COALESCE(ts, ingested_at) < ${f.until}::timestamptz)
         AND ${lex.match}
    ORDER BY coverage DESC, rank DESC LIMIT ${p.limit}
    `) as unknown as Array<{ source_kind: string; session_id: string; turn_idx: number; speaker: string; owner: string | null; harness_slug: string | null; ts: string | null; text: string; rank: number; highlight: string }>;
    return rows.map((r) => ({
      key: `session_turn:${r.source_kind}:${r.session_id}:${r.turn_idx}`,
      score: r.rank,
      row: {
        source: 'session_turn',
        source_id: `${r.source_kind}:${r.session_id}:${r.turn_idx}`,
        ...(r.harness_slug ? { scope: r.harness_slug } : {}),
        excerpt: `[${r.speaker}${r.owner ? ` ${r.owner}` : ''}${r.ts ? ` ${r.ts}` : ''}] ${trunc(r.text)}`,
        highlight: r.highlight,
        score: r.rank,
        // Expose the turn timestamp so the engine's optional recency re-rank
        // (RecencyRank.getTime defaults to hit.ts) can bias by freshness.
        ts: r.ts,
        rankers: ['bm25'],
      },
    }));
  },
  /**
   * P-034 / D-016 — scores a turn by the BEST of (its own vector, its chunk
   * vectors), not by its own vector alone.
   *
   * WHY THERE IS A SECOND LEG AT ALL. `text_embedding` is built from
   * `left(text, 2000)`, so content past that cut has no vector and is
   * unretrievable here. Measured over the 33,232 turns (8.1%) longer than the
   * cut — ~90.5M invisible characters — a probe drawn from past it ranked its
   * true parent at MRR ~0.25 / recall@1 ~14% out of 60. Unioning per-chunk
   * vectors (migration 749, 1500-char windows / 250 overlap) lifts the SAME
   * corpus and queries to MRR 0.73-0.84 / recall@1 60-75%.
   *
   * ⚠ MAX, NEVER MEAN. A turn is relevant if ANY part of it is, which is how a
   * chunked index is queried. Averaging a turn's chunk scores would reintroduce
   * precisely the dilution chunking exists to remove — a long turn with one
   * dead-on paragraph would score below a short mediocre one.
   *
   * ⚠ AND NOT A WIDER left(). That is the obvious cheaper fix and it was
   * measured and rejected: one 768-dim vector dilutes as its text grows, so
   * width PEAKS then DECLINES (at probe 3000, width 8000 scored WORSE than
   * 4000), and any apparent optimum is just the narrowest width containing the
   * probe — moving the probe collapsed width 4000 by 49%. See D-016.
   *
   * Both legs are separately top-K'd before the merge so each uses its own HNSW
   * index; deduping afterwards can only ever COLLAPSE rows, never invent them,
   * so the parent-only behaviour is preserved exactly when a turn has no chunks
   * (every turn ≤2000 chars, i.e. ~92% of them).
   */
  async embedding(p): Promise<Listing> {
    const f = sessionTurnFilterSql(p);
    // Fail-open: an unapplied migration 749 must degrade to the parent-only
    // leg, never take the semantic leg down. Cannot be a SQL-side guard —
    // Postgres resolves relations at parse time, so naming a missing table
    // fails the whole query before any predicate runs.
    const { turnChunksAvailable } = await import('../../search/turn-chunk-sync');
    const withChunks = await turnChunksAvailable(p.sql);
    const rows = (await p.sql`
      WITH scored AS (
        -- ⚠ EACH BRANCH IS PARENTHESIZED ON PURPOSE. Without the parens the
        -- trailing ORDER BY / LIMIT binds to the WHOLE union rather than to its
        -- branch, which silently turns two independent top-K probes into one —
        -- and the chunk leg would then be able to starve the parent leg out of
        -- the result entirely. Verified against live PG 2026-08-03.
        (SELECT workspace_id, source_kind, session_id, turn_idx,
               1 - (text_embedding <=> ${p.qVec}::vector) AS sim
          FROM harness_shared.session_turns
         WHERE (workspace_id = ${p.workspaceId} OR workspace_id = 'default')
           AND (${p.scopeFilter}::text IS NULL OR harness_slug = ${p.scopeFilter})
           AND (${f.owners}::text[] IS NULL OR owner = ANY(${f.owners}::text[]))
           AND (${f.speaker}::text IS NULL OR speaker = ${f.speaker})
           AND (${f.sessionId}::text IS NULL OR session_id = ${f.sessionId})
           AND (${f.sourceKind}::text IS NULL OR source_kind = ${f.sourceKind})
           AND (${f.since}::timestamptz IS NULL OR COALESCE(ts, ingested_at) >= ${f.since}::timestamptz)
           AND (${f.until}::timestamptz IS NULL OR COALESCE(ts, ingested_at) < ${f.until}::timestamptz)
           AND text_embedding IS NOT NULL
      ORDER BY text_embedding <=> ${p.qVec}::vector
         LIMIT ${p.limit})
        ${withChunks
          ? p.sql`
        UNION ALL
        (SELECT c.workspace_id, c.source_kind, c.session_id, c.turn_idx,
               1 - (c.embedding <=> ${p.qVec}::vector) AS sim
          FROM harness_shared.session_turn_chunks c
          JOIN harness_shared.session_turns st
            ON st.workspace_id = c.workspace_id
           AND st.source_kind  = c.source_kind
           AND st.session_id   = c.session_id
           AND st.turn_idx     = c.turn_idx
         WHERE (st.workspace_id = ${p.workspaceId} OR st.workspace_id = 'default')
           AND (${p.scopeFilter}::text IS NULL OR st.harness_slug = ${p.scopeFilter})
           AND (${f.owners}::text[] IS NULL OR st.owner = ANY(${f.owners}::text[]))
           AND (${f.speaker}::text IS NULL OR st.speaker = ${f.speaker})
           AND (${f.sessionId}::text IS NULL OR st.session_id = ${f.sessionId})
           AND (${f.sourceKind}::text IS NULL OR st.source_kind = ${f.sourceKind})
           AND (${f.since}::timestamptz IS NULL OR COALESCE(st.ts, st.ingested_at) >= ${f.since}::timestamptz)
           AND (${f.until}::timestamptz IS NULL OR COALESCE(st.ts, st.ingested_at) < ${f.until}::timestamptz)
           AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> ${p.qVec}::vector
         LIMIT ${p.limit})`
          : p.sql``}
      ),
      best AS (
        SELECT DISTINCT ON (workspace_id, source_kind, session_id, turn_idx)
               workspace_id, source_kind, session_id, turn_idx, sim
          FROM scored
      ORDER BY workspace_id, source_kind, session_id, turn_idx, sim DESC
      )
      SELECT st.source_kind, st.session_id, st.turn_idx, st.speaker, st.owner,
             st.harness_slug, st.ts, st.text, b.sim,
             ${p.wantHighlight === false
               ? p.sql`''`
               : p.sql`ts_headline('english', left(st.text, 4000),
                   plainto_tsquery('english', ${p.query}),
                   ${HEADLINE_OPTS})`} AS highlight
        FROM best b
        JOIN harness_shared.session_turns st
          ON st.workspace_id = b.workspace_id
         AND st.source_kind  = b.source_kind
         AND st.session_id   = b.session_id
         AND st.turn_idx     = b.turn_idx
    ORDER BY b.sim DESC
       LIMIT ${p.limit}
    `) as unknown as Array<{ source_kind: string; session_id: string; turn_idx: number; speaker: string; owner: string | null; harness_slug: string | null; ts: string | null; text: string; sim: number; highlight: string }>;
    return rows.map((r) => ({
      key: `session_turn:${r.source_kind}:${r.session_id}:${r.turn_idx}`,
      score: r.sim,
      row: {
        source: 'session_turn',
        source_id: `${r.source_kind}:${r.session_id}:${r.turn_idx}`,
        ...(r.harness_slug ? { scope: r.harness_slug } : {}),
        excerpt: `[${r.speaker}${r.owner ? ` ${r.owner}` : ''}${r.ts ? ` ${r.ts}` : ''}] ${trunc(r.text)}`,
        highlight: r.highlight,
        score: r.sim,
        // Expose the turn timestamp for the engine's optional recency re-rank.
        ts: r.ts,
        rankers: ['embeddings'],
      },
    }));
  },
  /** WI-4734: batched ts_headline for the FINAL fused top-N only (the engine
   *  calls this under deferHighlight after passing wantHighlight:false to the
   *  rankers above). source_id shape: `<sourceKind>:<sessionId>:<turnIdx>` —
   *  parsed first-colon/last-colon so a sessionId containing ':' survives
   *  (same rule as sessions/_shared parseTurnRef). One unnest join, never
   *  per-hit queries. */
  async hydrateHighlights(p: SearchSourceParams, sourceIds: string[]): Promise<Map<string, string>> {
    const kinds: string[] = [];
    const sids: string[] = [];
    const idxs: number[] = [];
    for (const id of sourceIds) {
      const first = id.indexOf(':');
      const last = id.lastIndexOf(':');
      if (first < 0 || last <= first) continue;
      const turnIdx = Number(id.slice(last + 1));
      if (!Number.isInteger(turnIdx)) continue;
      kinds.push(id.slice(0, first));
      sids.push(id.slice(first + 1, last));
      idxs.push(turnIdx);
    }
    if (kinds.length === 0) return new Map();
    const rows = (await p.sql`
      SELECT st.source_kind, st.session_id, st.turn_idx,
             ts_headline('english', left(st.text, 4000),
               plainto_tsquery('english', ${p.query}),
               ${HEADLINE_OPTS}) AS highlight
        FROM harness_shared.session_turns st
        JOIN unnest(${kinds}::text[], ${sids}::text[], ${idxs}::int[]) AS t(k, s, i)
          ON st.source_kind = t.k AND st.session_id = t.s AND st.turn_idx = t.i
    `) as unknown as Array<{ source_kind: string; session_id: string; turn_idx: number; highlight: string }>;
    return new Map(rows.map((r) => [`${r.source_kind}:${r.session_id}:${r.turn_idx}`, r.highlight]));
  },
};

/**
 * coord_message — ranked recall over the coord message stream (P-009): the
 * `messages` surface of harness_shared.coord_event_log. BM25-ONLY by design —
 * 120k+ envelope rows are not worth embedding; the expression GIN index
 * (migration 501) matches the EXACT to_tsvector expression below. With the
 * fleet→owners filter this answers "find where fleet X discussed Y" across
 * what members SAID TO EACH OTHER (this source) + what they said in their
 * sessions (session_turn) in one call.
 */
const coordMessage: SearchSource = {
  name: 'coord_message',
  async bm25(p: SearchSourceParams): Promise<Listing> {
    const f = sessionTurnFilterSql(p);
    const rows = (await p.sql`
      SELECT msg_id, ts, harness_slug,
             body->>'from' AS from_owner,
             body->>'kind' AS kind,
             left(coalesce(body->>'summary','') || ' ' || coalesce(body->>'body',''), 4000) AS msgtext,
             ts_rank_cd(
               to_tsvector('english', left(coalesce(body->>'summary','') || ' ' || coalesce(body->>'body',''), 20000)),
               plainto_tsquery('english', ${p.query})) AS rank,
             ts_headline('english',
               left(coalesce(body->>'summary','') || ' ' || coalesce(body->>'body',''), 4000),
               plainto_tsquery('english', ${p.query}),
               ${HEADLINE_OPTS}) AS highlight
        FROM harness_shared.coord_event_log
       WHERE surface = 'messages'
         AND (workspace_id = ${p.workspaceId} OR workspace_id = 'default')
         AND (${p.scopeFilter}::text IS NULL OR harness_slug = ${p.scopeFilter})
         AND (${f.owners}::text[] IS NULL OR body->>'from' = ANY(${f.owners}::text[]))
         AND (${f.since}::timestamptz IS NULL OR ts >= ${f.since}::timestamptz)
         AND (${f.until}::timestamptz IS NULL OR ts < ${f.until}::timestamptz)
         AND to_tsvector('english', left(coalesce(body->>'summary','') || ' ' || coalesce(body->>'body',''), 20000))
             @@ plainto_tsquery('english', ${p.query})
    ORDER BY rank DESC LIMIT ${p.limit}
    `) as unknown as Array<{ msg_id: string; ts: string; harness_slug: string | null; from_owner: string | null; kind: string | null; msgtext: string; rank: number; highlight: string }>;
    return rows.map((r) => ({
      key: `coord_message:${r.msg_id}`,
      score: r.rank,
      row: {
        source: 'coord_message',
        source_id: r.msg_id,
        ...(r.harness_slug ? { scope: r.harness_slug } : {}),
        excerpt: `[${r.kind ?? 'message'}${r.from_owner ? ` from ${r.from_owner}` : ''} ${r.ts}] ${trunc(r.msgtext)}`,
        highlight: r.highlight,
        score: r.rank,
        rankers: ['bm25'],
      },
    }));
  },
};

/** The seven prose surfaces, keyed by `scope` name. */
export const SEARCH_SOURCES: SearchSource[] = [
  escalations, brainstorm, turns, decisions, workItem, sessionTurn, coordMessage,
];
