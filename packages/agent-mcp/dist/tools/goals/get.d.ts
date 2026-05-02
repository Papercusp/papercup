/**
 * Get a single goal by id. Returns lineage (children + descendant tasks)
 * when detail='full'.
 */
import { z } from 'zod';
declare const _default: import("../..").ToolDefinition<z.ZodObject<{
    id: z.ZodString;
    detail: z.ZodDefault<z.ZodEnum<{
        summary: "summary";
        full: "full";
    }>>;
}, z.core.$strip>>;
export default _default;
