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
 * spawn-capable subset of `@papercusp/papercup-shared` chat-stream's
 * `AgentBackend` (which additionally has `meridian`, a stateless brains-only
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
}

/**
 * The default tier menu when the user hasn't defined one — ordered WEAKEST →
 * STRONGEST (the order IS the strength ranking the floor/ceiling clamp uses).
 * Mirrors the fleet's implicit haiku/sonnet/opus tiering (ROLE_MODEL_DEFAULTS).
 */
export const DEFAULT_MODEL_TIERS: readonly ModelTier[] = [
  { name: 'quick', spec: 'haiku' },
  { name: 'standard', spec: 'sonnet' },
  { name: 'deep', spec: 'opus:high' },
  { name: 'max', spec: 'opus:xhigh' },
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
