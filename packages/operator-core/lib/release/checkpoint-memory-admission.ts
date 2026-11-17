/**
 * Checkpoint launch compatibility receipt.
 *
 * Checkpoint runs have no aggregate RAM admission ceiling. A per-scope maximum
 * is a ceiling, not memory reserved by an idle run, and must not prevent another
 * root from starting. The former half-of-physical-RAM budget, small-run
 * allowance and deferred-run reservations have been removed.
 *
 * Both launch seams keep this receipt so existing result/log consumers remain
 * compatible. Per-run scope limits are managed separately in systemd-scope.
 */

/** Historical small-suite scope size; used by the scope-sizing regression. */
export const CHECKPOINT_SMALL_RUN_MAX_G = 8;

export type CheckpointAdmissionReason =
  | 'admitted-unbounded'
  // Historical reasons remain readable in persisted launch receipts.
  | 'admitted'
  | 'admitted-sole-run'
  | 'admitted-unmeasurable'
  | 'admitted-disabled'
  | 'admitted-small-run'
  | 'over-budget';

export interface CheckpointMemoryAdmission {
  admit: boolean;
  reason: CheckpointAdmissionReason;
  /** The caller's per-run scope size, not a reservation. */
  requestG: number;
  /** No commitment scan is performed; null explicitly means unmeasured. */
  committedG: number | null;
  /** null means there is no aggregate budget. */
  budgetG: number | null;
  scopes: number | null;
  unbounded: number | null;
  reservedG?: number;
  detail: string;
}

/**
 * Admit every checkpoint run without scanning peers or reserving host memory.
 * Legacy environment settings and root keys are accepted for caller compatibility;
 * neither can restore the removed aggregate RAM gate.
 */
export function admitCheckpointMemory(opts: {
  requestG: number;
  key?: string;
  env?: NodeJS.ProcessEnv;
}): CheckpointMemoryAdmission {
  return {
    admit: true,
    reason: 'admitted-unbounded',
    requestG: opts.requestG,
    committedG: null,
    budgetG: null,
    scopes: null,
    unbounded: null,
    detail: `checkpoint-memory: admitting run (scope ceiling ${opts.requestG} GiB); aggregate RAM admission is unbounded`,
  };
}
