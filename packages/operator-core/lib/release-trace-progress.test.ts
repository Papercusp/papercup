import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EVIDENCE_TRUST_MS,
  DEFAULT_STALL_THRESHOLD_MS,
  certifyCheckpointProgress,
  type ProgressCertificateInput,
} from './release-trace-progress.js';

/**
 * Fixed clock. `certifyCheckpointProgress` takes `nowMs` explicitly precisely so no
 * assertion here can drift with wall-clock time.
 */
const NOW = 1_700_000_000_000;

/** A run whose heartbeat genuinely advanced, read live. The healthy baseline. */
function liveAdvancing(over: Partial<ProgressCertificateInput> = {}): ProgressCertificateInput {
  return {
    active: true,
    activeSource: 'run-lock',
    startedAtMs: NOW - 3_000_000,
    progressAtMs: NOW - 30_000,
    verdictWrittenAtMs: null,
    asOfAgeMs: 0,
    ...over,
  };
}

/**
 * A run read live whose heartbeat ADVANCED past its start and then went quiet — the only
 * shape that may legitimately yield `stalled`.
 *
 * It exists as its own helper because the obvious way to write it by overriding
 * `liveAdvancing({ progressAtMs: NOW - 5_000_000 })` is WRONG and silently tests something
 * else: that pushes the heartbeat BEHIND the baseline's start time, which routes to
 * `clock-skew`. The first draft of this file did exactly that, and the suite caught it.
 */
function liveStale(over: Partial<ProgressCertificateInput> = {}): ProgressCertificateInput {
  return liveAdvancing({
    startedAtMs: NOW - 6_000_000,
    progressAtMs: NOW - 5_000_000,
    ...over,
  });
}

describe('certifyCheckpointProgress — nothing to certify', () => {
  it('reports an ABSENT reading as unknown/no-run, not as an idle gate', () => {
    const cert = certifyCheckpointProgress(null, NOW);
    expect(cert.verdict).toBe('unknown');
    expect(cert.basis).toBe('no-run');
    expect(cert.detail).toMatch(/absent measurement, not an idle gate/i);
  });

  it('reports active:false as unknown/no-run rather than stalled', () => {
    const cert = certifyCheckpointProgress({ active: false }, NOW);
    expect(cert.verdict).toBe('unknown');
    expect(cert.basis).toBe('no-run');
  });

  it('never returns `stalled` when there is simply no run', () => {
    for (const input of [null, undefined, { active: false }, {}]) {
      expect(certifyCheckpointProgress(input, NOW).verdict).not.toBe('stalled');
    }
  });
});

/**
 * D-003. The equality `progressAtMs === startedAtMs` is produced by EVERY fallback site
 * when no heartbeat was measured, so it cannot distinguish "just started" from "never
 * measured" — and both are compatible with a healthy run. `stalled` here is the false
 * positive that costs a full suite, so these are the cases the module exists for.
 */
describe('certifyCheckpointProgress — D-003 fallback ambiguity is never a stall', () => {
  it('yields unknown/ambiguous-fallback when the heartbeat equals the start time', () => {
    const started = NOW - 3_180_000; // 53 minutes, the EI-22129511435526580 shape
    const cert = certifyCheckpointProgress(
      liveAdvancing({ startedAtMs: started, progressAtMs: started, currentPhase: 'materializing' }),
      NOW,
    );
    expect(cert.verdict).toBe('unknown');
    expect(cert.basis).toBe('ambiguous-fallback');
    expect(cert.detail).toMatch(/EITHER/);
    expect(cert.detail).toMatch(/not evidence of a stall/i);
  });

  it('stays unknown for a 53-minute-old equality even though elapsed time looks overdue', () => {
    const started = NOW - 3_180_000;
    const cert = certifyCheckpointProgress(
      liveAdvancing({ startedAtMs: started, progressAtMs: started, elapsedSec: 3180 }),
      NOW,
    );
    // The elapsed run time is far past any stall threshold; the verdict must still not be
    // `stalled`, because the input carries no evidence about progress either way.
    expect(cert.verdict).toBe('unknown');
    expect(cert.verdict).not.toBe('stalled');
  });

  it('stays unknown under a LIVE authority — a live read of an ambiguous value is still ambiguous', () => {
    const started = NOW - 4_000_000;
    for (const source of ['run-lock', 'process-authority'] as const) {
      const cert = certifyCheckpointProgress(
        liveAdvancing({ activeSource: source, startedAtMs: started, progressAtMs: started }),
        NOW,
      );
      expect(cert.basis).toBe('ambiguous-fallback');
      expect(cert.verdict).toBe('unknown');
      expect(cert.liveAuthority).toBe(true);
    }
  });

  it('stays unknown at any stall threshold, including a deliberately tiny one', () => {
    const started = NOW - 10_000;
    const cert = certifyCheckpointProgress(
      liveAdvancing({ startedAtMs: started, progressAtMs: started }),
      NOW,
      { stallThresholdMs: 1 },
    );
    expect(cert.verdict).toBe('unknown');
  });

  it('treats a null heartbeat as unmeasured, not as a stall', () => {
    const cert = certifyCheckpointProgress(liveAdvancing({ progressAtMs: null }), NOW);
    expect(cert.verdict).toBe('unknown');
    expect(cert.basis).toBe('progress-unmeasured');
    expect(cert.detail).toMatch(/not evidence of a stall/i);
  });

  it('treats an ABSENT heartbeat key the same as an explicit null', () => {
    const { progressAtMs: _dropped, ...withoutHeartbeat } = liveAdvancing();
    expect(certifyCheckpointProgress(withoutHeartbeat, NOW).basis).toBe('progress-unmeasured');
  });

  it('does NOT call it ambiguous when startedAtMs is null — no fallback could have produced the value', () => {
    // git-pipeline-stats.ts:1156 writes `startedAtMs` only when it is finite, so a non-null
    // heartbeat beside a null start is a genuine measurement, not the fallback collision.
    const cert = certifyCheckpointProgress(
      liveAdvancing({ startedAtMs: null, progressAtMs: NOW - 5_000 }),
      NOW,
    );
    expect(cert.basis).toBe('live-heartbeat');
    expect(cert.verdict).toBe('progressing');
  });

  it('reports unknown when both the start and the heartbeat are null', () => {
    const cert = certifyCheckpointProgress(
      liveAdvancing({ startedAtMs: null, progressAtMs: null }),
      NOW,
    );
    expect(cert.basis).toBe('progress-unmeasured');
  });
});

/**
 * D-005. A cache-backed reading is a hint in EITHER direction, so it may never carry the
 * expensive verdict.
 */
describe('certifyCheckpointProgress — evidence age caps the verdict (D-005)', () => {
  it('caps at unknown when a cache-backed reading is past the trust window', () => {
    const cert = certifyCheckpointProgress(
      { ...liveAdvancing(), activeSource: undefined, asOfAgeMs: 25_200_000 }, // the measured 7h
      NOW,
    );
    expect(cert.verdict).toBe('unknown');
    expect(cert.basis).toBe('evidence-too-old');
    expect(cert.evidenceAgeMs).toBe(25_200_000);
    expect(cert.evidenceAgeSource).toBe('cache');
    expect(cert.liveAuthority).toBe(false);
  });

  it('caps at unknown when the cache carried no age at all', () => {
    const cert = certifyCheckpointProgress(
      { ...liveAdvancing(), activeSource: undefined, asOfAgeMs: null },
      NOW,
    );
    expect(cert.basis).toBe('evidence-too-old');
    expect(cert.evidenceAgeMs).toBeNull();
    expect(cert.evidenceAgeSource).toBeNull();
    expect(cert.detail).toMatch(/freshness is unknown/i);
  });

  it('lets a FRESH cache-backed reading support progressing', () => {
    const cert = certifyCheckpointProgress(
      { ...liveAdvancing(), activeSource: undefined, asOfAgeMs: DEFAULT_EVIDENCE_TRUST_MS - 1 },
      NOW,
    );
    expect(cert.verdict).toBe('progressing');
    expect(cert.liveAuthority).toBe(false);
  });

  it('refuses to call a stale heartbeat `stalled` without a live authority, even inside the trust window', () => {
    const cert = certifyCheckpointProgress(
      {
        ...liveAdvancing(),
        activeSource: undefined,
        asOfAgeMs: 1_000,
        progressAtMs: NOW - (DEFAULT_STALL_THRESHOLD_MS + 60_000),
      },
      NOW,
    );
    expect(cert.verdict).toBe('unknown');
    expect(cert.basis).toBe('evidence-too-old');
    expect(cert.detail).toMatch(/before treating this as a stall/i);
  });

  it('names the clock behind every evidence age it reports', () => {
    const cases: ProgressCertificateInput[] = [
      liveAdvancing(),
      liveAdvancing({ verdictWrittenAtMs: NOW - 900_000 }),
      liveStale(),
      { ...liveAdvancing(), activeSource: undefined, asOfAgeMs: 25_200_000 },
    ];
    let aged = 0;
    for (const input of cases) {
      const cert = certifyCheckpointProgress(input, NOW);
      if (cert.evidenceAgeMs !== null) {
        aged += 1;
        expect(cert.evidenceAgeSource).not.toBeNull();
      }
    }
    // Positive control: the assertion above is conditional, so without this the whole loop
    // would pass vacuously if every case started returning a null age.
    expect(aged).toBe(cases.length);
  });
});

describe('certifyCheckpointProgress — a published verdict is not an overdue run', () => {
  it('reports progressing/verdict-published even when the heartbeat is long stale', () => {
    const cert = certifyCheckpointProgress(
      liveAdvancing({
        startedAtMs: NOW - 4_080_000, // 68 minutes
        progressAtMs: NOW - 3_000_000,
        verdictWrittenAtMs: NOW - 960_000, // decided at 52 minutes
      }),
      NOW,
    );
    expect(cert.verdict).toBe('progressing');
    expect(cert.basis).toBe('verdict-published');
    expect(cert.evidenceAgeMs).toBe(960_000);
    expect(cert.detail).toMatch(/salvage, not deciding/i);
  });

  it('treats a null verdictWrittenAtMs as still deciding, not as a published verdict', () => {
    expect(certifyCheckpointProgress(liveAdvancing({ verdictWrittenAtMs: null }), NOW).basis).toBe(
      'live-heartbeat',
    );
  });

  it('treats an ABSENT verdictWrittenAtMs as unknown, never as "still deciding"', () => {
    // The field is emitted only on the branch whose marker answered, so its absence must not
    // be read as information — the heartbeat rules decide instead.
    const { verdictWrittenAtMs: _dropped, ...withoutVerdict } = liveAdvancing();
    expect(certifyCheckpointProgress(withoutVerdict, NOW).basis).toBe('live-heartbeat');
  });
});

describe('certifyCheckpointProgress — heartbeat verdicts', () => {
  it('reports progressing for a live heartbeat inside the threshold', () => {
    const cert = certifyCheckpointProgress(liveAdvancing(), NOW);
    expect(cert.verdict).toBe('progressing');
    expect(cert.basis).toBe('live-heartbeat');
    expect(cert.evidenceAgeMs).toBe(30_000);
    expect(cert.evidenceAgeSource).toBe('heartbeat');
  });

  it('reports stalled ONLY with a live authority and a heartbeat past the threshold', () => {
    const cert = certifyCheckpointProgress(
      liveAdvancing({ progressAtMs: NOW - (DEFAULT_STALL_THRESHOLD_MS + 1) }),
      NOW,
    );
    expect(cert.verdict).toBe('stalled');
    expect(cert.basis).toBe('heartbeat-stale');
    expect(cert.liveAuthority).toBe(true);
  });

  it('treats exactly the threshold as still progressing', () => {
    const cert = certifyCheckpointProgress(
      liveAdvancing({ progressAtMs: NOW - DEFAULT_STALL_THRESHOLD_MS }),
      NOW,
    );
    expect(cert.verdict).toBe('progressing');
  });

  it('honours an explicit stallThresholdMs', () => {
    const input = liveAdvancing({ progressAtMs: NOW - 120_000 });
    expect(certifyCheckpointProgress(input, NOW, { stallThresholdMs: 60_000 }).verdict).toBe('stalled');
    expect(certifyCheckpointProgress(input, NOW, { stallThresholdMs: 180_000 }).verdict).toBe(
      'progressing',
    );
  });
});

describe('certifyCheckpointProgress — disagreeing clocks are unknown, not stalls', () => {
  it('reports clock-skew when the heartbeat precedes the run start', () => {
    const cert = certifyCheckpointProgress(
      liveAdvancing({ startedAtMs: NOW - 60_000, progressAtMs: NOW - 600_000 }),
      NOW,
    );
    expect(cert.verdict).toBe('unknown');
    expect(cert.basis).toBe('clock-skew');
    expect(cert.evidenceAgeMs).toBeNull();
  });

  it('reports clock-skew for a heartbeat far in the future', () => {
    const cert = certifyCheckpointProgress(liveAdvancing({ progressAtMs: NOW + 600_000 }), NOW);
    expect(cert.verdict).toBe('unknown');
    expect(cert.basis).toBe('clock-skew');
  });

  it('tolerates small jitter and floors the reported age at zero', () => {
    const cert = certifyCheckpointProgress(liveAdvancing({ progressAtMs: NOW + 5_000 }), NOW);
    expect(cert.verdict).toBe('progressing');
    expect(cert.basis).toBe('live-heartbeat');
    expect(cert.evidenceAgeMs).toBe(0);
  });
});

describe('certifyCheckpointProgress — the re-triage interlock is visible on every certificate (D-004)', () => {
  it('surfaces inRetriageWindow regardless of verdict', () => {
    const inputs: ProgressCertificateInput[] = [
      liveAdvancing({ inRetriageWindow: true }),
      liveStale({ inRetriageWindow: true }),
      liveAdvancing({ inRetriageWindow: true, progressAtMs: null }),
      { active: false, inRetriageWindow: true },
    ];
    for (const input of inputs) {
      expect(certifyCheckpointProgress(input, NOW).inRetriageWindow).toBe(true);
    }
  });

  it('defaults inRetriageWindow to false when the field is absent', () => {
    expect(certifyCheckpointProgress(liveAdvancing(), NOW).inRetriageWindow).toBe(false);
    expect(certifyCheckpointProgress(null, NOW).inRetriageWindow).toBe(false);
  });

  it('warns against a manual run in the detail of a stalled in-window certificate', () => {
    const cert = certifyCheckpointProgress(liveStale({ inRetriageWindow: true }), NOW);
    expect(cert.verdict).toBe('stalled');
    expect(cert.detail).toMatch(/do NOT fire a manual checkpoint run/i);
    expect(cert.detail).toMatch(/discard the in-flight rescue/i);
  });
});

describe('certifyCheckpointProgress — purity', () => {
  it('is a function of its inputs only: the same input at the same instant is identical', () => {
    const input = liveAdvancing();
    expect(certifyCheckpointProgress(input, NOW)).toEqual(certifyCheckpointProgress(input, NOW));
  });

  it('does not mutate its input', () => {
    const input = liveAdvancing({ inRetriageWindow: true });
    const before = JSON.stringify(input);
    certifyCheckpointProgress(input, NOW);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('moves only with the clock it is given', () => {
    const input = liveAdvancing({ progressAtMs: NOW - 100 });
    expect(certifyCheckpointProgress(input, NOW).verdict).toBe('progressing');
    expect(
      certifyCheckpointProgress(input, NOW + DEFAULT_STALL_THRESHOLD_MS + 1_000).verdict,
    ).toBe('stalled');
  });
});
