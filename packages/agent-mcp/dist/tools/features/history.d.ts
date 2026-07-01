/**
 * features:history — the rendered feature-history block for one OR many features.
 *
 * Same data path as the prompt-injected version (orchestrator's
 * `feature-history.ts`): notes + debugger findings + recent audit
 * transitions, read PG-only. Useful when:
 *   - The agent's prompt-injected version was capped (long history).
 *   - The agent is exploring a non-current feature.
 *
 * Returns the rendered markdown string verbatim. Caller can re-format.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): the feature key is the COMPOUND
 * `(slug, feature_id)`, and the per-section caps ride per item. Pass a single
 * `{ slug, feature_id, notes_max_chars?, debug_max_chars?, audit_rows? }` for
 * n=1, or `items:[{ … }]` for many → { ok, results:[{ ok, slug, feature_id,
 * history? | error }], counts }. Each result self-describes its (slug,
 * feature_id); a degraded / invalid-slug item fails only itself.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    items: z.ZodOptional<z.ZodArray<z.ZodObject<{
        notes_max_chars: z.ZodDefault<z.ZodNumber>;
        debug_max_chars: z.ZodDefault<z.ZodNumber>;
        audit_rows: z.ZodDefault<z.ZodNumber>;
        slug: z.ZodString;
        feature_id: z.ZodString;
    }, z.core.$strip>>>;
    notes_max_chars: z.ZodDefault<z.ZodNumber>;
    debug_max_chars: z.ZodDefault<z.ZodNumber>;
    audit_rows: z.ZodDefault<z.ZodNumber>;
    slug: z.ZodOptional<z.ZodString>;
    feature_id: z.ZodOptional<z.ZodString>;
}, z.core.$strip>>;
export default _default;
