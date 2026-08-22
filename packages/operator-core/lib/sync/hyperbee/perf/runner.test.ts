import { describe, it, expect } from 'vitest';
import { parseSwapPages, computeHostHealth, parsePsiSome, collectConvergenceViolations } from './runner';
import type { PerfArtifact } from './artifact';

describe('parseSwapPages (EI-9145)', () => {
  it('parses pswpin/pswpout out of a real /proc/vmstat shape', () => {
    const text = ['nr_free_pages 12345', 'pswpin 200', 'pswpout 900', 'pgpgin 55555'].join('\n');
    expect(parseSwapPages(text)).toEqual({ pswpin: 200, pswpout: 900 });
  });

  it('returns null when the fields are missing (non-Linux / unexpected shape)', () => {
    expect(parseSwapPages('nr_free_pages 12345\npgpgin 55555')).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(parseSwapPages('')).toBeNull();
  });
});

/**
 * PERMANENT PRE-FIX CONTROL (EI-19301664378023382 part 2). This is the logic
 * computeHostHealth had until 2026-08-17: the swap-page delta decided memory
 * contention on its own, with no notion of rate and no notion of whether
 * anything actually STALLED. It is kept here deliberately so the tests below
 * can demonstrate the fix is FALSIFIABLE — a guard that has never been shown to
 * fail is a guard nobody has tested. Never wire this into production code.
 */
function decideByPageDeltaAlone(input: { ratio1m: number; swapPagesDelta: number | null }): {
  oversubscribed: boolean;
  memoryContended: boolean;
} {
  const memoryContended = input.swapPagesDelta !== null && input.swapPagesDelta > 1000;
  return { oversubscribed: input.ratio1m > 1.0 || memoryContended, memoryContended };
}

describe('computeHostHealth (EI-9145 + EI-8843 + EI-19301664378023382)', () => {
  it('neither CPU nor memory confound ⇒ not oversubscribed', () => {
    expect(computeHostHealth({ ratio1m: 0.4, swapPagesDelta: 10, psiMemSome60: 0.2 })).toEqual({
      oversubscribed: false,
      memoryContended: false,
      memoryContendedReason: null,
    });
  });

  it('CPU ratio over the limit alone ⇒ oversubscribed, not memory-contended', () => {
    expect(computeHostHealth({ ratio1m: 1.5, swapPagesDelta: 0, psiMemSome60: 0.1 })).toEqual({
      oversubscribed: true,
      memoryContended: false,
      memoryContendedReason: null,
    });
  });

  it('PSI memory stall over the threshold (low CPU ratio) ⇒ oversubscribed via psi-stall', () => {
    expect(computeHostHealth({ ratio1m: 0.9, swapPagesDelta: 50_000, psiMemSome60: 22.4 })).toEqual({
      oversubscribed: true,
      memoryContended: true,
      memoryContendedReason: 'psi-stall',
    });
  });

  it('PSI exactly at the threshold is NOT contended (strictly greater-than)', () => {
    expect(computeHostHealth({ ratio1m: 0.5, swapPagesDelta: 0, psiMemSome60: 5.0 })).toEqual({
      oversubscribed: false,
      memoryContended: false,
      memoryContendedReason: null,
    });
  });

  it('both confounds ⇒ oversubscribed AND memory-contended', () => {
    expect(computeHostHealth({ ratio1m: 1.6, swapPagesDelta: 100_000, psiMemSome60: 30 })).toEqual({
      oversubscribed: true,
      memoryContended: true,
      memoryContendedReason: 'psi-stall',
    });
  });

  describe('page-delta FALLBACK — only when PSI is unreadable', () => {
    it('null PSI + delta over the threshold ⇒ contended via swap-pages-fallback', () => {
      expect(computeHostHealth({ ratio1m: 0.9, swapPagesDelta: 50_000, psiMemSome60: null })).toEqual({
        oversubscribed: true,
        memoryContended: true,
        memoryContendedReason: 'swap-pages-fallback',
      });
    });

    it('null PSI + delta under the threshold ⇒ not contended', () => {
      expect(computeHostHealth({ ratio1m: 0.5, swapPagesDelta: 10, psiMemSome60: null })).toEqual({
        oversubscribed: false,
        memoryContended: false,
        memoryContendedReason: null,
      });
    });

    it('null PSI + null delta (non-Linux / sample failure) never triggers contention', () => {
      expect(computeHostHealth({ ratio1m: 0.5, swapPagesDelta: null, psiMemSome60: null })).toEqual({
        oversubscribed: false,
        memoryContended: false,
        memoryContendedReason: null,
      });
    });

    it('delta exactly at the threshold is NOT contended, even on the fallback path', () => {
      expect(computeHostHealth({ ratio1m: 0.5, swapPagesDelta: 1000, psiMemSome60: null })).toEqual({
        oversubscribed: false,
        memoryContended: false,
        memoryContendedReason: null,
      });
    });
  });

  describe('the measured 2026-08-17 miscalibration this fix exists for', () => {
    // Both rows are REAL readings taken on this shared dev box within the same
    // hour, via the runner's own probe and a /proc/vmstat sample.
    const QUIET_MOMENT = { ratio1m: 0.518, swapPagesDelta: 3_364, psiMemSome60: 0.76 };

    it('a quiet host (PSI 0.76% — no meaningful stall) is NOT called contended', () => {
      expect(computeHostHealth(QUIET_MOMENT)).toEqual({
        oversubscribed: false,
        memoryContended: false,
        memoryContendedReason: null,
      });
    });

    it('PRE-FIX CONTROL: the old page-delta-only logic DID call that quiet host contended', () => {
      // The falsifier. If this ever starts agreeing with computeHostHealth, the
      // fix has been reverted or neutered and the assertion above is vacuous.
      const old = decideByPageDeltaAlone(QUIET_MOMENT);
      expect(old.memoryContended).toBe(true);
      expect(old.oversubscribed).toBe(true);
      expect(computeHostHealth(QUIET_MOMENT).memoryContended).toBe(false);
    });

    it('CALIBRATION: a real burst (909k pages, PSI 6.98%) IS still caught', () => {
      // Guards the opposite failure — a fix that simply stops flagging anything
      // would pass the two assertions above while destroying the guard.
      expect(computeHostHealth({ ratio1m: 0.52, swapPagesDelta: 909_444, psiMemSome60: 6.98 })).toEqual({
        oversubscribed: true,
        memoryContended: true,
        memoryContendedReason: 'psi-stall',
      });
    });

    it('catches memory stall with NO swap I/O at all — reclaim/page-cache thrashing the old check missed', () => {
      expect(computeHostHealth({ ratio1m: 0.3, swapPagesDelta: 0, psiMemSome60: 40 })).toEqual({
        oversubscribed: true,
        memoryContended: true,
        memoryContendedReason: 'psi-stall',
      });
      expect(decideByPageDeltaAlone({ ratio1m: 0.3, swapPagesDelta: 0 }).memoryContended).toBe(false);
    });
  });
});

describe('parsePsiSome (EI-19301664378023382)', () => {
  it('parses avg10/avg60 out of a real /proc/pressure/memory shape', () => {
    const text = [
      'some avg10=0.03 avg60=5.07 avg300=8.22 total=47076542478',
      'full avg10=0.02 avg60=4.25 avg300=6.55 total=39585873377',
    ].join('\n');
    expect(parsePsiSome(text)).toEqual({ avg10: 0.03, avg60: 5.07 });
  });

  it('parses a real /proc/pressure/cpu shape (no "full" line — cpu PSI has none)', () => {
    const text = 'some avg10=0.79 avg60=1.15 avg300=1.44 total=65889176130';
    expect(parsePsiSome(text)).toEqual({ avg10: 0.79, avg60: 1.15 });
  });

  it('returns null when there is no "some" line (non-Linux / unexpected shape)', () => {
    expect(parsePsiSome('full avg10=0.00 avg60=0.00 avg300=0.00 total=0')).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(parsePsiSome('')).toBeNull();
  });

  it('reproduces the 2026-08-02 audit finding: low PSI alongside a high swap-page-delta', () => {
    // EI-19301664378023382's measured mismatch: the runner's swap-delta confound fired
    // "oversubscribed" (deltas of 2,394,052 and 259,671 pages, both ≫ the 1000-page
    // threshold) while a same-moment PSI memory check showed avg60 ~5%, avg10 ~0% —
    // i.e. the kernel's own stall-time accounting did not show sustained thrashing.
    // This test pins the PARSE of that exact measured line. As of 2026-08-17 the
    // composite decision IS wired to PSI (computeHostHealth phase 2 above); note
    // avg60=5.07 sits just over HOST_PSI_MEM_STALL_PCT, so this historical sample
    // would now be called contended — narrowly, and on stall time rather than on a
    // page count 259x its threshold.
    const text = 'some avg10=0.00 avg60=5.07 avg300=8.22 total=47076542478';
    expect(parsePsiSome(text)).toEqual({ avg10: 0, avg60: 5.07 });
  });
});

/**
 * The GATE half of the EI-20576392705164447 guard.
 *
 * `metrics.test.ts` proves the artifact stops claiming a pass; this proves the
 * runner's gated exit paths (`--gate`, `--slo-only`) actually SEE it. Both
 * halves are needed: the 2026-08-16 run failed because a correctly-detected
 * problem never reached the verdict, and a verdict nothing reads is the same
 * bug one layer out.
 */
describe('collectConvergenceViolations (EI-20576392705164447)', () => {
  const cell = (over: Partial<PerfArtifact>): PerfArtifact =>
    ({
      schema: 2,
      provenance: null,
      scenario: 'replication.sustained',
      tier: 1,
      params: { peers: 64, rate: 10 },
      startedAt: '2026-08-16T02:32:24.570Z',
      durationMs: 1_023_652,
      host: { hostname: 'host-abc', platform: 'linux', arch: 'x64', cpus: 128, node: 'v22' },
      metrics: {},
      loopLag: { p50Ms: 5, p95Ms: 21.1, p99Ms: 30, maxMs: 40 },
      sloPassed: true,
      sloLimitMs: 100,
      convergence: null,
      convergencePassed: null,
      cpu: { userMs: 1, systemMs: 1 },
      rss: { peakBytes: 1 },
      notes: [],
      ...over,
    }) as PerfArtifact;

  it('flags the exact artifact that shipped green: sloPassed true, readers behind', () => {
    const v = collectConvergenceViolations([
      cell({
        convergence: {
          expectedReaders: 63,
          convergedReaders: 58,
          laggingReaders: ['1', '2', '22', '29', '3'],
          p95LimitMs: null,
          observedP95Ms: 601_075,
          budgetMs: null,
          convergedMs: null,
        },
        convergencePassed: false,
        notes: ['reader 1 did not apply all ops in time'],
      }),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      scenario: 'replication.sustained',
      paramsKey: 'peers=64,rate=10',
      expectedReaders: 63,
      convergedReaders: 58,
      observedP95Ms: 601_075,
    });
  });

  it('a converged cell is not a violation', () => {
    expect(
      collectConvergenceViolations([
        cell({
          convergence: {
            expectedReaders: 15,
            convergedReaders: 15,
            laggingReaders: [],
            p95LimitMs: null,
            observedP95Ms: 996,
            budgetMs: null,
            convergedMs: null,
          },
          convergencePassed: true,
        }),
      ]),
    ).toHaveLength(0);
  });

  it('an unmeasured cell (no readers declared, or a legacy artifact) is not a violation', () => {
    // null must read as "not measured", never as a failure — otherwise every
    // reader-less scenario (merge.idle-tick) and every pre-fix baseline artifact
    // would red the gate for a property they never claimed.
    expect(collectConvergenceViolations([cell({}), cell({ convergencePassed: undefined as never })])).toHaveLength(0);
  });
});
