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
  /** Hard memory.max of the current task cgroup, when finite. */
  taskCgroupMemoryMaxMb?: number | string | null;
}

export interface TaskAllocation {
  lane: 'primary' | 'reserved' | 'serial';
  workers: number;
  memoryMb: number;
}

/**
 * What `formatTaskBudgetObservedMarker` ACCEPTS. The admission terms are optional here on
 * purpose: the formatter is deliberately defensive so a hand-built stats object (tests, older
 * callers) still renders the legacy marker string. That tolerance is a real part of the
 * contract, so it is stated in the type rather than left to a runtime `?? `.
 */
export interface TaskSchedulerObserved extends ResolvedTaskBudget {
  observedMaxWorkers: number;
  observedMaxMemoryMb: number;
  observedMaxTasks: number;
  memoryReadings?: number | null;
  admissionClamps?: number | null;
  minAdmittedWorkers?: number | null;
  lastMemAvailableMb?: number | null;
}

/**
 * What `runBudgetedTasks` PRODUCES — the same shape with every admission term REQUIRED, because
 * a real run always populates all four. Keeping them required here is what stops a future
 * change from silently dropping one and under-reporting the clamp.
 */
export interface TaskSchedulerStats extends TaskSchedulerObserved {
  /**
   * How many times admission re-measured available memory, or `null` when no
   * `readMemAvailableMb` was supplied. `null` and `0` are DIFFERENT facts — "nobody measured"
   * vs "a reader was wired but never consulted" — and `formatTaskBudgetObservedMarker`
   * distinguishes them by exactly this null (EI-20801764054303492).
   */
  memoryReadings: number | null;
  /** Admissions the memory reading narrowed below the lane width. */
  admissionClamps: number;
  /** Narrowest width ever admitted, or `null` when no reader was supplied. */
  minAdmittedWorkers: number | null;
  /** Last finite reading, or `null` when unread/unreadable. */
  lastMemAvailableMb: number | null;
}

export function formatTaskBudgetObservedMarker(stats: TaskSchedulerObserved): string;

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

export interface AffectedBlastRadius {
  kind: 'scoped' | 'near-tree-wide';
  reason: 'path-closure' | 'root-manifest-or-config' | 'all-requested' | 'derivation-degraded';
  triggerPaths: string[];
}

export interface AffectedTaskShard<Task> {
  index: number;
  tasks: Task[];
  taskKeys: string[];
}

export interface AffectedTaskShardPlan<Task> {
  blastRadius: AffectedBlastRadius;
  maxTasksPerShard: number;
  taskCount: number;
  shards: Array<AffectedTaskShard<Task>>;
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
  taskCgroupMemoryMaxMb?: number | string | null;
  workerBudget: number | string;
  workerMemoryMb: number | string;
  reserveFraction?: number;
  cgroupReserveFraction?: number;
}): number;

export function readTaskCgroupMemoryMaxMb(input?: {
  readFile?: (path: string, encoding: string) => string | Buffer;
  procCgroupPath?: string;
  cgroupRoot?: string;
}): number | null;

export function classifyAffectedBlastRadius(input?: {
  changedPaths?: string[];
  runAll?: boolean;
  derivationDegraded?: boolean;
}): AffectedBlastRadius;

export function planAffectedTaskShards<Task>(
  tasks: Task[],
  options?: {
    blastRadius?: AffectedBlastRadius;
    maxTasksPerShard?: number | string;
    taskKey?: (task: Task, index: number) => string | number;
  },
): AffectedTaskShardPlan<Task>;

export function formatAffectedTaskShardMarker(
  plan: AffectedTaskShardPlan<unknown>,
  taskCgroupMemoryMaxMb?: number | null,
): string;

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
    /**
     * OPT-IN live memory reading, consulted before every admission after the run's first.
     * ABSENT ⇒ allocations are byte-identical to the pre-clamp scheduler (the back-compat
     * contract). Present ⇒ admission may only ever admit FEWER workers, never more. A reader
     * that returns null/non-finite, or throws, leaves the lane width unchanged: a broken
     * instrument must not read as "no memory" (EI-20801764054303492).
     */
    readMemAvailableMb?: () => number | null | undefined;
    runTask: (task: Task, allocation: TaskAllocation, index: number) => Value | Promise<Value>;
  },
): Promise<BudgetedTaskRun<Task, Value>>;

export function runBudgetedTaskShards<Task, Value>(
  plan: AffectedTaskShardPlan<Task>,
  options: TaskBudgetInput & {
    estimateMs?: (task: Task, index: number) => number | null | undefined;
    readMemAvailableMb?: () => number | null | undefined;
    runTask: (task: Task, allocation: TaskAllocation, index: number) => Value | Promise<Value>;
  },
): Promise<BudgetedTaskRun<Task, Value> & {
  shardStats: Array<TaskSchedulerStats & { index: number; taskCount: number }>;
  shardPlan: AffectedTaskShardPlan<Task>;
}>;

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
