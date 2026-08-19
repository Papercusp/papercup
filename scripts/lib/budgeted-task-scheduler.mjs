import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DURATION_HISTORY_VERSION = 1;

const positiveInteger = (value, name) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer; received ${String(value)}`);
  }
  return parsed;
};

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
    ['AFFECTED_GLOBAL_WORKER_BUDGET', affectedWorkerBudget],
    ['VITEST_MAX_WORKERS', vitestMaxWorkers],
    ['VITEST_MAX_FORKS', vitestMaxForks],
    ['VITEST_MAX_THREADS', vitestMaxThreads],
  ].flatMap(([name, value]) => (value == null || value === '' ? [] : [positiveInteger(value, name)]));
  if (candidates.length === 0) return positiveInteger(fallback, 'fallback');
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
export function resolveWorkerMemoryMb({ affectedWorkerMemoryMb, nodeOptions, fallback }) {
  const candidates = [positiveInteger(fallback, 'fallback')];
  if (affectedWorkerMemoryMb != null && affectedWorkerMemoryMb !== '') {
    candidates.push(positiveInteger(affectedWorkerMemoryMb, 'AFFECTED_WORKER_MEMORY_MB'));
  }
  const heapPattern = /(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s+)(\d+)(?=\s|$)/g;
  for (const match of String(nodeOptions ?? '').matchAll(heapPattern)) {
    candidates.push(positiveInteger(match[1], 'NODE_OPTIONS max-old-space-size'));
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
  workerBudget,
  workerMemoryMb,
  reserveFraction = MEMORY_RESERVE_FRACTION,
}) {
  const perWorker = positiveInteger(workerMemoryMb, 'workerMemoryMb');
  if (affectedGlobalMemoryMb != null && affectedGlobalMemoryMb !== '') {
    return positiveInteger(affectedGlobalMemoryMb, 'AFFECTED_GLOBAL_MEMORY_MB');
  }
  const ceiling = positiveInteger(workerBudget, 'workerBudget') * perWorker;
  if (memAvailableMb == null || memAvailableMb === '') return ceiling;
  if (!(reserveFraction >= 0 && reserveFraction < 1)) {
    throw new Error(`reserveFraction must be in [0, 1); received ${String(reserveFraction)}`);
  }
  const usable = Math.floor(positiveInteger(memAvailableMb, 'memAvailableMb') * (1 - reserveFraction));
  return Math.max(perWorker, Math.min(ceiling, usable));
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
}) {
  const configuredWorkerBudget = positiveInteger(workerBudget, 'workerBudget');
  const configuredMemoryBudgetMb = positiveInteger(memoryBudgetMb, 'memoryBudgetMb');
  const configuredWorkerMemoryMb = positiveInteger(workerMemoryMb, 'workerMemoryMb');
  const configuredMaxConcurrentTasks = positiveInteger(maxConcurrentTasks, 'maxConcurrentTasks');
  const configuredReserveWorkers = positiveInteger(reserveWorkers, 'reserveWorkers');
  const memoryWorkerBudget = Math.floor(configuredMemoryBudgetMb / configuredWorkerMemoryMb);
  if (memoryWorkerBudget < 1) {
    throw new Error(
      `memoryBudgetMb=${configuredMemoryBudgetMb} cannot admit one ` +
        `workerMemoryMb=${configuredWorkerMemoryMb} token`,
    );
  }
  const effectiveWorkerBudget = Math.min(configuredWorkerBudget, memoryWorkerBudget);
  const parallel =
    effectiveWorkerBudget > configuredReserveWorkers && configuredMaxConcurrentTasks > 1;

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
    boundBy: memoryWorkerBudget < configuredWorkerBudget ? 'memory' : 'ceiling',
    effectiveWorkerBudget,
    maxConcurrentTasks: configuredMaxConcurrentTasks,
    reserveWorkers: configuredReserveWorkers,
    mode: parallel ? 'parallel' : 'serial',
    primaryWorkers: parallel ? effectiveWorkerBudget - configuredReserveWorkers : effectiveWorkerBudget,
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
  const configuredLaneWorkers = positiveInteger(laneWorkers, 'laneWorkers');
  if (memAvailableMb == null || memAvailableMb === '') return configuredLaneWorkers;
  const perWorker = positiveInteger(workerMemoryMb, 'workerMemoryMb');
  if (!(reserveFraction >= 0 && reserveFraction < 1)) {
    throw new Error(`reserveFraction must be in [0, 1); received ${String(reserveFraction)}`);
  }
  const measured = Number(memAvailableMb);
  // A reading is an OBSERVATION, not a configuration value: a negative or non-finite one means
  // the instrument is broken, and a broken instrument must not be read as "no memory" (that
  // would throttle a healthy box to one worker). Fall back to the unchanged lane width.
  if (!Number.isFinite(measured) || measured < 0) return configuredLaneWorkers;
  const usable = Math.floor(measured * (1 - reserveFraction));
  const affordable = Math.floor(usable / perWorker);
  return Math.max(1, Math.min(configuredLaneWorkers, affordable));
}

const finiteEstimate = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

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
  if (typeof runTask !== 'function') throw new Error('runTask must be a function');
  // EI-20801764054303492 route (a): an OPT-IN live reading. Absent ⇒ every allocation below is
  // byte-identical to the pre-clamp scheduler, which is the back-compat contract every existing
  // caller and test relies on. Present ⇒ admission re-checks memory and may only ever admit LESS.
  const readMemAvailableMb =
    typeof options.readMemAvailableMb === 'function' ? options.readMemAvailableMb : null;

  const pending = tasks.map((task, index) => pendingTask(task, index, estimateMs(task, index)));
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
  const admitWorkersFor = (laneWorkers) => {
    if (!readMemAvailableMb) return laneWorkers;
    const admitted = admissions === 0 ? laneWorkers : clampByMemory(laneWorkers);
    minAdmittedWorkers =
      minAdmittedWorkers == null ? admitted : Math.min(minAdmittedWorkers, admitted);
    return admitted;
  };

  const runOne = async (entry, lane, workers) => {
    const memoryMb = workers * budget.workerMemoryMb;
    admissions += 1;
    activeWorkers += workers;
    activeTasks += 1;
    observedMaxWorkers = Math.max(observedMaxWorkers, activeWorkers);
    observedMaxMemoryMb = Math.max(observedMaxMemoryMb, activeWorkers * budget.workerMemoryMb);
    observedMaxTasks = Math.max(observedMaxTasks, activeTasks);
    if (
      activeWorkers > budget.effectiveWorkerBudget ||
      activeWorkers * budget.workerMemoryMb > budget.memoryBudgetMb ||
      activeTasks > budget.maxConcurrentTasks
    ) {
      throw new Error('budgeted task scheduler admitted work beyond its configured ceiling');
    }
    const allocation = { lane, workers, memoryMb };
    try {
      const value = await runTask(entry.task, allocation, entry.index);
      results[entry.index] = { task: entry.task, index: entry.index, allocation, value };
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

  if (budget.mode === 'parallel' && pending.length > 1) {
    // Promise.all rejects before its siblings settle. A task failure must instead stop NEW
    // admission, drain the child already running in the other lane, and only then reject so the
    // caller never tears down while an unobserved child is still writing output/history.
    const lanes = await Promise.allSettled([
      runLane('primary', budget.primaryWorkers, takeLongest),
      runLane('reserved', budget.reserveLaneWorkers, takeShortest),
    ]);
    const rejected = lanes.find((lane) => lane.status === 'rejected');
    if (rejected) throw rejected.reason;
  } else {
    await runLane('serial', budget.effectiveWorkerBudget, takeLongest);
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

export function emptyDurationHistory() {
  return { version: DURATION_HISTORY_VERSION, tasks: {} };
}

export function readDurationHistory(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.version !== DURATION_HISTORY_VERSION || !parsed.tasks || typeof parsed.tasks !== 'object') {
      // EI-20806073740910935: a silent discard here is indistinguishable from
      // "first run, no history yet" — and it disarms every watchdog bound for
      // the whole run. Say WHY the history was thrown away.
      process.stderr.write(
        `[budgeted-task-scheduler] duration history at ${path} DISCARDED: ` +
          `version=${JSON.stringify(parsed?.version)} (want ${DURATION_HISTORY_VERSION}), ` +
          `tasks=${parsed?.tasks ? typeof parsed.tasks : 'missing'} — starting empty\n`,
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
    if (err?.code !== 'ENOENT') {
      process.stderr.write(
        `[budgeted-task-scheduler] duration history READ FAILED at ${path}: ` +
          `${err?.code ?? err?.name ?? 'error'} ${err?.message ?? ''} — starting empty ` +
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
export function mergeDurationHistory(history, observations, now = new Date().toISOString()) {
  const next = {
    version: DURATION_HISTORY_VERSION,
    tasks: { ...(history?.tasks ?? {}) },
  };
  for (const observation of observations) {
    const durationMs = finiteEstimate(observation?.durationMs);
    const key = typeof observation?.key === 'string' ? observation.key : '';
    if (!key || durationMs == null) continue;
    const prior = next.tasks[key];
    const samples = Number.isSafeInteger(prior?.samples) && prior.samples > 0 ? prior.samples : 0;
    // A legacy entry has no peakMs; seed the decay base from its EWMA rather
    // than 0 so an upgrade never *lowers* an existing task's effective bound.
    const priorPeak = finiteEstimate(prior?.peakMs) ?? finiteEstimate(prior?.durationMs) ?? 0;
    next.tasks[key] = {
      durationMs: samples > 0 ? Math.round(prior.durationMs * 0.75 + durationMs * 0.25) : Math.round(durationMs),
      peakMs: Math.max(Math.round(durationMs), Math.round(priorPeak * PEAK_DECAY_PER_RUN)),
      samples: samples + 1,
      updatedAt: now,
    };
  }
  return next;
}

/** Write via same-directory rename: readers see either the old complete JSON or the new one. */
export function writeDurationHistoryAtomic(path, history, nonce = `${process.pid}-${Date.now()}`) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${nonce}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function formatTaskBudgetMarker(stats, prefix = 'AFFECTED_TESTS_SCHEDULER') {
  // EI-20801764054303492 step 3: report the memory term and WHICH term bound, so a gate run's
  // concurrency decision is readable from its own log instead of re-derived from source. Both are
  // derived defensively rather than required, so a hand-built stats object (tests, older callers)
  // still formats. `memAvailableMb` is appended only when the caller measured it — its absence is
  // meaningful ("no measurement"), so it is omitted rather than printed as 0 or null.
  const boundBy =
    stats.boundBy ?? (stats.memoryWorkerBudget < stats.workerBudget ? 'memory' : 'ceiling');
  const measured =
    stats.memAvailableMb == null ? '' : ` memAvailableMb=${stats.memAvailableMb}`;
  return (
    `${prefix} mode=${stats.mode} workerBudget=${stats.workerBudget} ` +
    `memoryBudgetMb=${stats.memoryBudgetMb} workerMemoryMb=${stats.workerMemoryMb} ` +
    `effectiveWorkers=${stats.effectiveWorkerBudget} maxTasks=${stats.maxConcurrentTasks} ` +
    `reserveWorkers=${stats.reserveWorkers} memoryWorkers=${stats.memoryWorkerBudget} ` +
    `boundBy=${boundBy}${measured}`
  );
}

export function formatTaskBudgetObservedMarker(stats) {
  // EI-20801764054303492 route (a): the per-admission clamp is only trustworthy if a run can say
  // whether it actually measured anything and whether that measurement ever bit. Appended ONLY
  // when a reader was wired (memoryReadings != null) — a hand-built stats object, and every
  // caller that passes no reader, keeps the exact legacy string.
  const admission =
    stats.memoryReadings == null
      ? ''
      : ` memReadings=${stats.memoryReadings} clamps=${stats.admissionClamps} ` +
        `minAdmittedWorkers=${stats.minAdmittedWorkers}`;
  return (
    `AFFECTED_TESTS_SCHEDULER_OBSERVED maxWorkers=${stats.observedMaxWorkers} ` +
    `maxMemoryMb=${stats.observedMaxMemoryMb} maxTasks=${stats.observedMaxTasks}${admission}`
  );
}
