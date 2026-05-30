/**
 * Federated search across workspace state.
 *
 * Uses Postgres full-text search (tsvector + GIN, set up by 013-fts-indexes.sql)
 * when the `_search` column is available on each table. Falls back to ILIKE
 * substring search if the columns don't exist yet (i.e. before 013 is applied).
 *
 * jsonb columns (audit_log.details) are not searched in v1; FTS over jsonb
 * requires a generated text-flattened column deferred to v1.5.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';

const KINDS = ['tasks', 'goals', 'projects', 'audit', 'messages'] as const;
type Kind = (typeof KINDS)[number];

interface SearchHit {
  kind: string;
  id: string;
  snippet: string;
  score: number;
}

export default defineTool({
  name: 'search:query',
  capability: 'search:read',
  guidance: {
    when: 'User asks an open-ended question that could match anything in the workspace ("anything about auth?", "find references to budget guard"). Cross-resource full-text search over tasks, goals, projects, audit, messages.',
    notWhen: 'For a SPECIFIC resource type, use the dedicated list/get tool — search is broader but ranked less precisely. For code-graph queries, use `gitnexus:query`.',
  },
  args: z.object({
    query: z.string().min(1),
    kinds: z.array(z.enum(KINDS)).optional(),
    limit: z.number().int().positive().max(100).default(25),
  }),
  async handler(args, ctx) {
    const wantKind = (k: Kind) => !args.kinds || args.kinds.includes(k);
    const hits: SearchHit[] = [];
    const degradedReasons: string[] = [];

    // FTS path: plainto_tsquery is forgiving (accepts user-supplied text).
    // We use ts_rank_cd for ordering. If the `_search` column is missing
    // (013 not applied), the catch falls back to ILIKE.
    if (wantKind('tasks')) {
      try {
        const rows = await ctx.tx<
          Array<{ harness_slug: string; feature_id: string; title: string; summary: string; rank: number }>
        >`
          SELECT harness_slug, feature_id, title, summary,
                 ts_rank_cd(_search, plainto_tsquery('english', ${args.query})) AS rank
            FROM harness_shared.harness_features_consolidated
           WHERE _search @@ plainto_tsquery('english', ${args.query})
           ORDER BY rank DESC
           LIMIT ${args.limit}
        `;
        for (const r of rows) {
          hits.push({
            kind: 'tasks',
            id: `${r.harness_slug}/${r.feature_id}`,
            snippet: r.title || (r.summary ?? '').slice(0, 100),
            score: Number(r.rank),
          });
        }
      } catch {
        // Fallback: ILIKE
        const q = `%${args.query}%`;
        const rows = await ctx.tx<Array<{ harness_slug: string; feature_id: string; title: string; summary: string }>>`
          SELECT harness_slug, feature_id, title, summary
            FROM harness_shared.harness_features_consolidated
           WHERE title ILIKE ${q} OR summary ILIKE ${q}
           LIMIT ${args.limit}
        `;
        for (const r of rows) {
          hits.push({
            kind: 'tasks',
            id: `${r.harness_slug}/${r.feature_id}`,
            snippet: r.title || (r.summary ?? '').slice(0, 100),
            score: 1,
          });
        }
        degradedReasons.push('tasks_using_ilike_fallback');
      }
    }

    if (wantKind('goals')) {
      try {
        const rows = await ctx.tx<Array<{ id: string; title: string; rank: number }>>`
          SELECT id, title, ts_rank_cd(_search, plainto_tsquery('english', ${args.query})) AS rank
            FROM harness_shared.goals
           WHERE _search @@ plainto_tsquery('english', ${args.query})
           ORDER BY rank DESC
           LIMIT ${args.limit}
        `;
        for (const r of rows) hits.push({ kind: 'goals', id: r.id, snippet: r.title, score: Number(r.rank) });
      } catch {
        const q = `%${args.query}%`;
        const rows = await ctx.tx<Array<{ id: string; title: string; body: string }>>`
          SELECT id, title, body FROM harness_shared.goals
           WHERE title ILIKE ${q} OR body ILIKE ${q}
           LIMIT ${args.limit}
        `;
        for (const r of rows) hits.push({ kind: 'goals', id: r.id, snippet: r.title, score: 1 });
        degradedReasons.push('goals_using_ilike_fallback');
      }
    }

    if (wantKind('projects')) {
      try {
        const rows = await ctx.tx<Array<{ id: string; slug: string; name: string; rank: number }>>`
          SELECT id, slug, name, ts_rank_cd(_search, plainto_tsquery('english', ${args.query})) AS rank
            FROM harness_shared.projects
           WHERE _search @@ plainto_tsquery('english', ${args.query})
           ORDER BY rank DESC
           LIMIT ${args.limit}
        `;
        for (const r of rows) {
          hits.push({ kind: 'projects', id: r.slug ?? r.id, snippet: r.name, score: Number(r.rank) });
        }
      } catch {
        const q = `%${args.query}%`;
        const rows = await ctx.tx<Array<{ id: string; slug: string; name: string }>>`
          SELECT id, slug, name FROM harness_shared.projects
           WHERE name ILIKE ${q} OR slug ILIKE ${q}
           LIMIT ${args.limit}
        `;
        for (const r of rows) hits.push({ kind: 'projects', id: r.slug ?? r.id, snippet: r.name, score: 1 });
        degradedReasons.push('projects_using_ilike_fallback');
      }
    }

    if (wantKind('audit')) {
      try {
        const rows = await ctx.tx<Array<{ id: string; subject: string; action: string; rank: number }>>`
          SELECT id, subject, action,
                 ts_rank_cd(_search, plainto_tsquery('simple', ${args.query})) AS rank
            FROM harness_shared.audit_log
           WHERE _search @@ plainto_tsquery('simple', ${args.query})
           ORDER BY rank DESC
           LIMIT ${args.limit}
        `;
        for (const r of rows) {
          hits.push({ kind: 'audit', id: r.id, snippet: `${r.action}: ${r.subject}`, score: Number(r.rank) });
        }
      } catch {
        const q = `%${args.query}%`;
        const rows = await ctx.tx<Array<{ id: string; subject: string; action: string }>>`
          SELECT id, subject, action FROM harness_shared.audit_log
           WHERE subject ILIKE ${q} OR action ILIKE ${q}
           LIMIT ${args.limit}
        `;
        for (const r of rows) hits.push({ kind: 'audit', id: r.id, snippet: `${r.action}: ${r.subject}`, score: 0.5 });
        degradedReasons.push('audit_using_ilike_fallback');
      }
    }

    // Sort across kinds by score descending so highest-confidence hits land first.
    hits.sort((a, b) => b.score - a.score);

    return {
      data: hits.slice(0, args.limit),
      ...(degradedReasons.length ? { degraded: true, degradedReasons } : {}),
    };
  },
});
