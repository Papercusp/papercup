/**
 * The frozen LLM judge runner — the only grader of record (factored out of the gym's
 * `judge.ts` into the shared eval-battery engine, reconciliation D-001).
 *
 * It sits ABOVE a subject's own validator: it does NOT re-check literal spec
 * conformance, but reasons generically over a DISTILLED trace about intent/spec-gaps,
 * code quality, and process correctness, emitting per-dimension scores + a rationale.
 * The weighted composite is the reward.
 *
 * The LLM call is injected ({@link JudgeLlmCall}) so build → call → parse → composite
 * is unit-tested without the network; the wiring passes the real `llmCall`, which
 * routes opus-4-8 with extended thinking through the shared backend.
 */
import { tryParseJson } from './parse-json';
import { composite, parseJudgeOutput, rubricHash, type BatteryRubric, type DimensionWeights } from './scoring';

/** The injected LLM call (structurally the llm-testing `llmCall`). */
export interface JudgeLlmCall {
  (opts: {
    model: string;
    system?: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    responseFormat?: 'text' | 'json';
    thinkingBudgetTokens?: number;
    maxTokens?: number;
  }): Promise<{ text: string; json?: unknown; costUsd: number; inputTokens: number; outputTokens: number }>;
}

export interface JudgeInput {
  /** The high-level intent the work should have achieved. */
  intent: string;
  /** Project context (repo summary) the judge weighs spec-gaps against. */
  projectContext: string;
  /** The distilled trace of the subject's run (judge-sized). */
  distilledTrace: string;
  /** The frozen rubric (model + weights + temp + dimension defs + thinking budget). */
  rubric: BatteryRubric;
}

export interface BatteryScore {
  d1: number;
  d2: number;
  d3: number;
  composite: number;
  rationale: string;
  judgeModel: string;
  rubricHash: string;
  judgeTemp: number;
  weights: DimensionWeights;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export function buildJudgePrompt(input: JudgeInput): { system: string; user: string } {
  const { dimensions } = input.rubric;
  const system = [
    'You are a FROZEN, independent evaluator of a coding harness’s work on one task.',
    'You sit ABOVE the harness’s own validator: do NOT re-check literal spec conformance',
    '(that is the harness’s job). Using your own judgment — not a rigid anchor table —',
    'score each dimension from 0 (worst) to 10 (best):',
    '',
    `D1 — ${dimensions.d1}`,
    `D2 — ${dimensions.d2}`,
    `D3 — ${dimensions.d3}`,
    '',
    'Reason carefully first, then output ONLY a single JSON object (no prose, no code fences):',
    '{"d1": <0-10 number>, "d2": <0-10 number>, "d3": <0-10 number>, "rationale": "<concise justification a prompt-optimizer will reflect on>"}',
  ].join('\n');

  const user = [
    '## Intent',
    input.intent,
    '',
    '## Project context',
    input.projectContext,
    '',
    '## Distilled trace of the harness run',
    input.distilledTrace,
  ].join('\n');

  return { system, user };
}

export async function judgeBatteryRun(input: JudgeInput, deps: { llmCall: JudgeLlmCall }): Promise<BatteryScore> {
  const { rubric } = input;
  const { system, user } = buildJudgePrompt(input);

  const res = await deps.llmCall({
    model: rubric.model,
    system,
    messages: [{ role: 'user', content: user }],
    responseFormat: 'json',
    thinkingBudgetTokens: rubric.thinkingBudgetTokens,
    // Anthropic requires max_tokens > thinking.budget_tokens; leave room for the output.
    maxTokens: rubric.thinkingBudgetTokens + 4096,
  });

  const rawJson = res.json ?? tryParseJson(res.text);
  if (rawJson == null) {
    throw new Error('battery judge produced no parseable JSON output');
  }
  const parsed = parseJudgeOutput(rawJson);

  return {
    d1: parsed.d1,
    d2: parsed.d2,
    d3: parsed.d3,
    composite: composite(parsed, rubric.weights),
    rationale: parsed.rationale,
    judgeModel: rubric.model,
    rubricHash: rubricHash(rubric),
    judgeTemp: rubric.temperature,
    weights: rubric.weights,
    costUsd: res.costUsd,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
  };
}
