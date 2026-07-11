/**
 * Read the harness registry (`harness_shared.harness_registry` — single
 * JSONB row per workspace, written by `harness:create` and the desktop
 * "add project" route) from an agent-tool's workspace-scoped `ctx.tx`.
 *
 * The registry is the runtime store-of-record for WHICH harnesses exist;
 * the org-level `harness_shared.projects` table carries Pot/department
 * metadata (budget, status) for a subset. The read tools merge the two —
 * autoloop-pot-operator-rebuild-2026-06-05 P-004 (before that they read
 * only `projects`, hiding every registry harness from the operator).
 */
/** Registry projects for `workspaceId`, or `[]` when no row / bad payload. */
export async function readRegistryProjects(tx, workspaceId) {
    const rows = await tx `
    SELECT payload FROM harness_shared.harness_registry
     WHERE workspace_id = ${workspaceId}
     LIMIT 1
  `;
    const payload = rows[0]?.payload;
    const projects = payload?.projects;
    if (!Array.isArray(projects))
        return [];
    return projects.filter((p) => typeof p === 'object' && p !== null && typeof p.slug === 'string');
}
