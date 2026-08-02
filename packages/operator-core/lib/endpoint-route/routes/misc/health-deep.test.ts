/**
 * B4 (infra-fail-fast-build-integrity-2026-06-19) — /api/health/deep subsystem
 * readiness. Tests the pure gating predicate + the deadline-bounded probe
 * (which is what would have turned the 2026-06-19 green-check-over-wedged-mem0
 * outage into a 503). The handler's real PG/memory round-trips are integration
 * territory; the logic here is what determines ready vs 503.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { computeDeepReadiness, probeSubsystem, readLoopLag, type ProbeStatus } from './health-deep';
import { startEventLoopLagMonitor, type LagMonitorHandle } from '../../../event-loop-lag-monitor';

describe('computeDeepReadiness', () => {
  const base = { dbosEnabled: false, dbosLaunched: false, pg: 'ok' as ProbeStatus, memory: 'ok' as ProbeStatus };

  it('ready when PG ok + memory ok and DBOS not enabled', () => {
    expect(computeDeepReadiness(base)).toBe(true);
  });

  it('NOT ready when PG is down (operator cannot serve without PG)', () => {
    expect(computeDeepReadiness({ ...base, pg: 'down' })).toBe(false);
  });

  it('NOT ready when memory is down (the wedged-mem0 outage case)', () => {
    expect(computeDeepReadiness({ ...base, memory: 'down' })).toBe(false);
  });

  it('READY when memory is merely disabled (a NoopBackend host is healthy)', () => {
    expect(computeDeepReadiness({ ...base, memory: 'disabled' })).toBe(true);
  });

  it('gates on DBOS launch only when DBOS is enabled (mirrors isReady)', () => {
    expect(computeDeepReadiness({ ...base, dbosEnabled: true, dbosLaunched: false })).toBe(false);
    expect(computeDeepReadiness({ ...base, dbosEnabled: true, dbosLaunched: true })).toBe(true);
  });
});

describe('probeSubsystem', () => {
  it('returns the fn status on success (ok)', async () => {
    const r = await probeSubsystem(async () => 'ok', 1000);
    expect(r.status).toBe('ok');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('passes through a disabled status', async () => {
    const r = await probeSubsystem(async () => 'disabled', 1000);
    expect(r.status).toBe('disabled');
  });

  it('maps a thrown error to down, capturing the detail', async () => {
    const r = await probeSubsystem(async () => {
      throw new Error('SELECT 1 failed: connection refused');
    }, 1000);
    expect(r.status).toBe('down');
    expect(r.detail).toMatch(/connection refused/);
  });

  it('maps a HANG to down via the deadline (the outage signature)', async () => {
    const r = await probeSubsystem(() => new Promise<ProbeStatus>(() => {}), 20);
    expect(r.status).toBe('down');
    expect(r.detail).toMatch(/timeout after 20ms/);
  });
});

// EI-19285078178745571: a green /api/health(/deep) during an actually-wedged host is
// exactly the detector gap this closes (a 2026-08-01 incident had every MCP call hang
// while both stayed 200; the near-identical 2026-06-19 EI-79 outage was event-loop-lag
// shaped). These pin readLoopLag's no-monitor-running fail-safe AND its live pass-through
// of the SAME event-loop-lag-monitor gauge the P-010 admission layer already sheds on.
describe('readLoopLag', () => {
  let handle: LagMonitorHandle | undefined;
  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  it('no monitor running ⇒ pressure ok, every figure null (absence of signal is never a false-healthy OR false-unhealthy claim)', () => {
    const r = readLoopLag();
    expect(r.pressure).toBe('ok');
    expect(r.p95Ms).toBeNull();
    expect(r.p99Ms).toBeNull();
    expect(r.maxMs).toBeNull();
  });

  it('a running monitor is reflected live (finite figures, pressure derived from the SAME gauge the admission layer reads)', () => {
    handle = startEventLoopLagMonitor();
    const r = readLoopLag();
    expect(['ok', 'elevated', 'critical']).toContain(r.pressure);
    expect(typeof r.p95Ms).toBe('number');
    expect(typeof r.p99Ms).toBe('number');
    expect(typeof r.maxMs).toBe('number');
  });
});
