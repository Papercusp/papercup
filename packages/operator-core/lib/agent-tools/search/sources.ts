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
  async bm25({ sql, query, workspaceId, scopeFilter, limit }: SearchSourceParams): Promise<Listing> {
    const rows = (await sql`
      SELECT issue_id, scope, title, body, kind, state, severity,
             ts_rank_cd(_search, plainto_tsquery('english', ${query})) AS rank,
             ts_headline('english', coalesce(title, '') || E'\n' || coalesce(body, ''),
               plainto_tsquery('english', ${query}),
               ${HEADLINE_OPTS}) AS highlight
        FROM harness_shared.engineer_issues
       WHERE workspace_id = ${workspaceId}
         -- the scope column stores 'operator' | 'harness:<slug>' — a bare harness_slug
         -- filter (as the other sources take it) maps to the 'harness:<slug>' form.
         AND (${scopeFilter}::text IS NULL OR scope = 'harness:' || ${scopeFilter}::text)
         AND _search @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC LIMIT ${limit}
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
    const rows = (await p.sql`
      SELECT source_kind, session_id, turn_idx, speaker, owner, harness_slug, ts, text,
             ts_rank_cd(text_tsv, plainto_tsquery('english', ${p.query})) AS rank,
             ts_headline('english', left(text, 4000),
               plainto_tsquery('english', ${p.query}),
               ${HEADLINE_OPTS}) AS highlight
        FROM harness_shared.session_turns
       WHERE (workspace_id = ${p.workspaceId} OR workspace_id = 'default')
         AND (${p.scopeFilter}::text IS NULL OR harness_slug = ${p.scopeFilter})
         AND (${f.owners}::text[] IS NULL OR owner = ANY(${f.owners}::text[]))
         AND (${f.speaker}::text IS NULL OR speaker = ${f.speaker})
         AND (${f.sessionId}::text IS NULL OR session_id = ${f.sessionId})
         AND (${f.sourceKind}::text IS NULL OR source_kind = ${f.sourceKind})
         AND (${f.since}::timestamptz IS NULL OR COALESCE(ts, ingested_at) >= ${f.since}::timestamptz)
         AND (${f.until}::timestamptz IS NULL OR COALESCE(ts, ingested_at) < ${f.until}::timestamptz)
         AND text_tsv @@ plainto_tsquery('english', ${p.query})
    ORDER BY rank DESC LIMIT ${p.limit}
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
        rankers: ['bm25'],
      },
    }));
  },
  async embedding(p): Promise<Listing> {
    const f = sessionTurnFilterSql(p);
    const rows = (await p.sql`
      SELECT source_kind, session_id, turn_idx, speaker, owner, harness_slug, ts, text,
             1 - (text_embedding <=> ${p.qVec}::vector) AS sim,
             ts_headline('english', left(text, 4000),
               plainto_tsquery('english', ${p.query}),
               ${HEADLINE_OPTS}) AS highlight
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
        rankers: ['embeddings'],
      },
    }));
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
