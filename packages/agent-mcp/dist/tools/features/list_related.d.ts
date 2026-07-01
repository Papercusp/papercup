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
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    slug: z.ZodOptional<z.ZodString>;
    feature_id: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodNumber>;
    items: z.ZodOptional<z.ZodArray<z.ZodObject<{
        slug: z.ZodString;
        feature_id: z.ZodString;
        limit: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>>;
}, z.core.$strip>>;
export default _default;
