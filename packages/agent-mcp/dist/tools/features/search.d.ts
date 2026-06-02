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
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    slug: z.ZodString;
    query: z.ZodOptional<z.ZodString>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    status: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>>;
export default _default;
