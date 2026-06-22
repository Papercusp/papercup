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
  runPerfGate,
  type PerfGatePolicy,
  type PerfGateIO,
} from './perf-gate';
import type { PerfVerdict, PerfSignalsV1 } from '@papercusp/operator-core/lib/system-health/perf-budgets';

const NOW = Date.parse('2026-06-19T16:35:00Z');

/** A PerfVerdict at `status` with `reasons`; other fields are irrelevant to the gate. */
const verdict = (status: PerfVerdict['status'], reasons: string[] = []): PerfVerdict => ({
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
