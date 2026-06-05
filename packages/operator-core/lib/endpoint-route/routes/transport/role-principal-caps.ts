import type { Sql } from 'postgres';

/**
 * Capabilities granted to **blueprint-declared roles** — agents a blueprint spawns
 * that are NOT provisioned system principals (they're declared by a blueprint, not
 * seeded per workspace), so they have no `system_principals` row and
 * `loadRoleCapabilities` would otherwise return an empty set — which denies the
 * capability-gated built-ins their workflow needs (surfaced as `role-not-allowed`).
 * They get exactly the caps that workflow needs — least-privilege, no blanket grant,
 * workspace-agnostic (no per-workspace seed). Composes with any provisioned row
 * (the two are unioned). Covers:
 *   - **program-blueprint roles** (coordination-ops-as-blueprint-primitives): a
 *     `vote`'s `voter` / `advocate` post their structured vote/objection into the
 *     thread (`coord:thread-post` → `coord:write`) and read docs/search to ground it.
 *   - **launch-blueprint roles** (unify-agent-launches-as-blueprints D-005): the
 *     `scan` blueprint's `scanner` reads harness/plans/search state and captures each
 *     finding via `improvements:capture` (`coord:write`) into the self-improvement
 *     backlog — so it needs the read caps + coord:write, nothing more.
 */
export const BLUEPRINT_ROLE_CAPS: Readonly<Record<string, readonly string[]>> = {
  voter: ['coord:read', 'coord:write', 'docs:read', 'search:read'],
  advocate: ['coord:read', 'coord:write', 'docs:read', 'search:read'],
  scanner: ['coord:read', 'coord:write', 'docs:read', 'search:read', 'harness:read', 'plans:read'],
  // The Pot's decider (autoloop-pot-operator-rebuild-2026-06-05 P-004,
  // D-001/D-003): the `pot` launch blueprint wakes the `operator` role to
  // survey the blackboard (work_items frontier, curation feed, activity
  // bridge, coord, plans) and create/manage harnesses from blueprints
  // (blueprint:catalog/validate → harness:read; blueprint:extend +
  // harness:create → harness:write; pot:declare-wake → routines:write).
  // Declared here AS WELL AS in the provisioned OPERATOR_CAPS (provision.ts)
  // because provision-without-force is a no-op for an existing row — the pot
  // must not depend on a re-provision to function. The two union cleanly.
  operator: [
    'harness:read',
    'harness:write',
    'work_items:read',
    'work_items:write',
    'curation:read',
    'activity:read',
    'coord:read',
    'coord:write',
    'plans:read',
    'routines:write',
  ],
};

/**
 * Least-privilege capabilities for a role-scoped (non-superuser) MCP caller.
 *
 * Background: principal-gated built-in tools (the default `defineTool`) hard-
 * require `ctx.principal` + `ctx.tx`. The MCP handler used to synthesize those
 * only for `?superuser=1` calls, so a signed role-scoped agent (operator,
 * oracle, director, …) got neither and every such built-in 100%-failed with
 * `requires authenticated request (bearer + workspace tx)` (seen in
 * harness_shared.tool_invocations, 2026-05-31).
 *
 * The caller is already authenticated by its verified signed role URL, so we
 * synthesize a principal — but only with the capabilities its **provisioned
 * system principal** carries. `operator`/`oracle` have rows in
 * harness_shared.system_principals (their OPERATOR_CAPS / ORACLE_CAPS); pipeline
 * roles (worker/scoper/validator/…) have no row, so they get an EMPTY set —
 * capability-gated built-ins stay denied for them and the dispatch role
 * allow-list + RLS remain the primary boundary. This is least-privilege: a role
 * gets exactly what it was provisioned, never a blanket grant.
 *
 * `tx` must already be workspace-scoped (the GUC that `withWorkspace` sets).
 */
export async function loadRoleCapabilities(
  tx: Sql,
  workspaceId: string,
  roleName: string,
): Promise<Set<string>> {
  const rows = await tx<Array<{ capabilities: unknown }>>`
    SELECT capabilities
      FROM harness_shared.system_principals
     WHERE workspace_id = ${workspaceId} AND name = ${roleName}
     LIMIT 1
  `;
  const raw = rows[0]?.capabilities;
  const caps = new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  // Blueprint-declared roles (voter/advocate/scanner) carry no system_principals
  // row; union in their declared baseline so the capability gate passes for the
  // tools their blueprint role uses (e.g. coord:thread-post / improvements:capture →
  // coord:write).
  for (const c of BLUEPRINT_ROLE_CAPS[roleName] ?? []) caps.add(c);
  return caps;
}

/**
 * Whether a tool call needs a synthesized principal + workspace tx. Any
 * concrete workspace does; `'*'` (superuser with no chosen workspace) and an
 * empty workspace do NOT — principal-gated built-ins then fail and the caller
 * must pass `?workspace=X` (or, superuser only, a per-call `workspace` arg —
 * see `effectiveDispatchWorkspace`).
 */
export function dispatchNeedsTx(spawnCtx: { workspaceId: string }): boolean {
  return Boolean(spawnCtx.workspaceId) && spawnCtx.workspaceId !== '*';
}

/**
 * The workspace a tool call should dispatch under — EI-30.
 *
 * An UNSCOPED superuser session (`?superuser=1`, workspaceId `'*'`) gets no
 * synthesized workspace tx, so every principal-gated built-in (harness:list,
 * …) hard-fails even though the SU playbooks document `workspace` as a
 * per-call arg ("hop without re-auth"). Honor that promise at the dispatch
 * layer: when the caller is superuser, the session is unscoped, and the args
 * carry a concrete `workspace` string, dispatch under THAT workspace (tx
 * synthesis + ALS pin), exactly as `?workspace=X` would have.
 *
 * Superuser is admin across every workspace, so this is a convenience, not a
 * privilege change. It deliberately does NOT apply to power-user callers
 * (their `workspace` arg is clamped to the token's workspace upstream) or to
 * role-scoped callers (they always carry a concrete workspace).
 */
export function effectiveDispatchWorkspace(
  spawnCtx: { workspaceId: string; isSuperuser?: boolean },
  args: unknown,
): string {
  if (spawnCtx.isSuperuser !== true || spawnCtx.workspaceId !== '*') return spawnCtx.workspaceId;
  const ws =
    args && typeof args === 'object' && typeof (args as Record<string, unknown>).workspace === 'string'
      ? ((args as Record<string, unknown>).workspace as string)
      : '';
  return ws.length > 0 ? ws : spawnCtx.workspaceId;
}

/**
 * The principal to dispatch a concrete-workspace call under. Superuser keeps the
 * `gateBypass.capability` it already carries (its empty cap-set is fine); a
 * signed role-scoped caller is NOT bypassed, so it gets exactly its provisioned
 * capabilities (least-privilege) and the capability gate enforces normally.
 * `tx` must already be workspace-scoped.
 */
export async function synthesizeDispatchPrincipal(
  tx: Sql,
  spawnCtx: { workspaceId: string; role: string; isSuperuser?: boolean },
): Promise<{ slug: string; workspaceId: string; capabilities: Set<string> }> {
  const capabilities = spawnCtx.isSuperuser
    ? new Set<string>()
    : await loadRoleCapabilities(tx, spawnCtx.workspaceId, spawnCtx.role);
  return {
    slug: spawnCtx.isSuperuser ? 'system:operator' : `system:${spawnCtx.role}`,
    workspaceId: spawnCtx.workspaceId,
    capabilities,
  };
}
