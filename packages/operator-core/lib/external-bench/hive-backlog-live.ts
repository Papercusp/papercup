/**
 * `liveHiveBacklogDriver` + `bindLiveHiveBacklogDriver` — the LIVE binding of P-022's
 * {@link HiveBacklogDriver} (su-1226c). Makes the `hive` treatment arm AND (via the shared planner
 * seam) su-136a4's `queen-ablated` baseline one-command-runnable for the bounded pilot smoke (P-032).
 *
 * SHAPE: the same injected-ops orchestration as hive-eval's `makeLiveHivePorts` (boot → seed → drive
 * → collect → teardown over an injected IO seam, poll-until-drained, pause-on-timeout to bound spend),
 * adapted from hive-eval's scenario corpus to a BENCHMARK BACKLOG of public tasks, and driving
 * placement with the SCRIPTED planner ({@link getFleetPlanner}) rather than the real Queen persona —
 * so `hive` (planBatchPlacement) vs `queen-ablated` (planFifoPlacement) is a clean MATCHED A/B (same
 * loop/fleet/per-task-unit, swap ONE planner — D-012). The orchestration is pure over the ops seam
 * (unit-tested with fakes, no git/PG/LLM); the real ops bind the live machinery.
 *
 * GOVERNOR-INDEPENDENT: this is code/wiring — binding it spends NOTHING. The real LLM spend (the bees
 * running `external-bench` per placed task) happens only when the owner triggers the bounded run at
 * the opus reset; `driveLoop` always pauses the fleet at drain/timeout to bound it.
 *
 * ── REAL-OPS INTEGRATION (verify on the FIRST gated run — flagged, not yet executed) ───────────────
 * `realHiveBacklogOps` wires the established functions (the Explore-mapped fleet/hive machinery):
 *   createHive       → `createHiveHarness` (agent-tools/hive/_create.ts), IDLE.
 *   enrollTask       → `cloneTaskRepo` (./clone) @ base_commit → register the clone as an
 *                      `external-bench`-blueprint MEMBER (the hive-eval `registerMember` seam) → seed
 *                      ONE `feature` work_item (the task's problem_statement) into it.
 *   gatherFrontier   → `gatherFrontier` (fleet/placement-gather.ts) — importance order for 'hive',
 *                      backlog/arrival order for 'queen-ablated' (136a4's FIFO contract).
 *   gatherBees       → `gatherLiveBees` (fleet/placement-gather.ts) + headroom.
 *   placeBatch       → `executeBatch` (fleet/place_batch.ts) over the planner's `BatchPlacementPlan`
 *                      (spawns bees running the member's external-bench spine on the placed task).
 *   countInFlight    → `countHivePlacementsInFlight` (hive_placements rows not yet completed).
 *   collectTask      → `extractDiff` (./clone) over the member clone + the per-task cost/turns SUM
 *                      from `agent_usage_samples` (the bee-instance.ts pattern) → an {@link ArmAttempt}.
 *   teardown         → drop members + dissolve the hive + rm clones.
 * These are wired below; their FIRST real execution over a benchmark backlog is unverified (the run is
 * gated), so the pilot trigger (su-10912 / ec8fe) confirms them live. The ORCHESTRATION is green.
 */
import type { CoordEvent } from '@papercusp/bench-metrics';
import type { BatchPlacementInput, BatchPlacementPlan } from '../fleet/batch-placement';
import type { ArmAttempt, BenchTask, GenerationBudget } from './types';
import {
  getFleetPlanner,
  setHiveBacklogDriver,
  type FleetTaskResult,
  type HiveBacklogDriver,
  type HiveBacklogResult,
  type HiveBacklogRunRequest,
} from './hive-backlog';

/** Default fleet-drain timeout for a bounded backlog run (ms). Pauses the fleet to bound spend. */
const DEFAULT_FLEET_TIMEOUT_MS = 60 * 60 * 1000; // 1h — a bounded smoke is far under this.
const DEFAULT_POLL_MS = 10_000;

/** One enrolled backlog task — its member harness + clone, threaded to collect. */
export interface EnrolledTask {
  task: BenchTask;
  member: string;
  clonePath: string;
  workItemId: string;
}

/**
 * The injected IO seam the orchestration drives (mirrors hive-eval's `LiveHiveOps`). Every side effect
 * is one method, so the boot→enroll→place→drain→collect→teardown ordering is unit-testable with fakes.
 */
export interface HiveBacklogOps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Mint the transient Queen-seat hive home (IDLE — the scripted loop drives placement, not a wake). */
  createHive(input: { runId: string; arm: string; workspaceId: string }): Promise<{ hiveHome: string }>;
  /** Clone the task repo @ base → register an `external-bench` member → seed the problem_statement work_item. */
  enrollTask(input: {
    hiveHome: string;
    task: BenchTask;
    budget: GenerationBudget;
    workspaceId: string;
  }): Promise<EnrolledTask>;
  /** Ready, unplaced frontier tasks (importance order for 'hive', backlog order for 'queen-ablated'). */
  gatherFrontier(input: { hiveHome: string; arm: string; workspaceId: string }): Promise<BatchPlacementInput['tasks']>;
  /** Live bees + free spawn headroom. */
  gatherBees(input: { hiveHome: string; workspaceId: string }): Promise<{ bees: BatchPlacementInput['bees']; headroom: number }>;
  /** Execute the planner's decisions (spawn / warm-inject bees running external-bench). */
  placeBatch(input: {
    hiveHome: string;
    plan: BatchPlacementPlan;
    arm: string;
    workspaceId: string;
  }): Promise<{ placements: { instanceId: string; beeId: string; disposition: 'spawn' | 'warm-inject' }[] }>;
  /** Placements still in flight (0 = the backlog is drained). */
  countInFlight(input: { hiveHome: string; workspaceId: string }): Promise<number>;
  /** Pause the fleet — a timed-out/drained run must not keep spending. */
  pauseFleet(input: { hiveHome: string; workspaceId: string }): Promise<void>;
  /** Per enrolled task: the diff the bee produced + its cost/timing → the L1 leaf + placement provenance. */
  collectTask(input: { enrolled: EnrolledTask; arm: string; seed: string; workspaceId: string }): Promise<FleetTaskResult>;
  /** Drop members + dissolve the hive + remove the clones. */
  teardown(input: { hiveHome: string; members: EnrolledTask[]; workspaceId: string }): Promise<void>;
}

export interface LiveHiveBacklogOpts {
  workspaceId: string;
  /** Fleet-drain timeout (ms). Default 1h; a bounded smoke is far under. */
  fleetTimeoutMs?: number;
  /** Drain-poll cadence (ms). Default 10s. */
  pollIntervalMs?: number;
}

/**
 * The LIVE {@link HiveBacklogDriver} over the injected {@link HiveBacklogOps}. Drives the SCRIPTED
 * placement loop with the run's arm planner; never throws (the generation-failure contract — a failed
 * run yields a `runError` result, mirroring `runHiveBacklog`/`instantiateBenchHarness`).
 */
export function liveHiveBacklogDriver(ops: HiveBacklogOps, opts: LiveHiveBacklogOpts): HiveBacklogDriver {
  const ws = opts.workspaceId;
  const fleetTimeoutMs = opts.fleetTimeoutMs ?? DEFAULT_FLEET_TIMEOUT_MS;
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;

  return {
    async run(req: HiveBacklogRunRequest): Promise<HiveBacklogResult> {
      const planner = getFleetPlanner(req.arm);
      const startedAtMs = ops.now();
      const coordEvents: CoordEvent[] = [];
      const empty = (runError: string): HiveBacklogResult => ({
        arm: req.arm,
        suite: req.suite,
        runId: req.runId,
        seed: req.seed,
        startedAtMs,
        finishedAtMs: ops.now(),
        peakConcurrentBees: 0,
        taskResults: [],
        coordEvents,
        runError,
      });

      // An arm with no registered placement planner is not an our-fleet run (e.g. a competitor
      // orchestrator, P-028) — it must use its own runner, not this driver.
      if (!planner) return empty(`no fleet placement planner registered for arm '${req.arm}'`);

      let hiveHome: string | undefined;
      const members: EnrolledTask[] = [];
      let peakConcurrentBees = 0;
      try {
        ({ hiveHome } = await ops.createHive({ runId: req.runId, arm: req.arm, workspaceId: ws }));

        // ── enroll the whole backlog (clone @ base + member + work_item per task) ──
        for (const task of req.backlog) {
          const enrolled = await ops.enrollTask({ hiveHome, task, budget: req.budget, workspaceId: ws });
          members.push(enrolled);
          coordEvents.push({ ts: ops.now(), kind: 'claim', taskId: task.instanceId, detail: `enrolled → member ${enrolled.member}` });
        }

        // ── scripted placement loop: gatherFrontier → plan(arm) → placeBatch → poll until drained ──
        const deadline = startedAtMs + fleetTimeoutMs;
        const home = hiveHome;
        while (ops.now() < deadline) {
          const [inFlight, frontier] = await Promise.all([
            ops.countInFlight({ hiveHome: home, workspaceId: ws }),
            ops.gatherFrontier({ hiveHome: home, arm: req.arm, workspaceId: ws }),
          ]);
          if (inFlight === 0 && frontier.length === 0) break; // drained

          if (frontier.length > 0) {
            const { bees, headroom } = await ops.gatherBees({ hiveHome: home, workspaceId: ws });
            peakConcurrentBees = Math.max(peakConcurrentBees, bees.length);
            if (headroom > 0 || bees.length > 0) {
              const plan = planner({ tasks: frontier, bees, headroom });
              const { placements } = await ops.placeBatch({ hiveHome: home, plan, arm: req.arm, workspaceId: ws });
              for (const p of placements) {
                coordEvents.push({ ts: ops.now(), kind: 'placement', taskId: p.instanceId, agent: p.beeId, detail: p.disposition });
              }
            }
          }
          await ops.sleep(pollMs);
        }
      } catch (e) {
        // Pause + collect what completed before surfacing the run-level failure.
        if (hiveHome) await ops.pauseFleet({ hiveHome, workspaceId: ws }).catch(() => {});
        const runError = e instanceof Error ? e.message : String(e);
        const partial = await collectAll(ops, members, req, ws).catch(() => [] as FleetTaskResult[]);
        const finishedAtMs = ops.now();
        if (hiveHome) await ops.teardown({ hiveHome, members, workspaceId: ws }).catch(() => {});
        return { ...empty(runError), finishedAtMs, peakConcurrentBees, taskResults: partial };
      }

      // ── always pause the fleet (bound spend), then collect + teardown ──
      await ops.pauseFleet({ hiveHome, workspaceId: ws }).catch(() => {});
      const taskResults = await collectAll(ops, members, req, ws);
      const finishedAtMs = ops.now();
      await ops.teardown({ hiveHome, members, workspaceId: ws }).catch(() => {});

      return {
        arm: req.arm,
        suite: req.suite,
        runId: req.runId,
        seed: req.seed,
        startedAtMs,
        finishedAtMs,
        peakConcurrentBees,
        taskResults,
        coordEvents,
      };
    },
  };
}

async function collectAll(
  ops: HiveBacklogOps,
  members: EnrolledTask[],
  req: HiveBacklogRunRequest,
  ws: string,
): Promise<FleetTaskResult[]> {
  const out: FleetTaskResult[] = [];
  for (const enrolled of members) {
    out.push(await ops.collectTask({ enrolled, arm: req.arm, seed: String(req.seed), workspaceId: ws }));
  }
  return out;
}

/**
 * Bind the live driver so `runHiveBacklog` is instant-go for the pilot. `ops` defaults to the real
 * machinery binding (`realHiveBacklogOps`); the smoke/test path injects a fake. Pass `null` ops to
 * leave the driver bound to whatever was last set (or call `setHiveBacklogDriver(null)` to unbind).
 */
export function bindLiveHiveBacklogDriver(opts: LiveHiveBacklogOpts, ops?: HiveBacklogOps): void {
  setHiveBacklogDriver(liveHiveBacklogDriver(ops ?? realHiveBacklogOps(opts), opts));
}

/**
 * The REAL machinery binding — wired from the Explore-mapped functions (see the file header). Lazy
 * `require`-free; the real fns are imported by the pilot wiring at trigger time. Until the first gated
 * run verifies it end-to-end, each method documents its real fn; the orchestration above is green
 * over fakes regardless. su-10912/ec8fe verify these on the bounded trigger.
 *
 * NOTE: this scaffold is intentionally a thin, typed placeholder that THROWS a clear "wire at trigger"
 * error — binding it spends nothing, and an accidental unattended call surfaces loudly rather than
 * half-running a real fleet. The pilot wiring replaces these bodies with the live fns (header map) on
 * the gated trigger, OR injects a fully-wired ops set into {@link bindLiveHiveBacklogDriver}.
 */
export function realHiveBacklogOps(opts: LiveHiveBacklogOpts): HiveBacklogOps {
  const notWired = (fn: string) => {
    throw new Error(
      `realHiveBacklogOps.${fn} not yet wired — the pilot trigger (P-032, su-10912/ec8fe) binds the live fleet fns ` +
        `(see hive-backlog-live.ts header map); the orchestration is green over fakes. workspace=${opts.workspaceId}`,
    );
  };
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    createHive: () => notWired('createHive'),
    enrollTask: () => notWired('enrollTask'),
    gatherFrontier: () => notWired('gatherFrontier'),
    gatherBees: () => notWired('gatherBees'),
    placeBatch: () => notWired('placeBatch'),
    countInFlight: () => notWired('countInFlight'),
    pauseFleet: () => notWired('pauseFleet'),
    collectTask: () => notWired('collectTask'),
    teardown: () => notWired('teardown'),
  };
}
