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
 * STATUS — this is the INITIAL policy cut. Enforcement ships default-OFF (observe-only,
 * the `papercusp-capability-envelope` flag); the real per-role POSITIVE allowlist and the
 * path/domain dimensions are tuned during the B-18 fleet cutover, once B-05's capability
 * defineTools (bash / file / git / net — which carry the path/domain args this evaluator
 * will then match) exist. Today the only ACTIVE constraint is the universal
 * never-auto protected-capability deny (the queen-autonomy D-005 protected set expressed
 * at the capability layer). Default-allow everywhere else keeps observe-mode signal
 * high-precision (a fleet agent reaching for a protected capability) rather than flooding.
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
 * Per-role envelopes. EMPTY at B-06 — every fleet role is default-allow (only the
 * universal protected deny constrains it). B-18 fills the positive per-role allowlists +
 * path/domain dimensions here as it cuts the fleet over to `dontAsk` + a tight allowlist.
 */
export const ROLE_ENVELOPES: Partial<Record<string, RoleEnvelope>> = {};

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
