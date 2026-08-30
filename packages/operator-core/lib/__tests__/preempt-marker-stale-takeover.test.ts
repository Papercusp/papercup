/**
 * Regression guards for pc-heavy after-ready marker publication
 * (EI-21882371330313535).
 *
 * `publishPreemptReadyMarker` creates its marker with open(O_CREAT|O_EXCL) so the
 * file proves this process owns the barrier — cleanup may then remove it without
 * risking an unrelated run's file. That exclusivity used to make ANY collision
 * fatal: an EEXIST aborted the whole run as `TEST_FILE_ROUTE_ERROR` exit 75,
 * which reads as "your paths were wrong" and, by this repo's triage rules, means
 * zero files were measured. A collision says nothing about the caller's test set.
 *
 * On the shared box this fired against pure debris: of five markers present, one
 * had a live owner and four were dead or unattributable — two carrying a dead
 * pid, two zero-length with no pid at all (killed between the exclusive create
 * and the write of the pid, so provenance cannot identify them at all).
 *
 * The contract these tests pin is therefore asymmetric on purpose:
 *   - a LIVE owner still wins — exclusivity is only protecting something then;
 *   - dead or long-stale debris is reclaimed rather than aborting the run;
 *   - anything ambiguous is treated as LIVE, because wrongly refusing costs one
 *     run while wrongly stealing breaks a peer's barrier.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — plain-Node .mjs CLI, no declaration file (same convention as test-file-router.test.ts).
import { publishPreemptReadyMarker, reapPreemptMarkerDebris } from '../../../../scripts/test-files.mjs';

let dir: string;
let marker: string;
/** Publication announces itself on stderr by design; capture rather than silence it, so the reclaim path's own log line stays assertable. */
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'preempt-marker-'));
  marker = join(dir, 'ready.TESTXX');
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const loggedLines = () => errorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');

/** A pid that is certainly not running: allocate one and confirm it is gone. */
function deadPid(): number {
  // 2^22 is above the default pid_max on Linux, so it can never be live.
  const candidate = 4_194_303;
  try {
    process.kill(candidate, 0);
    throw new Error('precondition failed: chosen dead pid is actually alive');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return candidate;
    throw error;
  }
}

/** Backdate a file so an age-based staleness check treats it as debris. */
function backdate(path: string, secondsAgo: number): void {
  const when = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path, when, when);
}

const ownerPidOf = (path: string) => Number.parseInt(readFileSync(path, 'utf8').trim(), 10);

describe('publishPreemptReadyMarker — clean publication', () => {
  it('publishes when no marker exists and records THIS process as the owner', () => {
    const cleanup = publishPreemptReadyMarker(marker);
    expect(cleanup).toBeTypeOf('function');
    expect(ownerPidOf(marker)).toBe(process.pid);
    // An uncontended publish must NOT claim it reclaimed anything.
    expect(loggedLines()).toContain(`PC_HEAVY_PREEMPT_READY pid=${process.pid}`);
    expect(loggedLines()).not.toContain('reclaimed-stale-marker');
  });

  it('returns a cleanup that removes the marker, and is idempotent', () => {
    const cleanup = publishPreemptReadyMarker(marker)!;
    cleanup();
    expect(existsSync(marker)).toBe(false);
    expect(() => cleanup()).not.toThrow();
  });

  it('returns null (publishing nothing) when no marker path is configured', () => {
    // The `undefined` case falls through to the default parameter, which reads
    // PC_HEAVY_PREEMPT_READY_FILE — and pc-heavy SETS that variable for every run
    // that opts into the after-ready barrier, which includes the gate. Left
    // ambient, this assertion passes under `testing:run` and fails under a real
    // barrier-enabled invocation, where the fallback publishes a marker instead
    // of returning null. Stub it so the test is about "no path configured"
    // rather than about whichever environment happened to run it.
    vi.stubEnv('PC_HEAVY_PREEMPT_READY_FILE', '');
    expect(publishPreemptReadyMarker('')).toBeNull();
    expect(publishPreemptReadyMarker('   ')).toBeNull();
    expect(publishPreemptReadyMarker(undefined)).toBeNull();
  });
});

describe('publishPreemptReadyMarker — reclaims debris instead of aborting the run', () => {
  it('reclaims a marker whose recorded owner is DEAD, and says so', () => {
    writeFileSync(marker, `${deadPid()}\n`, { mode: 0o600 });
    expect(() => publishPreemptReadyMarker(marker)).not.toThrow();
    expect(ownerPidOf(marker)).toBe(process.pid);
    // A silent takeover would hide real barrier churn from whoever reads the log.
    expect(loggedLines()).toContain('reclaimed-stale-marker');
  });

  it('reclaims a zero-length unattributable marker once it has aged', () => {
    // The killed-between-create-and-write case: no pid, so provenance cannot
    // help and age is the only available signal.
    writeFileSync(marker, '', { mode: 0o600 });
    backdate(marker, 60);
    expect(() => publishPreemptReadyMarker(marker)).not.toThrow();
    expect(ownerPidOf(marker)).toBe(process.pid);
  });

  it('reclaims a marker holding unparseable junk once it has aged', () => {
    writeFileSync(marker, 'not-a-pid\n', { mode: 0o600 });
    backdate(marker, 60);
    expect(() => publishPreemptReadyMarker(marker)).not.toThrow();
    expect(ownerPidOf(marker)).toBe(process.pid);
  });

  it('leaves a reclaimed marker cleanly removable', () => {
    writeFileSync(marker, `${deadPid()}\n`, { mode: 0o600 });
    const cleanup = publishPreemptReadyMarker(marker)!;
    cleanup();
    expect(existsSync(marker)).toBe(false);
  });
});

describe('publishPreemptReadyMarker — never steals a live barrier', () => {
  it('REFUSES when the recorded owner is alive', () => {
    // Our own pid is the most certainly-live one available.
    writeFileSync(marker, `${process.pid}\n`, { mode: 0o600 });
    expect(() => publishPreemptReadyMarker(marker)).toThrow(/EEXIST/);
    // The incumbent must be left exactly as found.
    expect(ownerPidOf(marker)).toBe(process.pid);
  });

  it('REFUSES a FRESH zero-length marker — a peer may be mid-publish', () => {
    // open(O_CREAT|O_EXCL) then write() is microseconds apart; a brand-new empty
    // marker is far more likely a peer in that window than abandoned debris.
    writeFileSync(marker, '', { mode: 0o600 });
    expect(() => publishPreemptReadyMarker(marker)).toThrow(/EEXIST/);
    expect(statSync(marker).size).toBe(0);
  });

  it('is falsifiable: the SAME empty marker is refused fresh and reclaimed once aged', () => {
    // Pins the age boundary as the actual discriminator rather than letting both
    // outcomes pass for unrelated reasons.
    writeFileSync(marker, '', { mode: 0o600 });
    expect(() => publishPreemptReadyMarker(marker)).toThrow(/EEXIST/);
    backdate(marker, 60);
    expect(() => publishPreemptReadyMarker(marker)).not.toThrow();
    expect(ownerPidOf(marker)).toBe(process.pid);
  });
});

/**
 * Guards for the directory sweep (EI-21883357870313468).
 *
 * The publisher above only ever reclaims the ONE path it needs, so markers left
 * by killed runs under different names accumulated forever — pc-heavy names the
 * monitor as the cleanup backstop, but the monitor is itself killed with the
 * process group it is backing up, so the backstop shares a fate with the thing
 * it backs up. The sweep is the missing fate-independent reclamation path: a
 * later, unrelated, demonstrably-alive process does the tidying.
 *
 * Because it judges OTHER runs' files, every bound here is deliberately more
 * conservative than the publisher's: a false positive steals a live peer's
 * barrier, while a false negative merely leaves a byte of debris for next time.
 */
describe('reapPreemptMarkerDebris — removes abandoned markers', () => {
  const write = (name: string, body: string, secondsAgo?: number) => {
    const path = join(dir, name);
    writeFileSync(path, body, { mode: 0o600 });
    if (secondsAgo !== undefined) backdate(path, secondsAgo);
    return path;
  };

  it('removes a marker whose recorded owner is DEAD', () => {
    const abandoned = write('ready.aaaaaa', `${deadPid()}\n`, 300);
    expect(reapPreemptMarkerDebris(dir)).toEqual(['ready.aaaaaa']);
    expect(existsSync(abandoned)).toBe(false);
  });

  it('removes a long-stale zero-length marker that provenance can never identify', () => {
    // Killed between open(O_CREAT|O_EXCL) and write(2): nothing was ever recorded
    // in it, so age is the only signal that exists. Observed at 20 HOURS old.
    const abandoned = write('ready.bbbbbb', '', 7200);
    expect(reapPreemptMarkerDebris(dir)).toEqual(['ready.bbbbbb']);
    expect(existsSync(abandoned)).toBe(false);
  });

  it('sweeps the finalization family too, not just ready markers', () => {
    // Both families are allocated by pc-heavy into this same directory and both
    // leak by the same mechanism; covering only one would leave half the debris.
    const abandoned = write('finalization.cccccc', `${deadPid()}\n`, 300);
    expect(reapPreemptMarkerDebris(dir)).toEqual(['finalization.cccccc']);
    expect(existsSync(abandoned)).toBe(false);
  });
});

describe('reapPreemptMarkerDebris — never steals a live barrier', () => {
  const write = (name: string, body: string, secondsAgo?: number) => {
    const path = join(dir, name);
    writeFileSync(path, body, { mode: 0o600 });
    if (secondsAgo !== undefined) backdate(path, secondsAgo);
    return path;
  };

  it('PRESERVES a marker with a live owner however old it is', () => {
    const live = write('ready.dddddd', `${process.pid}\n`, 86_400);
    expect(reapPreemptMarkerDebris(dir)).toEqual([]);
    expect(existsSync(live)).toBe(true);
    expect(ownerPidOf(live)).toBe(process.pid);
  });

  it('PRESERVES anything younger than the age floor, even with a dead owner', () => {
    // The floor is what makes the sweep unable to interfere with a run starting
    // right now — including pc-heavy's own mktemp window, which briefly leaves a
    // zero-length file behind before deleting it.
    const young = write('ready.eeeeee', `${deadPid()}\n`, 5);
    expect(reapPreemptMarkerDebris(dir)).toEqual([]);
    expect(existsSync(young)).toBe(true);
  });

  it('is falsifiable: the SAME dead-owner marker is kept young and removed once aged', () => {
    // Pins the age floor as a real discriminator rather than letting both
    // outcomes pass for unrelated reasons.
    const path = write('ready.ffffff', `${deadPid()}\n`, 5);
    expect(reapPreemptMarkerDebris(dir)).toEqual([]);
    expect(existsSync(path)).toBe(true);
    backdate(path, 300);
    expect(reapPreemptMarkerDebris(dir)).toEqual(['ready.ffffff']);
    expect(existsSync(path)).toBe(false);
  });

  it('PRESERVES an aged EMPTY marker until the generous empty bound passes', () => {
    // The publisher may use a 5s bound for the one path it needs; the sweep must
    // not, because it is judging files it knows nothing about.
    const path = write('ready.gggggg', '', 300);
    expect(reapPreemptMarkerDebris(dir)).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  it('never removes the caller\'s own marker', () => {
    const own = write('ready.hhhhhh', `${deadPid()}\n`, 300);
    // Deliberately a path the rules WOULD otherwise reap, so this proves the
    // self-exclusion rather than passing because nothing matched.
    expect(reapPreemptMarkerDebris(dir)).toEqual(['ready.hhhhhh']);
    writeFileSync(own, `${deadPid()}\n`, { mode: 0o600 });
    backdate(own, 300);
    expect(reapPreemptMarkerDebris(dir, { self: own })).toEqual([]);
    expect(existsSync(own)).toBe(true);
  });

  it('ignores files that are not pc-heavy markers', () => {
    // The directory is shared; anything not matching the shape pc-heavy itself
    // allocates belongs to something we know nothing about.
    const foreign = write('some-other-tool.lock', `${deadPid()}\n`, 86_400);
    const nested = write('ready.TOOLONGNAME', `${deadPid()}\n`, 86_400);
    expect(reapPreemptMarkerDebris(dir)).toEqual([]);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(nested)).toBe(true);
  });
});

describe('reapPreemptMarkerDebris — cannot fail a run', () => {
  it('returns [] instead of throwing when the directory does not exist', () => {
    expect(reapPreemptMarkerDebris(join(dir, 'no-such-dir'))).toEqual([]);
  });

  it('bounds how many entries it will examine', () => {
    for (let i = 0; i < 12; i += 1) {
      const path = join(dir, `ready.b${String(i).padStart(5, '0')}`);
      writeFileSync(path, `${deadPid()}\n`, { mode: 0o600 });
      backdate(path, 300);
    }
    // Every one of these is reapable; the cap, not their contents, is what stops
    // the sweep — so this run must remove strictly fewer than all of them.
    expect(reapPreemptMarkerDebris(dir, { maxEntries: 5 })).toHaveLength(5);
  });
});

describe('publishing sweeps the directory it publishes into', () => {
  it('reaps abandoned neighbours, keeps live ones, and reports the count', () => {
    const abandoned = join(dir, 'ready.iiiiii');
    writeFileSync(abandoned, `${deadPid()}\n`, { mode: 0o600 });
    backdate(abandoned, 300);

    const live = join(dir, 'ready.jjjjjj');
    writeFileSync(live, `${process.pid}\n`, { mode: 0o600 });
    backdate(live, 300);

    const cleanup = publishPreemptReadyMarker(marker);
    expect(cleanup).toBeTypeOf('function');

    // Our own publication succeeded, the debris is gone, the live peer is intact.
    expect(ownerPidOf(marker)).toBe(process.pid);
    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(live)).toBe(true);
    // Barrier churn stays visible rather than silent.
    expect(loggedLines()).toContain('reaped-abandoned-markers count=1');
  });

  it('does not claim a reap when the directory was already clean', () => {
    publishPreemptReadyMarker(marker);
    expect(loggedLines()).not.toContain('reaped-abandoned-markers');
  });
});
