/**
 * Prompt-sedimentology system action (self-learning-frontier-2026-06-12
 * P-023 / FB-09) — `system:prompt-ablation`, the weekly cadence that SHADOW-
 * ablates ONE SU-playbook governance rule and records the behavioral delta
 * (lib/ablation/runner.ts). Live prompts are never mutated; the only writes
 * are evidence rows in harness_shared.prompt_ablation_runs and the governor
 * spend ledger.
 *
 * Gates, in order (the FB-04 negative-space precedent):
 *
 *   - the `papercusp-prompt-ablation` flag, default OFF — the frontier
 *     program's D-001 owner-ratified arming gate. OFF → log + return.
 *   - the learning-governor preflight (D-004 / FB-01, enforcement
 *     'governor'): governor dark / unregistered / unbudgeted / exhausted ⇒
 *     refuse — `lib/ablation/governor.ts`. This loop spends REAL LLM tokens
 *     (SUT + sim + judge across two arms per scenario), so the per-cycle
 *     budget the owner sets at P-001 is a genuine spend bound: the verdict's
 *     remainingUsd is passed to the runner as the hard cycle cap.
 *   - the routine itself is SEEDED INACTIVE
 *     (lib/ablation/seed-prompt-ablation-routine.ts).
 *
 * Payload tuning (payload_template): `scenarioIds` (subset of the su suite),
 * `repeat` (matrix repeat per arm, default 1), `ruleKey` (pin one rule instead
 * of the rotation), `ledgerWindowDays`. Realized spend is ledgered
 * recordLearningSpend(accumulate) — the scout pattern. One durable step,
 * never throws.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import type { GovernorVerdict } from '../../learning-governor/core';
import {
  runPromptAblation,
  type PromptAblationCycleRunner,
  type PromptAblationSpendRecorder,
} from '../../ablation/run';

/**
 * The flag → governor → cap-bound cycle → spend-ledger orchestration this action
 * runs is SHARED with the `prompt:ablation` deterministic blueprint step via
 * `runPromptAblation` (deterministic-blueprints-migration-2026-06-13 P-121 / D-004 —
 * provably behavior-neutral: one gated cycle, two callers). This action keeps its
 * own injectable seams (the test pins them) and passes them into the shared core.
 */

/** The cycle-runner seam — injectable for tests (mirrors setNegativeSpaceTickDeps). */
export type { PromptAblationCycleRunner, PromptAblationSpendRecorder };
let _runner: PromptAblationCycleRunner | null = null;
export function setPromptAblationCycleRunner(runner: PromptAblationCycleRunner | null): void {
  _runner = runner;
}

/** The governor-gate seam — injectable for tests. Pass null to restore the live preflight. */
export type PromptAblationGovernorGate = (workspaceId: string) => Promise<GovernorVerdict>;
let _governorGate: PromptAblationGovernorGate | null = null;
export function setPromptAblationGovernorGate(gate: PromptAblationGovernorGate | null): void {
  _governorGate = gate;
}

/** Spend-ledger seam — injectable for tests. */
let _recordSpend: PromptAblationSpendRecorder | null = null;
export function setPromptAblationSpendRecorder(rec: PromptAblationSpendRecorder | null): void {
  _recordSpend = rec;
}

registerSystemAction('prompt-ablation', async (ctx: SystemActionCtx) => {
  try {
    const outcome = await runPromptAblation(
      { workspaceId: ctx.workspaceId, installSlug: ctx.installSlug, payload: ctx.payloadTemplate },
      {
        governorGate: _governorGate ?? undefined,
        runner: _runner ?? undefined,
        recordSpend: _recordSpend ?? undefined,
      },
    );
    if (!outcome.ran) {
      if (outcome.skipReason === 'flag-off') {
        console.log(
          '[prompt-ablation] flag papercusp-prompt-ablation is OFF (frontier arming gate, ' +
            'self-learning-frontier P-001) — skipping',
        );
      } else {
        console.log(
          `[prompt-ablation] learning-governor refused (${outcome.governorReason}) — skipping ` +
            '(D-004: an unattended frontier loop runs only registered + budgeted)',
        );
      }
      return;
    }
    const result = outcome.result!;
    console.log(
      `[prompt-ablation] cycle ${result.runRowId}: '${result.ruleKey}' verdict=${result.score.verdict} ` +
        `cost=$${result.costUsd.toFixed(2)}${result.capped ? ' CAPPED' : ''}`,
    );
  } catch (e) {
    // Never throw from a durable step (replay = a second full-cost cycle).
    console.warn('[prompt-ablation] cycle FAILED:', e instanceof Error ? e.message : e);
  }
});
