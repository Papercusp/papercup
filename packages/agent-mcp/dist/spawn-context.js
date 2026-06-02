"use strict";
/**
 * Parses the seven per-spawn URL params from inbound MCP requests.
 *
 * Used by the MCP transport (apps/operator/app/api/[transport]/route.ts)
 * to derive the spawn context from the URL the orchestrator baked into
 * each spawn's `.mcp.json` (PR 4 of plugin-MCP-host).
 *
 * URL shape:
 *   ?harness=<slug>&workspace=<id>&role=<role>
 *   &run=<runId>&spawn=<spawnId>
 *   &feature=<id?>&chunk=<id?>&parent_spawn=<id?>&client=<uiClientId?>
 *
 * Required: harness, workspace, role, run, spawn.
 * Optional: feature, chunk, parent_spawn (set by Phase 9 spawn-of-spawn),
 *           client (UI client id; when an agent is invoked from a
 *           browser tab, the tab's client_id is baked here so tools
 *           like `ui:dispatch` can default to it).
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md (D4).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvalidRequestContextError = void 0;
exports.parseRequestContext = parseRequestContext;
class InvalidRequestContextError extends Error {
    missing;
    constructor(missing) {
        super(`request URL is missing required params: ${missing.join(', ')}`);
        this.missing = missing;
        this.name = 'InvalidRequestContextError';
    }
}
exports.InvalidRequestContextError = InvalidRequestContextError;
function parseRequestContext(url) {
    const u = typeof url === 'string' ? new URL(url) : url;
    const harnessSlug = (u.searchParams.get('harness') ?? '').trim();
    const workspaceId = (u.searchParams.get('workspace') ?? '').trim();
    const role = (u.searchParams.get('role') ?? '').trim();
    const runId = (u.searchParams.get('run') ?? '').trim();
    const spawnId = (u.searchParams.get('spawn') ?? '').trim();
    const featureRaw = (u.searchParams.get('feature') ?? '').trim();
    const chunkRaw = (u.searchParams.get('chunk') ?? '').trim();
    const parentRaw = (u.searchParams.get('parent_spawn') ?? '').trim();
    const clientRaw = (u.searchParams.get('client') ?? '').trim();
    const missing = [];
    if (!harnessSlug)
        missing.push('harness');
    if (!workspaceId)
        missing.push('workspace');
    if (!role)
        missing.push('role');
    if (!runId)
        missing.push('run');
    if (!spawnId)
        missing.push('spawn');
    if (missing.length > 0)
        throw new InvalidRequestContextError(missing);
    return {
        harnessSlug,
        workspaceId,
        role,
        runId,
        spawnId,
        featureId: featureRaw.length > 0 ? featureRaw : null,
        chunkId: chunkRaw.length > 0 ? chunkRaw : null,
        parentSpawnId: parentRaw.length > 0 ? parentRaw : null,
        uiClientId: clientRaw.length > 0 ? clientRaw : null,
    };
}
