/**
 * P-022 / redirect BRIEF 2 (su-1226c) — the HIVE-OVER-BACKLOG runner: the **'hive' treatment
 * arm** of the reframed suite (D-010). Hand the WHOLE benchmark task SET to a Hive (Queen + bee
 * fleet) as a backlog; the Queen places / ranks / evicts / warm-injects autonomously; each placed
 * task → a bee runs the per-task `external-bench` unit (`instantiateBenchHarness('external-bench',…)`,
 * D-009) to DONE; we collect the raw fleet generation trace. The headline of the reframe: the
 * `hive` arm vs the `queen-ablated` arm (P-023, same fleet + naive FIFO) — the delta IS the Queen's
 * value.
 *
 * ── CONTRACT BOUNDARY (who owns what) ──────────────────────────────────────────────────────────
 * This runner EMITS the raw fleet GENERATION record ({@link HiveBacklogResult}); the DERIVED metrics
 * stay single-owned downstream (same boundary as the L1 row in D-009):
 *   - per-task `resolved` ← BRIEF 3's `OfficialGrader` grading the {@link FleetTaskResult.attempt} diffs.
 *   - throughput / value / autonomy ← P-025 `@papercusp/bench-metrics` `buildHiveReport` over the
 *     {@link FleetRunSummary} this record projects to ({@link toFleetRunSummary}).
 *   - MAST coordination rates ← P-026 over the {@link HiveBacklogResult.coordEvents} trace
 *     (`CoordEvent`s, incl. every placement) that P-010's rollout layer persists.
 * So the metrics shapes live in bench-metrics (locked, P-025/P-026); this owns only the raw record +
 * the runner port. Arm ids are the LOCKED `FleetArmId` vocab ('hive' | 'queen-ablated' | …).
 *
 * ── THE SCHEDULER SEAM (hive ↔ queen-ablated — P-023, su-136a4 plugs in here) ──────────────────
 * The ONLY thing that differs between the treatment and its headline baseline is the placement
 * POLICY. {@link FleetScheduler} is that policy; everything else (seed the backlog / await drain /
 * collect the trace / teardown) is the shared runner. I register the `'hive'` scheduler (boot the
 * real Queen persona); P-023 registers `'queen-ablated'` (a scripted naive-FIFO loop over the same
 * `frontier()`/`place()` primitives). Same split as `instantiateBenchHarness` ↔ `coding-solo`.
 *
 * ── STAGING (D-009 discipline — live driver bound at the pilot) ────────────────────────────────
 * Spinning a real Hive over a backlog spends real fleet budget, so — like `instantiateBenchHarness`,
 * the grader, and the single-agent drive — the LIVE driver is bound at the P-032 pilot via
 * {@link setHiveBacklogDriver}. The live driver mirrors hive-eval's `makeLiveHivePorts` loop
 * (create transient hive → seed backlog work_items → the arm's scheduler drives placement →
 * `countHivePlacementsInFlight()==0` → collect `spawned_agents`/work-item outcomes → teardown). The
 * live function map is documented on {@link HiveBacklogDriver}. UNBOUND, the port returns an
 * infra-error result so the wave builds + tests against it today; fake-tested below.
 */
import type { BenchSuite, CoordEvent, FleetArmId, FleetRunSummary } from '@papercusp/bench-metrics';
import type { ArmAttempt, BenchTask, GenerationBudget } from './types';

/** The treatment arm this runner spins by default — the real Queen + bee fleet. */
export const HIVE_ARM: FleetArmId = 'hive';

/* -------------------------------------------------------------------------- */
/* The raw fleet run record (this runner's output)                            */
/* -------------------------------------------------------------------------- */

/** How the scheduler placed a task onto a bee (the Queen's placement vocabulary). */
export type PlacementDisposition = 'spawn' | 'warm-inject';

/** One backlog task's leaf result, with its fleet placement + timing provenance. */
export interface FleetTaskResult {
  /** The L1 leaf — the per-task `external-bench` generation (diff + cost + stopReason). Graded
   *  downstream by BRIEF 3's OfficialGrader → fills `resolved`. */
  attempt: ArmAttempt;
  /** The bee (spawn id) that ran it. */
  beeId: string;
  /** When the scheduler placed it (ms epoch). */
  placedAtMs: number;
  /** When the bee started / finished the task (ms epoch). */
  startedAtMs: number;
  finishedAtMs: number;
  /** How it was placed — fresh spawn vs warm-inject onto a busy bee. */
  disposition: PlacementDisposition;
}

/** The whole backlog run handed to one fleet arm — the raw generation trace. */
export interface HiveBacklogResult {
  /** LOCKED fleet vocab — 'hive' (this) | 'queen-ablated' (P-023) | 'native-serial' (P-024) | competitors. */
  arm: FleetArmId;
  suite: BenchSuite;
  /** P-010 pre-registered run id (groups every arm × seed of one pilot). */
  runId: string;
  /** The reproducibility seed/prefix this backlog pass ran under. */
  seed: number;
  /** Backlog-drain window (ms epoch) → wall-clock = finishedAtMs − startedAtMs (parallel, NOT Σ). */
  startedAtMs: number;
  finishedAtMs: number;
  /** Peak concurrent bees over the run (throughput context). */
  peakConcurrentBees: number;
  /** One per backlog task. */
  taskResults: FleetTaskResult[];
  /** The coordination trace (every placement/evict + substrate event) → P-026 MAST + P-010 rollout. */
  coordEvents: CoordEvent[];
  /** Generation-side infra failure for the WHOLE run (e.g. the live driver is unbound); null on a clean run. */
  runError?: string | null;
}

/**
 * Project the raw record → the LOCKED P-025 {@link FleetRunSummary} (the input `buildHiveReport`
 * consumes). `resolved` is NOT known at generation time (the grader fills it), so it is passed in
 * after BRIEF 3 grades the per-task diffs. Cost/tokens are SUMMED across every bee + turn
 * (coordination overhead counted — fairness #2); wall-clock is the PARALLEL drain window, not the
 * sum of per-task times. Autonomy numerator = tasks that reached DONE with no human gate.
 */
export function toFleetRunSummary(result: HiveBacklogResult, resolvedCount: number): FleetRunSummary {
  let costUsd = 0;
  let tokensTotal = 0;
  let tasksZeroHumanGate = 0;
  for (const t of result.taskResults) {
    costUsd += t.attempt.costUsd;
    tokensTotal += t.attempt.tokensIn + t.attempt.tokensOut;
    // A benchmark backlog runs with NO human gate; "zero human gate" = the bee reached DONE on its
    // own (not an ESCALATE that, in a gated run, would have waited on a human).
    if (t.attempt.stopReason === 'done') tasksZeroHumanGate += 1;
  }
  return {
    runId: result.runId,
    suite: result.suite,
    arm: result.arm,
    tasks: result.taskResults.length,
    resolved: resolvedCount,
    wallClockMs: Math.max(0, result.finishedAtMs - result.startedAtMs),
    costUsd,
    tokensTotal,
    tasksZeroHumanGate,
    peakConcurrency: result.peakConcurrentBees,
  };
}

/* -------------------------------------------------------------------------- */
/* The scheduler seam — the hive ↔ queen-ablated placement-policy toggle       */
/* -------------------------------------------------------------------------- */

/** A ready, unplaced backlog task (importance/backlog order; index 0 = highest). */
export interface FrontierTask {
  taskId: string;
  importance: number;
}

/** A live bee + its current load (for affinity / FIFO assignment). */
export interface FleetBee {
  id: string;
  load: number;
}

/** One placement decision a scheduler emits: run `taskId` on `bee` ('spawn' = a fresh bee). */
export interface PlacementDecision {
  taskId: string;
  bee: string | 'spawn';
  disposition: PlacementDisposition;
}

/**
 * The live fleet primitives a {@link FleetScheduler} drives, provided by the pilot-bound driver
 * (the hive-eval `makeLiveHivePorts` surface, narrowed to placement). A scripted scheduler (FIFO,
 * P-023) uses the low-level frontier/fleet/place loop; the Queen scheduler delegates to the real
 * Queen persona via `wakeQueen` + `awaitDrain`. Both record their behavior via `emit`.
 */
export interface FleetSchedulerContext {
  /** The benchmark backlog (already seeded as work_items). */
  readonly backlog: readonly BenchTask[];
  /** Ready, unplaced tasks in backlog/importance order (gatherFrontier). */
  frontier(): Promise<readonly FrontierTask[]>;
  /** Live bee roster + free spawn slots (gatherLiveBees + headroom). */
  fleet(): Promise<{ bees: readonly FleetBee[]; headroom: number }>;
  /** Place a batch of decisions (fleet:place_batch → spawn / warm-inject). */
  place(decisions: readonly PlacementDecision[]): Promise<void>;
  /** Tasks still in flight (countHivePlacementsInFlight); 0 = the backlog is drained. */
  inFlight(): Promise<number>;
  /** Wait for a fleet change (a bee freed / a task completed) before re-planning. */
  awaitProgress(timeoutMs?: number): Promise<void>;
  /** Boot the real Queen persona over the seeded backlog (the 'hive' arm; no-op for a scripted arm). */
  wakeQueen(): Promise<void>;
  /** Resolve once `inFlight()` reaches 0 (used by the Queen arm, which doesn't place itself). */
  awaitDrain(): Promise<void>;
  /** Record a coordination event into the run's MAST trace (placements, hand-offs, failures). */
  emit(event: CoordEvent): void;
}

/** The placement POLICY — the only thing that differs between arms (the D-009 `blueprintId` analog). */
export interface FleetScheduler {
  arm: FleetArmId;
  /** Drive the seeded backlog to drained, using the ctx primitives this policy needs. */
  drivePlacement(ctx: FleetSchedulerContext): Promise<void>;
}

const _schedulers = new Map<FleetArmId, FleetScheduler>();

/** Register a placement policy for an arm. P-022 registers 'hive'; P-023 registers 'queen-ablated'. */
export function registerFleetScheduler(scheduler: FleetScheduler): void {
  _schedulers.set(scheduler.arm, scheduler);
}

/** Look up a registered scheduler (the live driver dispatches on the run's arm). */
export function getFleetScheduler(arm: FleetArmId): FleetScheduler | undefined {
  return _schedulers.get(arm);
}

/**
 * The 'hive' treatment scheduler (P-022): boot the REAL Queen and let it place autonomously, then
 * await drain. The Queen's intelligence (ranking / eviction / warm-inject / briefs / wake-timing) is
 * the treatment under test — it is a PERSONA, not a function, so this delegates rather than scripting
 * placement. The substrate's placement events are captured into the trace by the live driver's `emit`.
 */
export const hiveQueenScheduler: FleetScheduler = {
  arm: HIVE_ARM,
  async drivePlacement(ctx) {
    await ctx.wakeQueen();
    await ctx.awaitDrain();
  },
};
registerFleetScheduler(hiveQueenScheduler);

/* -------------------------------------------------------------------------- */
/* The runner port — live driver bound at the P-032 pilot                      */
/* -------------------------------------------------------------------------- */

/** One backlog run's config (the firing payload). */
export interface HiveBacklogRunRequest {
  arm: FleetArmId;
  suite: BenchSuite;
  runId: string;
  seed: number;
  /** The whole benchmark backlog handed to the fleet. */
  backlog: BenchTask[];
  /** Per-task iso-budget + an optional fleet-level $/time cap (BRIEF 7). */
  budget: GenerationBudget;
}

/**
 * The LIVE hive-backlog driver — bound at the P-032 pilot. Mirrors hive-eval's `makeLiveHivePorts`:
 *   CREATE   — a transient hive home (`createHiveHarness`, `agent-tools/hive/_create.ts`).
 *   SEED     — insert the backlog as `feature` work_items into the member harness
 *              (`harness_features_consolidated`), status 'todo', unassigned — the Queen's frontier.
 *   DRIVE    — `getFleetScheduler(req.arm).drivePlacement(ctx)` where ctx wraps the live fleet
 *              (`surveyHive`/`gatherFrontier`/`gatherLiveBees`/`fleet:place_batch`/
 *              `countHivePlacementsInFlight`). Each placed task → a bee running
 *              `instantiateBenchHarness('external-bench', task, …)` (the L1 leaf, D-009).
 *   COLLECT  — read `spawned_agents` (timing/cost) + work-item outcomes → assemble `FleetTaskResult[]`,
 *              the placement/coord `CoordEvent[]`, and the drain window.
 *   TEARDOWN — dissolve the transient hive.
 */
export interface HiveBacklogDriver {
  run(req: HiveBacklogRunRequest): Promise<HiveBacklogResult>;
}

/** The default driver — unbound until the pilot wires the live one (the hive-eval precedent). */
const UNBOUND_DRIVER: HiveBacklogDriver = {
  async run() {
    throw new Error(
      'live hive-backlog driver not bound — setHiveBacklogDriver() is wired at the pilot (P-032 / impartial-benchmark-suite-2026-06-15)',
    );
  },
};

let _driver: HiveBacklogDriver | null = null;

/** Bind the live hive-backlog driver (the pilot) — or a fake (tests). `null` restores the unbound default. */
export function setHiveBacklogDriver(driver: HiveBacklogDriver | null): void {
  _driver = driver;
}

/**
 * Run one backlog through a fleet arm. Delegates to the bound {@link HiveBacklogDriver}; an
 * unbound/failed driver yields an empty result carrying `runError` (never throws — the
 * generation-failure contract the metrics layer relies on, mirroring `instantiateBenchHarness`).
 */
export async function runHiveBacklog(req: HiveBacklogRunRequest): Promise<HiveBacklogResult> {
  const driver = _driver ?? UNBOUND_DRIVER;
  try {
    return await driver.run(req);
  } catch (e) {
    const runError = e instanceof Error ? e.message : String(e);
    return {
      arm: req.arm,
      suite: req.suite,
      runId: req.runId,
      seed: req.seed,
      startedAtMs: 0,
      finishedAtMs: 0,
      peakConcurrentBees: 0,
      taskResults: [],
      coordEvents: [],
      runError,
    };
  }
}
