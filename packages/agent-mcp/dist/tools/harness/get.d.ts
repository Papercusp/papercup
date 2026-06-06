/**
 * Get a single harness by slug.
 *
 * Summary returns slug + status + name + last activity. Full returns
 * the entire `harness_shared.projects` row plus aggregate feature counts.
 *
 * Typed via `schemaOf(projects).select`.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    slug: z.ZodString;
    detail: z.ZodDefault<z.ZodEnum<{
        full: "full";
        summary: "summary";
    }>>;
}, z.core.$strip>>;
export default _default;
