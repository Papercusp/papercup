/**
 * The LLM scenario battery on the verification-harness contract (EVL P-006, R-11).
 *
 * Every scenario in a `llm-test` run is one phase. Behavioral failures do not abort other
 * scenarios. With transport diagnostics, the first scenario for each target/transport is a
 * prerequisite: an unrecovered provider-auth failure blocks dependent model calls.
 * Running it through the contract adds what a re-run needs: a structured per-scenario
 * result {phase, status, reasonCode, evidenceDir}, one retained evidence dir per run with a
 * greppable HARNESS_RESULT line naming the first failure, and `--parallel` as the contract's
 * bounded concurrency instead of hand-rolled batches.
 */
import {
  defaultEvidenceRoot,
  formatSummaryLine,
  type HarnessContract,
  type HarnessRunResult,
  type PhaseOutcome,
  runHarness,
} from '@papercusp/verification-harness';
import type { ScenarioOutcome } from './run-exit-code';
import type { LlmCallDiagnostic } from '@papercusp/testing-shell/llm';

export const LLM_BATTERY_HARNESS = 'llm-scenario-battery';

/** `LLM_TEST_EVIDENCE_ROOT` wins; otherwise the shared verification-harness default root. */
export function llmBatteryEvidenceRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.LLM_TEST_EVIDENCE_ROOT?.trim() || defaultEvidenceRoot(LLM_BATTERY_HARNESS, env);
}

export interface BatteryScenario {
  id: string;
  target: string;
  description: string;
  transport?: string;
}

/** A recovered pool attempt is healthy; only a call's last HTTP response counts. */
export function providerAuthFailure(diagnostics: readonly LlmCallDiagnostic[]): LlmCallDiagnostic | undefined {
  const lastResponses = new Map<string, LlmCallDiagnostic>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.phase === 'response' && diagnostic.status !== null) {
      lastResponses.set(diagnostic.callId, diagnostic);
    }
  }
  return [...lastResponses.values()].find(diagnostic => diagnostic.status === 401 || diagnostic.status === 403);
}

export function llmBatteryContract(scenarios: readonly BatteryScenario[]): HarnessContract {
  return {
    name: LLM_BATTERY_HARNESS,
    phases: scenarios.map((s) => ({ id: s.id, description: `[${s.target}] ${s.description.slice(0, 160)}` })),
  };
}

/** A scenario that measured nothing (claim busy) is not a pass: the phase fails with that reason. */
export function scenarioPhaseOutcome(outcome: ScenarioOutcome): PhaseOutcome {
  if (outcome === 'executed') return { ok: true };
  if (outcome === 'skipped') return { ok: false, reasonCode: 'claim-busy', step: 'claim' };
  return { ok: false, reasonCode: 'scenario-failed', step: 'run-scenario' };
}

export async function runScenarioBattery<S extends BatteryScenario>(args: {
  scenarios: readonly S[];
  concurrency: number;
  /** Runs one scenario; `evidenceDir` is that scenario's own phase dir in this run. */
  runScenario: (scenario: S, evidenceDir: string) => Promise<ScenarioOutcome>;
  /** Actual production-call diagnostics, including calls from a runner that throws. */
  transportDiagnostics?: (scenario: S) => readonly LlmCallDiagnostic[];
  evidenceRoot?: string;
}): Promise<{ outcomes: ScenarioOutcome[]; harness: HarnessRunResult; summaryLine: string }> {
  const byId = new Map(args.scenarios.map((s) => [s.id, s]));
  const outcomeOf = new Map<string, ScenarioOutcome>();
  const groupOf = (scenario: S) => JSON.stringify([scenario.target, scenario.transport ?? 'http-sse']);
  const groups = new Map<string, {
    first: string;
    ready: Promise<void>;
    release: () => void;
    failure?: { scenarioId: string; diagnostic: LlmCallDiagnostic };
  }>();
  if (args.transportDiagnostics) {
    for (const scenario of args.scenarios) {
      const key = groupOf(scenario);
      if (groups.has(key)) continue;
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      groups.set(key, { first: scenario.id, ready, release });
    }
  }
  const harness = await runHarness({
    contract: llmBatteryContract(args.scenarios),
    evidenceRoot: args.evidenceRoot ?? llmBatteryEvidenceRoot(),
    // Preserve original diagnostics before retention can evict completed runs,
    // including failed provider attempts that remain evidence for open work.
    // One bounded selector covers the declared population, including batteries
    // larger than the harness's selector limit, without sweeping unrelated files.
    retainedArtifacts: ['phases/*/report-summary.json'],
    concurrency: args.concurrency,
    runPhase: async (ctx) => {
      const scenario = byId.get(ctx.phase)!;
      const group = groups.get(groupOf(scenario));
      if (group && scenario.id !== group.first) await group.ready;
      if (group?.failure) {
        // Keep the original response and the prerequisite identity in each blocked
        // phase. These phases measured no product behavior and must never pass.
        const { writeFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        writeFileSync(join(ctx.evidenceDir, 'report-summary.json'), `${JSON.stringify({
          scenarioId: scenario.id, verdict: 'blocked', reasonCode: 'provider-auth-unavailable',
          prerequisiteScenarioId: group.failure.scenarioId,
          transportDiagnostic: group.failure.diagnostic,
        })}\n`);
        outcomeOf.set(scenario.id, 'failed');
        return { ok: false, reasonCode: 'provider-auth-unavailable', step: 'transport-prerequisite' };
      }
      ctx.markStep('run-scenario');
      let outcome: ScenarioOutcome = 'failed';
      try {
        outcome = await args.runScenario(scenario, ctx.evidenceDir);
        outcomeOf.set(ctx.phase, outcome);
        return scenarioPhaseOutcome(outcome);
      } finally {
        if (group) {
          try {
            const diagnostic = outcome === 'failed' ? providerAuthFailure(args.transportDiagnostics!(scenario)) : undefined;
            if (diagnostic) group.failure = { scenarioId: scenario.id, diagnostic };
          } finally {
            if (scenario.id === group.first) group.release();
          }
        }
      }
    },
  });
  // A scenario whose runner threw never reported an outcome: that is a failure, never a pass.
  const outcomes = args.scenarios.map((s) => outcomeOf.get(s.id) ?? 'failed');
  return { outcomes, harness, summaryLine: formatSummaryLine(harness) };
}
