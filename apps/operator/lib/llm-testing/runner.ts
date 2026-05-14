/**
 * Runner — orchestrates Scenario × Persona → SUT → Judge.
 *
 * Plan §3.4. Single run:
 *   1. target.open() → session
 *   2. simUser.nextAction(history) → text | choice | give_up | declare_success
 *   3. session.send(turnInput) → TurnResult (one assistant turn)
 *   4. apply post-turn triggers (auto-fire, silence-nudge)
 *   5. check goal / caps
 *   6. evaluate deterministic asserts + run judge
 *   7. persist RunSummary
 *
 * runMatrix: scenario declares N runs; each gets its own matrix_index.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { evaluateAsserts } from './asserts/index';
import { computeIdentityHash, computeScenarioHash } from './identity';
import { judgeRun } from './judge';
import { lookupBlend } from './personas/blends';
import { resolvePersona } from './personas/traits';
import { SimUser, type SimAction } from './sim-user';
import { getTarget } from './targets/index';
import { pullToolInvocations, pullContinueChainRows } from './telemetry';
import type {
  CardEvent,
  ChatSession,
  Persona,
  RunSummary,
  Scenario,
  TurnInput,
  TurnResult,
  TurnTrigger,
  Violation,
} from './types';

export interface RunnerOpts {
  /** Override SUT model — defaults to env or scenario default. */
  sutModel?: string;
  /** Override judge model — see §6.3 (must differ from SUT). */
  judgeModel?: string;
  /** Override sim-user model — defaults to Haiku per plan §9. */
  simModel?: string;
  /** Force matrix repeat count (CLI --no-matrix uses 1). */
  forceRepeat?: number;
  /** Seed for deterministic sampling (sim temp, judge temp 0). */
  seed?: number;
  /** Path to scenario source file (for hashing). Optional but recommended. */
  scenarioFilePath?: string;
}

export interface RunReport {
  scenarioId: string;
  matrixGroupId?: string;
  runs: SingleRunReport[];
  /** Aggregate verdict across the matrix. */
  verdict: 'pass' | 'fail' | 'preview' | 'errored';
  /** Variance per axis across the matrix (stddev). */
  varianceByAxis: Record<string, number>;
  /** Variance-policy findings (e.g. 'inconsistent_behavior'). */
  varianceFindings: Violation[];
}

export interface SingleRunReport {
  summary: RunSummary;
  violations: Violation[];
  judge: import('./types').JudgeResult;
  status: 'passed' | 'failed' | 'errored';
}

const DEFAULTS = {
  sutModel:   process.env.LLM_TEST_SUT_MODEL   ?? 'claude-sonnet-4-6',
  judgeModel: process.env.LLM_TEST_JUDGE_MODEL ?? 'claude-sonnet-4-6',
  simModel:   process.env.LLM_TEST_SIM_MODEL   ?? 'claude-haiku-4-5',
};

export async function runScenario(scenario: Scenario, opts: RunnerOpts = {}): Promise<RunReport> {
  const sutModel = opts.sutModel ?? DEFAULTS.sutModel;
  const judgeModel = opts.judgeModel ?? DEFAULTS.judgeModel;
  const simModel = opts.simModel ?? DEFAULTS.simModel;

  if (sutModel === judgeModel) {
    console.warn(
      `[llm-testing] SUT model === judge model (${sutModel}). Plan §6.3 recommends they differ to avoid self-grading bias.`,
    );
  }

  const persona = resolvePersona(scenario.persona, lookupBlend);
  const scenarioHash = readScenarioHash(opts.scenarioFilePath);
  const matrixRepeat = opts.forceRepeat ?? scenario.runMatrix?.repeat ?? 1;
  const matrixGroupId = matrixRepeat > 1 ? randomUUID() : undefined;

  const runs: SingleRunReport[] = [];
  for (let i = 0; i < matrixRepeat; i++) {
    const report = await runOnce({
      scenario,
      persona,
      scenarioHash,
      sutModel,
      judgeModel,
      simModel,
      matrixGroupId,
      matrixIndex: matrixGroupId ? i : undefined,
    });
    runs.push(report);
  }

  return aggregate(scenario, matrixGroupId, runs);
}

interface OnceArgs {
  scenario: Scenario;
  persona: Persona;
  scenarioHash: string;
  sutModel: string;
  judgeModel: string;
  simModel: string;
  matrixGroupId?: string;
  matrixIndex?: number;
}

async function runOnce(args: OnceArgs): Promise<SingleRunReport> {
  const { scenario, persona, scenarioHash, sutModel, judgeModel, simModel } = args;
  const runId = randomUUID();

  const identityHash = computeIdentityHash({
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    scenarioHash,
    personaId: persona.id,
    personaTraits: persona.traits,
    rubricVersion: scenario.rubric.version,
    sutModel,
    judgeModel,
  });

  const target = getTarget(scenario.target);
  const session = await target.open({
    runId,
    workspaceMode: scenario.realWorkspace ? 'real' : 'isolated',
    transport: scenario.transport ?? 'http-sse',
    dispatchOverride: scenario.toolOverride,
  });

  const simUser = new SimUser({
    persona,
    goal: scenario.goal,
    model: simModel,
  });

  const startedAt = new Date();
  const turns: TurnResult[] = [];
  const simHistory: Array<
    | { who: 'sim'; action: SimAction }
    | { who: 'sut'; turn: TurnResult }
  > = [];
  const wireMessages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
  const capBreaches: string[] = [];

  const maxTurns = scenario.caps.maxTurns;
  const maxWallSecs = scenario.caps.maxWallSecs;
  const maxCostUsd = scenario.caps.maxCostUsd;
  const wallDeadlineMs = startedAt.getTime() + maxWallSecs * 1000;

  let totalCostUsd = 0;
  let finishReason: RunSummary['finishReason'] = 'completed';
  let openCards: CardEvent[] = [];
  let pendingTrigger: TurnTrigger | null = null;

  // Scenario-declared scripted triggers (§ScenarioTrigger).
  // `on: 'after_turn'` with `param: N` fires the trigger right before
  // turn N (0-indexed). Used by S09 to inject `generate_ideas` as the
  // first turn before sim-user gets a say. Consumed once per match.
  const scriptedTriggers = new Map<number, TurnTrigger>();
  for (const t of scenario.triggers ?? []) {
    if (t.on === 'after_turn' && typeof t.param === 'number') {
      scriptedTriggers.set(t.param, t.fire);
    }
  }

  try {
    for (let turnIdx = 0; turnIdx < maxTurns; turnIdx++) {
      if (Date.now() > wallDeadlineMs) {
        capBreaches.push('wallclock');
        finishReason = 'cap_breach';
        break;
      }
      if (totalCostUsd > maxCostUsd) {
        capBreaches.push('cost');
        finishReason = 'cap_breach';
        break;
      }

      let trigger: TurnTrigger;
      let turnMeta: Record<string, unknown> = { modality: persona.traits.modality };

      const scripted = scriptedTriggers.get(turnIdx);
      if (scripted) {
        trigger = scripted;
        scriptedTriggers.delete(turnIdx);
      } else if (pendingTrigger) {
        trigger = pendingTrigger;
        pendingTrigger = null;
      } else {
        // Ask sim-user what to do.
        const action = await simUser.nextAction({
          history: simHistory,
          cards: openCards,
          turnsRemaining: maxTurns - turnIdx,
        });
        simHistory.push({ who: 'sim', action });

        if (action.kind === 'give_up') {
          finishReason = 'aborted';
          break;
        }
        if (action.kind === 'declare_success') {
          finishReason = 'completed';
          break;
        }

        if (action.kind === 'text') {
          wireMessages.push({ role: 'user', content: action.text });
          trigger = 'user_message';
        } else {
          // choice
          wireMessages.push({
            role: 'user',
            content: `[card ${action.cardId} → ${action.optionId}]${action.freeText ? `: ${action.freeText}` : ''}`,
          });
          trigger = 'user_says_ready';
          turnMeta.cardId = action.cardId;
          turnMeta.optionId = action.optionId;
        }
      }

      // Drive one assistant turn.
      const input: TurnInput = {
        messages: wireMessages.slice(),
        trigger,
        meta: turnMeta,
      };

      const result = await session.send(input);
      turns.push(result);
      simHistory.push({ who: 'sut', turn: result });
      wireMessages.push({ role: 'assistant', content: result.assistantText });
      totalCostUsd += result.costUsd;
      openCards = result.cards;

      if (result.finishReason === 'error') {
        finishReason = 'errored';
        break;
      }

      // Auto-fire heuristic: if the assistant emits a `<continue/>` tag,
      // schedule an auto-fire continue turn. Same for terminal '?'.
      if (result.controlTags.some((c) => c.tag === 'continue')) {
        pendingTrigger = 'continue';
      } else if (endsWithQuestion(result.assistantText)) {
        // The real provider triggers a 'user_says_ready' here in V8 active
        // mode. The runner replicates that for deterministic asserts.
        // Sim-user gets the next say so it can also choose to answer the
        // question directly — we let sim-user run first (no auto-fire here).
      }
    }
    if (finishReason === 'completed' && turns.length === maxTurns) {
      capBreaches.push('turns');
      finishReason = 'cap_breach';
    }
  } finally {
    await session.close();
  }

  const finishedAt = new Date();
  const uiClientId = `llm-testing/${runId}`;
  let toolInvocations: RunSummary['toolInvocations'] = [];
  let continueChainRows: RunSummary['continueChainRows'] = [];
  try {
    [toolInvocations, continueChainRows] = await Promise.all([
      pullToolInvocations(uiClientId),
      pullContinueChainRows(uiClientId),
    ]);
  } catch (err) {
    // Telemetry pull is best-effort — a PG hiccup shouldn't crash the run
    // when we already have the SSE-side data. Asserts that depend on
    // PG rows will surface their own miss; this just records the warning.
    console.warn(`[llm-testing] telemetry pull failed: ${(err as Error).message}`);
  }
  const summary: RunSummary = {
    runId,
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    identityHash,
    matrixGroupId: args.matrixGroupId,
    matrixIndex: args.matrixIndex,
    sutModel,
    judgeModel,
    personaId: persona.id,
    personaTraits: persona.traits,
    workspaceMode: scenario.realWorkspace ? 'real' : 'isolated',
    transportMode: scenario.transport ?? 'http-sse',
    turns,
    toolInvocations,
    continueChainRows,
    totalCostUsd,
    startedAt,
    finishedAt,
    finishReason,
    capBreaches,
  };

  // Deterministic asserts.
  const violations = evaluateAsserts(scenario.asserts, summary);

  // Judge.
  const personaSummary = describePersona(persona);
  const goalSummary = describeGoal(scenario.goal);
  const judge = await judgeRun(
    {
      model: judgeModel,
      rubric: scenario.rubric,
      scenarioId: scenario.id,
      scenarioDescription: scenario.description,
      personaSummary,
      goalSummary,
    },
    summary,
    violations,
  );

  const hasErrorViolation = violations.some((v) => v.severity === 'error');
  const hasErrorFinding = judge.findings.some((f) => f.severity === 'error');
  let status: SingleRunReport['status'] = 'passed';
  if (finishReason === 'errored') status = 'errored';
  else if (hasErrorViolation || hasErrorFinding) status = 'failed';

  return { summary, violations, judge, status };
}

// =============================================================================
// Aggregation across a runMatrix
// =============================================================================

function aggregate(scenario: Scenario, matrixGroupId: string | undefined, runs: SingleRunReport[]): RunReport {
  if (!matrixGroupId || runs.length === 1) {
    const r = runs[0];
    const verdict: RunReport['verdict'] = matrixGroupId === undefined && r
      ? r.status === 'errored' ? 'errored'
        : r.status === 'passed' ? 'preview' // single run = preview per §2.4
          : 'fail'
      : 'errored';
    return { scenarioId: scenario.id, matrixGroupId, runs, verdict, varianceByAxis: {}, varianceFindings: [] };
  }

  // Variance per axis.
  const varianceByAxis: Record<string, number> = {};
  const axes = scenario.rubric.axes;
  for (const axis of axes) {
    const vals = runs.map((r) => r.judge.scores[axis.id] ?? 0);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    varianceByAxis[axis.id] = Math.sqrt(variance);
  }

  const varianceFindings: Violation[] = [];
  const policy = scenario.runMatrix?.variancePolicy ?? 'flag-if-stddev>0.5';
  if (policy === 'flag-if-stddev>0.5') {
    for (const [axis, stddev] of Object.entries(varianceByAxis)) {
      if (stddev > 0.5) {
        varianceFindings.push({
          assertKind: 'inconsistent_behavior',
          severity: 'warn',
          claim: `Score stddev ${stddev.toFixed(2)} on axis '${axis}' across ${runs.length} runs — operator behavior is inconsistent on this scenario.`,
          suggestion: 'Investigate the source of variance; non-determinism in operator behavior is itself a finding.',
        });
      }
    }
  } else if (policy === 'flag-if-disagreement') {
    const statuses = runs.map((r) => r.status);
    if (new Set(statuses).size > 1) {
      varianceFindings.push({
        assertKind: 'inconsistent_behavior',
        severity: 'warn',
        claim: `Status disagreement across ${runs.length} runs: ${statuses.join(', ')}`,
      });
    }
  }

  // Majority verdict.
  const counts = { passed: 0, failed: 0, errored: 0 };
  for (const r of runs) counts[r.status]++;
  let verdict: RunReport['verdict'] = 'fail';
  if (counts.errored > runs.length / 2) verdict = 'errored';
  else if (counts.passed > runs.length / 2) verdict = 'pass';
  else verdict = 'fail';

  return { scenarioId: scenario.id, matrixGroupId, runs, verdict, varianceByAxis, varianceFindings };
}

// =============================================================================
// Helpers
// =============================================================================

function readScenarioHash(filePath: string | undefined): string {
  if (!filePath) return computeScenarioHash('no-file-provided');
  try {
    return computeScenarioHash(readFileSync(filePath, 'utf8'));
  } catch {
    return computeScenarioHash('file-read-failed');
  }
}

function endsWithQuestion(text: string): boolean {
  const trimmed = text.trimEnd();
  return trimmed.endsWith('?');
}

function describePersona(p: Persona): string {
  const t = p.traits;
  return `${p.id}: ${t.verbosity}, ${t.politeness}, ${t.clarification}, ${t.goalClarity}, modality=${t.modality}${t.interrupts ? ', interrupts' : ''}${t.domain ? `, domain=${t.domain}` : ''}`;
}

function describeGoal(g: Scenario['goal']): string {
  switch (g.kind) {
    case 'user_satisfied': return `User-driven satisfaction: the sim-user decides when the goal is reached.`;
    case 'tool_fired': return `Goal: SUT must invoke tool '${g.toolName}'.`;
    case 'card_emitted': return `Goal: SUT must emit a card of kind '${g.cardKind}'.`;
    case 'state_reached': return `Goal: ${g.predicate}`;
  }
}
