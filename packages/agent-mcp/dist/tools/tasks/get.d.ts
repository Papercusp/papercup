/**
 * Get a single task by (harnessSlug, id). Summary returns id+title+status;
 * full returns the row.
 *
 * Typed via `schemaOf(harness_features_consolidated).select`.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    harnessSlug: z.ZodString;
    id: z.ZodString;
    detail: z.ZodDefault<z.ZodEnum<{
        full: "full";
        summary: "summary";
    }>>;
}, z.core.$strip>>;
export default _default;
