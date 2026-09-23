/**
 * rubrics:amend receipts (review-system-rework-reduction-2026-09-23 P-008, clause
 * RSR-P-008-C: "rubrics:amend that would exceed its timeout returns a pollable
 * receipt"; falsifier: "the caller receives a timeout error with an unknown commit
 * state").
 *
 * WHY. An acceptance-BAR amendment rebinds contracts and invalidates evidence
 * atomically, and it can run past the MCP transport deadline: in the 14 days before
 * this change 18 amends timed out (8 beyond 50s, the longest 223s) and 11 more
 * succeeded only after 30s. A timed-out caller could not tell whether the amendment
 * had landed, so the safe next step (re-read, compare, maybe retry) cost several
 * round-trips and sometimes a duplicate attempt.
 *
 * WHAT THIS HOLDS. The outcome of each amend the handler started, keyed by its
 * idempotency key, so `rubrics:amend-status` can answer running / committed /
 * failed while the operator process that ran it is alive.
 *
 * ⚠ PROCESS-LOCAL, like in-flight-calls.ts, and deliberately so. The DURABLE truth
 * for a BAR-changing amendment is its subject-plan Decision carrying
 * `Amendment-Id: <key>` (findAmendmentDecisionByKey), which commits atomically with
 * the rubric revision. This registry only adds what durable state cannot say —
 * "still running" and "failed with this error" — and both of those die with the
 * process anyway: an amendment in flight across a restart rolls back, which is
 * exactly the not-committed case a same-key retry handles safely. Entries are
 * bounded by age and count so a long-lived process cannot accumulate them.
 */
import { pinModuleState } from '@papercusp/module-singleton';

export type AmendReceiptState = 'running' | 'committed' | 'failed';

export interface AmendReceiptEntry {
  idempotencyKey: string;
  rubricRef: string;
  state: AmendReceiptState;
  startedAt: number;
  finishedAt?: number;
  /** The exact JSON payload the synchronous call would have returned. */
  result?: Record<string, unknown>;
  error?: string;
}

/** How long a finished outcome stays readable. Long enough for a caller to poll
 *  after a slow amend; a running entry is kept until it settles. */
export const AMEND_RECEIPT_RETENTION_MS = 60 * 60 * 1000;
/** Hard ceiling on retained entries; the oldest finished ones go first. */
const MAX_ENTRIES = 500;

const state = pinModuleState('@papercusp/operator-core.rubrics-amend-receipts', () => ({
  entries: new Map<string, AmendReceiptEntry>(),
}));

function sweep(now: number): void {
  for (const [key, entry] of state.entries) {
    if (entry.state !== 'running' && entry.finishedAt !== undefined && now - entry.finishedAt > AMEND_RECEIPT_RETENTION_MS) {
      state.entries.delete(key);
    }
  }
  if (state.entries.size <= MAX_ENTRIES) return;
  const finished = [...state.entries.values()]
    .filter((entry) => entry.state !== 'running')
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  for (const entry of finished) {
    if (state.entries.size <= MAX_ENTRIES) break;
    state.entries.delete(entry.idempotencyKey);
  }
}

/**
 * Record an amend the handler started and track it to completion. `run` resolves
 * with the payload the synchronous call returns; an `ok:false` payload (no such
 * rubric) and a thrown error are both recorded as failed.
 */
export function trackAmendRun(
  idempotencyKey: string,
  rubricRef: string,
  run: Promise<Record<string, unknown>>,
  now: number = Date.now(),
): Promise<Record<string, unknown>> {
  sweep(now);
  const entry: AmendReceiptEntry = { idempotencyKey, rubricRef, state: 'running', startedAt: now };
  state.entries.set(idempotencyKey, entry);
  return run.then(
    (result) => {
      entry.finishedAt = Date.now();
      entry.result = result;
      entry.state = result.ok === true ? 'committed' : 'failed';
      if (entry.state === 'failed') entry.error = typeof result.error === 'string' ? result.error : 'amend returned ok:false';
      return result;
    },
    (error: unknown) => {
      entry.finishedAt = Date.now();
      entry.state = 'failed';
      entry.error = error instanceof Error ? error.message : String(error);
      throw error;
    },
  );
}

export function getAmendReceipt(idempotencyKey: string): AmendReceiptEntry | undefined {
  return state.entries.get(idempotencyKey.trim());
}

export function __resetAmendReceiptsForTest(): void {
  state.entries.clear();
}
