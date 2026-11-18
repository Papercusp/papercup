export const TASK_DEADLINE_EPOCH_MS_ENV: 'PAPERCUSP_TASK_DEADLINE_EPOCH_MS';
export const TASK_DEADLINE_REFUSAL_MARKER: 'TASK_DEADLINE_REFUSAL';

export function readTaskDeadlineEpochMs(env?: Record<string, unknown>): number | null;

export interface TaskDeadlineEstimate {
  remainingMs: number;
  knownEstimateMs: number;
  knownTasks: number;
  unknownTasks: number;
}

export function formatTaskDeadlineRefusal(estimate: TaskDeadlineEstimate): string;
export function isTaskDeadlineRefusal(error: unknown): boolean;

export function admitTaskDeadline(options?: {
  env?: Record<string, unknown>;
  nowMs?: number;
  knownEstimateMs?: number;
  cleanupReserveMs?: number;
  knownTasks?: number;
  unknownTasks?: number;
}): {
  deadlineEpochMs: number | null;
  remainingMs: number | null;
  knownEstimateMs: number;
  cleanupReserveMs: number;
  childCutoffEpochMs: number | null;
};
