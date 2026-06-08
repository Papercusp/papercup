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
  // The generic Hive worker (local-hive-orchestration D-003 / P-011; expanded by
  // bee-capability-expansion-2026-06-08): a plain implementation agent the Queen
  // places ranked work + a brief onto. A BROAD but deliberately NON-operator cap
  // set — broader than a pipeline role (it owns its sequencing + can spin up a
  // structured subharness for harder work, D-017) yet WITHOUT the Queen-only
  // privileges. The goal is bee == psu *engineering* parity (D-005): the bee
  // inherits the worker engineering surface; the Queen-bee adds placement/steering.
  //   - work_items read/write  → maintain + publish its ordered work-list (P-020/P-021)
  //   - coord read/write       → declare-intent, send, coord:await-inbox at idle (P-041);
  //                              ALSO improvements:capture + issues:create/list/get
  //                              (those gate on coord:read/write + COORD_ROLES — bee is a
  //                              COORD_ROLE, so issue/idea read+create already resolve)
  //   - harness read/write     → blueprint:catalog/validate + harness:create a kind:'harness'
  //                              subharness for structured work (a bee may, a hive may not nest)
  //   - plans read/write       → ground its work against plans AND author/edit them
  //                              (D-005, owner-ratified: full plan-authoring parity with psu)
  //   - docs read/write        → ground against docs + write harness_docs/insights (D-001)
  //   - search read            → the fulltext + semantic index
  //   - memory read/write      → durable cross-turn learnings
  //   - tasks read/write       → its own task scaffolding
  //   - intel read             → the dev-diagnostics surface (dev:service_health/build_status/
  //                              processes/activity, flags:get, dogfood_substrate_status, …)
  //                              + the intel:artifacts / intel:spawn_tree reads (D-001)
  //   - locks read/write       → explicit multi-file holds, locks:queue/list, db:check_drift (D-001)
  //   - issues read            → the papercusp://harness/issues MCP resource (the issues:* TOOLS
  //                              already resolve via coord:read above) (D-001)
  // Deliberately NOT granted (D-002 — these stay Queen-only; the Queen is a kind:'hive'
  // bee that holds them): routines:write (self-wake scheduling = the Queen's placement
  // axis), curation:* / activity:report / operator:* / autoloop:* / processes:kill /
  // secrets:* / backup:* / plugins:write / discovery:write / hive:* / gym:* (brain-only
  // judgment + admin + placement surfaces). Least-privilege, workspace-agnostic; unions
  // with any provisioned row.
  //
  // ⚠ TWO-GATE REALITY (bee-capability-expansion-2026-06-08 audit): a capability here is
  // NECESSARY but NOT SUFFICIENT to call a tool. The dispatch stack (libs/generic/tooldef
  // dispatch-stack.ts) runs an independent `role-allowlist` gate FIRST: a tool that
  // declares `agentRoles` is callable only by a role in that list, regardless of caps. The
  // intel/locks/docs:write/plans:write tools each declared an agentRoles list that
  // historically EXCLUDED bee, so the caps above were INERT until the allowlist co-edit.
  // P-004 DID that co-edit: `bee` is now in the agentRoles of every tool gated by these caps
  // (the ~60 dev:*/flags:*/locks:*/db:*/harness_docs:*/plans:* tools), and the COORD_ROLES-gated
  // tools (coord:*, issues:*, improvements:capture) already admit bee. CARVE-OUT: three
  // COORD_ROLES tools that are PLACEMENT/optimization surfaces — fleet:spawn, gym:judge,
  // gym:signals — filter bee BACK OUT of their allowlist (D-002, Queen-only; see those files).
  // The boundary is pinned empirically in bee-tool-boundary.test.ts.
  bee: [
    'harness:read',
    'harness:write',
    'work_items:read',
    'work_items:write',
    'coord:read',
    'coord:write',
    'plans:read',
    'plans:write', // bee-capability-expansion D-005 (owner-ratified): plan-authoring parity with psu
    'docs:read',
    'docs:write', // bee-capability-expansion D-001: harness_docs:record + insight writing
    'search:read',
    'memory:read',
    'memory:write',
    'tasks:read',
    'tasks:write',
    'intel:read', // bee-capability-expansion D-001: the dev-diagnostics surface
    'locks:read', // bee-capability-expansion D-001: locks:queue/list, db:check_drift
    'locks:write', // bee-capability-expansion D-001: explicit multi-file holds
    'issues:read', // bee-capability-expansion D-001: the papercusp://harness/issues resource
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
  // Universal tool-discovery. `agent_tools:list` is declared `agentRoles:[ALL_ROLES]`
  // + `requirePrincipal:false`, and EVERY pipeline-role persona
  // (worker/scoper/architect/validator/reviewer .tools.md) instructs calling
  // `agent_tools:list { asRole }` as the runtime fallback playbook. It is read-only
  // introspection — it lists tool metadata + a per-tool `allowed` flag; the
  // role-allowlist + each tool's own capability still gate actual CALLS — so granting
  // its `agent_tools:read` capability to every role-scoped caller is safe
  // least-privilege. Without it, the synthesize-principal change (this module)
  // regressed pipeline roles: pre-change they carried NO principal so the dispatch
  // cap-gate was skipped and `agent_tools:list` ran via the role-allowlist; now they
  // carry an empty-cap synthesized principal, so the cap-gate denied their own
  // documented discovery tool with `missing_capability`.
  caps.add('agent_tools:read');
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
