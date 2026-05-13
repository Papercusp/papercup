/**
 * Full-text BM25-style recall over unstructured prose.
 *
 * Plan 2A — Postgres tsvector + GIN. No embeddings, no extensions
 * beyond pg_trgm/plpgsql (already present). Solves the "remember when
 * we decided…" use case where the content is past the chat history
 * budget but still in PG.
 *
 * Indexed surfaces (per migration 059):
 *   - harness_escalations  (escalation + supervisor_notes)
 *   - harness_brainstorm   (content)
 *   - operator_turns       (text, all roles)
 *
 * Different from `search:query`: that one searches structured rows
 * (tasks/goals/projects/audit/messages) by title/summary. This one
 * targets free-text bodies for paraphrase recall.
 *
 * After 1-2 weeks of observation, if BM25 alone misses real cases,
 * add Plan 2B+C (embeddings + RRF) as a SECOND tool `search:semantic`
 * that fuses BM25 + cosine ranks.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

const SCOPE_CHOICES = ['escalations', 'brainstorm', 'turns', 'decisions', 'all'] as const;

interface FullTextHit {
  source: string;       // 'escalations' | 'brainstorm' | 'turns'
  source_id: string;
  harness_slug?: string;
  excerpt: string;      // first 200 chars
  /** ts_headline-derived snippet with <mark> around matched terms. */
  highlight: string;
  rank: number;
}

/** Standard ts_headline options for our 3 surfaces. */
const HEADLINE_OPTS =
  'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, FragmentDelimiter=" … ", MaxWords=18, MinWords=5, ShortWord=2';

const ALL_ROLES = [
  'scoper', 'architect', 'worker', 'validator',
  'reviewer', 'debugger', 'operator', 'documenter', 'curator',
] as const;

export default defineTool({
  name: 'search:fulltext',
  capability: 'search:read',
  description:
    'Search workspace prose (escalations, brainstorm notes, older operator turns) by keyword match (BM25-style). Ranked by relevance. Returns excerpts.',
  guidance: {
    when: 'User references prose past the chat history budget ("remember when we decided pricing", "the X discussion from last week"), or asks about content in escalations/brainstorm where the right SQL filter is not obvious. Returns ranked snippets.',
    notWhen:
      'For STRUCTURED queries on harness state, features, tasks, issues, or messages — use the dedicated tools (harness:status, tasks:list, etc). They are faster and more precise when the schema matches the query. For CODE recall, use `gitnexus:query`. For tasks/goals/projects text, use `search:query`.',
    chaining:
      'Pair with `harness:escalation` or `harness:plan_reviews` to fetch the full row of a returned hit. The result `excerpt` is just the first 200 chars for ranking display.',
  },
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  rolesQuota: { worker: { perChunk: 10 }, operator: { perRun: 100 } },
  args: z.object({
    query: z.string().min(1).max(500),
    scope: z.array(z.enum(SCOPE_CHOICES)).optional(),
    harness_slug: z.string().optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async handler(args, ctx) {
    const limit = args.limit ?? 5;
    const scope = args.scope?.includes('all') || !args.scope?.length
      ? ['escalations', 'brainstorm', 'turns', 'decisions']
      : args.scope;

    const hits: FullTextHit[] = [];

    // The plainto_tsquery is forgiving — accepts arbitrary user
    // input without parser errors. ts_rank_cd for ordering uses
    // cover-density (favors documents where query terms are close
    // together), which matches BM25 spirit more than ts_rank.
    const harnessFilter = args.harness_slug ?? null;
    if (scope.includes('escalations')) {
      try {
        const rows = await ctx.tx<{
          harness_slug: string;
          phase: string;
          escalation: string | null;
          supervisor_notes: string | null;
          rank: number;
        }>`
          SELECT harness_slug, phase, escalation, supervisor_notes,
                 ts_rank_cd(body_tsv, plainto_tsquery('english', ${args.query})) AS rank,
                 ts_headline('english',
                   COALESCE(escalation, '') || E'\n' || COALESCE(supervisor_notes, ''),
                   plainto_tsquery('english', ${args.query}),
                   ${HEADLINE_OPTS}
                 ) AS highlight
            FROM harness_shared.harness_escalations
           WHERE workspace_id = ${ctx.workspaceId}
             AND (${harnessFilter}::text IS NULL OR harness_slug = ${harnessFilter})
             AND body_tsv @@ plainto_tsquery('english', ${args.query})
        ORDER BY rank DESC
           LIMIT ${limit}
        ` as unknown as Array<{ harness_slug: string; phase: string; escalation: string|null; supervisor_notes: string|null; rank: number; highlight: string }>;
        for (const r of rows) {
          const body = `${r.escalation ?? ''}\n${r.supervisor_notes ?? ''}`.trim();
          hits.push({
            source: 'escalations',
            source_id: `${r.harness_slug}:${r.phase}`,
            harness_slug: r.harness_slug,
            excerpt: body.slice(0, 200) + (body.length > 200 ? '…' : ''),
            highlight: r.highlight,
            rank: r.rank,
          });
        }
      } catch (err) {
        // Index not yet present (first boot before migration 059), OR
        // a real SQL error. Log under ctx.log so we can distinguish.
        ctx.log?.(`search:fulltext escalations skipped: ${(err as Error).message}`);
      }
    }

    if (scope.includes('brainstorm')) {
      try {
        const rows = await ctx.tx<{
          harness_slug: string;
          phase: string;
          content: string;
          rank: number;
        }>`
          SELECT harness_slug, phase, content,
                 ts_rank_cd(content_tsv, plainto_tsquery('english', ${args.query})) AS rank,
                 ts_headline('english', content,
                   plainto_tsquery('english', ${args.query}),
                   ${HEADLINE_OPTS}
                 ) AS highlight
            FROM harness_shared.harness_brainstorm
           WHERE workspace_id = ${ctx.workspaceId}
             AND (${harnessFilter}::text IS NULL OR harness_slug = ${harnessFilter})
             AND content_tsv @@ plainto_tsquery('english', ${args.query})
        ORDER BY rank DESC
           LIMIT ${limit}
        ` as unknown as Array<{ harness_slug: string; phase: string; content: string; rank: number; highlight: string }>;
        for (const r of rows) {
          hits.push({
            source: 'brainstorm',
            source_id: `${r.harness_slug}:${r.phase}`,
            harness_slug: r.harness_slug,
            excerpt: r.content.slice(0, 200) + (r.content.length > 200 ? '…' : ''),
            highlight: r.highlight,
            rank: r.rank,
          });
        }
      } catch (err) {
        ctx.log?.(`search:fulltext brainstorm skipped: ${(err as Error).message}`);
      }
    }

    if (scope.includes('turns')) {
      // operator_turns has no workspace_id column — it joins through
      // operator_conversations.workspace_id via the conversation_id FK.
      try {
        const rows = await ctx.tx<{
          id: string;
          role: string;
          text: string;
          rank: number;
        }>`
          SELECT t.id, t.role, t.text,
                 ts_rank_cd(t.text_tsv, plainto_tsquery('english', ${args.query})) AS rank,
                 ts_headline('english', t.text,
                   plainto_tsquery('english', ${args.query}),
                   ${HEADLINE_OPTS}
                 ) AS highlight
            FROM harness_shared.operator_turns t
            JOIN harness_shared.operator_conversations c
              ON c.id = t.conversation_id
           WHERE c.workspace_id = ${ctx.workspaceId}
             AND t.text_tsv @@ plainto_tsquery('english', ${args.query})
        ORDER BY rank DESC
           LIMIT ${limit}
        ` as unknown as Array<{ id: string; role: string; text: string; rank: number; highlight: string }>;
        for (const r of rows) {
          hits.push({
            source: 'turns',
            source_id: r.id,
            excerpt: `[${r.role}] ${r.text.slice(0, 200)}${r.text.length > 200 ? '…' : ''}`,
            highlight: `[${r.role}] ${r.highlight}`,
            rank: r.rank,
          });
        }
      } catch (err) {
        ctx.log?.(`search:fulltext turns skipped: ${(err as Error).message}`);
      }
    }

    if (scope.includes('decisions')) {
      try {
        const rows = await ctx.tx<{
          harness_slug: string;
          line_hash: string;
          verb: string;
          args: string;
          iso: string;
          rank: number;
        }>`
          SELECT harness_slug, line_hash, verb, args, iso,
                 ts_rank_cd(body_tsv, plainto_tsquery('english', ${args.query})) AS rank,
                 ts_headline('english',
                   coalesce(verb, '') || ' ' || coalesce(args, ''),
                   plainto_tsquery('english', ${args.query}),
                   ${HEADLINE_OPTS}
                 ) AS highlight
            FROM harness_shared.harness_decisions
           WHERE workspace_id = ${ctx.workspaceId}
             AND (${harnessFilter}::text IS NULL OR harness_slug = ${harnessFilter})
             AND body_tsv @@ plainto_tsquery('english', ${args.query})
        ORDER BY rank DESC
           LIMIT ${limit}
        ` as unknown as Array<{ harness_slug: string; line_hash: string; verb: string; args: string; iso: string; rank: number; highlight: string }>;
        for (const r of rows) {
          const body = `${r.verb} ${r.args}`.trim();
          hits.push({
            source: 'decisions',
            source_id: `${r.harness_slug}:${r.line_hash}`,
            harness_slug: r.harness_slug,
            excerpt: `[${r.iso}] ${body.slice(0, 200)}${body.length > 200 ? '…' : ''}`,
            highlight: r.highlight,
            rank: r.rank,
          });
        }
      } catch (err) {
        ctx.log?.(`search:fulltext decisions skipped: ${(err as Error).message}`);
      }
    }

    // Global merge: combine all scopes and re-rank by raw score.
    // (No RRF in 2A — that's Plan 2B+C territory.)
    hits.sort((a, b) => b.rank - a.rank);
    const top = hits.slice(0, limit);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          query: args.query,
          scope,
          total_hits: hits.length,
          results: top,
        }),
      }],
    };
  },
});
