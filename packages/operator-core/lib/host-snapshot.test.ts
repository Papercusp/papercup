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
/** `/proc/stat` fixture. Deliberately NULL by default so the interception is
 *  OPT-IN: the pre-existing tests above must keep reading the real file and stay
 *  byte-identical in behaviour, rather than being silently re-pointed at a
 *  fixture by a mock added for a later leg. */
let statRead: (() => string) | null = null;
let statReadCount = 0;
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: (...args: unknown[]) => {
    const p = String(args[0]);
    if (p === '/proc/pressure/memory') {
      psiReadCount += 1;
      return psiRead();
    }
    if (p === '/proc/stat' && statRead) {
      statReadCount += 1;
      return statRead();
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

  it('answers `nproc` with the MACHINE core count, not this process cgroup quota', async () => {
    // Caught live 2026-07-27: the operator runs under a systemd CPUQuota that
    // makes its effective core count 12 on a 128-core box. Reporting the
    // effective count is a different answer from the one `nproc` gives an agent
    // in its own shell, AND it misreads the load average by an order of
    // magnitude. Pin the machine count so a future "reuse the resource profile"
    // refactor cannot silently reintroduce it.
    const os = await import('node:os');
    const snap = getHostSnapshot();
    expect(snap.cores).toBe(os.cpus().length);
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

/**
 * `nowLocal` (EI-20086558925351815). `now` is UTC; every filesystem timestamp an
 * agent compares it against (`ls -la`, `stat`, journald) renders LOCAL, so on a
 * UTC-4 box a file written a minute ago reads four hours stale and "the job never
 * wrote to it" is the natural, wrong conclusion. It was filed 6× before the field
 * existed.
 *
 * Per this file's D-028 doctrine, presence is not the property worth pinning — a
 * WRONG local time is far more dangerous than a missing one, because it looks
 * like an answer. So the load-bearing test below reconstructs the instant from
 * the rendered wall-clock + the rendered offset and requires it to equal `now`.
 * That is what fails on a sign inversion, which is the live hazard here:
 * `getTimezoneOffset()` returns +240 for UTC-4, inverted from the ±HH:MM
 * convention every tool prints, so getting it backwards yields a perfectly
 * well-formed timestamp that is off by twice the offset.
 */
describe('getHostSnapshot().nowLocal', () => {
  beforeEach(() => {
    psiRead = () => 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0';
    resetHostSnapshotCache();
  });

  it('renders the wall clock with a zone and an explicit ±HH:MM offset', () => {
    expect(getHostSnapshot().nowLocal).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}( [A-Za-z0-9+\-]+)? \(UTC[+-]\d{2}:\d{2}\)$/,
    );
  });

  it('describes the SAME instant as `now` — the sign-inversion falsifier', () => {
    const { now, nowLocal } = getHostSnapshot();

    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}).*\(UTC([+-])(\d{2}):(\d{2})\)$/.exec(nowLocal);
    expect(m, `nowLocal did not parse: ${nowLocal}`).not.toBeNull();
    const [, date, time, sign, offHh, offMm] = m!;

    // Reconstruct UTC from what was RENDERED. If the offset sign were inverted,
    // this lands 2x the offset away from `now` and the assertion fails.
    const reconstructedMs = Date.parse(`${date}T${time}${sign}${offHh}:${offMm}`);
    expect(Number.isNaN(reconstructedMs)).toBe(false);

    // `now` carries ms and nowLocal is second-resolution, so allow the truncation
    // (and a tick, since the two fields are rendered from one captured nowMs).
    expect(Math.abs(reconstructedMs - Date.parse(now))).toBeLessThan(2000);
  });

  it('is present even when every optional leg is unavailable', () => {
    psiRead = () => {
      throw new Error('boom');
    };
    resetHostSnapshotCache();
    // An ABSENT local time would leave exactly the ambiguity the field removes,
    // so it is required rather than optional — unlike the measurement legs, it
    // is a rendering of `now` and has nothing to be unavailable about.
    expect(getHostSnapshot().nowLocal).toBeTruthy();
  });
});
