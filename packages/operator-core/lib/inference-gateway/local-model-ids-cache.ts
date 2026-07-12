/**
 * A SYNC-readable snapshot of the registered LOCAL-backend model ids, for fuzzyEnum arg validation
 * (generic-tool-arg-fuzzy-validation-2026-07-03, D-001). `listLocalBackends` is an async PG read,
 * but zod arg validation must be sync to work through EVERY validation path — so this keeps a
 * per-workspace snapshot refreshed out-of-band and hands it out synchronously.
 *
 * Cold start / stale ⇒ the snapshot is empty and fuzzyEnum FAILS OPEN (never a false reject); the
 * first read kicks a background refresh that populates it for subsequent calls. The set is the
 * enumerable ground truth a typo'd ornith model id is matched against.
 *
 * WI-4395: this used to be a SINGLE module-global snapshot, refreshed via a bare
 * `listLocalBackends()` call that let `activeWorkspaceId()` re-resolve the workspace from
 * whatever ALS context happened to be live when the fire-and-forget `.then()` callback ran —
 * called from inside a zod schema's `superRefine` (not a tool handler), several async hops away
 * from the resolved `ctx.workspaceId` a real handler receives. Net effect: `gateway:local_backend_list`
 * (which threads `ctx.workspaceId` straight through) found a genuinely-registered backend, while
 * this snapshot stayed permanently empty for that same session — the mechanism's only live
 * consumer (fleet:launch-on-plan `model`) silently never rejected a bad local/ornith model id.
 * Fix: capture `activeWorkspaceId()` SYNCHRONOUSLY at the `localModelIdsSync()` call site (still
 * within the caller's own synchronous stack — no async hop, no ALS-timing ambiguity) and key the
 * cache BY workspace, so one workspace's resolution can never serve (or starve) another's.
 */
import { listLocalBackends } from './local-backend-store';
import { activeWorkspaceId } from '../workspace-registry';

interface WorkspaceSnapshot {
  models: string[];
  lastRefreshAt: number;
}

const snapshots = new Map<string, WorkspaceSnapshot>();
const REFRESH_TTL_MS = 30_000;

function entryFor(ws: string): WorkspaceSnapshot {
  let e = snapshots.get(ws);
  if (!e) {
    e = { models: [], lastRefreshAt: 0 };
    snapshots.set(ws, e);
  }
  return e;
}

/** Kick a debounced background refresh for `ws` when its snapshot is stale; returns immediately. */
function refreshSoon(ws: string): void {
  const entry = entryFor(ws);
  const now = Date.now();
  if (now - entry.lastRefreshAt < REFRESH_TTL_MS) return;
  entry.lastRefreshAt = now; // debounce even if the load fails
  void listLocalBackends({ workspaceId: ws })
    .then((backends) => {
      entry.models = [...new Set(backends.flatMap((b) => b.models))];
    })
    .catch(() => {
      /* fail-open: keep the previous snapshot; retry after the TTL */
    });
}

/**
 * SYNC list of registered local-backend model ids for the CALLER's workspace (the fuzzyEnum
 * resolver for a `model` arg). `activeWorkspaceId()` is read synchronously right here — the same
 * call site zod's `superRefine` invokes this from, still inside the original request's stack —
 * so it can never drift from what a real tool handler would resolve for the same call. Kicks a
 * background refresh and returns the current snapshot — empty until the first refresh lands, so
 * fuzzyEnum fails open rather than reject a real model before the gateway registry is loaded.
 */
export function localModelIdsSync(): string[] {
  const ws = activeWorkspaceId();
  refreshSoon(ws);
  return entryFor(ws).models;
}

/** Test seam: await one refresh so a test can assert against a known registry. */
export async function __refreshLocalModelIdsForTests(): Promise<string[]> {
  const ws = activeWorkspaceId();
  const entry = entryFor(ws);
  // refreshSoon fires-and-forgets; do the awaited load directly for determinism. Stamp
  // lastRefreshAt on the way out (success OR failure) so an immediately-following
  // localModelIdsSync() call in the same test doesn't see a stale timestamp and kick a
  // SECOND, unawaited refresh that races/consumes a test's next mocked response.
  try {
    entry.models = [...new Set((await listLocalBackends({ workspaceId: ws })).flatMap((b) => b.models))];
  } catch {
    /* leave snapshot as-is */
  } finally {
    entry.lastRefreshAt = Date.now();
  }
  return entry.models;
}

/** Test seam: drop every cached workspace snapshot (isolate tests from each other). */
export function __resetLocalModelIdsCacheForTests(): void {
  snapshots.clear();
}
