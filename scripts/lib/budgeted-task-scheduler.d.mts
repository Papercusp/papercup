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
  mode: "parallel" | "serial";
  primaryWorkers: number;
  reserveLaneWorkers: number;
}

export interface TaskAllocation {
  lane: "primary" | "reserved" | "serial";
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

export function resolveTaskBudget(input: TaskBudgetInput): ResolvedTaskBudget;

export function runBudgetedTasks<Task, Value>(
  tasks: Task[],
  options: TaskBudgetInput & {
    estimateMs?: (task: Task, index: number) => number | null | undefined;
    runTask: (
      task: Task,
      allocation: TaskAllocation,
      index: number,
    ) => Value | Promise<Value>;
  },
): Promise<BudgetedTaskRun<Task, Value>>;

export function emptyDurationHistory(): DurationHistory;

export function readDurationHistory(path: string): DurationHistory;

export function durationEstimate(
  history: DurationHistory,
  key: string,
): number | null;

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

export function formatTaskBudgetObservedMarker(
  stats: TaskSchedulerStats,
): string;
