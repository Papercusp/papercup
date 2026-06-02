/**
 * Pure scoring cores for the frozen Opus judge (P-008).
 *
 * The judge reads a distilled trace and scores three dimensions with generic,
 * judgment-based reasoning (D-011) — not a rigid anchor table. The weighted
 * `composite` is THE optimization reward. The rubric (model + temperature +
 * weights + dimension definitions) is frozen per optimization run (D-016), and
 * `rubricHash` is the key for re-judge-from-cache (P-010): any change that would
 * change a score changes the hash, so cached scores under an old hash are never
 * silently mixed with a new rubric, and the circuit-breaker's absolute-aggregate
 * comparison stays valid only within one rubric.
 */
import { createHash } from 'node:crypto';

export interface DimensionWeights {
  d1: number;
  d2: number;
  d3: number;
}

export interface JudgeDimensionScores {
  d1: number;
  d2: number;
  d3: number;
}

export interface GymJudgeRubric {
  /** Bump to deliberately invalidate the cache / start a new comparison basis. */
  version: string;
  /** Frozen judge model (D-016). */
  model: string;
  /** Pinned sampling temperature (D-016). Recorded for audit; not sent for opus models. */
  temperature: number;
  /** Extended-thinking budget for the judge ("extra-high thinking"). */
  thinkingBudgetTokens: number;
  /** Frozen dimension weights; composite = weight-normalized aggregate. */
  weights: DimensionWeights;
  /** The dimension definitions the judge reasons against (D1 primary). */
  dimensions: { d1: string; d2: string; d3: string };
}

/** Score range the judge emits per dimension. */
const MIN_SCORE = 0;
const MAX_SCORE = 10;

export const GYM_JUDGE_RUBRIC_V1: GymJudgeRubric = {
  version: 'v1',
  model: 'claude-opus-4-8',
  temperature: 0,
  thinkingBudgetTokens: 32_000,
  // D1 is primary (the layer the harness's own tests don't cover).
  weights: { d1: 0.5, d2: 0.25, d3: 0.25 },
  dimensions: {
    d1:
      'Intent & spec fidelity (PRIMARY): did the work achieve the high-level INTENT, ' +
      'and was the spec itself gappy or misspecified given the project? Judge the layer ' +
      "the harness's own validator/tests do not cover — not literal spec conformance.",
    d2:
      'Code quality (subjective): clarity, minimality, convention-fit, and the absence of ' +
      'needless complexity or tech-debt in the produced diff.',
    d3:
      'Process correctness: did each role behave well — e.g. did the (mutable) validator ' +
      'catch real issues rather than rubber-stamp, did the worker avoid thrash. ' +
      'A quality observation, not a pass/fail gate.',
  },
};

/**
 * Canonical sha256 over everything that would change a score. Built field-by-field
 * in a fixed order so object key ordering of the input never affects the hash.
 */
export function rubricHash(r: GymJudgeRubric): string {
  const payload = JSON.stringify({
    version: r.version,
    model: r.model,
    temperature: r.temperature,
    weights: { d1: r.weights.d1, d2: r.weights.d2, d3: r.weights.d3 },
    dimensions: { d1: r.dimensions.d1, d2: r.dimensions.d2, d3: r.dimensions.d3 },
  });
  return createHash('sha256').update(payload).digest('hex');
}

/** The reward: the weight-normalized aggregate of the three dimension scores. */
export function composite(scores: JudgeDimensionScores, weights: DimensionWeights): number {
  const sum = weights.d1 + weights.d2 + weights.d3;
  if (sum <= 0) throw new Error('composite: weights must sum to a positive number');
  return (scores.d1 * weights.d1 + scores.d2 * weights.d2 + scores.d3 * weights.d3) / sum;
}

export interface ParsedJudgeOutput {
  d1: number;
  d2: number;
  d3: number;
  rationale: string;
}

function clampScore(v: number): number {
  return Math.min(MAX_SCORE, Math.max(MIN_SCORE, v));
}

/** Validate + clamp the judge's structured output. Throws (with the offending field) on garbage. */
export function parseJudgeOutput(raw: unknown): ParsedJudgeOutput {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`judge output must be a JSON object, got: ${typeof raw}`);
  }
  const o = raw as Record<string, unknown>;
  const dims: Array<keyof JudgeDimensionScores> = ['d1', 'd2', 'd3'];
  const scores = {} as JudgeDimensionScores;
  for (const dim of dims) {
    const v = o[dim];
    if (typeof v !== 'number' || Number.isNaN(v)) {
      throw new Error(`judge output dimension "${dim}" must be a number, got: ${JSON.stringify(v)}`);
    }
    scores[dim] = clampScore(v);
  }
  if (typeof o.rationale !== 'string') {
    throw new Error('judge output must include a string "rationale" (the proposer reflects on it)');
  }
  return { ...scores, rationale: o.rationale };
}
