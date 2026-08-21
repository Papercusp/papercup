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
/** `/proc/pressure/cpu` fixture (EI-20495650388693372's CPU-PSI leg). Deliberately
 *  NULL by default, same opt-in discipline as {@link statRead}: the pre-existing
 *  memory-PSI / run-queue tests above must keep falling through to whatever the
 *  real box answers for `/proc/pressure/cpu` (readable or not — either way none of
 *  them assert on `psiCpuSome60`), rather than being silently re-pointed at a
 *  fixture added for a later leg. */
let cpuPsiRead: (() => string) | null = null;
let cpuPsiReadCount = 0;
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
    if (p === '/proc/pressure/cpu' && cpuPsiRead) {
      cpuPsiReadCount += 1;
      return cpuPsiRead();
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

const { getHostSnapshot, resetHostSnapshotCache, PSI_CACHE_MS, RUNQ_CACHE_MS } =
  await import('./host-snapshot');

/** A realistic `/proc/stat` — the two keys we parse sit AFTER the per-core and
 *  `intr` lines, which is the shape the regexes must survive. */
function procStat({ running, blocked }: { running?: number; blocked?: number }): string {
  return [
    'cpu  1 2 3 4 5 6 7 8 9 10',
    'cpu0 1 2 3 4 5 6 7 8 9 10',
    'intr 12345 0 0 0 0 0 0',
    'ctxt 987654321',
    'btime 1700000000',
    'processes 4242',
    ...(running === undefined ? [] : [`procs_running ${running}`]),
    ...(blocked === undefined ? [] : [`procs_blocked ${blocked}`]),
    '',
  ].join('\n');
}

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

/**
 * The run-queue decomposition (EI-20495650388693372).
 *
 * THE BUG THIS PINS. A raw reading was filed as a defect — "128 cores, load
 * averages [217.72, 137.62, 122.82]" — and the ticket had to concede in its own
 * body that "no claim is made that ... any specific agent generated the
 * pressure". That concession was FORCED BY THIS FILE: it handed the reader `load`
 * and `cores` and nothing else, and `load > cores` is equally consistent with a
 * genuine CPU oversubscription and with a pile of D-state tasks using no CPU at
 * all. An unattributable number is the "high load as ambient weather"
 * non-diagnosis, and no amount of care downstream can recover a mechanism the
 * measurement never carried.
 *
 * Per this file's D-028 doctrine the tests below pin the properties that would
 * make the fold WRONG rather than merely absent — above all that the two
 * mechanisms are actually DISTINGUISHABLE at one identical load average, which is
 * the whole claim. A test that only asserted "the fields exist" would stay green
 * through a reader that returned the same number for both.
 */
describe('getHostSnapshot() run-queue decomposition', () => {
  beforeEach(() => {
    resetHostSnapshotCache();
    statReadCount = 0;
    statRead = () => procStat({ running: 61, blocked: 0 });
    psiRead = () => 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0';
  });
  afterEach(() => {
    vi.useRealTimers();
    statRead = null;
    resetHostSnapshotCache();
  });

  it('carries procs_running / procs_blocked beside the load average', () => {
    const snap = getHostSnapshot();
    expect(snap.procsRunning).toBe(61);
    expect(snap.procsBlocked).toBe(0);
    // The pair is only useful next to the denominator that makes it readable.
    expect(snap.cores).toBeGreaterThan(0);
    expect(snap.load).toHaveLength(3);
  });

  it('DISTINGUISHES a CPU-saturated box from an I/O-wedged one — the filed incident', () => {
    // Both of these are worlds in which an agent sees `load [217.72, …]` against
    // `cores: 128` and, reading load alone, files the same "load exceeded core
    // count" observation. They demand OPPOSITE responses: the first has a
    // runnable generator to go find, the second is work stuck in the kernel and
    // is not a CPU problem at all. If this assertion can ever be satisfied by
    // both worlds reporting the same thing, the fix is worthless.
    statRead = () => procStat({ running: 219, blocked: 2 });
    resetHostSnapshotCache();
    const cpuBound = getHostSnapshot();

    statRead = () => procStat({ running: 12, blocked: 205 });
    resetHostSnapshotCache();
    const ioBound = getHostSnapshot();

    expect(cpuBound.procsRunning).toBe(219);
    expect(cpuBound.procsBlocked).toBe(2);
    expect(ioBound.procsRunning).toBe(12);
    expect(ioBound.procsBlocked).toBe(205);

    // The property, stated as the discrimination it has to support rather than as
    // two literals: the runnable count is what separates them, and it does so in
    // the direction that matters.
    expect(cpuBound.procsRunning!).toBeGreaterThan(ioBound.procsRunning!);
    expect(ioBound.procsBlocked!).toBeGreaterThan(cpuBound.procsBlocked!);
  });

  it('OMITS both legs rather than reporting 0 when /proc/stat cannot be read', () => {
    // The inversion this guards is the sharpest one in the file: a fabricated
    // `procsRunning: 0` reads as "nothing is running, the box is idle" — the
    // strongest possible claim to invent out of a FAILED read, and the exact
    // opposite of "I could not tell".
    statRead = () => {
      throw new Error('ENOENT');
    };
    resetHostSnapshotCache();
    const snap = getHostSnapshot();
    expect(snap).not.toHaveProperty('procsRunning');
    expect(snap).not.toHaveProperty('procsBlocked');
    // ...and one dead leg must not degrade the others — this rides every orient.
    expect(snap.now).toBeTruthy();
    expect(snap.cores).toBeGreaterThan(0);
    expect(snap.load).toHaveLength(3);
  });

  it('OMITS rather than guessing when the keys are absent from the file', () => {
    statRead = () => procStat({});
    resetHostSnapshotCache();
    const snap = getHostSnapshot();
    expect(snap).not.toHaveProperty('procsRunning');
    expect(snap).not.toHaveProperty('procsBlocked');
  });

  it('reports the leg it HAS when only one of the two keys is present', () => {
    // Independent legs: a kernel/container that exposes one key must not cost us
    // the other. Discarding both would be a self-inflicted blind spot.
    statRead = () => procStat({ running: 7 });
    resetHostSnapshotCache();
    const snap = getHostSnapshot();
    expect(snap.procsRunning).toBe(7);
    expect(snap).not.toHaveProperty('procsBlocked');
  });

  it('caches /proc/stat instead of re-reading it per orient', () => {
    // 16.8 KB / 0.225 ms measured on this box — ~8x the pressure read, on a path
    // that runs on every orient.
    const a = getHostSnapshot();
    const b = getHostSnapshot();
    expect(a.procsRunning).toBe(61);
    expect(b.procsRunning).toBe(61);
    expect(statReadCount).toBe(1);
  });

  it('re-reads once the cache window has elapsed', () => {
    vi.useFakeTimers();
    resetHostSnapshotCache();
    getHostSnapshot();
    vi.advanceTimersByTime(RUNQ_CACHE_MS + 1);
    getHostSnapshot();
    expect(statReadCount).toBe(2);
  });

  it('resetHostSnapshotCache() clears the run-queue cache, not just PSI', () => {
    // A seam that reset only SOME cached legs would leak one test's fixture into
    // the next, which is a defect in the test seam that looks like a defect in
    // the subject. Pin it: after a reset the next call must re-read.
    getHostSnapshot();
    expect(statReadCount).toBe(1);
    resetHostSnapshotCache();
    statRead = () => procStat({ running: 99, blocked: 1 });
    const after = getHostSnapshot();
    expect(statReadCount).toBe(2);
    expect(after.procsRunning).toBe(99);
  });

  it('never throws when the run-queue leg fails', () => {
    statRead = () => {
      throw new Error('boom');
    };
    resetHostSnapshotCache();
    expect(() => getHostSnapshot()).not.toThrow();
    expect(getHostSnapshot().now).toBeTruthy();
  });
});

/**
 * The CPU-PSI saturation falsifier (EI-20495650388693372, EI-20633522682837476).
 *
 * THE GAP THIS PINS. `procsRunning`/`procsBlocked` (above) say WHAT KIND of load
 * `load` is — a runnable burst or a pile of D-state tasks. Neither says whether
 * anything is actually STARVED by it, which is the falsifier for "the box is
 * overloaded". `psiCpuSome60` was added to the {@link HostSnapshot} interface with
 * that exact justification, but the interface field alone proves nothing — a
 * documented-but-never-populated field is indistinguishable from a real one until
 * something asserts it is actually SET. (It shipped exactly that way once: the
 * field and its doc comment landed, `getHostSnapshot()` never called
 * `readPsiSome60('/proc/pressure/cpu', …)`, and no test caught it because none
 * existed.) Per this file's D-028 doctrine, the load-bearing assertion is not "the
 * field can be read" but that it is a DIFFERENT number from `psiMemSome60` at the
 * same instant — a reader that accidentally sourced both legs from
 * `/proc/pressure/memory` would still pass a presence-only test.
 */
describe("getHostSnapshot() CPU PSI (the load average's saturation companion)", () => {
  beforeEach(() => {
    resetHostSnapshotCache();
    cpuPsiReadCount = 0;
    cpuPsiRead = () => 'some avg10=0.50 avg60=1.08 avg300=0.20 total=42\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';
    psiReadCount = 0;
    psiRead = () => 'some avg10=1.00 avg60=3.25 avg300=0.10 total=1\nfull avg10=0.00 avg60=2.64 avg300=0.00 total=6942659778\n';
  });
  afterEach(() => {
    vi.useRealTimers();
    cpuPsiRead = null;
    resetHostSnapshotCache();
  });

  it('parses the CPU psi avg60 out of the pressure line, alongside `load`', () => {
    const snap = getHostSnapshot();
    expect(snap.psiCpuSome60).toBe(1.08);
    expect(snap.load).toHaveLength(3);
  });

  it('is a DIFFERENT number from memory PSI at the same instant — the copy-paste falsifier', () => {
    // A reader that (by bug) sourced psiCpuSome60 from '/proc/pressure/memory' a
    // second time would pass a presence-only assertion. This is the one that
    // catches it: the two fixtures above deliberately carry different avg60s.
    const snap = getHostSnapshot();
    expect(snap.psiCpuSome60).toBe(1.08);
    expect(snap.psiMemSome60).toBe(3.25);
    expect(snap.psiCpuSome60).not.toBe(snap.psiMemSome60);
  });

  it('OMITS CPU psi rather than reporting 0 when the pressure file cannot be read', () => {
    // Matching the memory leg's rule: system-wide /proc/pressure/cpu also never
    // tracks "full" (measured: cpu full total=0 exactly on this host), so a
    // fabricated 0 here would be indistinguishable from the real absence-of-
    // pressure reading — the exact inversion of "I could not tell".
    cpuPsiRead = () => {
      throw new Error('ENOENT');
    };
    resetHostSnapshotCache();
    const snap = getHostSnapshot();
    expect(snap).not.toHaveProperty('psiCpuSome60');
    // ...and the rest of the snapshot — including the OTHER psi leg — still
    // arrives; one dead leg must not degrade the others.
    expect(snap.now).toBeTruthy();
    expect(snap.psiMemSome60).toBe(3.25);
    expect(snap.load).toHaveLength(3);
  });

  it('OMITS CPU psi rather than guessing when the line is unparseable', () => {
    cpuPsiRead = () => 'garbage without an avg60 field\n';
    resetHostSnapshotCache();
    expect(getHostSnapshot()).not.toHaveProperty('psiCpuSome60');
  });

  it('caches the CPU pressure read instead of re-reading it per orient', () => {
    const a = getHostSnapshot();
    const b = getHostSnapshot();
    expect(a.psiCpuSome60).toBe(1.08);
    expect(b.psiCpuSome60).toBe(1.08);
    expect(cpuPsiReadCount).toBe(1);
  });

  it('re-reads CPU pressure once the cache window has elapsed', () => {
    vi.useFakeTimers();
    resetHostSnapshotCache();
    getHostSnapshot();
    vi.advanceTimersByTime(PSI_CACHE_MS + 1);
    getHostSnapshot();
    expect(cpuPsiReadCount).toBe(2);
  });

  it('never throws when the CPU-psi leg fails', () => {
    cpuPsiRead = () => {
      throw new Error('boom');
    };
    resetHostSnapshotCache();
    expect(() => getHostSnapshot()).not.toThrow();
    expect(getHostSnapshot().now).toBeTruthy();
  });
});
