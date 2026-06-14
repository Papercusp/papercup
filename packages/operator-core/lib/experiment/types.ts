/**
 * The experiment request/result/ctx shapes (`experiment-registry-invocation-api`
 * P-011/P-031). A {@link TestDescriptor}'s `run(request, ctx)` is bound to these:
 * the REQUEST is the common envelope (the arms to compare + a subject-specific
 * payload), the CTX is the operator-bound dep bundle, and the RESULT is the
 * NORMALIZED outcome (per-arm scores + the `compareArms` verdict) the ledger +
 * scoreboard read regardless of which Subject ran.
 */
import type { CompareSelectResult, FidelityTier, JudgeLlmCall } from '@papercusp/eval-battery';
import type { KnobArm } from './knob-space';
import type { ReplayRunner, ReplayStore } from '../replay/types';

/** What a caller asks an experiment to do. `arms` are the variants to compare —
 *  an arm with empty `knobs` is the champion/baseline. `payload` is the
 *  Subject-specific battery input (e.g. `{ cases }` for replay). */
export interface ExperimentRequest {
  /** Groups this invocation's cells/rows. */
  batteryId: string;
  /** The variants to compare (one empty-knobs arm = the baseline anchor). */
  arms: KnobArm[];
  /** Repeats per (arm × case) — the variance sample. */
  repeats: number;
  /** Judge-trace cap handed to the Subject. */
  maxDistillChars?: number;
  /** Spend cap for this run (non-offline tiers; the governor is the upstream gate). */
  budgetUsd?: number;
  /** Subject-specific battery input — each descriptor casts it to its own shape. */
  payload: unknown;
}

/** One arm's normalized outcome. */
export interface ExperimentArmResult {
  id: string;
  label: string;
  /** Mean judge composite over scored cells, or null when none scored. */
  meanScore: number | null;
  cells: number;
  scored: number;
  costUsd: number;
}

/** The normalized result every Subject maps to — the one shape the ledger,
 *  the scoreboard, and Scout meta-learning read. */
export interface ExperimentRunResult {
  testId: string;
  tier: FidelityTier;
  /** The baseline arm's id (the `compareArms` anchor). */
  baselineId: string;
  arms: ExperimentArmResult[];
  /** The baseline-vs-candidates ranking (compareArms), or null. */
  comparison: Omit<CompareSelectResult, 'scenarioId'> | null;
  /** The selected winning arm id (only on a strict improvement ≥ minDelta), else null. */
  winner: string | null;
  totalCostUsd: number;
  budgetExhausted: boolean;
}

/**
 * The operator-bound dep bundle handed to every descriptor's `run`. The
 * `experiment:run` tool builds ONE of these; each descriptor reads the slice it
 * needs. v1 wires the offline (replay) tier; the heavy-tier ports land as they are
 * bound (P-011 follow-on).
 */
export interface ExperimentRunCtx {
  workspaceId: string;
  now(): number;
  /** The frozen judge LLM client (shared across Subjects). */
  llmCall: JudgeLlmCall;
  /** The replay runner — required for the offline (replay) tier. */
  replayRunner?: ReplayRunner;
  /** Optional per-Subject persistence. */
  store?: { replay?: ReplayStore };
  /** Live gym AbDeps (createGymRunnerPorts) — present only when the gym tier is armed.
   *  Absent ⇒ the gym descriptor stays staged (run refuses). */
  gym?: { abDeps?: import('../gym/ab-runner').AbDeps };
  /** Injected for the rate-pause wait (defaults to real setTimeout in the runner). */
  sleep?(ms: number): Promise<void>;
}
