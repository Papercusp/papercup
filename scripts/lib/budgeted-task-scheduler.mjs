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
    effectiveWorkerBudget,
    maxConcurrentTasks: configuredMaxConcurrentTasks,
    reserveWorkers: configuredReserveWorkers,
    mode: parallel ? 'parallel' : 'serial',
    primaryWorkers: parallel ? effectiveWorkerBudget - configuredReserveWorkers : effectiveWorkerBudget,
    reserveLaneWorkers: parallel ? configuredReserveWorkers : 0,
  };
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

  const pending = tasks.map((task, index) => pendingTask(task, index, estimateMs(task, index)));
  const results = new Array(tasks.length);
  let activeWorkers = 0;
  let activeTasks = 0;
  let observedMaxWorkers = 0;
  let observedMaxMemoryMb = 0;
  let observedMaxTasks = 0;

  const runOne = async (entry, lane, workers) => {
    const memoryMb = workers * budget.workerMemoryMb;
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
    } finally {
      activeWorkers -= workers;
      activeTasks -= 1;
    }
  };

  const runLane = async (lane, workers, take) => {
    while (pending.length > 0) {
      const entry = take(pending);
      await runOne(entry, lane, workers);
    }
  };

  if (budget.mode === 'parallel' && pending.length > 1) {
    await Promise.all([
      runLane('primary', budget.primaryWorkers, takeLongest),
      runLane('reserved', budget.reserveLaneWorkers, takeShortest),
    ]);
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
      return emptyDurationHistory();
    }
    return parsed;
  } catch {
    return emptyDurationHistory();
  }
}

export function durationEstimate(history, key) {
  return finiteEstimate(history?.tasks?.[key]?.durationMs);
}

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
    next.tasks[key] = {
      durationMs: samples > 0 ? Math.round(prior.durationMs * 0.75 + durationMs * 0.25) : Math.round(durationMs),
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
  return (
    `${prefix} mode=${stats.mode} workerBudget=${stats.workerBudget} ` +
    `memoryBudgetMb=${stats.memoryBudgetMb} workerMemoryMb=${stats.workerMemoryMb} ` +
    `effectiveWorkers=${stats.effectiveWorkerBudget} maxTasks=${stats.maxConcurrentTasks} ` +
    `reserveWorkers=${stats.reserveWorkers}`
  );
}

export function formatTaskBudgetObservedMarker(stats) {
  return (
    `AFFECTED_TESTS_SCHEDULER_OBSERVED maxWorkers=${stats.observedMaxWorkers} ` +
    `maxMemoryMb=${stats.observedMaxMemoryMb} maxTasks=${stats.observedMaxTasks}`
  );
}
