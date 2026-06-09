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
  // The generic operator-world worker — the Hive's bee (local-hive-orchestration
  // D-003 / P-011). The plain "do this task" role the Queen places ranked work +
  // a brief onto. DECOUPLED from the pipeline guards: unlike `worker` (which
  // operator-spawn rejects without a `chunkId`), a `bee` carries NO pipeline spine
  // and NO chunk requirement. Pipeline roles (scoper/worker/validator/…) apply
  // ONLY when a bee explicitly spins up a coding harness (kind:'harness'); the bee
  // itself is the generic agent of the kind:'hive' blueprint.
  'bee',
  // Coordinator + cross-cutting roles (built-in, fire on plan events).
  'orchestrator',
  // Promotes a plan's `## Promote` policy into the harness, all waves up front
  // (launched by a human/agent). promote-policy-and-waves-2026-05-30; the
  // wave-advance sweep that used to drive it per-wave is retired (P-044).
  'promote',
  'security-reviewer',
  'infra-reviewer',
  // 'summarizer' + 'project_manager' — CUT (dbos-system-completion P-015).
  // summarizer: dead role, never dispatched, no subsystem. project_manager:
  // powered the projects→spec-revision PM-dispatch feature (regenerate-spec
  // route + passed→pm_due reactive path); the whole feature was retired by
  // product decision D-020, so the role + pm-dispatch.ts + its prompt are gone.
  'crosscheck',
  'ui-qa',
  // G2 user-protection gate (papercusp-user-protection-gate-2026-05-31 P-006):
  // read-only adversarial judgment role; screens remote-authored features before
  // they reach the orchestrator pick loop. No execution capability.
  'auditor',
  // git-sync merge-conflict resolver (git-sync-auto-commit P-011). Spawned by the
  // `system:git-sync` action when an auto-merge with origin/main conflicts: it
  // redoes the merge fresh on `main`, resolves, commits, leaves the tree clean, and
  // does NOT push (the next git-sync tick pushes). Not feature-scoped.
  'merge-resolver',
  // Release manager (release-gate-ready-branch-2026-06-04 D-011). The judgment
  // half of the deploy chokepoint — Claude Opus 4.8 @ xhigh effort, because the
  // blast radius is the whole running fleet. Spawned by the `system:release-trigger`
  // action (or launched interactively); reviews the gathered deploy plan + staged
  // migrations, makes the go/no-go call, runs the scripted deploy mechanics, then
  // reads health and decides rollback. The script is the hands; this is the brain.
  'release-manager',
  // The SENTINEL — the fleet watcher split out of the overloaded "operator"
  // (unify-launch-mechanics-2026-06-09 D-004). "operator" meant both the Queen
  // (steer: schedule + place + prioritize) AND a watcher; they are now separate.
  // The Queen STEERS; the sentinel WATCHES — fleet health (stuck/orphaned spawns,
  // crash-loops), misbehaving agents (lock hogs, retry storms, mute bees), and the
  // coord substrate (presence staleness, undelivered escalations). It is READ-MOSTLY
  // (its only writes are raising alarms: coord:escalate / coord:send), launched
  // through the SAME unified primitive as a bee and PLACED BY THE QUEEN (fleet:spawn
  // or the `sentinel` launch blueprint). No execution/mutation capability.
  'sentinel',
] as const;

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
export const BRAIN_PRINCIPAL_ROLE = 'brain';

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
