/**
 * Read a harness's inbox (messages addressed to it). Useful for
 * "what messages are pending for harness X?"
 */
import { z } from 'zod';
declare const _default: import("../..").ToolDefinition<z.ZodObject<{
    slug: z.ZodString;
    detail: z.ZodDefault<z.ZodEnum<{
        summary: "summary";
        full: "full";
    }>>;
    status: z.ZodDefault<z.ZodEnum<{
        pending: "pending";
        acknowledged: "acknowledged";
        all: "all";
    }>>;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>>;
export default _default;
