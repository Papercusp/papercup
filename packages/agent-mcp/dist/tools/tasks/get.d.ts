/**
 * Get a single task by (harnessSlug, id). Summary returns id+title+status;
 * full returns the row.
 */
import { z } from 'zod';
declare const _default: import("../..").ToolDefinition<z.ZodObject<{
    harnessSlug: z.ZodString;
    id: z.ZodString;
    detail: z.ZodDefault<z.ZodEnum<{
        summary: "summary";
        full: "full";
    }>>;
}, z.core.$strip>>;
export default _default;
