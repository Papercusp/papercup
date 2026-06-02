/**
 * Get the rendered feature-history block for a feature.
 *
 * Same data path as the prompt-injected version (orchestrator's
 * `feature-history.ts`): notes + debugger findings + recent audit
 * transitions, read PG-only. Useful when:
 *   - The agent's prompt-injected version was capped (long history).
 *   - The agent is exploring a non-current feature.
 *
 * Returns the rendered markdown string verbatim. Caller can re-format.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    slug: z.ZodString;
    feature_id: z.ZodString;
    notes_max_chars: z.ZodDefault<z.ZodNumber>;
    debug_max_chars: z.ZodDefault<z.ZodNumber>;
    audit_rows: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>>;
export default _default;
