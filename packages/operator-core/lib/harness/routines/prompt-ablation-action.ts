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
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import type { GovernorVerdict } from '../../learning-governor/core';
import { recordLearningSpend } from '../../learning-governor/store';
import { promptAblationGovernorGate, PROMPT_ABLATION_LOOP_ID } from '../../ablation/governor';
import { makeAblationReplayLeg } from '../../ablation/replay-leg';
import {
  runAblationCycle,
  type AblationCycleConfig,
  type AblationCycleDeps,
  type AblationCycleResult,
} from '../../ablation/runner';

/** The cycle-runner seam — injectable for tests (mirrors setNegativeSpaceTickDeps). */
export type PromptAblationCycleRunner = (
  cfg: AblationCycleConfig,
  deps: AblationCycleDeps,
) => Promise<AblationCycleResult>;
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
export type PromptAblationSpendRecorder = (input: {
  workspaceId: string;
  costUsd: number;
  runRef: string;
}) => Promise<void>;
let _recordSpend: PromptAblationSpendRecorder | null = null;
export function setPromptAblationSpendRecorder(rec: PromptAblationSpendRecorder | null): void {
  _recordSpend = rec;
}

function cycleConfigFromPayload(
  workspaceId: string,
  payload: unknown,
  capUsd: number | null,
): AblationCycleConfig {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const cfg: AblationCycleConfig = { workspaceId, maxCycleCostUsd: capUsd };
  if (Array.isArray(p.scenarioIds) && p.scenarioIds.every((s) => typeof s === 'string')) {
    cfg.scenarioIds = p.scenarioIds as string[];
  }
  if (typeof p.repeat === 'number' && Number.isInteger(p.repeat) && p.repeat >= 1 && p.repeat <= 5) {
    cfg.repeat = p.repeat;
  }
  if (typeof p.ruleKey === 'string' && p.ruleKey.trim()) cfg.ruleKey = p.ruleKey.trim();
  if (typeof p.ledgerWindowDays === 'number' && p.ledgerWindowDays > 0) {
    cfg.ledgerWindowDays = p.ledgerWindowDays;
  }
  return cfg;
}

registerSystemAction('prompt-ablation', async (ctx: SystemActionCtx) => {
  if (!(await getFlag(FLAGS.PROMPT_ABLATION, `routine:${ctx.installSlug}`))) {
    console.log(
      '[prompt-ablation] flag papercusp-prompt-ablation is OFF (frontier arming gate, ' +
        'self-learning-frontier P-001) — skipping',
    );
    return;
  }
  const verdict = await (_governorGate ?? promptAblationGovernorGate)(ctx.workspaceId);
  if (!verdict.allow) {
    console.log(
      `[prompt-ablation] learning-governor refused (${verdict.reason}) — skipping ` +
        '(D-004: an unattended frontier loop runs only registered + budgeted)',
    );
    return;
  }
  // per-cycle verdicts report the cap itself in remainingUsd — the hard bound
  // the runner enforces mid-suite.
  const cfg = cycleConfigFromPayload(ctx.workspaceId, ctx.payloadTemplate, verdict.remainingUsd);
  try {
    // The replay-sample leg (FB-06 substrate) is wired HERE, at the boot-path
    // registrar — runAblationCycle's deps carry no production default for it
    // (the default-on-flag-glue-vs-hermetic-unit-tests discipline). It rides
    // the REPLAY loop's own flag + governor budget and degrades to a recorded
    // skip until the replay harness arms at P-001.
    const sql = getOrgPg().sql;
    const result = await (_runner ?? runAblationCycle)(cfg, {
      sql,
      replayLeg: makeAblationReplayLeg({ sql }),
    });
    if (result.costUsd > 0) {
      const record =
        _recordSpend ??
        (async (input: { workspaceId: string; costUsd: number; runRef: string }) => {
          await recordLearningSpend(getOrgPg().sql, {
            workspaceId: input.workspaceId,
            loopId: PROMPT_ABLATION_LOOP_ID,
            costUsd: input.costUsd,
            runRef: input.runRef,
            note: 'shadow-ablation cycle',
            accumulate: true,
          });
        });
      try {
        await record({ workspaceId: ctx.workspaceId, costUsd: result.costUsd, runRef: result.runRowId });
      } catch (e) {
        // Best-effort: the evidence row is already persisted; the ledger hole
        // is logged, never fatal (the registrants.ts contract).
        console.warn(
          '[prompt-ablation] spend ledgering failed (cycle row stands):',
          e instanceof Error ? e.message : e,
        );
      }
    }
    console.log(
      `[prompt-ablation] cycle ${result.runRowId}: '${result.ruleKey}' verdict=${result.score.verdict} ` +
        `cost=$${result.costUsd.toFixed(2)}${result.capped ? ' CAPPED' : ''}`,
    );
  } catch (e) {
    // Never throw from a durable step (replay = a second full-cost cycle).
    console.warn('[prompt-ablation] cycle FAILED:', e instanceof Error ? e.message : e);
  }
});
