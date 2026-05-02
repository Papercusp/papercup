/**
 * List harnesses registered in the current workspace.
 *
 * Returns slug, status, and last-activity timestamp for each. Use to
 * answer "what harnesses do I have?" or to find a slug before calling
 * harness:get / harness:status.
 */
import { z } from 'zod';
declare const _default: import("../..").ToolDefinition<z.ZodObject<{
    detail: z.ZodDefault<z.ZodEnum<{
        summary: "summary";
        full: "full";
    }>>;
    limit: z.ZodDefault<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
}, z.core.$strip>>;
export default _default;
