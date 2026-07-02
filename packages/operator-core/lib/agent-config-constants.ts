/**
 * Client-safe agent-backend / surface constants + types.
 *
 * Why this file exists: `agent-config.ts` imports `node:fs/promises` and the
 * PG state layer (`operator-state-pg` → `db-encryption` → `postgres`) at module
 * scope. Pulling ANY export from there — even a plain string-tuple const like
 * `SURFACE_KEYS` — drags that whole server subtree into the consumer's chunk.
 * The operator-vite renderer has no Node built-ins, so that leak caused
 * "homedir is not a function" / postgres-in-the-browser crashes.
 *
 * Extracted so client modules (e.g. `app/settings/agent/page.tsx`) can import
 * these constants/types without triggering the cascade. `agent-config.ts`
 * re-exports them for backward compat. Mirrors the `workspace-id-constant.ts`
 * pattern. Keep this module free of any Node/server imports.
 */

/**
 * Canonical subprocess-spawn backend set (operator side). Kept in sync with the
 * orchestrator's `AGENT_BACKENDS` (`@papercusp/orchestrator` types.ts) and the
 * spawn-capable subset of `@papercusp/papercusp-shared` chat-stream's
 * `AgentBackend` (which additionally has `anthropic-direct`, a stateless brains-only
 * HTTP backend — not a subprocess). The submodule boundary rules out a single
 * literal import; `agent-backend-sync.test.ts` guards the three against drift.
 */
export const AGENT_BACKENDS = ['claude-code', 'omp', 'codex'] as const;
export type AgentBackend = (typeof AGENT_BACKENDS)[number];

/**
 * The in-app brain surfaces that support a per-surface backend override. Keep in
 * sync with the call sites that pass `surfaceBackend('<key>')` and the
 * /settings/agent per-surface table.
 */
export const SURFACE_KEYS = [
  'operator',
  'scanner',
  'delegate',
  'oracle',
  'architect',
  'brainstorm',
  'agent_chats',
  'plans',
] as const;
export type SurfaceKey = (typeof SURFACE_KEYS)[number];

// ── Model tiers (queen-model-tier-selection-2026-06-11) ──────────────────────

/** Reasoning-effort levels a model spec's `:<effort>` suffix may carry —
    mirrors the `claude --effort` flag values (same set as
    harness-invoke-once's EFFORT_LEVELS; client-safe copy lives here). */
export const MODEL_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ModelEffort = (typeof MODEL_EFFORT_LEVELS)[number];

/**
 * One entry in the user-defined model-tier menu. `spec` is the same
 * `<modelId>[:<effort>]` shape `AGENT_MODELS` values take, so it flows through
 * the existing parsers (applyRoleModel / resolveModel) unchanged.
 */
export interface ModelTier {
  /** Tier name the queen picks by — short, lowercase (e.g. 'standard'). */
  name: string;
  /** Model spec this tier resolves to (e.g. 'opus:high'). */
  spec: string;
  /** Backend this tier runs on. Absent = inherit the host's agent command
      (the usual case). When set and different from the host backend, the
      spawn's base command is swapped to this backend's default
      (DEFAULT_BACKEND_CMDS) before the model spec is applied — so a tier can
      be e.g. quick-on-omp while deep stays on claude. */
  backend?: AgentBackend;
  /** USER-AUTHORED guidance: when the queen should pick this tier (one
      line, e.g. 'ambiguous or architectural work; repeat failures'). Injected
      verbatim into the queen's launch prompt as her live tier menu — this is
      the owner's instruction channel for per-tier judgment. */
  when?: string;
  /** Soft compaction limit (tokens) for sessions spawned on this tier — the
      context size at which the agent should reach a clean stopping point and
      self-compact (agent-managed-compaction-2026-07-01). Absent = the
      model-derived default, `defaultCompactionLimitForSpec(spec)`
      (context-trimming-tiers D-001/D-002). That default is also the CEILING:
      agents may overshoot the soft limit by ~20%, so `parseTiers` clamps a
      stored value to keep `limit × 1.2 ≤ window − margin`. */
  compactionLimit?: number;
}

/** Default agent command per backend — used when a per-tier backend swap
    needs a base command for a backend the host's AGENT_CMD doesn't drive.
    Mirrors the /settings/agent placeholders + run.sh defaults. */
export const DEFAULT_BACKEND_CMDS: Record<AgentBackend, string> = {
  'claude-code': 'claude -p',
  omp: 'omp -p',
  codex: 'codex exec',
};

/**
 * The default tier menu when the user hasn't defined one — ordered WEAKEST →
 * STRONGEST (the order IS the strength ranking the floor/ceiling clamp uses).
 * Mirrors the fleet's implicit haiku/sonnet/opus tiering (ROLE_MODEL_DEFAULTS).
 * The `when` lines are the default placement rubric — the user's own menu
 * replaces them wholesale.
 */
export const DEFAULT_MODEL_TIERS: readonly ModelTier[] = [
  { name: 'quick', spec: 'haiku', when: 'trivial / mechanical work (renames, single-file fixes, mechanical sweeps)' },
  { name: 'standard', spec: 'sonnet', when: 'spec-bounded normal features and bugs — the usual pick; omitting tier is equivalent' },
  { name: 'deep', spec: 'opus:high', when: 'ambiguous or architectural work, cross-cutting changes, repeat failures on a lower tier' },
  { name: 'max', spec: 'opus:xhigh', when: 'security-sensitive, migration, or deploy-adjacent work where a mistake is expensive' },
] as const;

/** Validate a `<modelId>[:<effort>]` spec string (loose on the model id —
    provider ids vary — strict on the effort suffix). */
export function isValidModelSpec(spec: string): boolean {
  if (!spec || /\s/.test(spec)) return false;
  const lastColon = spec.lastIndexOf(':');
  if (lastColon <= 0) return spec.length > 0;
  const suffix = spec.slice(lastColon + 1);
  // A colon-bearing id whose suffix is NOT an effort level is treated as a
  // plain model id (same rule applyRoleModel uses when splitting).
  return suffix.length > 0 && spec.slice(0, lastColon).length > 0;
}

// ── Compaction limits (context-trimming-tiers-2026-07-01) ────────────────────

/** 1M-window models — a spec carrying the `[1m]` marker. */
export const MODEL_WINDOW_1M = 1_000_000;
/** The conservative default window: subscription-routed models without the
    `[1m]` marker (incl. sonnet, which has no subscription 1M path) run 200k. */
export const MODEL_WINDOW_DEFAULT = 200_000;

/**
 * Hard context window for a CC-hosted model spec. The `[1m]` marker on the
 * spec is the practical window signal — Claude Code enables the 1M-context
 * beta only for `[1m]` specs — so: `[1m]` → 1M; anything else (including an
 * unknown/null spec) → the conservative 200k. Fail-safe direction matters: a
 * low limit on a 1M session is just deliberate leanness (agent-managed-
 * compaction D-006); a high limit on a 200k session is a hard death. OMP/local
 * models resolve via their own registry (follow-up, context-trimming D-003).
 */
export function modelWindowForSpec(spec?: string | null): number {
  if (spec == null) return MODEL_WINDOW_DEFAULT;
  return spec.includes('[1m]') || isDefault1mModelSpec(spec) ? MODEL_WINDOW_1M : MODEL_WINDOW_DEFAULT;
}

/**
 * Model families papercusp defaults to the FULL 1M window (owner directive
 * 2026-07-02): `opus` and `fable`. Their launch spec is ALSO normalized to carry
 * `[1m]` (psu-launcher `normalizeModelSpec`) so Claude Code / the gateway enable
 * the 1M-context beta; this helper is the compaction-math twin, so a session that
 * skipped normalization still gets the 1M window here (never a 200k hard death).
 */
export function isDefault1mModelSpec(spec?: string | null): boolean {
  return spec != null && /fable|opus/i.test(spec);
}

/** Output-reservation + startup-attachment headroom subtracted from the hard
    window before deriving the soft limit. */
export const COMPACTION_WINDOW_MARGIN_TOKENS = 10_000;
/** Agents may run ~20% past their SOFT limit before the hard window threatens
    (owner rule, context-trimming-tiers D-001) — the derived default keeps
    `limit × OVERSHOOT ≤ window − margin`. */
export const COMPACTION_OVERSHOOT_FACTOR = 1.2;
/** Floor for any stored/self-set compaction limit (mirrors
    config:set-compaction-limit's arg minimum). */
export const MIN_COMPACTION_LIMIT_TOKENS = 20_000;

/**
 * Preemptive compaction cap for the default-1M families (opus + fable): they run
 * on the full 1M window but papercusp compacts them at 500k to bound token spend
 * (owner directive 2026-07-02) — 500k is ample for a leanly-scoped task, and its
 * ×1.2 overshoot (600k) stays well under the 1M − margin ceiling.
 */
export const COMPACTION_LIMIT_DEFAULT_1M_CAP = 500_000;

/**
 * The model-derived default soft compaction limit for a spec — and the CEILING
 * a user/agent-set limit is clamped to (context-trimming-tiers D-001):
 * `floor((window − margin) / 1.2)`, floored to 1k for stable display.
 * 200k window → 158,000; 1M → 825,000. EXCEPTION: opus + fable are capped at
 * 500,000 (owner directive 2026-07-02) so they compact preemptively despite the
 * 1M window.
 */
export function defaultCompactionLimitForSpec(spec?: string | null): number {
  if (isDefault1mModelSpec(spec)) return COMPACTION_LIMIT_DEFAULT_1M_CAP;
  const window = modelWindowForSpec(spec);
  const raw = (window - COMPACTION_WINDOW_MARGIN_TOKENS) / COMPACTION_OVERSHOOT_FACTOR;
  return Math.floor(raw / 1000) * 1000;
}

/** Clamp a requested compaction limit into [MIN, defaultCompactionLimitForSpec(spec)]. */
export function clampCompactionLimit(limit: number, spec?: string | null): number {
  const cap = defaultCompactionLimitForSpec(spec);
  return Math.min(Math.max(Math.floor(limit), MIN_COMPACTION_LIMIT_TOKENS), cap);
}
