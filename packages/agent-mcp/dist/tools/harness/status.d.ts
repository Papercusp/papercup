/**
 * Get the live status of a harness — current iteration phase, recent
 * activity, in-flight work. Useful for "what is harness X doing right now?"
 *
 * Typed via `schemaOf(projects).select` and `schemaOf(audit_log).select`.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    slug: z.ZodString;
}, z.core.$strip>>;
export default _default;
