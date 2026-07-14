/**
 * Scout LLM model defaults and the per-blueprint override shape.
 *
 * Kept in one small module so config.ts can build its defaults from the same constants
 * the step implementations use, without importing the heavier step modules.
 */

/** Owner directive: keep every autonomous loop role on the shared sonnet lane. */
export const DEFAULT_SCOUT_IDEATOR_MODEL = 'claude-sonnet-5[1m]:high';

/** Cheap by default: deterministic novelty already does the load-bearing dedup. */
export const DEFAULT_SCOUT_CRITIC_MODEL = 'claude-haiku-4-5';

/** Synthesis-tier by default: turns survivors into bettable proposals. */
export const DEFAULT_SCOUT_RECOMBINE_MODEL = 'claude-sonnet-4-6';

/** Synthesis-tier by default: rewrites an existing draft from Queen feedback. */
export const DEFAULT_SCOUT_REVISION_MODEL = 'claude-sonnet-4-6';

/** Synthesis-tier by default: sharpens a proposal into a replay experiment request. */
export const DEFAULT_SCOUT_EXPERIMENT_MODEL = 'claude-sonnet-4-6';

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
