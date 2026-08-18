/**
 * B4 (infra-fail-fast-build-integrity-2026-06-19) — /api/health/deep subsystem
 * readiness. Tests the pure gating predicate + the deadline-bounded probe
 * (which is what would have turned the 2026-06-19 green-check-over-wedged-mem0
 * outage into a 503). The handler's real PG/memory round-trips are integration
 * territory; the logic here is what determines ready vs 503.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import {
  computeDeepReadiness,
  probeSubsystem,
  readCpuWorker,
  readLoopLag,
  type ProbeStatus,
} from './health-deep';
import route from './health-deep';
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

// WI-37696. `readCpuWorker` is a PASS-THROUGH, and that is precisely what has to
// be pinned: the failure it exists to expose is a `disabled` latch that produces
// byte-identical output, so a reader which returned a plausible-looking snapshot
// WITHOUT actually consulting the live module would be indistinguishable from a
// working one — and would report a permanent, silent degradation as healthy.
//
// So these drive the REAL cpu-task-worker module (its own `_injectWorkerCrashForTest`
// seam) and assert the reading MOVES with it. Asserting a hand-built shape, or a
// value recomputed here, would pass against a reader wired to nothing
// (EI-20053788422725852, the same lesson that produced `keepAlive`).
//
// `mod()` is a bare dynamic import with no `vi.resetModules()`, exactly as
// cpu-task-worker.test.ts does it, so the module record this test mutates IS the
// one health-deep.ts imported.
describe('readCpuWorker', () => {
  async function cpuMod() {
    return import('../../../cpu-task-worker');
  }

  afterEach(async () => {
    await (await cpuMod())._resetCpuWorker();
  });

  function bigBatch(m: { OFFLOAD_MIN_ITEMS: number }) {
    return Array.from({ length: m.OFFLOAD_MIN_ITEMS + 1 }, (_, i) => ({ id: i }));
  }

  it('reports the idle module before anything has offloaded (never-used reads as available, not as failed)', async () => {
    const r = readCpuWorker();
    expect(r.alive).toBe(false);
    expect(r.disabled).toBe(false);
    expect(r.pendingCount).toBe(0);
    expect(r.consecutiveCrashes).toBe(0);
    expect(typeof r.minItems).toBe('number');
  });

  it('tracks the live worker through spawn and crash (proves it reads the module, not a snapshot of its own)', async () => {
    const m = await cpuMod();
    const rows = bigBatch(m);
    // EI-20505664003243915: every crash now logs its cause, transient ones
    // included — those are exactly the crashes that used to vanish and leave a
    // later trip unexplained.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await m.serializeJsonResponse({ rows }, rows.length);
    expect(readCpuWorker().alive).toBe(true);

    expect(m._injectWorkerCrashForTest(new Error('transient boom'))).toBe(true);
    const afterCrash = readCpuWorker();
    expect(afterCrash.alive).toBe(false);
    // One transient crash must NOT read as a tripped breaker — that distinction
    // is the whole point of surfacing `disabled` rather than `alive`.
    expect(afterCrash.disabled).toBe(false);
    // The crash landed with NOTHING in flight, so no request actually failed:
    // the last eligible request WAS served and the verdict correctly still reads
    // 'serving'. The crash is carried by consecutiveCrashes, not by demoting a
    // working offload. (This assertion originally read 'silently-falling-back'
    // and was wrong — it exposed a verdict keyed off a CUMULATIVE served count,
    // which would have reported 'serving' forever after a single boot-time
    // success. The verdict now keys off the most recent eligible outcome.)
    expect(afterCrash.verdict).toBe('serving');
    expect(afterCrash.consecutiveCrashes).toBe(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('transient boom');
    errSpy.mockRestore();
  });

  it('surfaces a TRIPPED breaker — the one field an operator must be able to alert on', async () => {
    const m = await cpuMod();
    const rows = bigBatch(m);

    // Latching the breaker deliberately writes the operator-facing warning to
    // console.error, and operator-core's vitest setup FAILS any test that does.
    // Spy rather than silence: that log is the only runtime trace the latch
    // leaves, so assert it actually fired instead of merely swallowing it.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // "Spawns fine, dies on every message": drop the reply so no request is ever
      // served, which is the run the breaker exists to give up on.
      const realPost = Worker.prototype.postMessage;
      (Worker.prototype as unknown as { postMessage: () => void }).postMessage = () => {};
      try {
        for (let i = 0; i < 3; i++) {
          const inFlight = m.serializeJsonResponse({ rows }, rows.length);
          for (let t = 0; t < 200 && readCpuWorker().pendingCount === 0; t++) {
            await new Promise((r) => setTimeout(r, 10));
          }
          expect(m._injectWorkerCrashForTest(new Error(`boom ${i}`))).toBe(true);
          await inFlight; // answered by the sync fallback
        }
      } finally {
        (Worker.prototype as unknown as { postMessage: typeof realPost }).postMessage = realPost;
      }

      // The process is still CORRECT and would still answer /health/deep 200 —
      // which is exactly why this has to appear in the payload. Without it the
      // offload is gone for the rest of the process lifetime with no other trace.
      expect(readCpuWorker()).toMatchObject({ disabled: true, consecutiveCrashes: 3 });
      expect(errSpy.mock.calls.flat().join(' ')).toContain('worker-breaker TRIPPED');
    } finally {
      errSpy.mockRestore();
    }
  });

  // A reader nothing SERVES is exactly as silent as no reader at all, so pin the
  // wiring too, not just the function: this fails if `cpuWorker` is dropped from
  // the response while `readCpuWorker` keeps working (and passing its own tests).
  //
  // Deliberately asserts nothing about `ready`/status: the PG and memory probes
  // legitimately fail in a unit-test environment, and the point here is that the
  // breaker is reported REGARDLESS of the readiness verdict — a degraded offload
  // must stay visible on a host that is otherwise answering fine.
  it('is served in the /health/deep payload, not merely exported', async () => {
    const res = await (
      route as unknown as { handler: (...a: unknown[]) => Promise<Response> }
    ).handler({}, {});
    const body = (await res.json()) as { cpuWorker?: Record<string, unknown> };

    expect(body.cpuWorker).toBeDefined();
    expect(body.cpuWorker).toMatchObject({
      alive: expect.any(Boolean),
      disabled: expect.any(Boolean),
      pendingCount: expect.any(Number),
      consecutiveCrashes: expect.any(Number),
    });
  }, 30000);
});
