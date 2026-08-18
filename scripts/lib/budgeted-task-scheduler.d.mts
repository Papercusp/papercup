export interface TaskBudgetInput {
  workerBudget: number | string;
  memoryBudgetMb: number | string;
  workerMemoryMb: number | string;
  maxConcurrentTasks?: number | string;
  reserveWorkers?: number | string;
}

export interface ResolvedTaskBudget {
  workerBudget: number;
  memoryBudgetMb: number;
  workerMemoryMb: number;
  memoryWorkerBudget: number;
  effectiveWorkerBudget: number;
  maxConcurrentTasks: number;
  reserveWorkers: number;
  mode: 'parallel' | 'serial';
  primaryWorkers: number;
  reserveLaneWorkers: number;
  /**
   * Which constraint actually bound the budget. `resolveTaskBudget` always sets it
   * (budgeted-task-scheduler.mjs:140), but `formatTaskBudgetMarker` re-derives it with a
   * `??` fallback for stats objects assembled elsewhere — so it is optional here to keep
   * both callers representable.
   */
  boundBy?: 'memory' | 'ceiling';
  /**
   * The measured available memory, present only when the caller measured it — its
   * ABSENCE is meaningful (the marker omits the field rather than printing a guess), so
   * this is nullable as well as optional.
   */
  memAvailableMb?: number | string | null;
}

export interface TaskAllocation {
  lane: 'primary' | 'reserved' | 'serial';
  workers: number;
  memoryMb: number;
}

export interface TaskSchedulerStats extends ResolvedTaskBudget {
  observedMaxWorkers: number;
  observedMaxMemoryMb: number;
  observedMaxTasks: number;
}

export interface ScheduledTaskResult<Task, Value> {
  task: Task;
  index: number;
  allocation: TaskAllocation;
  value: Value;
}

export interface BudgetedTaskRun<Task, Value> {
  results: Array<ScheduledTaskResult<Task, Awaited<Value>>>;
  stats: TaskSchedulerStats;
}

export interface DurationHistoryEntry {
  durationMs: number;
  samples: number;
  updatedAt: string;
  /**
   * Decayed high-water duration. OPTIONAL because a legacy entry written before the peak was
   * tracked has no `peakMs`, and every reader (timeoutDurationEstimate, mergeDurationHistory)
   * treats a missing value as "seed from the EWMA" rather than zero.
   */
  peakMs?: number;
}

export interface DurationHistory {
  version: number;
  tasks: Record<string, DurationHistoryEntry>;
}

export const DURATION_HISTORY_VERSION: number;

export function resolveGlobalWorkerBudget(input: {
  affectedWorkerBudget?: number | string;
  vitestMaxWorkers?: number | string;
  vitestMaxForks?: number | string;
  vitestMaxThreads?: number | string;
  fallback: number | string;
}): number;

export function resolveWorkerMemoryMb(input: {
  affectedWorkerMemoryMb?: number | string;
  nodeOptions?: string;
  fallback: number | string;
}): number;

/**
 * Headroom held back from MemAvailable before any worker token is paid for — shared by the
 * startup budget (resolveMemoryBudgetMb) and the per-admission re-check
 * (admissibleWorkersForMemory) so the two rails cannot drift apart (EI-20801764054303492).
 */
export const MEMORY_RESERVE_FRACTION: number;

export function resolveMemoryBudgetMb(input: {
  affectedGlobalMemoryMb?: number | string;
  memAvailableMb?: number | string | null;
  workerBudget: number | string;
  workerMemoryMb: number | string;
  reserveFraction?: number;
}): number;

export function resolveTaskBudget(input: TaskBudgetInput): ResolvedTaskBudget;

/**
 * Per-admission memory re-check: clamps a lane's worker count to what the measured
 * MemAvailable (minus the reserve fraction) can afford. A missing/broken reading returns the
 * configured lane width unchanged — an instrument failure must never read as "no memory".
 */
export function admissibleWorkersForMemory(input: {
  laneWorkers: number | string;
  workerMemoryMb: number | string;
  memAvailableMb?: number | string | null;
  reserveFraction?: number;
}): number;

export function runBudgetedTasks<Task, Value>(
  tasks: Task[],
  options: TaskBudgetInput & {
    estimateMs?: (task: Task, index: number) => number | null | undefined;
    runTask: (task: Task, allocation: TaskAllocation, index: number) => Value | Promise<Value>;
  },
): Promise<BudgetedTaskRun<Task, Value>>;

export function emptyDurationHistory(): DurationHistory;

export function readDurationHistory(path: string): DurationHistory;

export function durationEstimate(history: DurationHistory, key: string): number | null;

/**
 * Like {@link durationEstimate}, but for sizing a TIMEOUT rather than for ordering: it returns
 * the max of the EWMA and the decayed peak, so a bimodal task's slow mode keeps its headroom
 * through a run of fast completions.
 */
export function timeoutDurationEstimate(history: DurationHistory, key: string): number | null;

export function mergeDurationHistory(
  history: DurationHistory,
  observations: Array<{ key: string; durationMs: number }>,
  now?: string,
): DurationHistory;

export function writeDurationHistoryAtomic(
  path: string,
  history: DurationHistory,
  nonce?: string,
): void;

export function formatTaskBudgetMarker(
  stats: ResolvedTaskBudget,
  prefix?: string,
): string;

export function formatTaskBudgetObservedMarker(stats: TaskSchedulerStats): string;
