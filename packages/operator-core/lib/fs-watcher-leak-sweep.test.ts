/**
 * fs-watcher-leak-sweep (EI-255) — reproduces the Node fs.watch ENOENT handle
 * leak for real, then proves the sweep closes exactly the orphans and leaves
 * healthy watchers running.
 *
 * Assertions are on the sweep's contract over process._getActiveHandles()
 * (created in the SAME tick, so no GC/event-loop window can interfere), not
 * on global FSEventWrap resource counts — those proved environment-noisy
 * under vitest (an unstarted wrap can be collected in some GC windows; the
 * production accumulation EI-255 documents survived explicit GC for hours).
 */
import { mkdtempSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sweepLeakedFsWatchers } from './fs-watcher-leak-sweep';

const tick = () => new Promise<void>((r) => setImmediate(r));

/** Orphans (start-failed fs.watch handles) currently visible to a sweep. */
function visibleOrphans(): number {
  const handles = (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles();
  return handles.filter((h) => {
    const w = h as { constructor?: { name?: string }; _handle?: { initialized?: boolean } | null };
    return w?.constructor?.name === 'FSWatcher' && w._handle?.initialized === false;
  }).length;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try { fn(); } catch { /* already closed */ }
  }
});

describe('sweepLeakedFsWatchers (EI-255)', () => {
  it('closes every start-failed orphan and spares healthy watchers', async () => {
    sweepLeakedFsWatchers(); // drain anything earlier imports leaked

    const dir = mkdtempSync(join(tmpdir(), 'leak-sweep-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const healthy: FSWatcher = watch(dir, () => {});
    cleanups.push(() => healthy.close());

    // The leak: fs.watch on a missing path throws ENOENT but the FSEvent
    // handle is already allocated and never closed (chokidar swallows this
    // exact throw whenever a watched path vanishes mid-scan). Created and
    // swept in the SAME tick so nothing can collect them in between.
    let orphansMade = 0;
    for (let i = 0; i < 20; i++) {
      try {
        watch(join(dir, `missing-${i}`), () => {});
      } catch {
        orphansMade++; // the chokidar-style swallow
      }
    }
    expect(orphansMade).toBe(20);
    expect(visibleOrphans()).toBe(20); // the Node bug: throw left live handles

    const result = sweepLeakedFsWatchers();
    expect(result.closed).toBe(20);
    expect(result.scanned).toBeGreaterThanOrEqual(21); // orphans + healthy
    expect(visibleOrphans()).toBe(0);

    // Healthy watcher survived and still delivers events.
    const sawEvent = new Promise<void>((resolve) => {
      healthy.on('change', () => resolve());
    });
    await tick();
    writeFileSync(join(dir, 'touch.txt'), 'x');
    await sawEvent;
  });

  it('is a no-op when nothing leaked', () => {
    sweepLeakedFsWatchers();
    const again = sweepLeakedFsWatchers();
    expect(again.closed).toBe(0);
  });

  it('is idempotent — a second sweep right after finds nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leak-sweep2-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    try { watch(join(dir, 'gone'), () => {}); } catch { /* leak one */ }
    expect(sweepLeakedFsWatchers().closed).toBe(1);
    expect(sweepLeakedFsWatchers().closed).toBe(0);
  });
});
