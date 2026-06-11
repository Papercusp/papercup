/**
 * fleet/model-tiers — resolve a tier NAME to a model spec, clamped to the
 * role's safety bounds (queen-model-tier-selection-2026-06-11 P-002).
 *
 * The propose/dispose split for per-task model selection: the USER defines the
 * tier menu (AgentConfig.tiers, ordered weakest → strongest) and the per-role
 * ceilings (AgentConfig.tierCeilings); the QUEEN only picks a tier name from
 * that menu. Resolution clamps her pick to [role floor, role ceiling]:
 *
 *   - floor  — derived, not configured: the rank of the role's resolved
 *     default model (AGENT_MODELS[role] → ROLE_MODEL_DEFAULTS floor) in the
 *     tier list. A tier pick may ESCALATE a role above its default but never
 *     downgrade it below — the EI-7/EI-286 scar tissue (a queen silently
 *     dropped to haiku drifts into bash and fabricates evidence) is exactly
 *     why a "too cheap" pick must clamp up rather than apply.
 *   - ceiling — the user's budget envelope per role (tierCeilings[role]);
 *     absent = the strongest tier is allowed.
 *
 * Clamping is LOUD (the result names which bound clamped and why) but never
 * an error — only an unknown tier name rejects, since that's a bad input the
 * caller should fix, not a judgment to silently reinterpret.
 */
import {
  DEFAULT_MODEL_TIERS,
  type ModelTier,
} from '../agent-config-constants';
import { roleModelDefault } from '@papercusp/orchestrator/role-models';

export interface TierResolution {
  ok: true;
  /** The model spec to thread into the spawn (PAPERCUSP_SPAWN_MODEL). */
  spec: string;
  /** The tier the spawn actually runs at (post-clamp). */
  tier: string;
  /** The tier that was asked for. */
  requestedTier: string;
  /** Backend the resolved tier pins (PAPERCUSP_SPAWN_BACKEND). Absent =
      inherit the host's agent command. Comes from the RESOLVED tier — a
      clamp adopts the clamped-to tier's backend along with its spec. */
  backend?: string;
  /** Set when the pick was clamped, with the bound that did it. */
  clamped?: 'floor' | 'ceiling';
  /** Human-readable note on why the clamp happened (for the spawn log/row). */
  note?: string;
}

export interface TierError {
  ok: false;
  error: string;
}

/** The model id part of a `<modelId>[:<effort>]` spec (effort stripped). */
export function specModelId(spec: string): string {
  const trimmed = spec.trim();
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon <= 0) return trimmed;
  const suffix = trimmed.slice(lastColon + 1);
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(suffix)
    ? trimmed.slice(0, lastColon)
    : trimmed;
}

/** The role's resolved DEFAULT spec — what it runs with no tier: the
    user-level AGENT_MODELS env entry, else the committed floor. Empty when
    the role has neither (→ the CLI default; no floor protection possible). */
export function roleDefaultSpec(role: string): string {
  const raw = process.env.AGENT_MODELS;
  if (raw) {
    try {
      const map = JSON.parse(raw) as Record<string, unknown>;
      const v = map?.[role];
      if (typeof v === 'string' && v.trim()) return v.trim();
    } catch {
      /* malformed AGENT_MODELS — fall through to the committed default */
    }
  }
  return roleModelDefault(role) ?? '';
}

/** Rank of the first tier whose model id matches `spec`'s, or -1. */
function tierRankOfSpec(tiers: readonly ModelTier[], spec: string): number {
  if (!spec) return -1;
  const id = specModelId(spec);
  return tiers.findIndex((t) => specModelId(t.spec) === id);
}

/**
 * Resolve `tier` for `role` against the user's menu + bounds. Pass the
 * AgentConfig-stored `tiers`/`tierCeilings` (empty → DEFAULT_MODEL_TIERS /
 * no ceilings). Unknown tier name → error listing the valid menu; a pick
 * outside [floor, ceiling] clamps to the violated bound with a note.
 */
export function resolveTierSpec(opts: {
  tier: string;
  role: string;
  tiers?: readonly ModelTier[];
  tierCeilings?: Record<string, string>;
}): TierResolution | TierError {
  const tiers = opts.tiers && opts.tiers.length > 0 ? opts.tiers : DEFAULT_MODEL_TIERS;
  const requested = opts.tier.trim().toLowerCase();
  let idx = tiers.findIndex((t) => t.name.toLowerCase() === requested);
  if (idx < 0) {
    return {
      ok: false,
      error: `unknown tier "${opts.tier}" — valid tiers (weakest→strongest): ${tiers.map((t) => t.name).join(', ')}`,
    };
  }

  let clamped: TierResolution['clamped'];
  let note: string | undefined;

  // Ceiling, then floor — so when the two conflict (ceiling configured BELOW
  // the role's default) the floor wins: running at the role's default is what
  // happens with no tier at all, so a ceiling can never force a downgrade.
  const ceilingName = opts.tierCeilings?.[opts.role]?.trim().toLowerCase();
  if (ceilingName) {
    const ceilIdx = tiers.findIndex((t) => t.name.toLowerCase() === ceilingName);
    // An unknown ceiling name is a config bug — ignore it (no ceiling) rather
    // than guess; the settings UI validates names on save.
    if (ceilIdx >= 0 && idx > ceilIdx) {
      idx = ceilIdx;
      clamped = 'ceiling';
      note = `tier "${requested}" exceeds role "${opts.role}" ceiling "${tiers[ceilIdx].name}" — clamped down`;
    }
  }

  const floorIdx = tierRankOfSpec(tiers, roleDefaultSpec(opts.role));
  if (floorIdx >= 0 && idx < floorIdx) {
    idx = floorIdx;
    clamped = 'floor';
    note = `tier "${requested}" is below role "${opts.role}" default floor "${tiers[floorIdx].name}" — clamped up (a role never silently downgrades, EI-7/EI-286)`;
  }

  return {
    ok: true,
    spec: tiers[idx].spec,
    tier: tiers[idx].name,
    requestedTier: requested,
    ...(tiers[idx].backend ? { backend: tiers[idx].backend } : {}),
    ...(clamped ? { clamped, note } : {}),
  };
}
