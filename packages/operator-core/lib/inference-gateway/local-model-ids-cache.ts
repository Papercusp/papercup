/**
 * A SYNC-readable snapshot of the registered LOCAL-backend model ids, for fuzzyEnum arg validation
 * (generic-tool-arg-fuzzy-validation-2026-07-03, D-001). `listLocalBackends` is an async PG read,
 * but zod arg validation must be sync to work through EVERY validation path — so this keeps a
 * module-level snapshot refreshed out-of-band and hands it out synchronously.
 *
 * Cold start / stale ⇒ the snapshot is empty and fuzzyEnum FAILS OPEN (never a false reject); the
 * first read kicks a background refresh that populates it for subsequent calls. The set is the
 * enumerable ground truth a typo'd ornith model id is matched against.
 */
import { listLocalBackends } from './local-backend-store';

let snapshot: string[] = [];
let lastRefreshAt = 0;
const REFRESH_TTL_MS = 30_000;

/** Kick a debounced background refresh when the snapshot is stale; returns immediately. */
function refreshSoon(): void {
  const now = Date.now();
  if (now - lastRefreshAt < REFRESH_TTL_MS) return;
  lastRefreshAt = now; // debounce even if the load fails
  void listLocalBackends()
    .then((backends) => {
      snapshot = [...new Set(backends.flatMap((b) => b.models))];
    })
    .catch(() => {
      /* fail-open: keep the previous snapshot; retry after the TTL */
    });
}

/**
 * SYNC list of registered local-backend model ids (the fuzzyEnum resolver for a `model` arg). Kicks
 * a background refresh and returns the current snapshot — empty until the first refresh lands, so
 * fuzzyEnum fails open rather than reject a real model before the gateway registry is loaded.
 */
export function localModelIdsSync(): string[] {
  refreshSoon();
  return snapshot;
}

/** Test seam: await one refresh so a test can assert against a known registry. */
export async function __refreshLocalModelIdsForTests(): Promise<string[]> {
  lastRefreshAt = 0;
  refreshSoon();
  // refreshSoon fires-and-forgets; do the awaited load directly for determinism.
  try {
    snapshot = [...new Set((await listLocalBackends()).flatMap((b) => b.models))];
  } catch {
    /* leave snapshot as-is */
  }
  return snapshot;
}
