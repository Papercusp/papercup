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
import { publishPreemptReadyMarker } from '../../../../scripts/test-files.mjs';

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
