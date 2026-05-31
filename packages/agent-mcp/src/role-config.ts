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
 * roles (operator/oracle), then the cross-cutting expert roles that show up
 * in tool `roles:` allowlists.
 */

/**
 * The built-in Papercusp agent roles, as they appear in tool `roles:`
 * allowlists, `rolesQuota` keys, and `byRole` guidance overrides. The set is
 * open — plugins contribute additional roles at runtime (namespaced
 * `<plugin>:<role>`), which stay typed as bare `string`.
 */
export const AGENT_ROLES = [
  // Pipeline roles (scoper → curator).
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'documenter',
  'curator',
  // Chat-surface roles.
  'operator',
  'oracle',
  // Coordinator + cross-cutting expert roles (built-in, fire on plan events).
  'orchestrator',
  // Promotes one `## Promote` wave of a plan into the harness (launched by the
  // wave-advance sweep / a human). promote-policy-and-waves-2026-05-30 (Phase F).
  'promote',
  'expert',
  'feedback',
  'project_manager',
  'security-reviewer',
  'infra-reviewer',
  'summarizer',
  'crosscheck',
  'ui-qa',
] as const;

/** Union of the built-in role ids. Plugin roles widen `AgentRole` to `string`. */
export type BuiltinAgentRole = (typeof AGENT_ROLES)[number];

/**
 * Register the built-in roles with the framework. Declaration merging adds
 * these keys to `@papercusp/tooldef`'s `RoleRegistry`, which the framework
 * reads (`keyof RoleRegistry`) to shape `AgentRole`. Derived from
 * `AGENT_ROLES` so the two never drift.
 */
declare module '@papercusp/tooldef' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface RoleRegistry extends Record<BuiltinAgentRole, true> {}
}
