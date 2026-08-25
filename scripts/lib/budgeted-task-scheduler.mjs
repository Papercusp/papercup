import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DURATION_HISTORY_VERSION = 1;
// EI-21437241652128498 / EI-21437837415175286: one stateful test task first
// reached 1,517 cgroup tasks, then exhausted a 2,048-task capability scope while
// it was still progressing. Size one task for the next stable power-of-two rung
// and keep a separate shell/scheduler reserve. A 4,096-task capability or
// checkpoint envelope therefore admits ONE high-fanout task, not two tasks whose
// individually legitimate peaks can collide at the hard fork boundary. This is
// the cgroup that actually enforces fork(); a host-wide process count is not the
// relevant limit.
export const PIDS_PER_CONCURRENT_TASK = 3_072;
export const PIDS_RESERVE = 1_024;

const positiveInteger = (value, name) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${name} must be a positive integer; received ${String(value)}`,
    );
  }
  return parsed;
};

const nonNegativeInteger = (value, name) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `${name} must be a non-negative integer; received ${String(value)}`,
    );
  }
  return parsed;
};

function readTaskCgroupLimit(
  fileName,
  {
    readFile = readFileSync,
    procCgroupPath = "/proc/self/cgroup",
    cgroupRoot = "/sys/fs/cgroup",
  } = {},
) {
  try {
    const unified = String(readFile(procCgroupPath, "utf8"))
      .split(/\r?\n/)
      .find((line) => line.startsWith("0::"));
    if (!unified) return null;
    const relative = unified.slice(3).trim().replace(/^\/+/, "");
    const raw = String(
      readFile(join(cgroupRoot, relative, fileName), "utf8"),
    ).trim();
    if (!raw || raw === "max") return null;
    return raw;
  } catch {
    return null;
  }
}

/** Read the hard memory.max of THIS task's cgroup. `max`/unreadable means unbounded. */
export function readTaskCgroupMemoryMaxMb(options = {}) {
  try {
    const raw = readTaskCgroupLimit("memory.max", options);
    if (raw == null) return null;
    const bytes = BigInt(raw);
    if (bytes < 0n) return null;
    return Number(bytes / (1024n * 1024n));
  } catch {
    return null;
  }
}

/** Read the hard pids.max of THIS task's cgroup. `max`/unreadable means unbounded. */
export function readTaskCgroupPidsMax(options = {}) {
  try {
    const raw = readTaskCgroupLimit("pids.max", options);
    if (raw == null) return null;
    const pids = BigInt(raw);
    if (pids < 0n || pids > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(pids);
  } catch {
    return null;
  }
}

const ROOT_NEAR_TREE_WIDE = [
  /^package(?:-lock)?\.json$/,
  /^tsconfig(?:\.[^.]+)*\.json$/,
  /^(?:vitest|vite|eslint|prettier|turbo|nx)(?:\.[^.]+)*\.(?:[cm]?[jt]s|json)$/,
];

/** Classify path blast radius before any child process is launched. */
export function classifyAffectedBlastRadius({
  changedPaths = [],
  runAll = false,
  derivationDegraded = false,
} = {}) {
  if (runAll)
    return {
      kind: "near-tree-wide",
      reason: "all-requested",
      triggerPaths: [],
    };
  if (derivationDegraded) {
    return {
      kind: "near-tree-wide",
      reason: "derivation-degraded",
      triggerPaths: [],
    };
  }
  const triggerPaths = [...new Set(changedPaths)]
    .filter((path) => ROOT_NEAR_TREE_WIDE.some((pattern) => pattern.test(path)))
    .sort();
  return triggerPaths.length
    ? {
        kind: "near-tree-wide",
        reason: "root-manifest-or-config",
        triggerPaths,
      }
    : { kind: "scoped", reason: "path-closure", triggerPaths: [] };
}

/** Deterministically partition a finalized task set; duplicates fail before launch. */
export function planAffectedTaskShards(
  tasks,
  {
    blastRadius = { kind: "scoped", reason: "path-closure", triggerPaths: [] },
    maxTasksPerShard = 8,
    taskKey = (_task, index) => String(index),
  } = {},
) {
  if (!Array.isArray(tasks)) throw new Error("tasks must be an array");
  const identities = tasks.map((task, index) => String(taskKey(task, index)));
  const seen = new Set();
  for (const identity of identities) {
    if (seen.has(identity))
      throw new Error(`duplicate affected task before sharding: ${identity}`);
    seen.add(identity);
  }
  const bounded = positiveInteger(maxTasksPerShard, "maxTasksPerShard");
  const shardSize =
    blastRadius.kind === "near-tree-wide" ? bounded : Math.max(tasks.length, 1);
  const shards = [];
  for (let offset = 0; offset < tasks.length; offset += shardSize) {
    shards.push({
      index: shards.length,
      tasks: tasks.slice(offset, offset + shardSize),
      taskKeys: identities.slice(offset, offset + shardSize),
    });
  }
  return {
    blastRadius,
    maxTasksPerShard: shardSize,
    taskCount: tasks.length,
    shards,
  };
}

export function formatAffectedTaskShardMarker(
  plan,
  taskCgroupMemoryMaxMb = null,
) {
  const cgroup =
    taskCgroupMemoryMaxMb == null
      ? ""
      : ` taskCgroupMemoryMaxMb=${taskCgroupMemoryMaxMb}`;
  return (
    `AFFECTED_TASK_SHARDS class=${plan.blastRadius.kind} reason=${plan.blastRadius.reason} ` +
    `tasks=${plan.taskCount} shards=${plan.shards.length} maxTasksPerShard=${plan.maxTasksPerShard}${cgroup}`
  );
}

/**
 * Collapse every inherited/test-runner worker spelling into one global ceiling.
 *
 * Vitest 4 reads VITEST_MAX_WORKERS, while older/config-specific paths still set
 * VITEST_MAX_FORKS or VITEST_MAX_THREADS. The green checkpoint deliberately exports only the
 * latter two as its two-fork safety rail. Taking the minimum keeps any pre-set ceiling binding;
 * an affected-tests-specific value may tighten that rail but can never silently widen it.
 */
export function resolveGlobalWorkerBudget({
  affectedWorkerBudget,
  vitestMaxWorkers,
  vitestMaxForks,
  vitestMaxThreads,
  fallback,
}) {
  const candidates = [
    ["AFFECTED_GLOBAL_WORKER_BUDGET", affectedWorkerBudget],
    ["VITEST_MAX_WORKERS", vitestMaxWorkers],
    ["VITEST_MAX_FORKS", vitestMaxForks],
    ["VITEST_MAX_THREADS", vitestMaxThreads],
  ].flatMap(([name, value]) =>
    value == null || value === "" ? [] : [positiveInteger(value, name)],
  );
  if (candidates.length === 0) return positiveInteger(fallback, "fallback");
  return Math.min(...candidates);
}

/**
 * Size one scheduler memory token from the largest credible per-worker ceiling.
 *
 * The child inherits NODE_OPTIONS, so a V8 old-space pin is part of its possible footprint even
 * when AFFECTED_WORKER_MEMORY_MB is unset. Treat the explicit estimate and the inherited heap as
 * lower bounds rather than alternatives: an override may add native/RSS headroom, but it must not
 * make a 4 GiB heap look like a 1 GiB worker to the global admission budget.
 */
export function resolveWorkerMemoryMb({
  affectedWorkerMemoryMb,
  nodeOptions,
  fallback,
}) {
  const candidates = [positiveInteger(fallback, "fallback")];
  if (affectedWorkerMemoryMb != null && affectedWorkerMemoryMb !== "") {
    candidates.push(
      positiveInteger(affectedWorkerMemoryMb, "AFFECTED_WORKER_MEMORY_MB"),
    );
  }
  const heapPattern =
    /(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s+)(\d+)(?=\s|$)/g;
  for (const match of String(nodeOptions ?? "").matchAll(heapPattern)) {
    candidates.push(
      positiveInteger(match[1], "NODE_OPTIONS max-old-space-size"),
    );
  }
  return Math.max(...candidates);
}

/**
 * Headroom held back from MemAvailable before any worker token is paid for.
 *
 * EI-20801764054303492 route (a): the STARTUP budget ({@link resolveMemoryBudgetMb}) and the
 * PER-ADMISSION re-check ({@link admissibleWorkersForMemory}) must reserve the same slice, or the
 * two rails disagree about what "available" means and the run oscillates between them. Exported
 * as one constant so a future tuning change cannot move one and leave the other behind.
 *
 * It is also the ONLY thing standing in for memory a just-admitted child has not yet allocated:
 * a worker's 4 GiB heap materialises over its first minutes, so a reading taken right after an
 * admission still reports that memory as available. See the conservatism note on
 * {@link admissibleWorkersForMemory}.
 */
export const MEMORY_RESERVE_FRACTION = 0.25;

/**
 * Resolve the memory envelope that worker tokens are admitted against.
 *
 * WI-39472: the caller's default used to be `workerBudget * workerMemoryMb`, which made
 * `memoryWorkerBudget` identically equal to `workerBudget` — so the `Math.min` in
 * {@link resolveTaskBudget} could never bind and the memory rail was INERT. Nothing failed
 * loudly; the gate simply had no memory-awareness at all, which is why its concurrency had to
 * be pinned at a hardcoded worst-case 2 (green-checkpoint.ts:4588-4610 records the 8 -> 4 -> 2
 * walk, each step taken after a real OOM). A live clamp is the precondition for ever raising
 * that ceiling again: with it, a quiet box runs wide and a loaded box is throttled instead of
 * OOM-killed.
 *
 * MemAvailable, never MemFree/os.freemem(): free memory excludes reclaimable page cache and
 * reads catastrophically low on any box that has been up for a while, which would throttle the
 * scheduler to a single worker for no reason.
 *
 * SAFETY: the result is `min(ceiling, usable)`, so this can only ever LOWER the admitted budget
 * relative to the previous behaviour — it can never widen it. The floor of one worker's worth
 * keeps `memoryWorkerBudget >= 1`, so a memory-starved host still makes progress serially
 * rather than tripping the "cannot admit one token" throw.
 */
export function resolveMemoryBudgetMb({
  affectedGlobalMemoryMb,
  memAvailableMb,
  taskCgroupMemoryMaxMb,
  workerBudget,
  workerMemoryMb,
  reserveFraction = MEMORY_RESERVE_FRACTION,
  cgroupReserveFraction = MEMORY_RESERVE_FRACTION,
}) {
  const perWorker = positiveInteger(workerMemoryMb, "workerMemoryMb");
  const ceiling = positiveInteger(workerBudget, "workerBudget") * perWorker;
  const configured =
    affectedGlobalMemoryMb != null && affectedGlobalMemoryMb !== ""
      ? positiveInteger(affectedGlobalMemoryMb, "AFFECTED_GLOBAL_MEMORY_MB")
      : ceiling;
  // WI-41206: the MemAvailable reading no longer reduces the envelope. An explicit
  // AFFECTED_GLOBAL_MEMORY_MB override (handled above) is still honoured — that is an operator
  // deliberately setting a budget, which is the opposite of the machine imposing one.
  //
  // reserveFraction is still VALIDATED even though it no longer narrows anything: it is a public
  // argument, and silently ignoring a nonsensical value is exactly the failure mode that lets a
  // caller believe a budget is in force when it is not.
  if (!(reserveFraction >= 0 && reserveFraction < 1)) {
    throw new Error(
      `reserveFraction must be in [0, 1); received ${String(reserveFraction)}`,
    );
  }
  if (!(cgroupReserveFraction >= 0 && cgroupReserveFraction < 1)) {
    throw new Error(
      `cgroupReserveFraction must be in [0, 1); received ${String(cgroupReserveFraction)}`,
    );
  }
  void memAvailableMb;
  if (taskCgroupMemoryMaxMb == null || taskCgroupMemoryMaxMb === "")
    return configured;
  const cgroupMax = nonNegativeInteger(
    taskCgroupMemoryMaxMb,
    "taskCgroupMemoryMaxMb",
  );
  const cgroupBudget = Math.floor(cgroupMax * (1 - cgroupReserveFraction));
  if (cgroupBudget < perWorker) {
    throw new Error(
      `task cgroup memory.max=${cgroupMax}MB leaves ${cgroupBudget}MB after reserve, ` +
        `below one workerMemoryMb=${perWorker}MB token; refusing before launch`,
    );
  }
  return Math.min(configured, cgroupBudget);
}

/**
 * Resolve the single resource envelope shared by every concurrently-running task.
 * Memory is represented as tokens per worker: the scheduler never admits more worker
 * tokens than either the worker ceiling OR the memory ceiling can pay for.
 */
export function resolveTaskBudget({
  workerBudget,
  memoryBudgetMb,
  workerMemoryMb,
  maxConcurrentTasks = 2,
  reserveWorkers = 1,
  taskCgroupPidsMax = null,
  pidsPerConcurrentTask = PIDS_PER_CONCURRENT_TASK,
  pidsReserve = PIDS_RESERVE,
}) {
  const configuredWorkerBudget = positiveInteger(workerBudget, "workerBudget");
  const configuredMemoryBudgetMb = positiveInteger(
    memoryBudgetMb,
    "memoryBudgetMb",
  );
  const configuredWorkerMemoryMb = positiveInteger(
    workerMemoryMb,
    "workerMemoryMb",
  );
  const configuredMaxConcurrentTasks = positiveInteger(
    maxConcurrentTasks,
    "maxConcurrentTasks",
  );
  const configuredReserveWorkers = positiveInteger(
    reserveWorkers,
    "reserveWorkers",
  );
  const configuredPidsPerConcurrentTask = positiveInteger(
    pidsPerConcurrentTask,
    "pidsPerConcurrentTask",
  );
  const configuredPidsReserve = nonNegativeInteger(pidsReserve, "pidsReserve");
  const configuredTaskCgroupPidsMax =
    taskCgroupPidsMax == null || taskCgroupPidsMax === ""
      ? null
      : nonNegativeInteger(taskCgroupPidsMax, "taskCgroupPidsMax");
  const memoryWorkerBudget = Math.floor(
    configuredMemoryBudgetMb / configuredWorkerMemoryMb,
  );
  if (memoryWorkerBudget < 1) {
    throw new Error(
      `memoryBudgetMb=${configuredMemoryBudgetMb} cannot admit one ` +
        `workerMemoryMb=${configuredWorkerMemoryMb} token`,
    );
  }
  const effectiveWorkerBudget = Math.min(
    configuredWorkerBudget,
    memoryWorkerBudget,
  );
  let pidsMaxConcurrentTasks = null;
  if (configuredTaskCgroupPidsMax != null) {
    const usablePids = configuredTaskCgroupPidsMax - configuredPidsReserve;
    pidsMaxConcurrentTasks = Math.floor(
      usablePids / configuredPidsPerConcurrentTask,
    );
    if (pidsMaxConcurrentTasks < 1) {
      throw new Error(
        `task cgroup pids.max=${configuredTaskCgroupPidsMax} leaves ${Math.max(0, usablePids)} ` +
          `after pidsReserve=${configuredPidsReserve}, below one ` +
          `pidsPerConcurrentTask=${configuredPidsPerConcurrentTask} envelope; refusing before launch`,
      );
    }
  }
  const effectiveMaxConcurrentTasks = Math.min(
    configuredMaxConcurrentTasks,
    pidsMaxConcurrentTasks ?? configuredMaxConcurrentTasks,
  );
  const parallel =
    effectiveWorkerBudget > configuredReserveWorkers &&
    effectiveMaxConcurrentTasks > 1;

  return {
    workerBudget: configuredWorkerBudget,
    memoryBudgetMb: configuredMemoryBudgetMb,
    workerMemoryMb: configuredWorkerMemoryMb,
    memoryWorkerBudget,
    // EI-20801764054303492: WHICH term bound the budget. Without this, a gate log records the
    // resolved concurrency but not the reason for it, so the next incident has to re-derive the
    // whole chain from source to learn whether the memory rail engaged at all — which is exactly
    // how the rail stayed INERT unnoticed long enough to force the 8 -> 4 -> 2 fork walk.
    // 'memory' means the host measurement is what held concurrency down (raising the ceiling
    // would change nothing); 'ceiling' means the configured ceiling is binding and memory had
    // headroom to spare. Read this BEFORE proposing a ceiling change.
    boundBy: memoryWorkerBudget < configuredWorkerBudget ? "memory" : "ceiling",
    effectiveWorkerBudget,
    maxConcurrentTasks: effectiveMaxConcurrentTasks,
    configuredMaxConcurrentTasks,
    pidsMaxConcurrentTasks,
    taskCgroupPidsMax: configuredTaskCgroupPidsMax,
    pidsPerConcurrentTask: configuredPidsPerConcurrentTask,
    pidsReserve: configuredPidsReserve,
    taskBoundBy:
      effectiveMaxConcurrentTasks < configuredMaxConcurrentTasks
        ? "pids"
        : "ceiling",
    reserveWorkers: configuredReserveWorkers,
    mode: parallel ? "parallel" : "serial",
    primaryWorkers: parallel
      ? effectiveWorkerBudget - configuredReserveWorkers
      : effectiveWorkerBudget,
    reserveLaneWorkers: parallel ? configuredReserveWorkers : 0,
  };
}

/**
 * How many worker tokens the host can pay for RIGHT NOW, from a fresh MemAvailable reading.
 *
 * EI-20801764054303492 route (a). The startup budget is resolved from a SINGLE reading taken
 * before any child exists, and a gate run lasts ~55 minutes on a box shared with a large agent
 * fleet — so by the time the tenth task is admitted, the reading the whole run's concurrency
 * rests on can be an hour stale and describe a machine that no longer exists. Re-measuring at
 * each admission is what makes "a quiet box runs wide, a loaded box throttles" actually TRUE,
 * rather than "the box was quiet once, so we run wide regardless".
 *
 * SAFETY — this can only ever LOWER admission, never widen it: the result is clamped by the
 * lane's configured width, which was itself already clamped by the startup budget. A missing or
 * unreadable measurement returns the lane width unchanged, so a non-Linux host or a /proc read
 * failure degrades to exactly the previous behaviour instead of throttling to one worker.
 *
 * FLOOR of one: a host that cannot pay for a single token still makes progress serially. The
 * alternative — refusing admission — would deadlock a run that is already under memory pressure,
 * which is the worst possible moment to stop making forward progress.
 *
 * ⚠ KNOWN CONSERVATISM GAP: a child's heap materialises over its first minutes, so a reading
 * taken moments after an admission still counts that memory as available. {@link
 * MEMORY_RESERVE_FRACTION} is the headroom standing in for it. Modelling the unrealised
 * remainder would need a per-child ramp estimate this scheduler does not have, and guessing it
 * wrong throttles a healthy box — so the gap is documented rather than approximated.
 */
export function admissibleWorkersForMemory({
  laneWorkers,
  workerMemoryMb,
  memAvailableMb,
  reserveFraction = MEMORY_RESERVE_FRACTION,
}) {
  const configuredLaneWorkers = positiveInteger(laneWorkers, "laneWorkers");
  // WI-41206 / remove-memory-derived-work-refusals-2026-08-24: memory NO LONGER narrows the
  // lane. This function used to return min(configured, floor(usable / perWorker)).
  //
  // The reasoning that survives: a reading is an OBSERVATION, not a configuration value, and
  // this scheduler was already the best-behaved memory consumer in the tree — it PACED rather
  // than refusing, precisely because "refusing admission would deadlock a run that is already
  // under memory pressure". The owner's call is that the same argument extends one step: a
  // host driven into paging should get SLOWER on its own, from actual contention, rather than
  // from us pre-emptively narrowing the lane on a snapshot that is stale the moment it is read.
  //
  // The arguments are retained (call sites unchanged) and the measurement is still logged via
  // `memAvailableMb=` in the stats line, so the concurrency decision stays auditable.
  // reserveFraction stays VALIDATED for the same reason as in resolveMemoryBudgetMb: silently
  // ignoring a nonsensical public argument lets a caller believe a limit is in force.
  if (!(reserveFraction >= 0 && reserveFraction < 1)) {
    throw new Error(
      `reserveFraction must be in [0, 1); received ${String(reserveFraction)}`,
    );
  }
  void memAvailableMb;
  void workerMemoryMb;
  return configuredLaneWorkers;
}

const finiteEstimate = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

function pendingTask(task, index, estimateMs) {
  return { task, index, estimateMs: finiteEstimate(estimateMs) };
}

/** Pick the longest KNOWN task. Unknowns retain declaration order. */
function takeLongest(pending) {
  let chosen = 0;
  let best = -1;
  for (let i = 0; i < pending.length; i++) {
    const estimate = pending[i].estimateMs;
    if (estimate != null && estimate > best) {
      best = estimate;
      chosen = i;
    }
  }
  return pending.splice(chosen, 1)[0];
}

/** Pick the shortest KNOWN task for the reserved lane. Unknowns retain declaration order. */
function takeShortest(pending) {
  let chosen = -1;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < pending.length; i++) {
    const estimate = pending[i].estimateMs;
    if (estimate != null && estimate < best) {
      best = estimate;
      chosen = i;
    }
  }
  if (chosen < 0) chosen = 0;
  return pending.splice(chosen, 1)[0];
}

/**
 * Run tasks under one global worker+memory envelope.
 *
 * In parallel mode the primary lane consumes all but the reserved worker tokens and
 * selects longest-first. The reserved lane consumes the remaining tokens and selects
 * shortest-first. This overlaps fixed per-leg overhead and short guards without ever
 * multiplying a per-workspace cap. A one-worker/memory-token budget collapses to serial.
 * Results are returned in declaration order regardless of completion order.
 */
export async function runBudgetedTasks(tasks, options) {
  const budget = resolveTaskBudget(options);
  const estimateMs = options.estimateMs ?? (() => null);
  const runTask = options.runTask;
  if (typeof runTask !== "function")
    throw new Error("runTask must be a function");
  // EI-20801764054303492 route (a): an OPT-IN live reading. Absent ⇒ every allocation below is
  // byte-identical to the pre-clamp scheduler, which is the back-compat contract every existing
  // caller and test relies on. Present ⇒ admission re-checks memory and may only ever admit LESS.
  const readMemAvailableMb =
    typeof options.readMemAvailableMb === "function"
      ? options.readMemAvailableMb
      : null;

  const pending = tasks.map((task, index) =>
    pendingTask(task, index, estimateMs(task, index)),
  );
  const results = new Array(tasks.length);
  let activeWorkers = 0;
  let activeTasks = 0;
  let observedMaxWorkers = 0;
  let observedMaxMemoryMb = 0;
  let observedMaxTasks = 0;
  let firstError = null;
  let admissions = 0;
  // null (not 0) when no reader was supplied: "nobody measured" and "measured zero times" are
  // different facts, and the marker below distinguishes them by exactly this null.
  let memoryReadings = readMemAvailableMb ? 0 : null;
  let admissionClamps = 0;
  let minAdmittedWorkers = null;
  let lastMemAvailableMb = null;

  const clampByMemory = (laneWorkers) => {
    let reading;
    try {
      reading = readMemAvailableMb();
    } catch {
      // A THROWING instrument is a broken instrument, never a report of "no memory left". Admit
      // the unclamped lane width: a probe bug must not throttle a healthy box to one worker.
      return laneWorkers;
    }
    memoryReadings += 1;
    const measured = reading == null ? Number.NaN : Number(reading);
    lastMemAvailableMb = Number.isFinite(measured) ? measured : null;
    const admitted = admissibleWorkersForMemory({
      laneWorkers,
      workerMemoryMb: budget.workerMemoryMb,
      memAvailableMb: reading,
    });
    if (admitted < laneWorkers) admissionClamps += 1;
    return admitted;
  };

  // Re-measure before every admission EXCEPT the run's first: the startup reading that sized the
  // budget is still fresh at that point, so re-reading it there would add noise without adding
  // information. Every later admission is racing children whose heaps have grown since it.
  //
  // ⚠ LOAD-BEARING COMPOSITION — the first admission is UNMEASURED, so on its own this clamp does
  // NOT protect it: at an 8-worker/4GiB config that admission is 32GiB, the exact shape
  // green-checkpoint records as OOM-killing this box. It is safe ONLY because the STARTUP budget
  // is itself sized from a fresh reading (resolveMemoryBudgetMb, wired in affected-tests.mjs and
  // source-pinned by the WI-39472 guards), so a box that is already short on memory never reaches
  // admission #0 with a wide budget. Weaken that startup sizing and you silently unprotect the
  // first admission — the two halves only work together (EI-20801764054303492).
  const admitWorkersFor = (laneWorkers) => {
    if (!readMemAvailableMb) return laneWorkers;
    const admitted =
      admissions === 0 ? laneWorkers : clampByMemory(laneWorkers);
    minAdmittedWorkers =
      minAdmittedWorkers == null
        ? admitted
        : Math.min(minAdmittedWorkers, admitted);
    return admitted;
  };

  const runOne = async (entry, lane, workers) => {
    const memoryMb = workers * budget.workerMemoryMb;
    admissions += 1;
    activeWorkers += workers;
    activeTasks += 1;
    observedMaxWorkers = Math.max(observedMaxWorkers, activeWorkers);
    observedMaxMemoryMb = Math.max(
      observedMaxMemoryMb,
      activeWorkers * budget.workerMemoryMb,
    );
    observedMaxTasks = Math.max(observedMaxTasks, activeTasks);
    if (
      activeWorkers > budget.effectiveWorkerBudget ||
      activeWorkers * budget.workerMemoryMb > budget.memoryBudgetMb ||
      activeTasks > budget.maxConcurrentTasks
    ) {
      throw new Error(
        "budgeted task scheduler admitted work beyond its configured ceiling",
      );
    }
    const allocation = { lane, workers, memoryMb };
    try {
      const value = await runTask(entry.task, allocation, entry.index);
      results[entry.index] = {
        task: entry.task,
        index: entry.index,
        allocation,
        value,
      };
    } catch (error) {
      firstError ??= error;
      throw error;
    } finally {
      activeWorkers -= workers;
      activeTasks -= 1;
    }
  };

  const runLane = async (lane, workers, take) => {
    while (pending.length > 0 && firstError == null) {
      const entry = take(pending);
      await runOne(entry, lane, admitWorkersFor(workers));
    }
  };

  if (budget.mode === "parallel" && pending.length > 1) {
    // Promise.all rejects before its siblings settle. A task failure must instead stop NEW
    // admission, drain the child already running in the other lane, and only then reject so the
    // caller never tears down while an unobserved child is still writing output/history.
    const lanes = await Promise.allSettled([
      runLane("primary", budget.primaryWorkers, takeLongest),
      runLane("reserved", budget.reserveLaneWorkers, takeShortest),
    ]);
    const rejected = lanes.find((lane) => lane.status === "rejected");
    if (rejected) throw rejected.reason;
  } else {
    await runLane("serial", budget.effectiveWorkerBudget, takeLongest);
  }

  return {
    results,
    stats: {
      ...budget,
      observedMaxWorkers,
      observedMaxMemoryMb,
      observedMaxTasks,
      memoryReadings,
      admissionClamps,
      minAdmittedWorkers,
      lastMemAvailableMb,
    },
  };
}

/** Run deterministic shards sequentially while preserving declaration-order results. */
export async function runBudgetedTaskShards(plan, options) {
  if (!plan?.shards?.length) {
    throw new Error(
      "runBudgetedTaskShards requires at least one planned shard",
    );
  }
  const results = [];
  let aggregate = null;
  const shardStats = [];
  for (const shard of plan.shards) {
    const run = await runBudgetedTasks(shard.tasks, options);
    shardStats.push({
      index: shard.index,
      taskCount: shard.tasks.length,
      ...run.stats,
    });
    for (const entry of run.results)
      results.push({ ...entry, index: results.length });
    if (!aggregate) {
      aggregate = { ...run.stats };
      continue;
    }
    aggregate.observedMaxWorkers = Math.max(
      aggregate.observedMaxWorkers,
      run.stats.observedMaxWorkers,
    );
    aggregate.observedMaxMemoryMb = Math.max(
      aggregate.observedMaxMemoryMb,
      run.stats.observedMaxMemoryMb,
    );
    aggregate.observedMaxTasks = Math.max(
      aggregate.observedMaxTasks,
      run.stats.observedMaxTasks,
    );
    aggregate.admissionClamps += run.stats.admissionClamps;
    aggregate.memoryReadings =
      aggregate.memoryReadings == null || run.stats.memoryReadings == null
        ? null
        : aggregate.memoryReadings + run.stats.memoryReadings;
    aggregate.minAdmittedWorkers =
      aggregate.minAdmittedWorkers == null
        ? run.stats.minAdmittedWorkers
        : run.stats.minAdmittedWorkers == null
          ? aggregate.minAdmittedWorkers
          : Math.min(
              aggregate.minAdmittedWorkers,
              run.stats.minAdmittedWorkers,
            );
    aggregate.lastMemAvailableMb = run.stats.lastMemAvailableMb;
  }
  return { results, stats: aggregate, shardStats, shardPlan: plan };
}

export function emptyDurationHistory() {
  return { version: DURATION_HISTORY_VERSION, tasks: {} };
}

export function readDurationHistory(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed?.version !== DURATION_HISTORY_VERSION ||
      !parsed.tasks ||
      typeof parsed.tasks !== "object"
    ) {
      // EI-20806073740910935: a silent discard here is indistinguishable from
      // "first run, no history yet" — and it disarms every watchdog bound for
      // the whole run. Say WHY the history was thrown away.
      process.stderr.write(
        `[budgeted-task-scheduler] duration history at ${path} DISCARDED: ` +
          `version=${JSON.stringify(parsed?.version)} (want ${DURATION_HISTORY_VERSION}), ` +
          `tasks=${parsed?.tasks ? typeof parsed.tasks : "missing"} — starting empty\n`,
      );
      return emptyDurationHistory();
    }
    return parsed;
  } catch (err) {
    // ENOENT is the expected first-run case and stays quiet. ANYTHING else
    // (EMFILE/EIO/EACCES/parse error on a present file) silently disarmed the
    // watchdog estimator for an entire gate run on 2026-08-18 (run 10, all 36
    // progress lines durationEstimateMs=unknown while the file was valid) —
    // EI-20806073740910935. A single loud line makes the next occurrence
    // self-diagnosing.
    if (err?.code !== "ENOENT") {
      process.stderr.write(
        `[budgeted-task-scheduler] duration history READ FAILED at ${path}: ` +
          `${err?.code ?? err?.name ?? "error"} ${err?.message ?? ""} — starting empty ` +
          `(EI-20806073740910935: all duration estimates will print unknown this run)\n`,
      );
    }
    return emptyDurationHistory();
  }
}

export function durationEstimate(history, key) {
  return finiteEstimate(history?.tasks?.[key]?.durationMs);
}

/**
 * The estimate the WATCHDOG BOUND must use — never the bare EWMA.
 *
 * EI-20803703725014949: operator-core::test:lane-stateful is BIMODAL (~7min vs
 * ~45min, both honest completions). An EWMA of a bimodal distribution settles
 * between the modes and describes neither, so a mostly-fast history collapses
 * the batch timeout to its floor and a legitimate slow-mode finish then races
 * a timer set at exactly its own duration — the "coin flip" the policy comment
 * in affected-tests.mjs explicitly forbids. Worse, a SIGKILLed leg records
 * elapsed≈timeout into the EWMA, so the estimate oscillates around the
 * coin-flip regime instead of ever escaping it (measured ~50% kill rate).
 *
 * A watchdog cares about the honest WORST case, not the typical case: take the
 * max of the EWMA and the decayed peak. Ordering keeps using durationEstimate
 * (the EWMA) — typical cost is the right input for scheduling.
 */
export function timeoutDurationEstimate(history, key) {
  const entry = history?.tasks?.[key];
  const ewma = finiteEstimate(entry?.durationMs);
  const peak = finiteEstimate(entry?.peakMs);
  if (ewma == null && peak == null) return null;
  return Math.max(ewma ?? 0, peak ?? 0);
}

/**
 * Per-run decay for the recorded peak: slow enough that one honest slow-mode
 * completion protects roughly the next dozen runs (0.9^12 ≈ 0.28), fast enough
 * that a one-off pathological outlier does not pin the timeout forever.
 */
const PEAK_DECAY_PER_RUN = 0.9;

/** Keep a small EWMA so one loaded run informs ordering without pinning it forever. */
export function mergeDurationHistory(
  history,
  observations,
  now = new Date().toISOString(),
) {
  const next = {
    version: DURATION_HISTORY_VERSION,
    tasks: { ...(history?.tasks ?? {}) },
  };
  for (const observation of observations) {
    const durationMs = finiteEstimate(observation?.durationMs);
    const key = typeof observation?.key === "string" ? observation.key : "";
    if (!key || durationMs == null) continue;
    const prior = next.tasks[key];
    const samples =
      Number.isSafeInteger(prior?.samples) && prior.samples > 0
        ? prior.samples
        : 0;
    // A legacy entry has no peakMs; seed the decay base from its EWMA rather
    // than 0 so an upgrade never *lowers* an existing task's effective bound.
    const priorPeak =
      finiteEstimate(prior?.peakMs) ?? finiteEstimate(prior?.durationMs) ?? 0;
    next.tasks[key] = {
      durationMs:
        samples > 0
          ? Math.round(prior.durationMs * 0.75 + durationMs * 0.25)
          : Math.round(durationMs),
      peakMs: Math.max(
        Math.round(durationMs),
        Math.round(priorPeak * PEAK_DECAY_PER_RUN),
      ),
      samples: samples + 1,
      updatedAt: now,
    };
  }
  return next;
}

/** Write via same-directory rename: readers see either the old complete JSON or the new one. */
export function writeDurationHistoryAtomic(
  path,
  history,
  nonce = `${process.pid}-${Date.now()}`,
) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${nonce}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function formatTaskBudgetMarker(
  stats,
  prefix = "AFFECTED_TESTS_SCHEDULER",
) {
  // EI-20801764054303492 step 3: report the memory term and WHICH term bound, so a gate run's
  // concurrency decision is readable from its own log instead of re-derived from source. Both are
  // derived defensively rather than required, so a hand-built stats object (tests, older callers)
  // still formats. `memAvailableMb` is appended only when the caller measured it — its absence is
  // meaningful ("no measurement"), so it is omitted rather than printed as 0 or null.
  const boundBy =
    stats.boundBy ??
    (stats.memoryWorkerBudget < stats.workerBudget ? "memory" : "ceiling");
  const measured =
    stats.memAvailableMb == null
      ? ""
      : ` memAvailableMb=${stats.memAvailableMb}`;
  const cgroup =
    stats.taskCgroupMemoryMaxMb == null
      ? ""
      : ` taskCgroupMemoryMaxMb=${stats.taskCgroupMemoryMaxMb}`;
  const pids =
    stats.taskCgroupPidsMax == null
      ? ""
      : ` configuredMaxTasks=${stats.configuredMaxConcurrentTasks ?? stats.maxConcurrentTasks}` +
        ` pidsMaxTasks=${stats.pidsMaxConcurrentTasks ?? stats.maxConcurrentTasks}` +
        ` taskBoundBy=${stats.taskBoundBy ?? "ceiling"}` +
        ` taskCgroupPidsMax=${stats.taskCgroupPidsMax}` +
        ` pidsPerTask=${stats.pidsPerConcurrentTask ?? PIDS_PER_CONCURRENT_TASK}` +
        ` pidsReserve=${stats.pidsReserve ?? PIDS_RESERVE}`;
  return (
    `${prefix} mode=${stats.mode} workerBudget=${stats.workerBudget} ` +
    `memoryBudgetMb=${stats.memoryBudgetMb} workerMemoryMb=${stats.workerMemoryMb} ` +
    `effectiveWorkers=${stats.effectiveWorkerBudget} maxTasks=${stats.maxConcurrentTasks} ` +
    `reserveWorkers=${stats.reserveWorkers} memoryWorkers=${stats.memoryWorkerBudget} ` +
    `boundBy=${boundBy}${measured}${cgroup}${pids}`
  );
}

export function formatTaskBudgetObservedMarker(stats) {
  // EI-20801764054303492 route (a): the per-admission clamp is only trustworthy if a run can say
  // whether it actually measured anything and whether that measurement ever bit. Appended ONLY
  // when a reader was wired (memoryReadings != null) — a hand-built stats object, and every
  // caller that passes no reader, keeps the exact legacy string.
  const admission =
    stats.memoryReadings == null
      ? ""
      : ` memReadings=${stats.memoryReadings} clamps=${stats.admissionClamps} ` +
        `minAdmittedWorkers=${stats.minAdmittedWorkers}`;
  return (
    `AFFECTED_TESTS_SCHEDULER_OBSERVED maxWorkers=${stats.observedMaxWorkers} ` +
    `maxMemoryMb=${stats.observedMaxMemoryMb} maxTasks=${stats.observedMaxTasks}${admission}`
  );
}
