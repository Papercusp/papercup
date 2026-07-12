/**
 * EI-455 bug #2 — green-stall-watchdog verdict logic. The DB wiring (checkGreenStall)
 * is integration-covered by the live self-test; here we pin the pure decision +
 * escalation body that decide WHEN the silent-stall alarm fires.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  evaluateGreenStall,
  greenStallEscalationBody,
  evaluateMainBehindStaging,
  computeMainBehindStaging,
} from './green-stall-watchdog';

// EI-9922: stub `execFileSync` itself so the stderr-suppression assertion below is
// deterministic regardless of what git checkout (or non-repo) the test runs inside —
// mirrors workspace-map.test.ts's EI-8794 approach.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
import { execFileSync } from 'node:child_process';

const H = 60 * 60 * 1000;
const NOW = 1_750_000_000_000; // fixed epoch ms

describe('evaluateGreenStall', () => {
  it('a fresh install (never fired, never green) does not alarm', () => {
    const v = evaluateGreenStall({ lastFiredMs: null, lastGreenAt: null, watchdogAlerted: false }, NOW);
    expect(v.stalled).toBe(false);
    expect(v.fireStale).toBe(false);
    expect(v.verdictStale).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('a healthy routine (fired + greened within the hour) does not alarm', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 20 * 60 * 1000, watchdogAlerted: false },
      NOW,
    );
    expect(v.stalled).toBe(false);
  });

  it('FIRE-STALE: an active routine that stopped firing (>3h) alarms — the EI-455 wedge signature', () => {
    // The in-routine detector is blind to this (it only runs when the routine fires).
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 4 * H, lastGreenAt: NOW - 4 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.stalled).toBe(true);
    expect(v.fireStale).toBe(true);
    expect(v.reason).toContain('has not FIRED');
  });

  it('VERDICT-STALE: firing fine but no green in >12h alarms (deep backstop)', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 13 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.stalled).toBe(true);
    expect(v.fireStale).toBe(false);
    expect(v.verdictStale).toBe(true);
    expect(v.reason).toContain('no GREEN verdict');
  });

  it('does NOT double-fire with the in-routine 6h alarm: a 7h-stale green while still firing is not yet watchdog-stalled', () => {
    // The in-routine STALL_AGE_MS=6h owns this window; the watchdog's 12h backstop
    // only trips if that path also failed. So 7h-stale-while-firing stays quiet here.
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 7 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.stalled).toBe(false);
  });

  it('BOTH stale: the wedge that also aged past the green backstop reports both clauses', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 5 * H, lastGreenAt: NOW - 24 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.fireStale).toBe(true);
    expect(v.verdictStale).toBe(true);
    expect(v.reason).toContain('has not FIRED');
    expect(v.reason).toContain('no GREEN verdict');
  });

  it('honors custom thresholds', () => {
    const tight = { fireStaleMs: 30 * 60 * 1000, noGreenMs: H };
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 45 * 60 * 1000, lastGreenAt: NOW - 45 * 60 * 1000, watchdogAlerted: false },
      NOW,
      tight,
    );
    expect(v.fireStale).toBe(true);
  });

  it('boundary: exactly at the fire-stale threshold does not alarm (strict >)', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 3 * H, lastGreenAt: NOW - 3 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.fireStale).toBe(false);
    expect(v.stalled).toBe(false);
  });

  it('a routine that fired recently but has NEVER greened does not verdict-alarm (no lastGreenAt to age)', () => {
    // Fire-recency is healthy here; lastGreenAt null can't be aged. Caught only once
    // firing also goes stale (the wedge) — avoids false alarms on a never-green fresh start.
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 10 * 60 * 1000, lastGreenAt: null, watchdogAlerted: false },
      NOW,
    );
    expect(v.stalled).toBe(false);
  });

  it('EI-2994: a stale root routine engine suppresses green-specific symptom alarms', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 5 * H, lastGreenAt: NOW - 24 * H, watchdogAlerted: false, routineEngineStale: true },
      NOW,
    );
    expect(v.stalled).toBe(false);
    expect(v.fireStale).toBe(false);
    expect(v.verdictStale).toBe(false);
    expect(v.reason).toBeNull();
  });

  // EI-7505: the alarm reason previously never named WHICH test(s) are failing
  // the verdict, forcing a responder to hand-spelunk harness_shared.test_runs
  // (inconclusive — mixes every agent's local dev-test runs with the verdict
  // run) during a live deploy-freeze. gate_health.failingTests (persisted by
  // trackGateStall in release-actions.ts) is now threaded into the reason.
  it('EI-7505: a verdict-stale alarm names the failing test(s) when gate_health carries them', () => {
    const v = evaluateGreenStall(
      {
        lastFiredMs: NOW - 20 * 60 * 1000,
        lastGreenAt: NOW - 13 * H,
        watchdogAlerted: false,
        failingTests: ['pkgA/foo.test.ts', 'pkgB/bar.test.ts'],
      },
      NOW,
    );
    expect(v.stalled).toBe(true);
    expect(v.reason).toContain('no GREEN verdict');
    expect(v.reason).toContain('Failing verdict test(s): pkgA/foo.test.ts, pkgB/bar.test.ts');
  });

  it('EI-7505: truncates the reason to the first 5 tests with a "+N more" tail', () => {
    const tests = Array.from({ length: 8 }, (_, i) => `pkg/file-${i}.test.ts`);
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 13 * H, watchdogAlerted: false, failingTests: tests },
      NOW,
    );
    expect(v.reason).toContain('pkg/file-0.test.ts, pkg/file-1.test.ts, pkg/file-2.test.ts, pkg/file-3.test.ts, pkg/file-4.test.ts');
    expect(v.reason).toContain('(+3 more)');
  });

  it('EI-7505: no failing-test suffix when the list is absent/empty', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 13 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.reason).not.toContain('Failing verdict test(s)');
  });
});

describe('greenStallEscalationBody', () => {
  it('serializes the watchdog escalation with the stall axes + iso timestamps', () => {
    const verdict = evaluateGreenStall(
      { lastFiredMs: NOW - 4 * H, lastGreenAt: NOW - 26 * H, watchdogAlerted: false },
      NOW,
    );
    const body = JSON.parse(
      greenStallEscalationBody({
        installSlug: 'papercusp',
        verdict,
        lastFiredMs: NOW - 4 * H,
        lastGreenAt: NOW - 26 * H,
        nowMs: NOW,
      }),
    );
    expect(body.kind).toBe('green-checkpoint-watchdog');
    expect(body.harness_slug).toBe('papercusp');
    expect(body.fireStale).toBe(true);
    expect(body.verdictStale).toBe(true);
    expect(body.lastFiredAt).toBe(new Date(NOW - 4 * H).toISOString());
    expect(body.detail).toContain('silent stall');
  });

  it('EI-7505: includes failingTests (truncated to 20) in the escalation body when present', () => {
    const failingTests = Array.from({ length: 25 }, (_, i) => `pkg/file-${i}.test.ts`);
    const verdict = evaluateGreenStall(
      { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 13 * H, watchdogAlerted: false, failingTests },
      NOW,
    );
    const body = JSON.parse(
      greenStallEscalationBody({
        installSlug: 'papercusp',
        verdict,
        lastFiredMs: NOW - 20 * 60 * 1000,
        lastGreenAt: NOW - 13 * H,
        nowMs: NOW,
        failingTests,
      }),
    );
    expect(body.failingTests).toHaveLength(20);
    expect(body.failingTests).toEqual(failingTests.slice(0, 20));
  });

  it('EI-7505: failingTests defaults to an empty array when omitted', () => {
    const verdict = evaluateGreenStall(
      { lastFiredMs: NOW - 4 * H, lastGreenAt: NOW - 26 * H, watchdogAlerted: false },
      NOW,
    );
    const body = JSON.parse(
      greenStallEscalationBody({
        installSlug: 'papercusp',
        verdict,
        lastFiredMs: NOW - 4 * H,
        lastGreenAt: NOW - 26 * H,
        nowMs: NOW,
      }),
    );
    expect(body.failingTests).toEqual([]);
  });
});

describe('evaluateMainBehindStaging (EI-9762)', () => {
  it('does not alarm when main and staging are in sync (commitsBehind 0)', () => {
    const v = evaluateMainBehindStaging({ commitsBehind: 0, behindMs: null });
    expect(v.stalled).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('does not alarm on a small/fresh lag (a handful of commits just landed)', () => {
    const v = evaluateMainBehindStaging({ commitsBehind: 5, behindMs: 5 * 60 * 1000 });
    expect(v.stalled).toBe(false);
  });

  it('does not alarm on a small lag even if it sits for a while (low commit count alone is not the signal)', () => {
    const v = evaluateMainBehindStaging({ commitsBehind: 3, behindMs: 5 * H });
    expect(v.stalled).toBe(false);
  });

  it('does not alarm on a big burst that has not aged yet (lots of commits, all fresh)', () => {
    const v = evaluateMainBehindStaging({ commitsBehind: 40, behindMs: 2 * 60 * 1000 });
    expect(v.stalled).toBe(false);
  });

  it('ALARMS on the EI-9762 signature: many commits AND aged well past the threshold', () => {
    const v = evaluateMainBehindStaging({ commitsBehind: 56, behindMs: Math.round(4.8 * H) });
    expect(v.stalled).toBe(true);
    expect(v.reason).toContain('56 commits');
    expect(v.reason).toContain('4.8h');
  });

  it('respects custom thresholds', () => {
    const v = evaluateMainBehindStaging(
      { commitsBehind: 10, behindMs: 30 * 60 * 1000 },
      { commitsThreshold: 5, msThreshold: 15 * 60 * 1000 },
    );
    expect(v.stalled).toBe(true);
  });

  it('fails open (never alarms) when the git read could not resolve a value', () => {
    expect(evaluateMainBehindStaging({ commitsBehind: null, behindMs: null }).stalled).toBe(false);
    expect(evaluateMainBehindStaging({ commitsBehind: 56, behindMs: null }).stalled).toBe(false);
  });
});

describe('computeMainBehindStaging git shell-out (EI-9922 no-stderr-leak)', () => {
  // On a PACKAGED install this watchdog's boot pass shells git in a NON-repo dir.
  // `execFileSync`'s default stdio inherits the child's stderr, so it spammed
  // 'fatal: not a git repository' onto serve.log every boot + interval. gitOut must
  // pin stdio to ['ignore','pipe','ignore'] so stderr is discarded.
  it('EI-9922: shells git with stderr suppressed (stdio ["ignore","pipe","ignore"])', () => {
    (vi.mocked(execFileSync) as unknown as { mockReturnValueOnce: (v: string) => void }).mockReturnValueOnce('0\n');
    computeMainBehindStaging('/some/packaged/install');
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['rev-list']),
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'ignore'] }),
    );
    vi.mocked(execFileSync).mockReset();
  });

  it('EI-9922: fails open (all-null) without throwing when git rejects (non-repo)', () => {
    (vi.mocked(execFileSync) as unknown as { mockImplementationOnce: (fn: () => never) => void }).mockImplementationOnce(
      () => {
        throw new Error('fatal: not a git repository (or any parent up to mount point /)');
      },
    );
    expect(computeMainBehindStaging('/some/packaged/install')).toEqual({
      commitsBehind: null,
      behindMs: null,
    });
    vi.mocked(execFileSync).mockReset();
  });
});
