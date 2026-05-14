/**
 * Judge-model registry — Plan §6.3.
 *
 * Maps SUT model → judge model so the judge is never the same model
 * as the SUT (self-grading bias). Plan-prescribed default mapping:
 *   SUT = Sonnet → Judge = Opus
 *   SUT = Opus   → Judge = Sonnet (a second-opinion-Opus pass lands
 *                                  via JudgeRubric.criticality='high')
 *   SUT = Haiku  → Judge = Sonnet
 *
 * Per-scenario overrides go through Scenario / RunnerOpts.judgeModel.
 * Env override: LLM_TEST_JUDGE_MODEL — used by CI matrices or local
 * cost-tuning. When set, the env wins.
 */

export interface JudgeRegistryEntry {
  /** Default judge to use against this SUT family. */
  judge: string;
  /** Optional second-opinion judge for criticality='high'. */
  secondOpinion?: string;
}

const SUT_PREFIXES: Array<{ match: RegExp; entry: JudgeRegistryEntry }> = [
  { match: /^claude-opus/i,   entry: { judge: 'claude-sonnet-4-6', secondOpinion: 'claude-opus-4-7' } },
  { match: /^claude-sonnet/i, entry: { judge: 'claude-opus-4-7' } },
  { match: /^claude-haiku/i,  entry: { judge: 'claude-sonnet-4-6' } },
];

/**
 * Resolve the default judge model for a given SUT.
 * Falls back to claude-sonnet-4-6 for unknown SUT families.
 */
export function resolveJudgeModel(sutModel: string): JudgeRegistryEntry {
  for (const row of SUT_PREFIXES) {
    if (row.match.test(sutModel)) return row.entry;
  }
  return { judge: 'claude-sonnet-4-6' };
}

/**
 * True when SUT and judge would produce a self-grading risk.
 * The runner uses this to fix-up defaults; per-scenario explicit
 * overrides are trusted and not second-guessed.
 */
export function isSelfGradingPair(sutModel: string, judgeModel: string): boolean {
  return sutModel === judgeModel;
}
