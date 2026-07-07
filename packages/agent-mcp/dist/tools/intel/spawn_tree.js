"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const tooldef_1 = require("@papercusp/tooldef");
exports.default = (0, tooldef_1.defineTool)({
    name: 'intel:spawn_tree',
    profile: 'engineer',
    guidance: {
        when: 'User asks "what triggered this?", "show me the lineage of agent X", or you need the parent-child spawn graph for an Intel-panel-style view.',
        notWhen: 'For LIVE running spawns only, use `orchestrator.list_active`. spawn_tree is historical + structural; list_active is the now-snapshot.',
    },
    capability: 'intel:read',
    args: zod_1.z.object({
        /** Restrict to a specific harness slug. Required — Intel is per-harness. */
        harness: zod_1.z.string().min(1),
        /** Optional cutoff (epoch ms). Default: last 24 hours. */
        sinceMs: zod_1.z.number().int().optional(),
        /** Optional cap. Default 200; max 2000. */
        limit: zod_1.z.number().int().positive().max(2000).default(200),
        /** Optional status filter. */
        status: zod_1.z.enum(['ok', 'error', 'timeout', 'quota-exceeded', 'role-not-allowed']).optional(),
    }),
    async handler(args, ctx) {
        const sinceMs = args.sinceMs ?? Date.now() - 24 * 60 * 60 * 1000;
        // p_workspace_id omitted (NULL) — ctx.tx runs inside the RLS-scoped app
        // role's transaction, so the underlying tool_invocations reads are
        // already restricted to this workspace; no explicit scope needed here
        // (contrast the HTTP route, which uses the admin role and must pass it).
        const rows = await ctx.tx `
      SELECT id, tool_name, plugin_name, role,
             feature_id, chunk_id, run_id, spawn_id, parent_spawn_id,
             window_key, invoked_at, duration_ms, status,
             output_ref, output_size, error_message,
             depth, root_spawn_id
        FROM harness_shared.tool_invocations_spawn_tree_filtered(
               p_harness_slug => ${args.harness},
               p_since => to_timestamp(${sinceMs}::double precision / 1000.0),
               p_status => ${args.status ?? null},
               p_limit => ${args.limit}
             )
    `;
        return {
            data: rows.map((r) => ({
                id: r.id,
                toolName: r.tool_name,
                pluginName: r.plugin_name,
                role: r.role,
                featureId: r.feature_id,
                chunkId: r.chunk_id,
                runId: r.run_id,
                spawnId: r.spawn_id,
                parentSpawnId: r.parent_spawn_id,
                windowKey: r.window_key,
                invokedAtMs: new Date(r.invoked_at).getTime(),
                durationMs: r.duration_ms,
                status: r.status,
                outputRef: r.output_ref,
                outputSize: r.output_size,
                errorMessage: r.error_message,
                depth: r.depth,
                rootSpawnId: r.root_spawn_id,
            })),
        };
    },
});
