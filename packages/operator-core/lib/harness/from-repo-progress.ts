/**
 * from-repo-progress — REAL per-step progress for the long create
 * (hive-from-repo-hardening-2026-06-11 P-008).
 *
 * The HTTP route transport has no progress projection (checked: define-route
 * carries none), so per the item's fallback design the composition records
 * step transitions HERE — an in-process store — and each write fires
 * `notifySyncInvalidate('hiveFromRepo.progress', { progressId })` so the
 * form's `useSyncQuery` re-fetches over the EXISTING sync channel (SSE-driven,
 * no polling, the house data-sync rule). The client mints the progressId and
 * subscribes BEFORE submitting, so no event is ever missed.
 *
 * In-process by design: the resolver runs in the same Hono host as the route.
 * Rows are transient UX, not state — capped + TTL-swept, never persisted.
 */

export type FromRepoStep = 'lookup' | 'clone' | 'detect' | 'create' | 'publish';
export type FromRepoStepStatus = 'running' | 'done' | 'error' | 'skipped';

export interface FromRepoProgressRow {
  step: FromRepoStep;
  status: FromRepoStepStatus;
  ts: number;
}

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 200;

// Process-global (the route + resolver share the module instance).
const store = new Map<string, { rows: FromRepoProgressRow[]; touched: number }>();

function sweep(now: number): void {
  if (store.size <= MAX_ENTRIES) {
    for (const [id, e] of store) if (now - e.touched > TTL_MS) store.delete(id);
    return;
  }
  // Over cap: drop oldest first.
  const byAge = [...store.entries()].sort((a, b) => a[1].touched - b[1].touched);
  for (const [id] of byAge.slice(0, store.size - MAX_ENTRIES)) store.delete(id);
}

/** Record a step transition + fire the sync invalidate (best-effort). */
export function recordFromRepoStep(
  progressId: string,
  step: FromRepoStep,
  status: FromRepoStepStatus,
): void {
  if (!progressId) return;
  const now = Date.now();
  sweep(now);
  const entry = store.get(progressId) ?? { rows: [], touched: now };
  entry.rows.push({ step, status, ts: now });
  entry.touched = now;
  store.set(progressId, entry);
  // Lazy import avoids a cycle (sync-sse pulls broad operator infra).
  void import('../sync-sse')
    .then(({ notifySyncInvalidate }) => notifySyncInvalidate('hiveFromRepo.progress', { progressId }))
    .catch(() => {});
}

/** The transitions so far, oldest first (the resolver's rows). */
export function getFromRepoProgress(progressId: string): FromRepoProgressRow[] {
  const entry = store.get(progressId);
  if (!entry) return [];
  entry.touched = Date.now();
  return [...entry.rows];
}

/** Test seam. */
export function __resetFromRepoProgress(): void {
  store.clear();
}
