/**
 * in-process-periodic.test.ts — EI-1622. Pins the lightweight in-process scheduler
 * that replaced the high-frequency ephemeral DBOS periodic workflows:
 *  - runPeriodicCheck: heavy ticks shed, light ticks never shed, a throw is swallowed.
 *  - armInProcessPeriodicChecks: idempotent, unref'd, re-entrancy-guarded, disarmable.
 *  - buildDefaultChecks: the exact converted set + cadences + which ticks shed.
 *
 * Pure: every check is injected (no real timers fire against PG/flags; the default
 * ticks are only inspected as config, never invoked).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  armInProcessPeriodicChecks,
  buildDefaultChecks,
  disarmInProcessPeriodicChecks,
  inProcessPeriodicChecksArmed,
  runPeriodicCheck,
  type PeriodicCheck,
} from './in-process-periodic';

afterEach(() => {
  disarmInProcessPeriodicChecks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runPeriodicCheck', () => {
  it('runs a light (non-shed) tick and never consults the shed policy', async () => {
    const tick = vi.fn(async () => {});
    const shouldShed = vi.fn(() => true); // would shed — but a light check ignores it
    const check: PeriodicCheck = { name: 'light', intervalMs: 1000, tick };
    const res = await runPeriodicCheck(check, { shouldShed });
    expect(res).toEqual({ ran: true });
    expect(tick).toHaveBeenCalledOnce();
    expect(shouldShed).not.toHaveBeenCalled();
  });

  it('skips a HEAVY tick when the shed policy says to shed (tick not called)', async () => {
    const tick = vi.fn(async () => {});
    const check: PeriodicCheck = { name: 'heavy', intervalMs: 1000, shed: true, tick };
    const res = await runPeriodicCheck(check, { shouldShed: () => true });
    expect(res).toEqual({ ran: false, shed: true });
    expect(tick).not.toHaveBeenCalled();
  });

  it('runs a HEAVY tick when the shed policy says not to shed', async () => {
    const tick = vi.fn(async () => {});
    const check: PeriodicCheck = { name: 'heavy', intervalMs: 1000, shed: true, tick };
    const res = await runPeriodicCheck(check, { shouldShed: () => false });
    expect(res).toEqual({ ran: true });
    expect(tick).toHaveBeenCalledOnce();
  });

  it('swallows a throwing tick (never throws) and logs it', async () => {
    const log = vi.fn();
    const check: PeriodicCheck = {
      name: 'boom',
      intervalMs: 1000,
      tick: async () => {
        throw new Error('kaboom');
      },
    };
    const res = await runPeriodicCheck(check, { log });
    expect(res).toEqual({ ran: false });
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain('boom tick failed');
    expect(log.mock.calls[0][0]).toContain('kaboom');
  });
});

describe('armInProcessPeriodicChecks', () => {
  it('fires each check on its own interval and disarm stops it', async () => {
    vi.useFakeTimers();
    const a = vi.fn(async () => {});
    const b = vi.fn(async () => {});
    const checks: PeriodicCheck[] = [
      { name: 'a', intervalMs: 1000, tick: a },
      { name: 'b', intervalMs: 2000, tick: b },
    ];
    armInProcessPeriodicChecks({ checks });
    expect(inProcessPeriodicChecksArmed()).toBe(true);

    await vi.advanceTimersByTimeAsync(2000); // a fires twice (1s, 2s), b once (2s)
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);

    disarmInProcessPeriodicChecks();
    expect(inProcessPeriodicChecksArmed()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000); // no further fires after disarm
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a second arm is a no-op (does not arm a different check set)', async () => {
    vi.useFakeTimers();
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    armInProcessPeriodicChecks({ checks: [{ name: 'first', intervalMs: 1000, tick: first }] });
    armInProcessPeriodicChecks({ checks: [{ name: 'second', intervalMs: 1000, tick: second }] });

    await vi.advanceTimersByTimeAsync(1000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled(); // the 2nd arm was ignored
  });

  it('re-entrancy guard: a still-running tick is not fired concurrently', async () => {
    vi.useFakeTimers();
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const check: PeriodicCheck = {
      name: 'slow',
      intervalMs: 1000,
      tick: async () => {
        entered += 1;
        await gate; // hold the tick open across the next interval
      },
    };
    armInProcessPeriodicChecks({ checks: [check] });

    await vi.advanceTimersByTimeAsync(1000); // fire 1 → entered=1, tick pending
    await vi.advanceTimersByTimeAsync(1000); // fire 2 → running guard skips it
    expect(entered).toBe(1);

    release(); // let the held tick finish → running flag clears
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000); // fire 3 → runs again
    expect(entered).toBe(2);
  });
});

describe('buildDefaultChecks (the converted EI-1622 set)', () => {
  const checks = buildDefaultChecks();
  const byName = new Map(checks.map((c) => [c.name, c]));

  it('converts exactly the 11 high-frequency ephemeral probes', () => {
    expect([...byName.keys()].sort()).toEqual(
      [
        'completion-ref-verify',
        'connection-pressure',
        'federation-drain-reconcile',
        'harness-status-sweep',
        'hive-epoch-key-reconcile',
        'learning-infra-health',
        'service-health',
        'spawn-reclaim-sweep',
        'stale-claim-sweep',
        'steering-churn-sweep',
        'system-health',
      ].sort(),
    );
  });

  it('preserves each check cadence (no frequency cuts — the row-cost is already gone)', () => {
    expect(byName.get('system-health')!.intervalMs).toBe(30_000);
    expect(byName.get('harness-status-sweep')!.intervalMs).toBe(30_000);
    expect(byName.get('connection-pressure')!.intervalMs).toBe(30_000);
    expect(byName.get('service-health')!.intervalMs).toBe(60_000);
    expect(byName.get('completion-ref-verify')!.intervalMs).toBe(60_000);
    expect(byName.get('spawn-reclaim-sweep')!.intervalMs).toBe(60_000);
    expect(byName.get('stale-claim-sweep')!.intervalMs).toBe(60_000);
    expect(byName.get('learning-infra-health')!.intervalMs).toBe(120_000);
    expect(byName.get('steering-churn-sweep')!.intervalMs).toBe(300_000);
    expect(byName.get('federation-drain-reconcile')!.intervalMs).toBe(300_000);
    expect(byName.get('hive-epoch-key-reconcile')!.intervalMs).toBe(600_000);
  });

  it('only the heavy ticks shed under load (parity with shouldShedHeavyTick)', () => {
    const shedders = checks.filter((c) => c.shed).map((c) => c.name).sort();
    // federation-drain-reconcile sheds: it group-scans substrate_outbox, and a real
    // stall persists, so a shed tick is caught next interval (WI-254).
    // hive-epoch-key-reconcile sheds: it can derive+wrap epoch keys for a gappy hive; a real gap
    // persists, so a shed tick is caught next interval (WI-887). It is GAP-AWARE so the steady
    // state does no crypto regardless.
    expect(shedders).toEqual([
      'federation-drain-reconcile',
      'harness-status-sweep',
      'hive-epoch-key-reconcile',
      'system-health',
    ]);
  });
});
