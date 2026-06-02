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
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    slug: z.ZodString;
    feature_id: z.ZodString;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>>;
export default _default;
