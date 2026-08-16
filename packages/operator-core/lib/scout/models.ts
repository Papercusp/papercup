/**
 * Scout LLM model defaults and the per-blueprint override shape.
 *
 * Kept in one small module so config.ts can build its defaults from the same constants
 * the step implementations use, without importing the heavier step modules.
 */

/** ⚠ RAW API model id ONLY — the scout stateless path (llm-testing/llm-client →
 *  anthropic-direct) passes this string verbatim to the API. Fleet-spec syntax
 *  ('claude-sonnet-5[1m]:high') 404s there, and a 404'd ideator can surface as a
 *  SILENT 'ran/no-ideas' streak, not an error tick — that spec killed all organic
 *  ideation 07-14→07-16 (2.3 days) before EI-13118 caught it.
 *
 *  ⚠ P-020 ("migrate autonomous loop roles to GPT-5.6") CANNOT apply to scout yet:
 *  the production codex credential is a ChatGPT subscription, and its backend
 *  rejects gpt-5.6 outright — `codex exec -m gpt-5.6` → 400 "The 'gpt-5.6' model
 *  is not supported when using Codex with a ChatGPT account" (probed live
 *  2026-07-16). With gpt-5.6 here, resolveScoutModel's codex→claude swap is a
 *  self-swap no-op (the "claude" anchor IS the codex model) and every ideator
 *  hard-fails. These defaults must stay ANTHROPIC models until the codex
 *  credential supports the P-020 target — re-verify with the probe above before
 *  re-migrating. */
export const DEFAULT_SCOUT_IDEATOR_MODEL = 'claude-opus-5';

/** Owner mandate 2026-08-16 (P-010 blender-loop-repair-and-opus5-xhigh): every scout
 *  role runs claude-opus-5 — Opus 5 has its own rate-limit bucket separate from
 *  Opus 4.x, and effort rides output_config.effort on the calling path, never a
 *  model-string suffix (see RAW-id warning above). */
export const DEFAULT_SCOUT_CRITIC_MODEL = 'claude-opus-5';

export const DEFAULT_SCOUT_RECOMBINE_MODEL = 'claude-opus-5';

export const DEFAULT_SCOUT_REVISION_MODEL = 'claude-opus-5';

export const DEFAULT_SCOUT_EXPERIMENT_MODEL = 'claude-opus-5';

export interface ScoutModelConfig {
  ideator: string;
  critic: string;
  recombine: string;
  revision: string;
  experiment: string;
}

export const DEFAULT_SCOUT_MODELS: ScoutModelConfig = {
  ideator: DEFAULT_SCOUT_IDEATOR_MODEL,
  critic: DEFAULT_SCOUT_CRITIC_MODEL,
  recombine: DEFAULT_SCOUT_RECOMBINE_MODEL,
  revision: DEFAULT_SCOUT_REVISION_MODEL,
  experiment: DEFAULT_SCOUT_EXPERIMENT_MODEL,
};
