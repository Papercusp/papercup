/**
 * List goals in the current workspace.
 */
import { z } from 'zod';
declare const _default: import("../..").ToolDefinition<z.ZodObject<{
    detail: z.ZodDefault<z.ZodEnum<{
        summary: "summary";
        full: "full";
    }>>;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>>;
export default _default;
