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
export declare const AGENT_ROLES: readonly ["scoper", "architect", "worker", "validator", "reviewer", "debugger", "documenter", "curator", "operator", "oracle", "cup", "mug", "planner", "orchestrator", "promote", "security-reviewer", "infra-reviewer", "crosscheck", "ui-qa", "auditor", "merge-resolver", "content-fixer", "release-manager", "release-fixer", "doc-steward", "papercup", "kettle", "researcher", "research-director", "searcher", "discoverer", "finding-verifier", "findings-synthesizer", "synthesizer", "review-director", "dimension-reviewer", "verifier", "migration-director", "migration-verifier", "transformer", "gym-director", "judge", "task-generator", "variant-runner", "proposer", "scanner", "director", "committer", "tester", "test-writer", "monitor", "blender"];
/** Union of the built-in role ids. Plugin roles widen `AgentRole` to `string`. */
export type BuiltinAgentRole = (typeof AGENT_ROLES)[number];
/**
 * Roles that exist in AGENT_ROLES but must NEVER be applied as a gym variant
 * prompt-overlay or throwaway-harness override target. The external `judge` is
 * FROZEN (gym D-003): the gym overlays + optimizes a harness's PIPELINE roles and
 * the judge then EVALUATES the resulting variants — overlaying the judge itself
 * would let a variant rewrite (and so game) its own evaluator.
 *
 * This protection used to be IMPLICIT — `judge` was absent from AGENT_ROLES, so the
 * overlay validators rejected it as an "unknown role". That hole re-opened silently
 * when blueprint-role-bundling (EI-621 / D-008) made AGENT_ROLES the COMPLETE
 * built-in role universe (judge is a gym/learning-loop blueprint role). It is now
 * EXPLICIT and pinned here next to the role declaration so adding a role to
 * AGENT_ROLES can't re-open it. `satisfies` pins each member to AGENT_ROLES, so
 * renaming `judge` breaks compilation here instead of silently orphaning the freeze.
 */
export declare const FROZEN_OVERLAY_ROLES: readonly ["judge"];
/**
 * The standard SU-tool `agentRoles:` allowlist — the eight pipeline roles +
 * the operator chat role. THE single source for this set (audit P-072,
 * EI-145/EI-66 — it used to exist as ~113 identical inline copies named
 * SU_ROLES/ALL_ROLES across agent-tools). Variants compose at the use site:
 * `[...SU_ROLES, 'bee']`, `[...SU_ROLES, 'sentinel']`, etc.
 *
 * `satisfies` pins every member to AGENT_ROLES, so renaming a role there
 * breaks compilation here instead of silently orphaning an allowlist.
 */
export declare const SU_ROLES: readonly ["scoper", "architect", "worker", "validator", "reviewer", "debugger", "operator", "mug", "documenter", "curator"];
/**
 * The write-side subset of SU_ROLES: validator + reviewer are judgment
 * roles — they read artifacts/state but never author it (the artifacts
 * tools' allowlist; audit P-072 "shared READ/WRITE role consts").
 */
export declare const SU_WRITE_ROLES: readonly ["scoper", "architect", "worker", "debugger", "operator", "mug", "documenter", "curator"];
/**
 * The OPERATOR-CONFIG write-authority roles — the in-handler gate for tools that
 * MUTATE fleet-wide operator config (the rate-limit knobs, operator preferences,
 * config overrides, the db-migrate policy, watchdog tunables, scheduled routines).
 * Those tools advertise the broad `[...SU_ROLES]` INVOKE allowlist (read/list is
 * open to every pipeline role) but NARROW the mutating op to operator-level
 * authority — historically a hand-rolled `ctx.role !== 'operator' && ctx.role !==
 * 'architect'` re-spread across ~6 tools.
 *
 * `queen` belongs here: she is the operator SPECIALIZED for placement (local-hive
 * D-001 — "operator-equivalent grants"). She was silently omitted from those
 * re-spread literals when added to SU_ROLES, which is exactly EI-2204 — the Queen
 * could INVOKE `operator:rate_limit_config` but its `set` rejected her role,
 * blocking the clean path to reset a jammed concurrency ceiling (EI-2186).
 * Centralizing the set here keeps the operator≡queen equivalence from drifting
 * back out of sync across those tools (and the `isOperatorConfigWriteRole` guard
 * fails CI if the literal is re-introduced).
 */
export declare const OPERATOR_CONFIG_WRITE_ROLES: readonly ["operator", "architect", "mug"];
/**
 * Does `role` carry operator-config write authority (one of
 * OPERATOR_CONFIG_WRITE_ROLES)? The single predicate the operator-config-write
 * tools gate their mutating op on. Plugin-namespaced (`<plugin>:<role>`) and
 * unknown roles are not operator-equivalent → false (fail-closed).
 */
export declare function isOperatorConfigWriteRole(role: string | undefined | null): boolean;
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
