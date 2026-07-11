/**
 * Search a harness's features. Filters by FTS query, tags, and status.
 *
 * Reuses the tsvector `_search` column on `harness_features_consolidated`
 * (set up by migration 013). When no FTS query is supplied, returns
 * features filtered by tags / status only.
 *
 * Returns ranked feature summaries — id, title, status, tags,
 * updated_ts. Capped at `limit` (default 25, max 100).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
const SLUG_RE = /^[a-z0-9._-]+$/i;
export default defineTool({
    name: 'features:search',
    profile: 'engineer',
    capability: 'features:read',
    guidance: {
        when: 'Free-text query for features matching a topic ("auth", "error handling") — use when the user names a concept, not a specific feature id.',
        notWhen: 'For specific feature id, use `features:get`. For ALL features in a harness, use `harness:list_features`. For cross-resource search, use `search:query`.',
    },
    args: z.object({
        slug: z.string().min(1),
        /** FTS query string. Optional — omit for tag/status-only filtering. */
        query: z.string().optional(),
        /** Match features whose tags JSONB array contains ANY of these. */
        tags: z.array(z.string().min(1)).optional(),
        /** Filter by status. Single value (the consolidated table is one row per feature). */
        status: z.string().optional(),
        limit: z.number().int().positive().max(100).default(25),
    }),
    async handler(args, ctx) {
        if (!SLUG_RE.test(args.slug)) {
            return { data: [], degraded: true, degradedReasons: [`invalid slug ${JSON.stringify(args.slug)}`] };
        }
        // Branch on whether an FTS query was supplied. Without one we
        // return rows ranked by `updated_ts DESC` (recency); with one we
        // use ts_rank_cd.
        const tags = (args.tags ?? []).filter((t) => typeof t === 'string' && t.length > 0);
        let rows = [];
        try {
            if (args.query && args.query.trim().length > 0) {
                rows = await ctx.tx `
          SELECT feature_id, title, summary, status,
                 (SELECT array_agg(value) FROM jsonb_array_elements_text(COALESCE(tags, '[]'::jsonb))) AS tags,
                 updated_ts,
                 ts_rank_cd(_search, plainto_tsquery('english', ${args.query})) AS rank
            FROM harness_shared.harness_features_consolidated
           WHERE harness_slug = ${args.slug}
             AND _search @@ plainto_tsquery('english', ${args.query})
             AND (${args.status ?? null}::text IS NULL OR status = ${args.status ?? null})
             AND (${tags.length === 0}::boolean OR tags ?| ${tags}::text[])
           ORDER BY rank DESC, updated_ts DESC NULLS LAST
           LIMIT ${args.limit}
        `;
            }
            else {
                rows = await ctx.tx `
          SELECT feature_id, title, summary, status,
                 (SELECT array_agg(value) FROM jsonb_array_elements_text(COALESCE(tags, '[]'::jsonb))) AS tags,
                 updated_ts,
                 0::float AS rank
            FROM harness_shared.harness_features_consolidated
           WHERE harness_slug = ${args.slug}
             AND (${args.status ?? null}::text IS NULL OR status = ${args.status ?? null})
             AND (${tags.length === 0}::boolean OR tags ?| ${tags}::text[])
           ORDER BY updated_ts DESC NULLS LAST
           LIMIT ${args.limit}
        `;
            }
        }
        catch (err) {
            return {
                data: [],
                degraded: true,
                degradedReasons: [`features:search query failed: ${err.message.slice(0, 200)}`],
            };
        }
        return { data: rows };
    },
});
