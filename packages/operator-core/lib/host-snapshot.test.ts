/**
 * host-snapshot tests (bash-to-tool-substitution-2026-07-26, P-026 + P-027).
 *
 * D-028 is the standing warning behind this file: a green unit suite does NOT
 * mean a new surface works — P-023 shipped `logs:read` with 59 passing tests
 * that stayed green THROUGH two real defects. So these tests deliberately pin
 * the properties that would make the fold WRONG rather than merely absent:
 *  • an unreadable leg must be ABSENT, never a fabricated 0 (a 0 free-memory
 *    percentage reads as "the box is out of RAM", the opposite of "unknown");
 *  • `now` must be a real ISO-8601 UTC instant, because the whole P-027 claim is
 *    that every other requested format is a pure rendering of it;
 *  • it must never throw, because it rides on every orient.
 * The live-system check that a green suite cannot give is recorded on WI-6316.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** What the mocked `/proc/pressure/memory` read does next. A function so a test
 *  can make it throw (the unreadable case) or return a chosen payload; a counter
 *  so the cache assertions can see the real read count. `node:fs` is mocked at
 *  module scope because an ESM namespace export cannot be spied (the repo's
 *  existing idiom — see release/origin-freshness-watchdog.test.ts). */
let psiRead: () => string;
let psiReadCount = 0;
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: (...args: unknown[]) => {
    const p = String(args[0]);
    if (p === '/proc/pressure/memory') {
      psiReadCount += 1;
      return psiRead();
    }
    return (importOriginalSync() as typeof import('node:fs')).readFileSync(...(args as [never]));
  },
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const importOriginalSync = () => require('node:fs');

const { getHostSnapshot, resetHostSnapshotCache, PSI_CACHE_MS } = await import('./host-snapshot');

describe('getHostSnapshot', () => {
  beforeEach(() => {
    resetHostSnapshotCache();
    psiReadCount = 0;
    psiRead = () => 'some avg10=1.00 avg60=2.50 avg300=0.10 total=1\nfull avg10=0.00\n';
  });
  afterEach(() => {
    vi.useRealTimers();
    resetHostSnapshotCache();
  });

  it('always carries a parseable ISO-8601 UTC instant', () => {
    const snap = getHostSnapshot();
    expect(snap.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // The P-027 claim is that this one string determines every format the corpus
    // asks for — so it must round-trip to the same instant it was built from.
    expect(new Date(snap.now).toISOString()).toBe(snap.now);
    expect(Math.abs(Date.now() - new Date(snap.now).getTime())).toBeLessThan(5_000);
  });

  it('reports the load triple and free-memory percentage from the live host', () => {
    const snap = getHostSnapshot();
    // On any platform Node supports, loadavg() and totalmem() answer. These are
    // the `uptime` / `free -h` replacements, so a missing one is a real defect.
    expect(snap.load).toHaveLength(3);
    for (const v of snap.load!) expect(Number.isFinite(v)).toBe(true);
    expect(snap.memFreePct).toBeGreaterThanOrEqual(0);
    expect(snap.memFreePct).toBeLessThanOrEqual(100);
    expect(snap.memTotalGb).toBeGreaterThan(0);
  });

  it('answers `nproc` with a positive effective core count', () => {
    const snap = getHostSnapshot();
    expect(snap.cores).toBeGreaterThan(0);
    expect(Number.isInteger(snap.cores)).toBe(true);
  });

  it('parses the psi avg60 out of the pressure line', () => {
    const snap = getHostSnapshot();
    expect(snap.psiMemSome60).toBe(2.5);
  });

  it('OMITS psi rather than reporting 0 when the pressure file cannot be read', () => {
    // The defect this guards: a fabricated 0 means "no memory pressure", which is
    // the exact opposite of "I could not tell" — and the watchdog alarms on this
    // same signal, so a false 0 here would contradict a live alarm.
    psiRead = () => {
      throw new Error('ENOENT');
    };
    resetHostSnapshotCache();
    const snap = getHostSnapshot();
    expect(snap).not.toHaveProperty('psiMemSome60');
    // ...and the rest of the snapshot still arrives — one dead leg must not
    // degrade the others, because this rides on every orient.
    expect(snap.now).toBeTruthy();
    expect(snap.cores).toBeGreaterThan(0);
    expect(snap.load).toHaveLength(3);
  });

  it('OMITS psi rather than guessing when the line is unparseable', () => {
    psiRead = () => 'garbage without an avg60 field\n';
    resetHostSnapshotCache();
    expect(getHostSnapshot()).not.toHaveProperty('psiMemSome60');
  });

  it('caches the pressure read instead of re-reading it per orient', () => {
    const a = getHostSnapshot();
    const b = getHostSnapshot();
    expect(a.psiMemSome60).toBe(2.5);
    expect(b.psiMemSome60).toBe(2.5);
    expect(psiReadCount).toBe(1);
  });

  it('re-reads pressure once the cache window has elapsed', () => {
    vi.useFakeTimers();
    resetHostSnapshotCache();
    getHostSnapshot();
    vi.advanceTimersByTime(PSI_CACHE_MS + 1);
    getHostSnapshot();
    expect(psiReadCount).toBe(2);
  });

  it('never throws when the pressure leg fails', () => {
    psiRead = () => {
      throw new Error('boom');
    };
    resetHostSnapshotCache();
    expect(() => getHostSnapshot()).not.toThrow();
    expect(getHostSnapshot().now).toBeTruthy();
  });
});
