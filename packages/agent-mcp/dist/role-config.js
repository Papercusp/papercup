"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AGENT_ROLES = void 0;
/**
 * The built-in Papercusp agent roles, as they appear in tool `roles:`
 * allowlists, `rolesQuota` keys, and `byRole` guidance overrides. The set is
 * open — plugins contribute additional roles at runtime (namespaced
 * `<plugin>:<role>`), which stay typed as bare `string`.
 */
exports.AGENT_ROLES = [
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
    // Promotes a plan's `## Promote` policy into the harness, all waves up front
    // (launched by a human/agent). promote-policy-and-waves-2026-05-30; the
    // wave-advance sweep that used to drive it per-wave is retired (P-044).
    'promote',
    'expert',
    'feedback',
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
];
