/**
 * fs-watcher-leak-sweep — repair for a Node fs.watch handle leak (EI-255).
 *
 * Node (verified on v22.21.1 + v25.9.0): `fs.watch()` allocates the native
 * FSEvent handle in the FSWatcher constructor, then `start()` throws (e.g.
 * ENOENT when the path vanished between scan and watch) WITHOUT closing the
 * handle — the FSEvent stays registered in V8's global handles forever, and
 * the throw means no caller ever holds the FSWatcher to close it. chokidar
 * swallows exactly this throw (`createFsWatchInstance` try/catch), so every
 * watch-a-vanished-path race leaks one handle triple (FSEventWrap + FSWatcher
 * + Stats). On the dev box (git-sync + agent churn under watched dirs every
 * minute) this accumulated ~21.6k dead handles in 2h18m — the dominant
 * in-heap retainer behind EI-127/EI-79.
 *
 * The repair: a failed-start watcher is precisely identifiable —
 * `watcher._handle.initialized === false`. A healthy watcher flips
 * `initialized` true synchronously inside fs.watch before it returns, and a
 * closed one nulls `_handle` synchronously, so nothing live matches the
 * predicate. `FSWatcher.close()` on the orphan releases the native handle on
 * the next loop tick (verified: counts drop in getActiveResourcesInfo).
 *
 * Callers run this periodically (harness-fs-watcher's 60s reconcile). Upstream
 * Node fix would be `start()` closing the handle on throw — until then this
 * sweep keeps the population flat.
 */

interface LeakSweepResult {
  /** FSWatcher handles inspected. */
  scanned: number;
  /** Orphaned (start-failed) watchers closed. */
  closed: number;
}

interface FsWatcherLike {
  close(): void;
  _handle?: { initialized?: boolean } | null;
}

export function sweepLeakedFsWatchers(): LeakSweepResult {
  const result: LeakSweepResult = { scanned: 0, closed: 0 };
  // Internal API, stable since Node 0.x and used by why-is-node-running et al.
  const getHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })
    ._getActiveHandles;
  if (typeof getHandles !== 'function') return result;
  for (const h of getHandles.call(process)) {
    const ctor = (h as { constructor?: { name?: string } } | null)?.constructor?.name;
    if (ctor !== 'FSWatcher') continue;
    result.scanned += 1;
    const w = h as FsWatcherLike;
    if (w._handle && w._handle.initialized === false) {
      try {
        w.close();
        result.closed += 1;
      } catch {
        /* a racing close — fine, the handle is going away either way */
      }
    }
  }
  return result;
}
