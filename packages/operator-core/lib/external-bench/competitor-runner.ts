/**
 * Competitor-orchestrator OVER-BACKLOG runner (impartial-benchmark-suite-2026-06-15 P-028, D-010).
 *
 * The "vs other multi-agent systems" fleet arm: hand the SAME backlog to an external orchestrator
 * (OpenHands-async / CrewAI / LangGraph / opt. ROMA — see competitor-registry.ts), drain it, and produce
 *   • one {@link ArmAttempt} per task (arm = the competitor id) → the SHARED grader + run_result row, and
 *   • one MAST-convertible {@link CompetitorCoordinationTrace} for the whole drain → the L4 claim.
 * It is the structural twin of the `hive` arm (P-022) and `queen-ablated` (P-023): same backlog in, same
 * per-task ArmAttempt[] + fleet telemetry + coordination trace out, so "our coordination beats theirs"
 * (MAST failure rates vs the published 41–86% MAS baseline) is measured identically across arms.
 *
 * MAST (arXiv 2503.13657; P-029 hive-instrument-feasibility-2026-06-15.md, D-011): coordination quality is
 * graded by an LLM-judge / the published 14-mode rubric over a trace of fleet/coordination EVENTS, bucketed
 * into MAST's 3 categories (system-design, inter-agent misalignment, task verification). P-010 (su-66ad9)
 * owns the canonical MAST-convertible trace shape + emission; P-026 (su-4ac61) owns the rate computation.
 * The {@link CompetitorCoordinationTrace} here is the agreed-shape PROPOSAL aligned to those — RECONCILE to
 * P-010's canonical `CoordinationEvent`/trace type when it lands (import it, drop this).
 *
 * STAGING (the wave's discipline): running real OpenHands/CrewAI/LangGraph spends real model budget + needs
 * those Python stacks + Docker, so — exactly like `instantiateBenchHarness` (run-loop.ts) and the native arm
 * — the LIVE per-competitor drivers are bound at PILOT time (P-032) via {@link setCompetitorDriver}. Unbound,
 * the runner returns infra-error attempts (`stopReason:'error'`, excluded from accuracy, never scored as a
 * task failure — METR discipline) and an empty trace; it NEVER throws. Unit-tested with a fake driver.
 */
import {
  diffSubmission,
  type ArmAttempt,
  type BenchTask,
  type GenerationBudget,
  type GenerationPorts,
} from './types';
import { gradeAndEmitBatch, type AdapterRowResult, type BatchContext, type EmitRollout, seedPrefix } from './adapter';
import type { OfficialGrader } from './types';
import { type CompetitorArmId, isCompetitorArmId } from './competitor-registry';

/* -------------------------------------------------------------------------- */
/* MAST-convertible coordination trace (PROPOSAL — reconcile to P-010/P-026)   */
/* -------------------------------------------------------------------------- */

/** MAST's 3 failure categories (arXiv 2503.13657, §taxonomy). The judge buckets the 14 modes into these. */
export type MastCategory = 'system-design' | 'inter-agent-misalignment' | 'task-verification';

/** One observed fleet/coordination event — the substrate the MAST judge reads. */
export interface CoordinationEvent {
  /** ms offset from the backlog-drain start (monotonic; keeps the trace clock-portable). */
  ts: number;
  kind: 'spawn' | 'delegate' | 'handoff' | 'message' | 'claim' | 'edit' | 'verify' | 'complete' | 'error';
  /** The acting agent/role id within the orchestrator (e.g. 'planner', 'worker-2', 'supervisor'). */
  agent: string;
  /** The backlog task this event pertains to, if any. */
  taskId?: string;
  detail?: string;
}

/**
 * The coordination trace for ONE competitor's whole backlog drain. The EVENTS are the authority (P-026's
 * judge derives MAST rates from them); `mastSignals` is an OPTIONAL driver-side pre-tally (counts per MAST
 * category) for arms that already classify — never a substitute for the judge.
 */
export interface CompetitorCoordinationTrace {
  competitorId: CompetitorArmId;
  /** Distinct agents/roles observed across the drain. */
  agents: number;
  events: CoordinationEvent[];
  mastSignals?: Partial<Record<MastCategory, number>>;
}

/** Fleet-level telemetry for a whole backlog drain (the L2 throughput axis; P-025 consumes it). */
export interface FleetTelemetry {
  /** Wall-clock to drain the entire backlog (the speedup numerator vs serial). */
  wallClockMs: number;
  /** SUM of every agent + turn across every task (coordination overhead counted — fairness #2). */
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Tasks the orchestrator produced a submission for (a diff, empty or not). */
  tasksAttempted: number;
  /** Did the drain hit the backlog-level iso-budget cap? */
  capped: boolean;
}

/* -------------------------------------------------------------------------- */
/* The over-backlog request / result + the driver seam                         */
/* -------------------------------------------------------------------------- */

export interface CompetitorBacklogRequest {
  competitorId: CompetitorArmId;
  /**
   * The WHOLE backlog handed to the orchestrator at once (over-backlog framing — the orchestrator does its
   * own placement/ordering, which is exactly what MAST measures). Accepts the shared {@link BenchTask}.
   * RECONCILE: if P-022 (su-1226c) lands a `BenchBacklog` type, swap this field for it.
   */
  tasks: readonly BenchTask[];
  /** TOTAL iso-budget for the whole drain (the fleet-level cap; the driver allocates across tasks). */
  budget: GenerationBudget;
}

export interface CompetitorBacklogRun {
  competitorId: CompetitorArmId;
  /** One per task (arm = competitorId); costs SUM within `budget`. Order/coverage need not match input. */
  attempts: ArmAttempt[];
  trace: CompetitorCoordinationTrace;
  fleet: FleetTelemetry;
}

/**
 * The LIVE per-competitor driver — bound at pilot time (P-032). One method, the whole over-backlog lifecycle:
 * clone each task (via `ports.clone`), run the external orchestrator over the backlog, collect a diff per
 * task + the agent-event log, extract diffs (via `ports.extractDiff` or the orchestrator's native diff),
 * sum cost, and return per-task {@link ArmAttempt}s + the {@link CompetitorCoordinationTrace} + fleet telemetry.
 * The pilot composes it per framework (OpenHands python entrypoint / a CrewAI crew / a LangGraph graph — see
 * competitor-registry.ts `invocation`).
 */
export interface CompetitorOrchestratorDriver {
  runBacklog(req: CompetitorBacklogRequest, ports: GenerationPorts): Promise<CompetitorBacklogRun>;
}

/** Process-local driver bindings (the DI seam, mirroring run-loop.ts's `_driver`). NOT durable state. */
const _drivers = new Map<CompetitorArmId, CompetitorOrchestratorDriver>();

/** Bind (or, with `null`, unbind) the live driver for one competitor. The pilot binds; tests bind a fake. */
export function setCompetitorDriver(id: CompetitorArmId, driver: CompetitorOrchestratorDriver | null): void {
  if (driver) _drivers.set(id, driver);
  else _drivers.delete(id);
}

/** Test-teardown helper: drop every bound driver. */
export function clearCompetitorDrivers(): void {
  _drivers.clear();
}

/** An infra-error ArmAttempt for one task (no spend; excluded from accuracy, never scored as a fail). */
function infraErrorAttempt(competitorId: string, task: BenchTask, seed: string, generationError: string): ArmAttempt {
  return {
    arm: competitorId,
    blueprintId: competitorId,
    instanceId: task.instanceId,
    seed,
    diff: '',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    turns: 0,
    wallClockMs: 0,
    trajectoryRef: '',
    stopReason: 'error',
    generationError,
  };
}

function emptyTrace(competitorId: CompetitorArmId): CompetitorCoordinationTrace {
  return { competitorId, agents: 0, events: [] };
}

/**
 * Drain a backlog with a competitor orchestrator. Delegates to the bound {@link CompetitorOrchestratorDriver};
 * an unbound/throwing driver yields infra-error attempts (one per task) + an empty trace + zeroed fleet —
 * NEVER throws (the generation-failure contract the pilot relies on, mirroring `instantiateBenchHarness`).
 *
 * @param seedIndex reproducibility seed ordinal for this drain (≥3 distinct per arm for pass@1).
 */
export async function runCompetitorBacklog(
  req: CompetitorBacklogRequest,
  ports: GenerationPorts,
  seedIndex = 0,
): Promise<CompetitorBacklogRun> {
  const { competitorId, tasks } = req;
  const seed = seedPrefix(seedIndex);

  if (!isCompetitorArmId(competitorId)) {
    return {
      competitorId,
      attempts: tasks.map((t) => infraErrorAttempt(competitorId, t, seed, `unknown competitor '${competitorId}'`)),
      trace: emptyTrace(competitorId),
      fleet: zeroFleet(tasks.length),
    };
  }

  const driver = _drivers.get(competitorId);
  if (!driver) {
    return {
      competitorId,
      attempts: tasks.map((t) =>
        infraErrorAttempt(
          competitorId,
          t,
          seed,
          `competitor driver '${competitorId}' not bound — setCompetitorDriver() is wired at pilot time (P-032 / impartial-benchmark-suite-2026-06-15)`,
        ),
      ),
      trace: emptyTrace(competitorId),
      fleet: zeroFleet(tasks.length),
    };
  }

  try {
    return await driver.runBacklog(req, ports);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      competitorId,
      attempts: tasks.map((t) => infraErrorAttempt(competitorId, t, seed, `competitor drain failed: ${msg}`)),
      trace: emptyTrace(competitorId),
      fleet: zeroFleet(tasks.length),
    };
  }
}

function zeroFleet(tasksAttempted: number): FleetTelemetry {
  return { wallClockMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, tasksAttempted, capped: false };
}

/** Derive fleet telemetry from per-task attempts (the SUMMED cost — coordination overhead counted). */
export function summarizeFleet(attempts: readonly ArmAttempt[], opts: { capped?: boolean } = {}): FleetTelemetry {
  return {
    wallClockMs: attempts.reduce((m, a) => Math.max(m, a.wallClockMs), 0),
    tokensIn: attempts.reduce((s, a) => s + a.tokensIn, 0),
    tokensOut: attempts.reduce((s, a) => s + a.tokensOut, 0),
    costUsd: attempts.reduce((s, a) => s + a.costUsd, 0),
    tasksAttempted: attempts.length,
    capped: opts.capped ?? attempts.some((a) => a.stopReason === 'budget-exhausted'),
  };
}

/* -------------------------------------------------------------------------- */
/* Drain → grade → emit (wires into the SHARED, locked adapter)                */
/* -------------------------------------------------------------------------- */

export interface CompetitorBacklogResult {
  competitorId: CompetitorArmId;
  /** Per-task graded + emitted rows (via the shared `gradeAndEmitBatch` — identical grading to every arm). */
  rows: AdapterRowResult[];
  trace: CompetitorCoordinationTrace;
  fleet: FleetTelemetry;
}

/**
 * The end-to-end P-028 unit: drain the backlog with a competitor, then grade + emit every per-task attempt
 * through the SAME `gradeAndEmitBatch` every other arm uses (so grading is byte-identical, the fairness
 * invariant), and return the rows + the coordination trace (for P-026's MAST) + fleet telemetry (for P-025).
 * Infra-failed attempts flow through as skipped/null rows — never scored as task failures.
 */
export async function runAndGradeCompetitorBacklog(
  req: CompetitorBacklogRequest,
  ports: GenerationPorts,
  grader: OfficialGrader,
  emit: EmitRollout,
  ctx: BatchContext & { seedIndex: number },
): Promise<CompetitorBacklogResult> {
  const run = await runCompetitorBacklog(req, ports, ctx.seedIndex);
  const taskById = new Map(req.tasks.map((t) => [t.instanceId, t]));
  const entries = run.attempts
    .map((attempt) => {
      const task = taskById.get(attempt.instanceId);
      return task ? { attempt, task, seedIndex: ctx.seedIndex } : null;
    })
    .filter((e): e is { attempt: ArmAttempt; task: BenchTask; seedIndex: number } => e !== null);

  const rows = await gradeAndEmitBatch(entries, grader, emit, ctx);
  return { competitorId: run.competitorId, rows, trace: run.trace, fleet: run.fleet };
}

/** Re-export the predictions-record builder so a live driver can shape submissions identically to other arms. */
export { diffSubmission };
