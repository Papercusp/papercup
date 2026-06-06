/**
 * intel:spawn_tree — read tool_invocations as a parent→child tree.
 *
 * Backs the harness Intel panel's Spawns sub-tab. Reads from the
 * harness_shared.tool_invocations_spawn_tree view (Migration 048) which
 * exposes every row plus a `depth` column and a `root_spawn_id` so the
 * UI can group by root spawn.
 *
 * Today every row is depth=0 (Phase 9 spawn-of-spawn not yet shipped).
 * The shape is forward-compatible: when Phase 9 lands, depth>0 rows
 * appear without code change here.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    harness: z.ZodString;
    sinceMs: z.ZodOptional<z.ZodNumber>;
    limit: z.ZodDefault<z.ZodNumber>;
    status: z.ZodOptional<z.ZodEnum<{
        ok: "ok";
        error: "error";
        timeout: "timeout";
        "quota-exceeded": "quota-exceeded";
        "role-not-allowed": "role-not-allowed";
    }>>;
}, z.core.$strip>>;
export default _default;
