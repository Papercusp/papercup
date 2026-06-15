/**
 * The capability ENVELOPE — agent-capability-confinement-2026-06-13 B-06 (P-012).
 *
 * The cheap, static, per-role "may you do X at all" gate for the AUTONOMOUS FLEET — the
 * *capability gate* of the two-gate split (D-003), distinct from the Queen's rich
 * autonomy/decision gate. It is the ~µs allow/deny check every fleet tool call passes:
 * pure static matching, no PG, and NO decision-log row of its own (the per-action ledger
 * row is the SEPARATE emit — see `lib/decision-ledger`). A beyond-envelope request is the
 * thing that "routes up" to the decision gate.
 *
 * Scope (D-002): the envelope governs autonomous fleet roles ONLY. SU / power-user /
 * non-fleet / roleless callers are EXEMPT — supervised human sessions keep native-tool
 * ergonomics; the policy is the safety net precisely where there is no human.
 *
 * STATUS — enforcement is ARMED (`papercusp-capability-envelope` ON; its flip is the
 * kill-switch). The one active constraint is the universal never-auto protected-capability
 * deny (the queen-autonomy D-005 protected set at the capability layer — `secrets:*` +
 * `processes:kill`, applies to every fleet role). The per-role `ROLE_ENVELOPES` tuning is
 * currently EMPTY: the `bee` read-only confinement (EI-524 / P-035) was LIFTED on
 * 2026-06-14 (owner-directed full fleet autonomy — a bee must be able to LAND code-fix
 * work, not just diagnose it), so every fleet role is default-allow under the protected
 * floor. Path/domain dimensions remain forward-designed; `ROLE_ENVELOPES` stays as the
 * B-18 per-role tuning seam.
 */

import { AGENT_ROLES } from '@papercusp/agent-mcp';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';

/**
 * Roles the envelope governs: the autonomous fleet = every built-in agent role EXCEPT the
 * interactive chat surfaces (`operator` / `oracle`), which are human-driving sessions.
 * Plugin-contributed `<plugin>:<role>` ids are NOT in this set, so they are treated as
 * exempt until B-18 deliberately admits them.
 */
export const FLEET_ENVELOPE_ROLES: ReadonlySet<string> = new Set(
  AGENT_ROLES.filter((r) => r !== 'operator' && r !== 'oracle'),
);

/**
 * Capability globs NO autonomous fleet role may auto-exercise — the queen-autonomy-policy
 * D-005 "never-auto protected set" at the capability layer. Kept deliberately MINIMAL for
 * B-06 to the universally-never-auto verbs (raw secret reads, process kills) so observe
 * mode is near-zero-false-positive; the per-role protected nuance (e.g. the Queen MAY
 * fleet:spawn but a bee may not) is B-18 tuning via `ROLE_ENVELOPES`.
 */
export const PROTECTED_CAPABILITY_GLOBS: readonly string[] = [
  'secrets:*',
  'processes:kill',
];

/** Per-role envelope override. All dimensions optional; absent ⇒ default-allow (B-06). */
export interface RoleEnvelope {
  /** Positive capability/verb globs. Absent or `['*']` ⇒ allow all (the B-06 default). */
  allowCapabilities?: readonly string[];
  /** Role-specific deny globs, layered ON TOP of the universal protected set. */
  denyCapabilities?: readonly string[];
  /** FUTURE (B-05 file tools): path globs the role may read/write. */
  allowPathGlobs?: readonly string[];
  /** FUTURE (B-05 net tools): network domains the role may reach. */
  allowDomains?: readonly string[];
}

/**
 * Per-role envelopes — the B-18 per-role tuning seam. Currently EMPTY: every
 * fleet role is default-allow, constrained only by the universal protected set
 * (`PROTECTED_CAPABILITY_GLOBS`).
 *
 * HISTORY — the `bee` read-only confinement (EI-524 / P-035) lived here as
 * `denyCapabilities: ['capability:fs-write', 'capability:bash']`: it confined the
 * generic fleet worker to read-only inspection (READ + `capability:inspect`
 * verify + the coordination plane) so it could not act on a hallucinated root
 * cause — the fix for phantom F-FIX escalations. That confinement was LIFTED on
 * 2026-06-14 (owner-directed full fleet autonomy): a bee must be able to LAND a
 * code fix, not merely diagnose one, so it now gets write (`capability:fs-write`)
 * and exec (`capability:bash`, OS-sandboxed via P-022/D-008) like the pipeline
 * coding roles. The anti-hallucination guard is now the verify-before-diagnose
 * DISCIPLINE (`capability:inspect` remains the sanctioned focused verify) plus
 * the validator/reviewer pipeline + tests — not a capability wall. Re-add a
 * `bee` entry here to re-confine. Live behind `papercusp-capability-envelope`.
 */
export const ROLE_ENVELOPES: Partial<Record<string, RoleEnvelope>> = {
  // The OVERWATCH — the autonomous system-health SUPERVISOR (overwatch-role-2026-06-15
  // C-2 / B-01 + D-002). It READS the whole system and NUDGES/OBSERVES/ESCALATES
  // (coord:send / coord:escalate / improvements:capture / messages:send), but it must
  // NEVER edit code or run a shell — it tells the Queen/bees what to do, it doesn't act
  // on WORK itself (D-001). So, mirroring the lifted `bee` read-only confinement
  // (EI-524), deny the write+exec capabilities at the envelope layer. (Its
  // BLUEPRINT_ROLE_CAPS grant already omits work_items:write/harness:write/plans:write,
  // so this is the explicit belt: even a tool that asks for fs-write/bash is refused.)
  // The structural-action DECISION gate (restart a routine, flip a flag, kill a proc) is
  // B-06's autonomy-policy wiring, distinct from this static capability wall.
  overwatch: {
    denyCapabilities: ['capability:fs-write', 'capability:bash'],
  },
};

export interface EnvelopeDecision {
  /** false ⇒ beyond the envelope (a protected / denied capability). */
  withinEnvelope: boolean;
  /** false ⇒ the caller is EXEMPT (SU / power-user / non-fleet / roleless): the envelope did not apply. */
  applied: boolean;
  /** Human reason when beyond-envelope (feeds the deny message + the ledger `why`). */
  reason?: string;
}

/**
 * Evaluate the capability envelope for one call. Pure + synchronous + allocation-light —
 * safe on the dispatch hot path. The enforce-vs-observe decision is NOT here (it is the
 * flag, read by the dispatch-deps port); this answers only "is this within the envelope".
 */
export function evaluateCapabilityEnvelope(args: {
  toolName: string;
  capabilities: readonly string[];
  ctx: Pick<UnifiedToolContext, 'role' | 'isSuperuser' | 'isPowerUser'>;
}): EnvelopeDecision {
  const { toolName, capabilities, ctx } = args;

  // Exemptions (D-002): supervised humans + non-fleet roles keep full ergonomics.
  if (ctx.isSuperuser || ctx.isPowerUser) return { withinEnvelope: true, applied: false };
  const role = ctx.role;
  if (!role || !FLEET_ENVELOPE_ROLES.has(role)) return { withinEnvelope: true, applied: false };

  const env = ROLE_ENVELOPES[role];
  for (const cap of capabilities) {
    if (matchesAny(cap, PROTECTED_CAPABILITY_GLOBS)) {
      return {
        withinEnvelope: false,
        applied: true,
        reason: `capability "${cap}" is in the never-auto protected set (tool ${toolName}, role ${role})`,
      };
    }
    if (env?.denyCapabilities && matchesAny(cap, env.denyCapabilities)) {
      return {
        withinEnvelope: false,
        applied: true,
        reason: `capability "${cap}" denied for role ${role} (tool ${toolName})`,
      };
    }
    if (env?.allowCapabilities && env.allowCapabilities.length > 0 && !matchesAny(cap, env.allowCapabilities)) {
      return {
        withinEnvelope: false,
        applied: true,
        reason: `capability "${cap}" not in role ${role} allowlist (tool ${toolName})`,
      };
    }
  }
  return { withinEnvelope: true, applied: true };
}

function matchesAny(value: string, globs: readonly string[]): boolean {
  for (const g of globs) if (matchGlob(value, g)) return true;
  return false;
}

/** Minimal glob: `*` is a wildcard run. `secrets:*` matches `secrets:read:foo`. */
function matchGlob(value: string, glob: string): boolean {
  if (glob === '*') return true;
  if (!glob.includes('*')) return value === glob;
  const re = new RegExp('^' + glob.split('*').map(escapeRegExp).join('.*') + '$');
  return re.test(value);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
