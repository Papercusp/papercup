/**
 * List tasks across the workspace, optionally filtered by status, goal,
 * or harness. Summary returns id + title + status; full returns the row.
 *
 * Typed via `schemaOf(harness_features_consolidated).select` — response
 * row shape matches the column definition; no hand-typed Record.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    detail: z.ZodDefault<z.ZodEnum<{
        full: "full";
        summary: "summary";
    }>>;
    status: z.ZodOptional<z.ZodString>;
    goalId: z.ZodOptional<z.ZodString>;
    harnessSlug: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
}, z.core.$strip>>;
export default _default;
