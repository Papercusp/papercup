/**
 * List goals in the current workspace.
 *
 * Demonstrates the drizzle-zod pattern for MCP tools: response rows are
 * typed via `schemaOf(table).select` so the data sent back to the agent
 * matches the column shape declared in the migration — no hand-typed
 * `Record<string, unknown>`.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    detail: z.ZodDefault<z.ZodEnum<{
        full: "full";
        summary: "summary";
    }>>;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>>;
export default _default;
