/**
 * Read a harness's outbox (messages it has sent). Useful for tracing
 * "what did harness X say recently?"
 *
 * Typed via `schemaOf(audit_log).select` — outbox is audit_log filtered
 * by actor=slug + action='send_message'.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    slug: z.ZodString;
    detail: z.ZodDefault<z.ZodEnum<{
        full: "full";
        summary: "summary";
    }>>;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>>;
export default _default;
