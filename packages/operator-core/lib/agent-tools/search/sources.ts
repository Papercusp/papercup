/**
 * The four Papercusp prose search surfaces, as `@papercusp/search`
 * `SearchSource`s. Each owns its own SQL (table, tsvector/embedding
 * columns, ts_headline, row→hit mapping); both `search:fulltext` (BM25)
 * and `search:semantic` (hybrid) consume this one registry, so the BM25
 * SQL lives in exactly one place.
 *
 * Extraction per papercusp-systems-abstraction-2026-05-29 (P-013/P-020).
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

/** The four prose surfaces, keyed by `scope` name. */
export const SEARCH_SOURCES: SearchSource[] = [escalations, brainstorm, turns, decisions];
