/**
 * perf-budgets.test — the per-thread SLO budget evaluator (round-4 Lane F / P-030).
 * Pure boundary tests: no IO. Pins the load-bearing reframe (loadavg is NOT a budget
 * on a 128-core box), the definitive-wedge crits, the warn tiers, and the fail-safes
 * (stale never reds; null/wrong-schema → unknown).
 */
import { describe, it, expect } from 'vitest';
import { evaluatePerfSignals, type PerfSignalsV1 } from './perf-budgets';

const NOW = Date.parse('2026-06-19T16:35:00Z');
const sig = (
  over: Partial<PerfSignalsV1['signals']> = {},
  top: Partial<PerfSignalsV1> = {},
): PerfSignalsV1 => ({
  schemaVersion: 'perf-signals-v1',
  capturedAt: '2026-06-19T16:34:50Z', // ~10s old → fresh
  hostState: 'stable',
  signals: {
    loadavg: { l1: 18, l5: 19, l15: 20, cores: 128 },
    operatorWorkers: [{ pid: 1, cpuPct: 9, rssKb: 1_000_000, etimeSec: 100 }],
    closeWait_3070: 0,
    gateway_8788_reachable: true,
    operator_3070_reachable: true,
    ...over,
  },
  ...top,
});

describe('evaluatePerfSignals (per-thread SLO budgets)', () => {
  it('ok on a clean stable capture', () => {
    expect(evaluatePerfSignals(sig(), NOW).status).toBe('ok');
  });

  // THE reframe (round-4 D-010): loadavg 22 on 128 cores is NOT degraded, and a single
  // hot worker while "stable" is fine (su-1aa2f's 199%-while-stable live proof).
  it('does NOT degrade on high loadavg + a 199% worker while stable (128-core reframe)', () => {
    const v = evaluatePerfSignals(
      sig({ loadavg: { l1: 22, l5: 22, l15: 22, cores: 128 }, operatorWorkers: [{ pid: 1, cpuPct: 199, rssKb: 1_000_000, etimeSec: 100 }] }),
      NOW,
    );
    expect(v.status).toBe('ok'); // 199% < 200 warn budget; loadavg is never thresholded
    expect(v.degraded).toBe(false);
  });

  it('crit when the operator :3070 is unreachable (definitive wedge)', () => {
    const v = evaluatePerfSignals(sig({ operator_3070_reachable: false }), NOW);
    expect(v.status).toBe('crit');
    expect(v.degraded).toBe(true);
    expect(v.reasons.join(' ')).toMatch(/unreachable/);
  });

  it('crit when hostState is wedge-active (E1 caught a live wedge)', () => {
    expect(evaluatePerfSignals(sig({}, { hostState: 'wedge-active' }), NOW).status).toBe('crit');
  });

  it('crit on event-loop lag p95 over the crit budget', () => {
    const v = evaluatePerfSignals(sig({ eventLoopLag: { lag_p95_ms: 1746 } }), NOW);
    expect(v.status).toBe('crit');
    expect(v.eventLoopLagP95Ms).toBe(1746);
  });

  it('reads the MCP-merged eventLoopLag from _mcp_supplemented too', () => {
    expect(evaluatePerfSignals(sig({ _mcp_supplemented: { eventLoopLag: { lag_p95_ms: 1200 } } }), NOW).status).toBe('crit');
  });

  it('crit on a CLOSE_WAIT storm (event-loop peg symptom, deeb4 935 peak)', () => {
    expect(evaluatePerfSignals(sig({ closeWait_3070: 935 }), NOW).status).toBe('crit');
  });

  it('warn (not crit) on a hot worker over the CPU% warn budget', () => {
    const v = evaluatePerfSignals(sig({ operatorWorkers: [{ pid: 1, cpuPct: 272, rssKb: 1_000_000, etimeSec: 100 }] }), NOW);
    expect(v.status).toBe('warn');
    expect(v.worstWorkerCpuPct).toBe(272);
  });

  it('warn on a worker RSS over the leak budget (bg-host 3.2GB OOM class)', () => {
    expect(evaluatePerfSignals(sig({ operatorWorkers: [{ pid: 1, cpuPct: 9, rssKb: 3_200_000, etimeSec: 100 }] }), NOW).status).toBe('warn');
  });

  it('warn on CLOSE_WAIT past the warn budget but below crit', () => {
    expect(evaluatePerfSignals(sig({ closeWait_3070: 300 }), NOW).status).toBe('warn');
  });

  it('warn when the inference gateway is unreachable', () => {
    expect(evaluatePerfSignals(sig({ gateway_8788_reachable: false }), NOW).status).toBe('warn');
  });

  it('crit outranks warn (unreachable + a hot worker → crit)', () => {
    expect(
      evaluatePerfSignals(sig({ operator_3070_reachable: false, operatorWorkers: [{ pid: 1, cpuPct: 272, rssKb: 4_000_000, etimeSec: 100 }] }), NOW).status,
    ).toBe('crit');
  });

  it('unknown (never reds) on a BRIEFLY-stale capture — even one that looks crit', () => {
    // staleMs(10min) < age(15min) <= blindMs(30min): the timer skipped a tick — numbers
    // untrustworthy → unknown, but not yet a "monitor blind" alarm.
    const v = evaluatePerfSignals(sig({ operator_3070_reachable: false }, { capturedAt: '2026-06-19T16:20:00Z' }), NOW); // ~15min old
    expect(v.status).toBe('unknown');
    expect(v.stale).toBe(true);
    expect(v.degraded).toBe(false); // stale crit-looking data must NOT red the system
  });

  it('warn "monitor blind" on a VERY-stale capture (dead producer) — still never crit (WI-324 guard)', () => {
    // age(95min) > blindMs(30min): the capture timer has DIED, not skipped a tick — the
    // host SLO monitor is blind. Surface as warn so it is visible, but a stale crit-looking
    // capture must STILL never red (degraded=false), preserving the original fail-safe.
    const v = evaluatePerfSignals(sig({ operator_3070_reachable: false }, { capturedAt: '2026-06-19T15:00:00Z' }), NOW); // ~95min old
    expect(v.status).toBe('warn');
    expect(v.stale).toBe(true);
    expect(v.degraded).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/blind|stale/i);
  });

  it('unknown on null / wrong-schema input', () => {
    expect(evaluatePerfSignals(null, NOW).status).toBe('unknown');
    expect(evaluatePerfSignals({ schemaVersion: 'other' } as unknown as PerfSignalsV1, NOW).status).toBe('unknown');
  });
});
