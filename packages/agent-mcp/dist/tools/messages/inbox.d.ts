/**
 * messages:inbox — read messages addressed to a harness, or (with
 * `feature_id`) to a specific feature's pipeline lane within it.
 *
 * Reads `harness_<slug>.messages`:
 *   - no feature_id  → harness-level messages (to_feature_id IS NULL):
 *                      directives, worker replies, harness notes.
 *   - feature_id set → that feature's thread (to_feature_id = feature_id).
 *
 * (Subsumes the old `messages:feature_inbox` — one verb, optional feature
 * scope.)
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    slug: z.ZodString;
    feature_id: z.ZodOptional<z.ZodString>;
    detail: z.ZodDefault<z.ZodEnum<{
        full: "full";
        summary: "summary";
    }>>;
    status: z.ZodDefault<z.ZodEnum<{
        pending: "pending";
        all: "all";
        acknowledged: "acknowledged";
        archived: "archived";
    }>>;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>>;
export default _default;
