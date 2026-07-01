"use strict";
/**
 * features:list_related — features related to one OR many given features via
 * tags + see_also.
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
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): the source key is the COMPOUND
 * `(slug, feature_id)`, and `limit` rides per item. Pass a single
 * `{ slug, feature_id, limit? }` for n=1, or `items:[{ … }]` for many →
 * { ok, results:[{ ok, slug, feature_id, related? | error }], counts }. Each
 * result self-describes its (slug, feature_id); a missing-source / invalid-slug
 * / query-error item fails only itself.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const tooldef_1 = require("@papercusp/tooldef");
// The bulk helpers' LEAF module — relative, NOT the '@papercusp/agent-mcp'
// barrel (see features/get.ts for why: ESM circular-init + node-moduleResolution).
const _bulk_1 = require("../../_bulk");
const SLUG_RE = /^[a-z0-9._-]+$/i;
const RelatedItem = zod_1.z.object({
    slug: zod_1.z.string().min(1),
    feature_id: zod_1.z.string().min(1),
    limit: zod_1.z.number().int().positive().max(20).default(5),
});
exports.default = (0, tooldef_1.defineTool)({
    name: 'features:list_related',
    profile: 'engineer',
    capability: 'features:read',
    description: 'List features related (tag overlap + see_also) to one OR many source features. Pass a single `{ slug, feature_id, limit? }` or `items:[{ … }]` for several. Returns { ok, results:[{ ok, slug, feature_id, related? | error }], counts } — correlate by (slug, feature_id), not by position; a missing-source / invalid-slug / query-error item fails only itself. A source with no tags AND no see_also yields { ok:true, related:[] }.',
    guidance: {
        when: 'You have a feature and need to find related ones — tag overlap, shared chunks, dependency neighbors. Pass every (slug, feature_id) at once via `items`.',
        notWhen: 'For free-text "find features about X", use `features:search`. For ALL features in a harness, use `harness:list_features`.',
        chaining: 'After `features:get`, use this to discover the neighborhood. Bulk: single { slug, feature_id, limit? } | items[] → { ok, results, counts }; correlate by (slug, feature_id) not position; one failure never fails the rest.',
    },
    args: zod_1.z
        .object({
        slug: zod_1.z.string().min(1).optional().describe('a single source feature\'s harness slug (n=1 shorthand, paired with feature_id)'),
        feature_id: zod_1.z.string().min(1).optional().describe('a single source feature id (n=1 shorthand, paired with slug)'),
        limit: zod_1.z.number().int().positive().max(20).default(5).describe('max related rows for the n=1 single call (default 5, max 20)'),
        items: zod_1.z
            .array(RelatedItem)
            .min(1)
            .max(100)
            .optional()
            .describe('source feature keys + per-item limit (1–100), each { slug, feature_id, limit? }'),
    })
        .refine((a) => Boolean(a.items?.length) || (Boolean(a.slug) && Boolean(a.feature_id)), {
        message: 'pass `{ slug, feature_id }` (one) or `items:[{ slug, feature_id }]` (many)',
    }),
    async handler(args, ctx) {
        const items = args.items?.length
            ? args.items
            : [{ slug: args.slug, feature_id: args.feature_id, limit: args.limit }];
        const env = await (0, _bulk_1.runBulk)(items, async (item) => {
            const { slug, feature_id, limit } = item;
            if (!SLUG_RE.test(slug)) {
                return { ok: false, slug, feature_id, error: `invalid slug ${JSON.stringify(slug)}` };
            }
            // Source feature lookup — need its tags + see_also to drive the join.
            const src = await ctx.tx `
          SELECT tags, see_also
            FROM harness_shared.harness_features_consolidated
           WHERE harness_slug = ${slug} AND feature_id = ${feature_id}
           LIMIT 1
        `.catch(() => []);
            if (src.length === 0) {
                return { ok: false, slug, feature_id, error: `source feature ${feature_id} not found` };
            }
            // Coerce tags JSONB into a string array. Treats malformed/empty
            // tags as []; harmless degradation.
            const srcTags = Array.isArray(src[0].tags)
                ? src[0].tags.filter((t) => typeof t === 'string')
                : [];
            const srcSeeAlso = Array.isArray(src[0].see_also) ? src[0].see_also : [];
            if (srcTags.length === 0 && srcSeeAlso.length === 0) {
                return { ok: true, slug, feature_id, related: [] };
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
             WHERE harness_slug = ${slug}
               AND feature_id <> ${feature_id}
               AND (
                 feature_id = ANY(${srcSeeAlso}::text[])
                 OR (${srcTags.length > 0}::boolean AND tags ?| ${srcTags}::text[])
               )
             ORDER BY updated_ts DESC NULLS LAST
             LIMIT ${limit}
          `;
            }
            catch (err) {
                return {
                    ok: false,
                    slug,
                    feature_id,
                    error: `features:list_related query failed: ${err.message.slice(0, 200)}`,
                };
            }
            return { ok: true, slug, feature_id, related: rows };
        }, { keyOf: ({ slug, feature_id }) => ({ slug, feature_id }) });
        return (0, _bulk_1.bulkContent)(env);
    },
});
