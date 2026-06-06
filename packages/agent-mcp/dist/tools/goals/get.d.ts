/**
 * Get a single goal by id. Returns lineage (children + descendant tasks)
 * when detail='full'.
 *
 * Uses `schemaOf(generated.goalsInHarnessShared).select` so the response
 * row shape is the same Zod schema you'd use in a form or a CRUD admin
 * page — no hand-typed `Record<string, unknown>`.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    id: z.ZodString;
    detail: z.ZodDefault<z.ZodEnum<{
        full: "full";
        summary: "summary";
    }>>;
}, z.core.$strip>>;
export default _default;
