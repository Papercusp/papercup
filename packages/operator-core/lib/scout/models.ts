/**
 * Scout LLM model defaults and the per-blueprint override shape.
 *
 * Kept in one small module so config.ts can build its defaults from the same constants
 * the step implementations use, without importing the heavier step modules.
 */

/** Owner directive: migrate every autonomous loop role to GPT-5.6 Lua (P-020).
 *  ⚠ RAW API model id ONLY — the scout stateless path (llm-testing/llm-client →
 *  anthropic-direct) passes this string verbatim to the API. Fleet-spec syntax
 *  ('claude-sonnet-5[1m]:high', 'chatgpt:5.5') 404s there, and a 404'd ideator
 *  can surface as a SILENT 'ran/no-ideas' streak, not an error tick — that spec
 *  killed all organic ideation 07-14→07-16 (2.3 days) before EI-13118 caught it. 
 *  The Codex model id is `gpt-5.6`; this routes through the Codex backend. */
export const DEFAULT_SCOUT_IDEATOR_MODEL = 'gpt-5.6';

/** GPT-5.6 Lua for autonomous loop roles (P-020). */
export const DEFAULT_SCOUT_CRITIC_MODEL = 'gpt-5.6';

/** Synthesis-tier: GPT-5.6 Lua for autonomous loop roles (P-020). */
export const DEFAULT_SCOUT_RECOMBINE_MODEL = 'gpt-5.6';

/** Synthesis-tier: GPT-5.6 Lua for autonomous loop roles (P-020). */
export const DEFAULT_SCOUT_REVISION_MODEL = 'gpt-5.6';

/** Synthesis-tier: GPT-5.6 Lua for autonomous loop roles (P-020). */
export const DEFAULT_SCOUT_EXPERIMENT_MODEL = 'gpt-5.6';

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
