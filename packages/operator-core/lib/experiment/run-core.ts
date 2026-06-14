/**
 * run-core — the pure, injectable core of experiment:run (`experiment-registry-
 * invocation-api` P-031). The tool handler is a thin wrapper; this is unit-tested
 * with fakes ($0).
 *
 * v1 executes the OFFLINE replay tier and rides the existing frontier:replay-harness
 * gates: it routes through `runGovernedReplay`, which preflights the replay flag +
 * the learning-governor budget (refusing — with NO spend — when dark/unbudgeted/
 * exhausted) and ledgers the spend origin='replay'. So this verb inherits the rails
 * rather than re-implementing them (owner choice, 2026-06-14: ride frontier:replay-
 * harness). The live tiers (gym/instance/hive) are staged (P-063).
 *
 * A winning arm is only ever a PROPOSAL — applying it to live prompts/policy rides
 * commit→reproject + the change ledger + trust graduation, never this verb (D-006).
 */
import { BASELINE_ID, requireTest, type TestDescriptor } from '@papercusp/eval-battery';
import { REPLAY_BASELINE_VARIANT, type ReplayBatteryDeps } from '../replay/battery';
import { runGovernedReplay, type ReplayGlueDeps } from '../replay/governed';
import type { ReplayCase, ReplayRunner, ReplayVariant } from '../replay/types';
import { armToReplayVariant, registerExperimentDescriptors, replayResultToExperimentResult } from './descriptors';
import { validateArm } from './knob-space';
import type { ExperimentLedger } from './ledger';
import type { ExperimentRunResult } from './types';

export interface RunExperimentArm {
  id: string;
  label?: string;
  knobs: Record<string, unknown>;
}

/** A synthetic battery case (v1): a constructed context + the task intent the judge
 *  scores against. (Historical replay-by-ref is a follow-on.) */
export interface RunExperimentSyntheticCase {
  caseId: string;
  context: string;
  intent: string;
  projectContext?: string;
}

export interface RunExperimentInput {
  testId: string;
  batteryId: string;
  arms: RunExperimentArm[];
  cases: RunExperimentSyntheticCase[];
  repeats: number;
  budgetUsd?: number;
  maxDistillChars?: number;
}

export interface RunExperimentDeps {
  runGovernedReplay: typeof runGovernedReplay;
  replayRunner: ReplayRunner;
  judge: ReplayBatteryDeps['llmCall'];
  now?: () => number;
  glue?: ReplayGlueDeps;
  /** Cell-lifecycle store. Omit → the governed substrate uses PgReplayStore; an
   *  integration test (or a future ledger writer) injects its own. */
  store?: ReplayBatteryDeps['store'];
  /** The experiment ledger (P-050). When present, a finished run writes its
   *  run-level summary row (best-effort — a ledger failure never loses the result). */
  ledger?: ExperimentLedger;
}

export interface RunExperimentOutcome {
  ok: boolean;
  /** Set when the governed substrate refused (flag off / governor unbudgeted /
   *  exhausted) — a refusal NEVER spends. */
  refused?: { reason?: string };
  error?: string;
  result?: ExperimentRunResult;
}

export async function runExperiment(
  input: RunExperimentInput,
  ctx: { workspaceId: string },
  deps: RunExperimentDeps,
): Promise<RunExperimentOutcome> {
  registerExperimentDescriptors();

  let descriptor: TestDescriptor;
  try {
    descriptor = requireTest(input.testId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // v1: only the offline (replay) tier is executable; the live tiers are staged (P-063).
  if (descriptor.fidelityTier !== 'offline') {
    return {
      ok: false,
      error: `the "${input.testId}" test (${descriptor.fidelityTier} tier) is registered but not yet executable — offline replay is the only wired tier (D-004); live binding is P-063.`,
    };
  }

  // Slice + safety check BEFORE any spend (P-021).
  for (const arm of input.arms) {
    const v = validateArm({ id: arm.id, knobs: arm.knobs }, descriptor.knobSlice);
    if (!v.ok) {
      const bad = [...v.outOfSlice, ...v.excluded.map((x) => `${x} (safety-excluded)`)].join(', ');
      return { ok: false, error: `arm "${arm.id}" has knobs outside the "${input.testId}" slice: ${bad}` };
    }
  }

  const variants: ReplayVariant[] = input.arms.map((a) =>
    armToReplayVariant({ id: a.id, ...(a.label !== undefined ? { label: a.label } : {}), knobs: a.knobs }),
  );
  // compareArms needs the baseline anchor — prepend it when the caller gave only candidates.
  if (!variants.some((v) => v.variantId === BASELINE_ID)) variants.unshift(REPLAY_BASELINE_VARIANT);

  const cases: ReplayCase[] = input.cases.map((c) => ({
    kind: 'synthetic',
    caseId: c.caseId,
    context: c.context,
    intent: c.intent,
    ...(c.projectContext !== undefined ? { projectContext: c.projectContext } : {}),
  }));

  const { verdict, result } = await deps.runGovernedReplay(
    {
      workspaceId: ctx.workspaceId,
      config: {
        batteryId: input.batteryId,
        variants,
        cases,
        repeats: input.repeats,
        ...(input.budgetUsd !== undefined ? { maxSpendUsd: input.budgetUsd } : {}),
        ...(input.maxDistillChars !== undefined ? { maxDistillChars: input.maxDistillChars } : {}),
      },
    },
    {
      runner: deps.replayRunner,
      llmCall: deps.judge,
      now: deps.now ?? (() => Date.now()),
      ...(deps.store ? { store: deps.store } : {}),
    },
    deps.glue,
  );

  if (!result) return { ok: false, refused: { reason: verdict.reason } };

  const normalized = replayResultToExperimentResult(result);
  if (deps.ledger) {
    try {
      await deps.ledger.record({
        workspaceId: ctx.workspaceId,
        batteryId: input.batteryId,
        testId: normalized.testId,
        tier: normalized.tier,
        arms: normalized.arms,
        baselineId: normalized.baselineId,
        winner: normalized.winner,
        comparison: normalized.comparison,
        totalCostUsd: normalized.totalCostUsd,
        budgetExhausted: normalized.budgetExhausted,
      });
    } catch {
      // Best-effort: never lose a finished experiment result to a ledger write.
    }
  }
  return { ok: true, result: normalized };
}
