/**
 * intel:spawn_tree — read tool_invocations as a parent→child tree.
 *
 * Backs the harness Intel panel's Spawns sub-tab. Reads via
 * harness_shared.tool_invocations_spawn_tree_filtered (Migration 460), a
 * parameterized SQL function that exposes every matching row plus a `depth`
 * column and a `root_spawn_id` so the UI can group by root spawn. WI-1671:
 * replaced the bare tool_invocations_spawn_tree VIEW, whose unfiltered
 * `WITH RECURSIVE` base term scanned the whole tool_invocations table
 * (7.4M rows) on every call regardless of this tool's harness/invoked_at/
 * status filter (EI-6801 — a 27-min fleet-wide lock stampede). The function
 * selects the filtered candidates first (indexed), then walks UP (bounded 16
 * hops) to compute depth/root_spawn_id.
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
