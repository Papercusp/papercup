/**
 * Parses the seven per-spawn URL params from inbound MCP requests.
 *
 * Used by the MCP transport (apps/operator/app/api/[transport]/route.ts)
 * to derive the spawn context from the URL the orchestrator baked into
 * each spawn's `.mcp.json` (PR 4 of plugin-MCP-host).
 *
 * URL shape:
 *   ?harness=<slug?>&workspace=<id>&role=<role>
 *   &run=<runId>&spawn=<spawnId>
 *   &feature=<id?>&chunk=<id?>&parent_spawn=<id?>&client=<uiClientId?>
 *
 * Required: workspace, role, run, spawn.
 * Optional: harness (a WORKSPACE-LEVEL role session — operator/planner
 *           launched without a harness, hive-agent-tabs P-003; absent →
 *           `harnessSlug` is the `'*'` unscoped sentinel, the same value
 *           the superuser path uses — harness-scoped tools then answer
 *           `harness_required` until a per-call harness is named),
 *           feature, chunk, parent_spawn (set by Phase 9 spawn-of-spawn),
 *           client (UI client id; when an agent is invoked from a
 *           browser tab, the tab's client_id is baked here so tools
 *           like `ui:dispatch` can default to it).
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md (D4).
 */
import type { AgentRole } from '@papercusp/plugin-sdk';
export interface PluginRequestContext {
    workspaceId: string;
    harnessSlug: string;
    role: AgentRole;
    featureId: string | null;
    chunkId: string | null;
    runId: string;
    spawnId: string;
    parentSpawnId: string | null;
    uiClientId: string | null;
}
export declare class InvalidRequestContextError extends Error {
    readonly missing: readonly string[];
    constructor(missing: readonly string[]);
}
export declare function parseRequestContext(url: URL | string): PluginRequestContext;
