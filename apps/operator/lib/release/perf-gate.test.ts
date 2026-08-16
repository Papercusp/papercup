/**
 * perf-gate.test — the F2 perf-regression deploy-gate decision (round-4 Lane F / P-031).
 * Pins the two load-bearing rules: DEFAULT-WARN (a crit only blocks when block-mode is
 * armed; warn never blocks) and FAIL-SOFT (disabled / stale / no-signal → pass, never
 * hold a deploy on missing perf data). Pure decision tests + injected-IO runPerfGate tests.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluatePerfGate,
  perfGatePolicyFromEnv,
  perfGatePolicyFromFlags,
  runPerfGate,
  type PerfGatePolicy,
  type PerfGateIO,
} from './perf-gate';
import type { PerfVerdict, PerfSignalsV1 } from '@papercusp/operator-core/lib/system-health/perf-budgets';

const NOW = Date.parse('2026-06-19T16:35:00Z');

/**
 * A PerfVerdict at `status` with `reasons`; other fields are irrelevant to the gate.
 *
 * WI-38449 / D-007 F3: a `crit` defaults to ALL-OPERATOR-DEFECT attribution, so every
 * pre-existing case in this file keeps asserting exactly what it always did (a crit
 * that blocks when armed). Cases that care about attribution pass `attribution`
 * explicitly — see the D-007 F3 describe block below.
 */
const verdict = (
  status: PerfVerdict['status'],
  reasons: string[] = [],
  attribution?: PerfVerdict['critAttribution'],
): PerfVerdict => ({
  status,
  degraded: status === 'crit',
  reasons,
  hostState: null,
  worstWorkerCpuPct: null,
  worstWorkerRssKb: null,
  closeWait: null,
  eventLoopLagP95Ms: null,
  operatorReachable: null,
  ageMs: null,
  stale: status === 'unknown',
  critAttribution:
    attribution ?? (status === 'crit' ? { operatorDefect: reasons, ambientHost: [] } : { operatorDefect: [], ambientHost: [] }),
});

const OFF: PerfGatePolicy = { enabled: false, block: false };
const WARN_ONLY: PerfGatePolicy = { enabled: true, block: false };
const ARMED: PerfGatePolicy = { enabled: true, block: true };

describe('evaluatePerfGate — pure decision', () => {
  it('disabled gate is a no-op pass even on a crit', () => {
    const d = evaluatePerfGate(verdict('crit', ['operator :3070 unreachable']), OFF, 'abcdef1234');
    expect(d.action).toBe('pass');
    expect(d.summary).toContain('disabled');
    expect(d.summary).toContain('abcdef12'); // short sha
  });

  it('ok verdict clears', () => {
    expect(evaluatePerfGate(verdict('ok'), WARN_ONLY).action).toBe('pass');
  });

  it('unknown (stale / no signal) clears — fail-soft, never block on missing data', () => {
    const d = evaluatePerfGate(verdict('unknown'), ARMED);
    expect(d.action).toBe('pass');
    expect(d.summary).toContain('no fresh perf signal');
  });

  it('warn verdict surfaces but never blocks — even when block-mode is armed', () => {
    const d = evaluatePerfGate(verdict('warn', ['a worker at 240% CPU']), ARMED, 'deadbeef00');
    expect(d.action).toBe('warn');
    expect(d.verdictStatus).toBe('warn');
    expect(d.reasons).toEqual(['a worker at 240% CPU']);
    expect(d.summary).toContain('deadbeef');
  });

  it('crit + block-mode NOT armed → warn (default-warn), deploy still advances', () => {
    const d = evaluatePerfGate(verdict('crit', ['hostState=wedge-active']), WARN_ONLY);
    expect(d.action).toBe('warn');
    expect(d.summary).toContain('block-mode not armed');
    expect(d.summary).toContain('hostState=wedge-active');
  });

  it('crit + block-mode armed → block', () => {
    const d = evaluatePerfGate(verdict('crit', ['event-loop lag p95 1746ms ≥ 1000ms']), ARMED);
    expect(d.action).toBe('block');
    expect(d.summary).toContain('BLOCKED');
    expect(d.reasons).toEqual(['event-loop lag p95 1746ms ≥ 1000ms']);
  });

  describe('D-007 F3: a crit blocks only for reasons attributable to the OPERATOR', () => {
    // The measured incident this exists for (2026-08-16): the live capture's ONLY crit
    // reason was ambient RAM pressure from ~100 peer agents, and an armed gate returned
    // `block` — holding every deploy for a condition no candidate caused and no release
    // could fix.
    const AMBIENT_REASON = 'PSI memory full avg60 11.45 ≥ 5 — all tasks stalled on memory reclaim/swap';
    const DEFECT_REASON = 'operator :3070 unreachable';

    const ambientOnly = () =>
      verdict('crit', [AMBIENT_REASON], { operatorDefect: [], ambientHost: [AMBIENT_REASON] });

    it('ARMED + ambient-only crit → warn, NOT block (the false-red this prevents)', () => {
      const d = evaluatePerfGate(ambientOnly(), ARMED, 'cafebabe00');
      expect(d.action).toBe('warn');
      // Still a crit, still fully reported — this changes what BLOCKS, not what is SEEN.
      expect(d.verdictStatus).toBe('crit');
      expect(d.reasons).toEqual([AMBIENT_REASON]);
    });

    it('an armed gate that declines to block SAYS SO — silence here would be an invisible suppression channel', () => {
      const d = evaluatePerfGate(ambientOnly(), ARMED);
      expect(d.summary).toContain('AMBIENT HOST');
      // It must NOT read as "not armed" — that is a different, misleading claim.
      expect(d.summary).not.toContain('block-mode not armed');
    });

    it('ARMED + operator-defect crit → block (arming is now actually useful)', () => {
      const d = evaluatePerfGate(
        verdict('crit', [DEFECT_REASON], { operatorDefect: [DEFECT_REASON], ambientHost: [] }),
        ARMED,
      );
      expect(d.action).toBe('block');
      expect(d.summary).toContain('BLOCKED');
      expect(d.summary).toContain('operator-defect');
    });

    it('DISCRIMINATION: identical reasons, only the attribution differs ⇒ opposite actions', () => {
      // The single-field pair that proves the decision turns on attribution and not on
      // reason text, count, or verdict tier — all of which are held constant here.
      const reasons = ['some crit reason'];
      const asDefect = evaluatePerfGate(
        verdict('crit', reasons, { operatorDefect: reasons, ambientHost: [] }),
        ARMED,
      );
      const asAmbient = evaluatePerfGate(
        verdict('crit', reasons, { operatorDefect: [], ambientHost: reasons }),
        ARMED,
      );
      expect(asDefect.action).toBe('block');
      expect(asAmbient.action).toBe('warn');
    });

    it('a MIXED crit blocks on the operator-defect reason, and names the ambient one as non-blocking', () => {
      const d = evaluatePerfGate(
        verdict('crit', [DEFECT_REASON, AMBIENT_REASON], {
          operatorDefect: [DEFECT_REASON],
          ambientHost: [AMBIENT_REASON],
        }),
        ARMED,
      );
      expect(d.action).toBe('block');
      expect(d.summary).toContain(DEFECT_REASON);
      expect(d.summary).toContain('ambient (not blocking)');
    });

    it('an UNATTRIBUTED crit never blocks — an unclassified reason must not invent a deploy hold', () => {
      const d = evaluatePerfGate(
        verdict('crit', ['from some older code path'], { operatorDefect: [], ambientHost: [] }),
        ARMED,
      );
      expect(d.action).toBe('warn');
      expect(d.summary).toContain('NO attribution');
    });

    it('survives a verdict built before critAttribution existed (runtime, not just types)', () => {
      // apps/operator is outside lint:tsc's scope and vitest does not typecheck, so a
      // stale caller reaches this code as a RUNTIME shape, not a compile error. It must
      // fail soft rather than throw on the destructure.
      const stale = verdict('crit', ['event-loop lag p95 1746ms ≥ 1000ms']) as PerfVerdict;
      delete (stale as Partial<PerfVerdict>).critAttribution;
      const d = evaluatePerfGate(stale, ARMED);
      expect(d.action).toBe('warn');
      expect(d.verdictStatus).toBe('crit');
    });

    it('CALIBRATION: ambient-only still blocks NOTHING when the gate is merely disabled or unarmed', () => {
      // Guards against a "passes for the wrong reason" reading of the cases above: if
      // arming were broken outright, every negative here would also pass.
      expect(evaluatePerfGate(ambientOnly(), OFF).action).toBe('pass');
      expect(evaluatePerfGate(ambientOnly(), WARN_ONLY).action).toBe('warn');
      // ...while a defect crit DOES flip to block the moment arming is turned on,
      // proving arming itself works.
      const defect = verdict('crit', [DEFECT_REASON], { operatorDefect: [DEFECT_REASON], ambientHost: [] });
      expect(evaluatePerfGate(defect, WARN_ONLY).action).toBe('warn');
      expect(evaluatePerfGate(defect, ARMED).action).toBe('block');
    });
  });
});

describe('perfGatePolicyFromEnv', () => {
  it('defaults OFF and warn-only when unset', () => {
    expect(perfGatePolicyFromEnv({})).toEqual({ enabled: false, block: false });
  });
  it('PAPERCUSP_PERF_GATE=1 enables, block stays off', () => {
    expect(perfGatePolicyFromEnv({ PAPERCUSP_PERF_GATE: '1' })).toEqual({ enabled: true, block: false });
  });
  it('both flags arm block-mode', () => {
    expect(perfGatePolicyFromEnv({ PAPERCUSP_PERF_GATE: '1', PAPERCUSP_PERF_GATE_BLOCK: '1' })).toEqual({
      enabled: true,
      block: true,
    });
  });
});

describe('perfGatePolicyFromFlags (WI-6538 — the production path)', () => {
  it('is ENABLED when the flag is on', async () => {
    // The whole point of the migration: green-checkpoint runs detached (systemd-run)
    // and as a periodic spawn, so an env var could not reliably arm it. A flag read
    // in-process at evaluation time can.
    await expect(perfGatePolicyFromFlags(async () => true, {})).resolves.toEqual({
      enabled: true,
      block: false,
    });
  });

  it('is a no-op when the flag is off — the kill-switch', async () => {
    await expect(perfGatePolicyFromFlags(async () => false, {})).resolves.toEqual({
      enabled: false,
      block: false,
    });
  });

  it('NEVER arms block-mode, even with the flag on and the block env set', async () => {
    // Load-bearing: flipping the master flag must not be able to start holding
    // deploys. Block-mode is a separate owner-gated step by design.
    const p = await perfGatePolicyFromFlags(async () => true, { PAPERCUSP_PERF_GATE_BLOCK: '1' });
    expect(p.block).toBe(false);
  });

  it('fails SOFT to disabled when the flag backend throws', async () => {
    // A flag backend outage must not take the release gate down with it — it should
    // degrade to the old inert no-op `pass`, not surface an error mid-deploy.
    await expect(
      perfGatePolicyFromFlags(async () => {
        throw new Error('flag backend down');
      }, {}),
    ).resolves.toEqual({ enabled: false, block: false });
  });

  it('still honours the env override for a deliberate local run', async () => {
    await expect(
      perfGatePolicyFromFlags(async () => false, { PAPERCUSP_PERF_GATE: '1' }),
    ).resolves.toEqual({ enabled: true, block: false });
  });
});

/** A fresh wedge-active capture (≈10s old relative to NOW). */
const critSignals: PerfSignalsV1 = {
  schemaVersion: 'perf-signals-v1',
  capturedAt: '2026-06-19T16:34:50Z',
  hostState: 'wedge-active',
  signals: {
    operator_3070_reachable: false,
    operatorWorkers: [{ pid: 1, cpuPct: 160, rssKb: 1_000_000, etimeSec: 100 }],
    closeWait_3070: 600,
  },
};

/** A stale capture (well beyond budgets.staleMs of 10min). */
// Briefly stale: older than staleMs (10min) but within blindMs (30min) — a skipped
// capture tick → verdict `unknown` (numbers untrustworthy, not yet "monitor blind").
const staleSignals: PerfSignalsV1 = {
  ...critSignals,
  capturedAt: '2026-06-19T16:20:00Z', // ~15min old
};

// Very stale: past blindMs (30min) — the capture producer is DEAD, not skipped-a-tick →
// verdict `warn` "host SLO monitor blind" (still never crit/block; WI-324 recurrence guard).
const blindSignals: PerfSignalsV1 = {
  ...critSignals,
  capturedAt: '2026-06-19T15:00:00Z', // ~95min old
};

function fakeIO(over: Partial<PerfGateIO> & { signals?: PerfSignalsV1 | null } = {}): PerfGateIO & { reads: number } {
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    now: over.now ?? (() => NOW),
    readSignals:
      over.readSignals ??
      (async () => {
        reads++;
        return over.signals ?? null;
      }),
  } as PerfGateIO & { reads: number };
}

describe('runPerfGate — IO + policy end to end', () => {
  it('disabled: passes WITHOUT reading any signal', async () => {
    const io = fakeIO({ signals: critSignals });
    const d = await runPerfGate(OFF, 'abc1234567', io);
    expect(d.action).toBe('pass');
    expect(io.reads).toBe(0); // no IO when off
  });

  it('armed + fresh wedge capture → block', async () => {
    const d = await runPerfGate(ARMED, 'abc1234567', fakeIO({ signals: critSignals }));
    expect(d.action).toBe('block');
    expect(d.verdictStatus).toBe('crit');
  });

  it('enabled warn-only + fresh wedge capture → warn (advance), not block', async () => {
    const d = await runPerfGate(WARN_ONLY, 'abc1234567', fakeIO({ signals: critSignals }));
    expect(d.action).toBe('warn');
  });

  it('briefly-stale capture → unknown → pass even when armed', async () => {
    const d = await runPerfGate(ARMED, 'abc1234567', fakeIO({ signals: staleSignals }));
    expect(d.action).toBe('pass');
    expect(d.verdictStatus).toBe('unknown');
  });

  it('very-stale (dead-producer/blind) capture → warn but NEVER blocks, even when armed', async () => {
    // WI-324 recurrence guard: a dead capture timer surfaces as warn (visible) but must
    // not hold a deploy — fail-soft on missing/blind perf data still holds.
    const d = await runPerfGate(ARMED, 'abc1234567', fakeIO({ signals: blindSignals }));
    expect(d.action).toBe('warn'); // surfaced, not silently passed
    expect(d.action).not.toBe('block'); // …but the deploy proceeds
    expect(d.verdictStatus).toBe('warn');
    expect(d.reasons.join(' ')).toMatch(/blind|stale/i);
  });

  it('read error → pass (fail-soft), never blocks the deploy', async () => {
    const io: PerfGateIO = { now: () => NOW, readSignals: async () => { throw new Error('disk gone'); } };
    const d = await runPerfGate(ARMED, 'abc1234567', io);
    expect(d.action).toBe('pass');
  });

  it('no capture (null) → pass', async () => {
    const d = await runPerfGate(ARMED, 'abc1234567', fakeIO({ signals: null }));
    expect(d.action).toBe('pass');
  });
});
