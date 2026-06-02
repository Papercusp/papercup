"use strict";
/**
 * List features related to a given feature via tags + see_also.
 *
 * Two relation kinds, unioned:
 *   1. `tags` overlap — features whose tags JSONB array shares at
 *      least one tag with the source feature.
 *   2. `see_also` — features explicitly listed in the source's
 *      `see_also` text array.
 *
 * Self-feature is excluded. Ranked by recency (`updated_ts DESC`).
 * Capped by `limit` (default 5, max 20). Returns compact rows for
 * prompt-injection economy: id, title, status, tags, updated_ts,
 * relation_kind (`tag` | `see_also` | `both`).
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const tooldef_1 = require("@papercusp/tooldef");
const SLUG_RE = /^[a-z0-9._-]+$/i;
exports.default = (0, tooldef_1.defineTool)({
    name: 'features:list_related',
    profile: 'engineer',
    capability: 'features:read',
    guidance: {
        when: 'You have a feature and need to find related ones — tag overlap, shared chunks, dependency neighbors.',
        notWhen: 'For free-text "find features about X", use `features:search`. For ALL features in a harness, use `harness:list_features`.',
        chaining: 'After `features:get`, use this to discover the neighborhood.',
    },
    args: zod_1.z.object({
        slug: zod_1.z.string().min(1),
        feature_id: zod_1.z.string().min(1),
        limit: zod_1.z.number().int().positive().max(20).default(5),
    }),
    async handler(args, ctx) {
        if (!SLUG_RE.test(args.slug)) {
            return { data: [], degraded: true, degradedReasons: [`invalid slug ${JSON.stringify(args.slug)}`] };
        }
        // Source feature lookup — need its tags + see_also to drive the join.
        const src = await ctx.tx `
      SELECT tags, see_also
        FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${args.slug} AND feature_id = ${args.feature_id}
       LIMIT 1
    `.catch(() => []);
        if (src.length === 0) {
            return { data: [], degraded: true, degradedReasons: [`source feature ${args.feature_id} not found`] };
        }
        // Coerce tags JSONB into a string array. Treats malformed/empty
        // tags as []; harmless degradation.
        const srcTags = Array.isArray(src[0].tags)
            ? src[0].tags.filter((t) => typeof t === 'string')
            : [];
        const srcSeeAlso = Array.isArray(src[0].see_also) ? src[0].see_also : [];
        if (srcTags.length === 0 && srcSeeAlso.length === 0) {
            return { data: [], degraded: false };
        }
        let rows = [];
        try {
            rows = await ctx.tx `
        SELECT feature_id, title, status,
               (SELECT array_agg(value) FROM jsonb_array_elements_text(COALESCE(tags, '[]'::jsonb))) AS tags,
               updated_ts,
               CASE
                 WHEN feature_id = ANY(${srcSeeAlso}::text[]) AND tags ?| ${srcTags}::text[] THEN 'both'
                 WHEN feature_id = ANY(${srcSeeAlso}::text[]) THEN 'see_also'
                 ELSE 'tag'
               END AS relation_kind
          FROM harness_shared.harness_features_consolidated
         WHERE harness_slug = ${args.slug}
           AND feature_id <> ${args.feature_id}
           AND (
             feature_id = ANY(${srcSeeAlso}::text[])
             OR (${srcTags.length > 0}::boolean AND tags ?| ${srcTags}::text[])
           )
         ORDER BY updated_ts DESC NULLS LAST
         LIMIT ${args.limit}
      `;
        }
        catch (err) {
            return {
                data: [],
                degraded: true,
                degradedReasons: [`features:list_related query failed: ${err.message.slice(0, 200)}`],
            };
        }
        return { data: rows };
    },
});
