/**
 * Papercusp's role configuration — the host half of plan P-010 / D-005.
 *
 * `@papercusp/tooldef` is role-agnostic: its `AgentRole` type is `string`
 * until a host registers its known roles by augmenting the framework's
 * `RoleRegistry` interface. This file is where the Papercusp host does that.
 * After this module is part of the program, `AgentRole` resolves to the
 * suggestion-union below program-wide (still `string`-assignable, so
 * plugin-contributed `<plugin>:<role>` ids stay valid).
 *
 * `AGENT_ROLES` is the single runtime source of truth for the built-in role
 * ids; the type-level augmentation is *derived* from it (no hand-kept second
 * list to drift). The ordering is: the seven pipeline roles, the two chat
 * roles (operator/oracle), then the cross-cutting roles that show up
 * in tool `roles:` allowlists.
 */
/**
 * The built-in Papercusp agent roles, as they appear in tool `roles:`
 * allowlists, `rolesQuota` keys, and `byRole` guidance overrides. The set is
 * open — plugins contribute additional roles at runtime (namespaced
 * `<plugin>:<role>`), which stay typed as bare `string`.
 */
export declare const AGENT_ROLES: readonly ["scoper", "architect", "worker", "validator", "reviewer", "debugger", "documenter", "curator", "operator", "oracle", "bee", "planner", "orchestrator", "promote", "security-reviewer", "infra-reviewer", "crosscheck", "ui-qa", "auditor", "merge-resolver", "release-manager", "sentinel"];
/** Union of the built-in role ids. Plugin roles widen `AgentRole` to `string`. */
export type BuiltinAgentRole = (typeof AGENT_ROLES)[number];
/**
 * The PRINCIPAL role that marks "the brain" — the operator/orchestration intelligence
 * that decides whether a new agent spawn is worth it (unify-agent-spawn-chokepoint
 * P-006 / D-008). This is an RBAC role on `Principal.roles` (the fail-closed
 * `requireRoles` dispatch axis), NOT an agent `ctx.role`: it is assigned by the HOST
 * to the operator's OWN principal (the bearer-resolved `system:operator` + the
 * loopback palette caller), and is never carried by a spawned agent's caller-asserted
 * `?role=`. A tool gated `requireRoles: [BRAIN_PRINCIPAL_ROLE]` is therefore
 * approvable ONLY by the brain (or a superuser, which bypasses RBAC) — making "only
 * the brain decides spawns" enforced at the dispatch layer, not prompt convention.
 */
export declare const BRAIN_PRINCIPAL_ROLE = "brain";
/**
 * Register the built-in roles with the framework. Declaration merging adds
 * these keys to `@papercusp/tooldef`'s `RoleRegistry`, which the framework
 * reads (`keyof RoleRegistry`) to shape `AgentRole`. Derived from
 * `AGENT_ROLES` so the two never drift.
 */
declare module '@papercusp/tooldef' {
    interface RoleRegistry extends Record<BuiltinAgentRole, true> {
    }
}
