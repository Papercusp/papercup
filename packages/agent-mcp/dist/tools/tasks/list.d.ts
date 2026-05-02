/**
 * List tasks across the workspace, optionally filtered by status, goal,
 * or harness. Summary returns id + title + status; full returns the row.
 */
import { z } from 'zod';
declare const _default: import("../..").ToolDefinition<z.ZodObject<{
    detail: z.ZodDefault<z.ZodEnum<{
        summary: "summary";
        full: "full";
    }>>;
    status: z.ZodOptional<z.ZodString>;
    goalId: z.ZodOptional<z.ZodString>;
    harnessSlug: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
}, z.core.$strip>>;
export default _default;
