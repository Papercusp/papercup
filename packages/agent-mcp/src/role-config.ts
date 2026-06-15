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
  // The QUEEN — the hive blueprint's placement-specialist decider
  // (spine.deciderAlternatives; local-hive-orchestration P-030). The operator role
  // specialized for placement (D-001): same judgment layer, dial turned toward
  // fleet:spawn/drain + work-list shaping. Registered late (EI-286 follow-up): the
  // blueprint declared the role but the registry never knew it, so a role=queen
  // launch got an almost-empty role-scoped MCP catalog and could not place work.
  'queen',
  // The PLANNER (hive-agent-tabs-psu-tui-2026-06-09 P-006): an interactive,
  // RESPONSIVE plan-authoring session launched into the dock as a Planner-kind pane
  // (no auto-injected wakes — the owner drives). It drafts/refines ONE plan via the
  // plans:* tools; like a bee it appears in the roster + is paned by the dock driver,
  // but its job is the plan, not code execution. classifyAgentPane maps it → Planner.
  'planner',
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
  // git-sync CONTENT-guard repairer (git-sync-content-guard-2026-06-13 D-008 follow-up;
  // the merge-resolver's content-side twin). Spawned by the `system:git-sync` content
  // guard (EI-438) when a dirty file fails a content detector and is quarantined out of
  // the auto-commit — an .mdx that won't MDX-compile, a curly quote used as code. Fixes
  // ONLY the named files' syntax so they pass the detector, leaves the tree clean, does
  // NOT push. Registered late (mirrors the merge-resolver/release-fixer launch-fixer
  // family): the `content-fix` blueprint declared the role, but the registry never knew
  // it, so it lived as an untyped bare string in tool allowlists.
  'content-fixer',
  // Release manager (release-gate-ready-branch-2026-06-04 D-011). The judgment
  // half of the deploy chokepoint — Claude Opus 4.8 @ xhigh effort, because the
  // blast radius is the whole running fleet. Spawned by the `system:release-trigger`
  // action (or launched interactively); reviews the gathered deploy plan + staged
  // migrations, makes the go/no-go call, runs the scripted deploy mechanics, then
  // reads health and decides rollback. The script is the hands; this is the brain.
  'release-manager',
  // green-checkpoint GATE fixer (release-pipeline-resilience-2026-06-09 P-006; the
  // release-manager's execution-side twin, and the launch-fixer family's third member
  // alongside merge-resolver/content-fixer). Spawned by the `system:release-trigger` /
  // green-checkpoint routine when the gate goes RED: reads the checkpoint log, reproduces
  // the failing test to classify regression-vs-flake, then fixes the code or removes a
  // proven flake (hermetic / tier-out / accountable quarantine), leaves the tree clean,
  // does NOT push. Registered late (mirrors merge-resolver): the `release-fix` blueprint
  // declared the role, but the registry never knew it.
  'release-fixer',
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
  // The OVERWATCH — the autonomous system-health SUPERVISOR, a sibling to the Queen
  // (overwatch-role-2026-06-15 C-2 / B-01). Where the Queen SCHEDULES (places work)
  // and the sentinel WATCHES the fleet, the overwatch runs the short-term
  // sense→decide→act control loop over the WHOLE running system (the Queen, the bees,
  // the work-feed, tokens, plans, escalations): it detects drift and makes LIVE
  // course-corrections by NUDGING the running agents (coord:send) + recording
  // OBSERVATIONS (improvements:capture lane:observation), never re-placing work itself
  // (D-001 — the hard Queen-boundary). READ-EVERYTHING + nudge/observe/escalate ONLY:
  // its write-to-the-world verbs are coord:send / coord:escalate / improvements:capture
  // / messages:send, and its ROLE_ENVELOPES entry DENIES capability:fs-write +
  // capability:bash — it nudges, it never edits code. Registered statically + UNGATED
  // here (the `papercusp-overwatch` flag gates the LOOP/spawn/UI in B-04/B-08/B-10, not
  // this type-level role id). Canonical persona ships at the hive blueprint
  // (blueprints/hive/prompts/overwatch.md, B-05); the fallback prompts/overwatch.md is a
  // thin STUB so the two cannot drift (D-007 / the EI-611 lesson).
  'overwatch',
] as const;

/** Union of the built-in role ids. Plugin roles widen `AgentRole` to `string`. */
export type BuiltinAgentRole = (typeof AGENT_ROLES)[number];

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
export const SU_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  // The queen is the operator specialized (local-hive D-001) — operator-equivalent
  // grants so her placement loop (events:emit, hive wake declarations) resolves.
  'queen',
  'documenter',
  'curator',
] as const satisfies readonly BuiltinAgentRole[];

/**
 * The write-side subset of SU_ROLES: validator + reviewer are judgment
 * roles — they read artifacts/state but never author it (the artifacts
 * tools' allowlist; audit P-072 "shared READ/WRITE role consts").
 */
export const SU_WRITE_ROLES = [
  'scoper',
  'architect',
  'worker',
  'debugger',
  'operator',
  'queen',
  'documenter',
  'curator',
] as const satisfies readonly BuiltinAgentRole[];

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
