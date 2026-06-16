/**
 * su-independent-backlog.ts — the INDEPENDENT-su-agents backlog driver
 * (benchmark-arms-su-vs-queen-expansion-2026-06-16 / P-001).
 *
 * WHY THIS EXISTS. The two hive arms ({@link ./hive-backlog-realqueen.ts}) answer "how much does the
 * Queen's live placement/eviction/re-placement buy over no orchestration?" — both boot ONE hive over
 * the whole backlog and differ only in the Queen treatment. Neither is the honest "what does our
 * su/worker AGENT, standing alone, score on this benchmark?" pole. THIS driver is that pole: it runs
 * N INDEPENDENT agents, each solving EXACTLY ONE SWE-bench-Pro task end-to-end, with **NO Queen and
 * NO hive coordination** — no Queen wake, no placement-watchdog, no `hive_placements` ledger, no
 * survey/re-wake loop. It is the simplest of the three drivers: a bounded concurrency POOL of
 * independent per-task agents.
 *
 * THE COMPARISON LANDSCAPE (all three share clone/diff/grader/model — D-004 fairness):
 *   - 'su-independent' (this) — N independent su/worker agents, one task each, NO coordination.
 *                               The honest "our agent system, no orchestration" pole.
 *   - 'hive-realqueen'        — ONE hive, the REAL Queen places/evicts/re-places/briefs/adaptive-wakes.
 *   - 'mini-swe-agent'        — the reference standard harness (external, same model + same tasks).
 *
 * ── THE PER-TASK SPINE-DRIVE (the spawn primitive — D-001) ─────────────────────────────────────────
 * Each independent agent is driven by `instantiateBenchHarness('external-bench', task, checkout, budget)`
 * (./run-loop.ts → the LIVE {@link ../external-bench/bench-harness-live.ts liveBenchHarnessDriver}). That
 * is the PROVEN, queen-less per-task primitive: it CREATEs a throwaway harness over the cloned repo, FEEDs
 * the problem_statement as one feature, DRIVEs the full `external-bench` coding spine (director → scoper →
 * architect → worker → validator → reviewer …) to DONE via `spawnInvokeOnce` — THE governed agent-spawn
 * chokepoint that wraps `buildRoleLaunchSpec`/the role-launch path — sums cost from `agent_usage_samples`,
 * and tears down. We deliberately reuse it verbatim rather than re-driving `buildRoleLaunchSpec` by hand:
 * the prompt's own steer ("if spawnInvokeOnce already wraps this cleanly, prefer it") holds — the
 * bench-harness driver IS that clean wrapper, and reusing it keeps this arm byte-identical to the L1
 * papercusp arm's generation half (same spine, same clone/diff/cost), so the only delta across arms is
 * the ORCHESTRATION layer above it (none here; a Queen there).
 *
 * ── CONCURRENCY (the pool — D-002) ──────────────────────────────────────────────────────────────────
 * Up to `cap` agents run at once where `cap = spawnConcurrencyCeiling()` — the SAME global
 * `maxSimultaneousAgents` ceiling the hive arms draw from (`../fleet/operator-spawn`), read at run start.
 * We do NOT exceed it. As each task finishes the pool pulls the next backlog task, so a backlog larger
 * than the cap drains in waves of ≤cap concurrent agents (the same saturation discipline the hive arms
 * run under — fairness). The cap is a per-process module cache; the caller is responsible for setting
 * `maxSimultaneousAgents` to the intended value in THIS process before the run (the same `operator:
 * rate_limit_config` PUT the realqueen launcher does — there is no separate :3170 host here because the
 * independent agents spawn IN this process via `spawnInvokeOnce`, not via a Queen's loopback `fleet:spawn`).
 *
 * ── ACTUAL-CONCURRENCY TRACKING (load-bearing — P-003) ──────────────────────────────────────────────
 * Besides the scalar `peakConcurrentBees`, the driver records a {@link ConcurrencyTimeline}: a background
 * sampler reads the live pool-occupancy counter on a fixed cadence (`sampleIntervalMs`) and appends
 * `{tMs, live}`; at run end we compute `avgConcurrent`/`peakConcurrent` and attach it to the result. This
 * answers "how many independent agents actually ran at once, on average" — not just the peak — so the
 * report can show whether the pool was saturated or starved. The occupancy counter is the ground truth
 * (incremented at task start, decremented at task end), so the sample is exact, not a PG estimate.
 *
 * ── FAIRNESS (D-004): opus 4.8 @ xhigh ──────────────────────────────────────────────────────────────
 * The `external-bench` spine drives the PIPELINE roles (worker/validator/reviewer/director/scoper/
 * architect/documenter), whose committed floors are sonnet/haiku (orchestrator/role-models.ts) — NOT the
 * `bee` role the hive arms place. So to match the other arms' model the CALLER must export
 * `AGENT_MODELS` pinning those pipeline roles to `opus:xhigh`, e.g.
 *   AGENT_MODELS='{"director":"opus:xhigh","scoper":"opus:xhigh","architect":"opus:xhigh",
 *                  "worker":"opus:xhigh","validator":"opus:xhigh","reviewer":"opus:xhigh",
 *                  "documenter":"opus:xhigh","bee":"opus:xhigh"}'
 * plus `AGENT_CMD="claude -p"` (the `opus` alias). The bench-harness drive pins the claude-code backend
 * + waives the fleet sandbox per-spawn already (bench-harness-live.ts); the opus model pin is the
 * caller's because it must reach every spawned role. VERIFY `agent_usage_samples.model = claude-opus-4-8`
 * on a 1-task probe before any big spend (same protocol as the hive arms). Same clone/diff/grader as
 * every arm — the only independent variable across arms is the orchestration layer.
 *
 * GOVERNOR / SPEND: binding this spends nothing; the real LLM spend is the per-task agents on the gated
 * launch. The driver bounds spend with a per-task iso-budget (`req.budget`, enforced inside the
 * bench-harness drive) and a whole-run wall-clock ceiling; on timeout/error it stops pulling new tasks,
 * collects whatever finished, and cleans up every checkout. NEVER throws (the generation-failure
 * contract — a failure returns a {@link HiveBacklogResult} with `runError` + the partial `taskResults`).
 */
import type { FleetArmId } from '@papercusp/bench-metrics';
import type { ArmAttempt, BenchTask, GenerationBudget, GenerationTelemetry, TaskCheckout } from './types';
import {
  setHiveBacklogDriver,
  type ConcurrencyTimeline,
  type FleetTaskResult,
  type HiveBacklogDriver,
  type HiveBacklogResult,
  type HiveBacklogRunRequest,
} from './hive-backlog';

/** The arm this driver serves (open `FleetArmId` union — slots in with no type change). */
export const SU_INDEPENDENT_ARM: FleetArmId = 'su-independent';

/** The blueprint each independent agent drives — the FULL coding spine (same as the papercusp L1 arm). */
const SPINE_BLUEPRINT = 'external-bench';

/** Default whole-run wall-clock ceiling (the bound on spend) + the concurrency-sample cadence. */
const DEFAULT_FLEET_TIMEOUT_MS = 120 * 60 * 1000; // 2h ceiling — a bounded run is far under.
const DEFAULT_SAMPLE_INTERVAL_MS = 5_000; // sample live pool occupancy every 5s.

/**
 * One enrolled backlog task driven by an independent agent — its clone + the result fields the
 * collector fills. There is NO member harness / hive home / bee placement here (the independent
 * agent owns its own throwaway harness inside `runOneTask`); this is purely the per-task record.
 */
export interface SuIndependentEnrolled {
  task: BenchTask;
  /** The cloned worktree the agent edits (=== checkout.dir). */
  clonePath: string;
  checkout: TaskCheckout;
  /** The spawn/agent id that served it (best-effort; filled by `runOneTask`). null until it runs. */
  agentId: string | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
}

/**
 * What `runOneTask` returns — the per-task generation result for ONE independent agent. The driver
 * maps it into a {@link FleetTaskResult}. Mirrors the bench-harness {@link GenerationTelemetry} the
 * spine-drive produces, plus the unified diff (extracted from the worktree) the grader consumes.
 */
export interface SuTaskOutcome {
  /** The unified diff base..HEAD (grader test-files excluded); "" when the agent produced no change. */
  diff: string;
  telemetry: GenerationTelemetry;
  /** The agent/spawn id that served it (diagnostics + the FleetTaskResult.beeId field). */
  agentId: string;
}

/**
 * The injected IO seam. Every side effect is ONE method so the boot→spawn→collect→teardown ordering,
 * the concurrency-pool semantics, the timeline sampling, and the never-throw contract all unit-test
 * with fakes (NO git/PG/LLM, NO live spawns). The real binding ({@link suIndependentBacklogOps})
 * wires cloneTaskRepo / the bench-harness spine-drive / extractDiff via lazy dynamic imports.
 *
 * NOTE the deliberate ABSENCE of any queen/hive/placement methods — that is the whole point of this
 * arm. There is no `createHive`, no `startRealQueen`, no `reconcileWatchdog`, no `collectCoordEvents`.
 */
export interface SuIndependentBacklogOps {
  now(): number;
  /** The fleet concurrency cap (= the global `maxSimultaneousAgents`). Read ONCE at run start. */
  concurrencyCap(): number;
  /** Clone the task repo @ base into a fresh scratch worktree (the per-agent isolated checkout). */
  prepareTask(input: { task: BenchTask; budget: GenerationBudget; workspaceId: string }): Promise<SuIndependentEnrolled>;
  /**
   * Run ONE independent agent over the prepared checkout to a terminal state, then extract its diff +
   * cost. This is the whole per-task lifecycle (spin a throwaway `external-bench` harness → drive the
   * spine to DONE under `budget` via the governed spawn chokepoint → sum cost → extract diff). The
   * concurrency pool calls this for up to `cap` tasks at once. Should NOT throw on a generation failure
   * — return an outcome whose telemetry carries `stopReason:'error'` + `generationError` (the
   * bench-harness drive already honors this); a genuine infra throw is caught by the driver → a partial
   * result for this task.
   */
  runOneTask(input: { enrolled: SuIndependentEnrolled; budget: GenerationBudget; seed: string; workspaceId: string }): Promise<SuTaskOutcome>;
  /** Remove ONE task's scratch checkout (best-effort — the per-agent worktree). */
  teardownTask(input: { enrolled: SuIndependentEnrolled; workspaceId: string }): Promise<void>;
}

export interface SuIndependentBacklogOpts {
  workspaceId: string;
  /** Whole-run wall-clock ceiling (ms). Default 2h. */
  fleetTimeoutMs?: number;
  /** Live-concurrency sample cadence (ms). Default 5s. */
  sampleIntervalMs?: number;
  /**
   * DURABILITY hooks (mirror the realqueen driver — a mid-run kill keeps already-produced work).
   *   - `onEnrolled`      fires right after each task is cloned/prepared → persist the
   *                       instanceId → clonePath → baseCommit mapping for a recovery pass.
   *   - `onTaskCollected` fires per task as it finishes + is collected → persist that one task's
   *                       diff/row immediately, so a kill keeps every diff already gathered.
   * Both optional + best-effort: a hook throw (sync OR async) must NEVER abort the drive/collection.
   */
  onEnrolled?: (enrolled: SuIndependentEnrolled) => void | Promise<void>;
  onTaskCollected?: (result: FleetTaskResult) => void | Promise<void>;
}

/**
 * The LIVE {@link HiveBacklogDriver} over the injected {@link SuIndependentBacklogOps}. Runs the backlog
 * through a bounded concurrency POOL of independent per-task agents (size = the fleet cap), records the
 * live-concurrency timeline, and collects per-task diff/cost. NO queen, NO hive, NO placement. Never
 * throws (the generation-failure contract — a failure yields a result with `runError` + partials).
 */
export function suIndependentBacklogDriver(
  ops: SuIndependentBacklogOps,
  opts: SuIndependentBacklogOpts,
): HiveBacklogDriver {
  const ws = opts.workspaceId;
  const fleetTimeoutMs = opts.fleetTimeoutMs ?? DEFAULT_FLEET_TIMEOUT_MS;
  const sampleIntervalMs = opts.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;

  return {
    async run(req: HiveBacklogRunRequest): Promise<HiveBacklogResult> {
      const startedAtMs = ops.now();

      // ── live-concurrency accounting ──────────────────────────────────────────────────────────────
      // `live` is the ground-truth pool occupancy (++ at a task's first spine spawn, -- at its finish).
      // The sampler reads it on a fixed cadence into `samples`; peak is tracked inline so the scalar
      // `peakConcurrentBees` stays populated even when the run is shorter than one sample interval.
      let live = 0;
      let peak = 0;
      const samples: { tMs: number; live: number }[] = [];
      const sample = (): void => {
        samples.push({ tMs: ops.now() - startedAtMs, live });
        if (live > peak) peak = live;
      };
      const enter = (): void => {
        live += 1;
        if (live > peak) peak = live;
      };
      const exit = (): void => {
        live = Math.max(0, live - 1);
      };

      const taskResults: FleetTaskResult[] = [];
      const enrolledAll: SuIndependentEnrolled[] = [];

      // The concurrency sampler runs on a real timer (unref'd so it never keeps the process alive). The
      // injected `ops.now()` lets the unit test drive logical time; the timer cadence is wall-clock, so a
      // fake-driven test that wants samples calls `sample()` indirectly through a 0ms-interval pump or
      // asserts on the inline peak. We always take an initial + final sample so the timeline is non-empty.
      sample();
      const sampler = setInterval(() => sample(), Math.max(1, sampleIntervalMs));
      if (typeof sampler.unref === 'function') sampler.unref();

      const finalize = (runError?: string): HiveBacklogResult => {
        clearInterval(sampler);
        sample(); // final occupancy snapshot
        const avgConcurrent = samples.length > 0 ? samples.reduce((s, x) => s + x.live, 0) / samples.length : 0;
        const sampledPeak = samples.reduce((m, x) => Math.max(m, x.live), 0);
        const concurrencyTimeline: ConcurrencyTimeline = {
          samples,
          avgConcurrent,
          peakConcurrent: Math.max(sampledPeak, peak),
        };
        return {
          arm: req.arm,
          suite: req.suite,
          runId: req.runId,
          seed: req.seed,
          startedAtMs,
          finishedAtMs: ops.now(),
          peakConcurrentBees: peak,
          taskResults,
          coordEvents: [], // an independent-agent arm has NO coordination trace — by design.
          concurrencyTimeline,
          ...(runError ? { runError } : {}),
        };
      };

      try {
        const cap = Math.max(1, Math.floor(ops.concurrencyCap()) || 1);
        const deadline = startedAtMs + fleetTimeoutMs;
        const backlog = req.backlog;
        let nextIndex = 0;
        let timedOut = false;

        // ── the concurrency POOL ───────────────────────────────────────────────────────────────────
        // `cap` worker loops each pull the next un-started backlog task, prepare+run+collect it, then
        // loop for the next — so at most `cap` agents are live at once and the backlog drains in waves
        // of ≤cap. A worker stops pulling when the backlog is exhausted OR the wall-clock deadline passed
        // (the run-bound; a task already in flight finishes, we just stop STARTING new ones). The shared
        // `nextIndex` cursor is mutated synchronously between `await`s — single-threaded JS, so no lock.
        const worker = async (): Promise<void> => {
          for (;;) {
            if (ops.now() >= deadline) {
              timedOut = true;
              return;
            }
            const i = nextIndex;
            if (i >= backlog.length) return;
            nextIndex += 1;
            const task = backlog[i];

            // PREPARE (clone) — a prepare failure for ONE task must not abort the pool; record an
            // error result for it and continue pulling.
            let enrolled: SuIndependentEnrolled;
            try {
              enrolled = await ops.prepareTask({ task, budget: req.budget, workspaceId: ws });
            } catch (e) {
              taskResults.push(
                errorTaskResult(req.arm, task, String(req.seed), `prepareTask failed: ${msg(e)}`),
              );
              continue;
            }
            enrolledAll.push(enrolled);
            await fireHook(opts.onEnrolled, enrolled);

            // RUN one independent agent over the checkout (++/-- the occupancy counter around it so the
            // timeline reflects exactly the spine-drive window). The drive itself never throws a
            // generation failure (it maps to telemetry.stopReason='error'); a genuine infra throw lands
            // an error result for this task. TEARDOWN the checkout either way.
            enter();
            enrolled.startedAtMs = ops.now();
            let result: FleetTaskResult;
            try {
              const outcome = await ops.runOneTask({ enrolled, budget: req.budget, seed: String(req.seed), workspaceId: ws });
              enrolled.finishedAtMs = ops.now();
              enrolled.agentId = outcome.agentId;
              result = taskResultFromOutcome(req.arm, enrolled, String(req.seed), outcome);
            } catch (e) {
              enrolled.finishedAtMs = ops.now();
              result = errorTaskResult(req.arm, task, String(req.seed), `runOneTask failed: ${msg(e)}`, enrolled);
            } finally {
              exit();
              await ops.teardownTask({ enrolled, workspaceId: ws }).catch(() => {});
            }
            taskResults.push(result);
            await fireHook(opts.onTaskCollected, result);
          }
        };

        // Spawn min(cap, backlog) worker loops and await them all. Each task is collected as it finishes
        // (inside the loop), so the durability hooks fire incrementally — a mid-run kill keeps the
        // already-collected diffs. There is no separate collect phase (unlike the hive arms, whose collect
        // is serial AFTER drain): an independent agent's diff is extracted the instant it terminates.
        const poolSize = Math.max(1, Math.min(cap, backlog.length || 1));
        await Promise.all(Array.from({ length: poolSize }, () => worker()));

        return finalize(timedOut ? `run wall-clock timeout after ${fleetTimeoutMs}ms (backlog not fully drained)` : undefined);
      } catch (e) {
        // A failure OUTSIDE a single task (e.g. concurrencyCap threw) — tear down any prepared checkouts
        // and return the partial result with runError. Never throw.
        for (const en of enrolledAll) await ops.teardownTask({ enrolled: en, workspaceId: ws }).catch(() => {});
        return finalize(msg(e));
      }
    },
  };
}

/** Map a successful per-task outcome → a {@link FleetTaskResult}. */
function taskResultFromOutcome(
  arm: FleetArmId,
  enrolled: SuIndependentEnrolled,
  seed: string,
  outcome: SuTaskOutcome,
): FleetTaskResult {
  const t = outcome.telemetry;
  const startedAtMs = enrolled.startedAtMs ?? 0;
  const finishedAtMs = enrolled.finishedAtMs ?? startedAtMs;
  const attempt: ArmAttempt = {
    arm,
    blueprintId: SPINE_BLUEPRINT,
    instanceId: enrolled.task.instanceId,
    seed,
    diff: outcome.diff,
    tokensIn: t.tokensIn,
    tokensOut: t.tokensOut,
    costUsd: t.costUsd,
    turns: t.turns,
    wallClockMs: t.wallClockMs,
    trajectoryRef: t.trajectoryRef || `xbench-su-independent://${enrolled.task.instanceId}`,
    stopReason: t.stopReason,
    ...(t.generationError ? { generationError: t.generationError } : {}),
    armMeta: { independent: true, agentId: outcome.agentId },
  };
  return {
    attempt,
    beeId: outcome.agentId,
    placedAtMs: startedAtMs, // there is no "placement" — the agent starts when the pool pulls it.
    startedAtMs,
    finishedAtMs,
    disposition: 'spawn', // always a fresh independent spawn (never a warm-inject — no fleet to inject into).
  };
}

/** Build an error {@link FleetTaskResult} for a task whose prepare/run threw (infra failure, not scored). */
function errorTaskResult(
  arm: FleetArmId,
  task: BenchTask,
  seed: string,
  generationError: string,
  enrolled?: SuIndependentEnrolled,
): FleetTaskResult {
  const startedAtMs = enrolled?.startedAtMs ?? 0;
  const finishedAtMs = enrolled?.finishedAtMs ?? startedAtMs;
  const attempt: ArmAttempt = {
    arm,
    blueprintId: SPINE_BLUEPRINT,
    instanceId: task.instanceId,
    seed,
    diff: '',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    turns: 0,
    wallClockMs: Math.max(0, finishedAtMs - startedAtMs),
    trajectoryRef: `xbench-su-independent://${task.instanceId}`,
    stopReason: 'error',
    generationError,
    armMeta: { independent: true },
  };
  return {
    attempt,
    beeId: enrolled?.agentId ?? task.instanceId,
    placedAtMs: startedAtMs,
    startedAtMs,
    finishedAtMs,
    disposition: 'spawn',
  };
}

/** Fire a best-effort durability hook — a sync OR async throw must never abort the caller. */
async function fireHook<T>(hook: ((x: T) => void | Promise<void>) | undefined, arg: T): Promise<void> {
  if (!hook) return;
  try {
    await hook(arg);
  } catch {
    /* best-effort durability hook — ignore */
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Bind the live su-independent driver so `runHiveBacklog` is instant-go. `ops` defaults to the real binding. */
export function bindSuIndependentBacklogDriver(
  opts: SuIndependentBacklogOpts,
  ops?: SuIndependentBacklogOps,
): void {
  setHiveBacklogDriver(suIndependentBacklogDriver(ops ?? suIndependentBacklogOps(opts), opts));
}

/* -------------------------------------------------------------------------- */
/* The REAL binding — clone + the bench-harness spine-drive + diff, NO hive.   */
/* -------------------------------------------------------------------------- */

/**
 * The REAL machinery binding. Each task: clone @ base → drive ONE independent agent over the
 * `external-bench` spine to DONE → extract its diff. Lazy dynamic imports keep the module import-light
 * so the fake-driven test never loads git/PG/the bench-harness live ops.
 *
 * The spine-drive runs through the bench-harness LIVE driver ({@link ../external-bench/bench-harness-live.ts
 * liveBenchHarnessDriver} via `instantiateBenchHarness`), which already pins the claude-code backend +
 * waives the fleet sandbox per-spawn. The opus model pin (AGENT_MODELS pipeline-roles=opus:xhigh) is the
 * CALLER's responsibility (it must reach every spawned role) — documented in the file header.
 */
export function suIndependentBacklogOps(opts: SuIndependentBacklogOpts): SuIndependentBacklogOps {
  const ws = opts.workspaceId;

  return {
    now: () => Date.now(),

    concurrencyCap() {
      // The SAME global maxSimultaneousAgents ceiling the hive arms draw from — read once at run start.
      // `spawnConcurrencyCeiling` is a synchronous read of the per-process cache; the caller is
      // responsible for having set the intended cap in this process before the run. Lazy require (the
      // established operator-core pattern for a sync read inside an async-bound seam) so the fake-driven
      // test never pulls the fleet module.
      const { spawnConcurrencyCeiling } = require('../fleet/operator-spawn') as typeof import('../fleet/operator-spawn');
      return spawnConcurrencyCeiling();
    },

    async prepareTask({ task }) {
      const { cloneTaskRepo } = await import('./clone');
      const checkout = await cloneTaskRepo(task);
      const enrolled: SuIndependentEnrolled = {
        task,
        clonePath: checkout.dir,
        checkout,
        agentId: null,
        startedAtMs: null,
        finishedAtMs: null,
      };
      return enrolled;
    },

    async runOneTask({ enrolled, budget }) {
      // Drive ONE independent agent over the full `external-bench` spine to DONE via the bench-harness
      // LIVE driver. We bind it lazily HERE (idempotent — re-binding the same live ops is harmless) so a
      // su-independent run doesn't require the caller to also wire bindLiveBenchHarness; the bench-harness
      // driver owns the throwaway-harness create/feed/drive/cost/teardown for THIS task in-process.
      const [{ bindLiveBenchHarness }, { instantiateBenchHarness }, { extractDiff }] = await Promise.all([
        import('./bench-harness-live'),
        import('./run-loop'),
        import('./clone'),
      ]);
      bindLiveBenchHarness({ workspaceId: ws });

      const run = await instantiateBenchHarness(SPINE_BLUEPRINT, enrolled.task, enrolled.checkout, budget);
      // Extract the diff from the worktree the agent edited (grader test-files + .papercusp/ excluded).
      let diff = '';
      try {
        diff = await extractDiff(enrolled.checkout, enrolled.task);
      } catch (e) {
        // A diff-extract failure is a generation-side infra failure for THIS task — surface it on the
        // telemetry rather than throwing (so the task still collects, just with stopReason carried).
        return {
          diff: '',
          telemetry: { ...run.telemetry, stopReason: 'error', generationError: `extractDiff failed: ${msg(e)}` },
          agentId: trajectoryAgentId(run.telemetry.trajectoryRef, enrolled.task.instanceId),
        };
      }
      return {
        diff,
        telemetry: run.telemetry,
        agentId: trajectoryAgentId(run.telemetry.trajectoryRef, enrolled.task.instanceId),
      };
    },

    async teardownTask({ enrolled }) {
      // The bench-harness driver already unregisters + drops the throwaway harness schema; we own the
      // clone (the caller of cloneTaskRepo). Best-effort.
      await enrolled.checkout.cleanup().catch(() => {});
    },
  };
}

/** Derive a stable agent id from the bench-harness trajectoryRef (`xbench://<slug>`), else the instanceId. */
function trajectoryAgentId(trajectoryRef: string, instanceId: string): string {
  const m = /^xbench:\/\/(.+)$/.exec(trajectoryRef);
  return m?.[1] ?? (trajectoryRef || instanceId);
}

export type { ConcurrencyTimeline } from './hive-backlog';
