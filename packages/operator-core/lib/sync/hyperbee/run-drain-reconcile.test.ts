/**
 * run-drain-reconcile.test.ts — WI-254 (EI-1618 item 2).
 *
 * The periodic drain-reconcile pass: read undrained stats → map over LIVE booted
 * harnesses → file a DEDUPED improvement per stalled one. All deps injected, so the
 * test is PG/boot-free. Teeth-shaped: a capture must fire for a stalled harness and
 * NOT for a fresh/clean one (drop the threshold and it goes RED), with the stable
 * per-harness watchdog key (the dedup that keeps one improvement per stall).
 */
import { describe, it, expect, vi } from 'vitest';
import { runDrainReconcileOnce, type CaptureResult, type RunDrainReconcileDeps } from './run-drain-reconcile';
import type { SubstrateDrainStat } from './load-drain-stats';
import type { InProcessSubstrateStatus } from './in-process-status';

/** A fake getStatus mirroring getInProcessSubstrateStatus: it pulls each booted
 *  harness's drain through the resolver (so we exercise the loadDrainStats →
 *  resolver → planDrainReconcile chain end-to-end). */
function fakeGetStatus(booted: Array<[string, string]>) {
  return (opts: { resolveDrainStats: (ws: string, slug: string) => SubstrateDrainStat }): InProcessSubstrateStatus =>
    ({
      substrateActive: true,
      bootedCount: booted.length,
      summary: {} as never,
      logStats: [],
      harnesses: booted.map(([ws, slug]) => ({
        workspaceId: ws,
        harnessSlug: slug,
        verdict: 'healthy',
        reasons: [],
        drain: opts.resolveDrainStats(ws, slug),
      })),
    }) as InProcessSubstrateStatus;
}

const okCapture = (): CaptureResult => ({ created: true, issue: { id: 'EI-X' } });

describe('runDrainReconcileOnce', () => {
  it('files ONE deduped improvement per stalled booted harness, none for fresh/clean', async () => {
    const drainByKey = new Map<string, SubstrateDrainStat>([
      ['ws::stalled', { undrainedCount: 5, oldestUndrainedAgeMs: 120_000 }],
      ['ws::veryStalled', { undrainedCount: 12, oldestUndrainedAgeMs: 600_000 }],
      ['ws::fresh', { undrainedCount: 3, oldestUndrainedAgeMs: 5_000 }],
      // ws::clean intentionally absent → resolver returns zero-drain
    ]);
    const capture = vi.fn<NonNullable<RunDrainReconcileDeps['capture']>>(async () => okCapture());

    const res = await runDrainReconcileOnce({
      loadDrainStats: async () => drainByKey,
      getStatus: fakeGetStatus([
        ['ws', 'stalled'],
        ['ws', 'veryStalled'],
        ['ws', 'fresh'],
        ['ws', 'clean'],
      ]),
      capture,
      log: () => {},
    });

    expect(res.flagged.map((f) => f.harnessSlug).sort()).toEqual(['stalled', 'veryStalled']);
    expect(res.captured).toBe(2);
    expect(capture).toHaveBeenCalledTimes(2);

    // dedup key + severity mapping are honesty-shaped
    const calls = capture.mock.calls.map((c) => c[0]);
    const stalled = calls.find((a) => a.watchdogKey === 'federation-drain-stall:ws:stalled');
    const very = calls.find((a) => a.watchdogKey === 'federation-drain-stall:ws:veryStalled');
    expect(stalled).toBeDefined();
    expect(stalled?.severity).toBe('minor'); // 120s ≥ 60s but < 5m → degraded → minor
    expect(very?.severity).toBe('major'); // 600s ≥ 5m → unhealthy → major
    for (const a of calls) {
      expect(a.dedupScope).toBe('open'); // the dedup — one improvement per open stall, not per tick
      expect(a.kind).toBe('bug');
    }
  });

  it('files NOTHING when no booted harness is stalled', async () => {
    const capture = vi.fn(async () => okCapture());
    const res = await runDrainReconcileOnce({
      loadDrainStats: async () => new Map([['ws::a', { undrainedCount: 1, oldestUndrainedAgeMs: 1_000 }]]),
      getStatus: fakeGetStatus([['ws', 'a'], ['ws', 'b']]),
      capture,
    });
    expect(res.flagged).toEqual([]);
    expect(res.captured).toBe(0);
    expect(capture).not.toHaveBeenCalled();
  });

  it('counts only newly-created captures (a deduped capture does not increment)', async () => {
    const capture = vi.fn(async () => ({ created: false, reason: 'duplicate' }) as CaptureResult);
    const res = await runDrainReconcileOnce({
      loadDrainStats: async () => new Map([['ws::s', { undrainedCount: 2, oldestUndrainedAgeMs: 90_000 }]]),
      getStatus: fakeGetStatus([['ws', 's']]),
      capture,
      log: () => {},
    });
    expect(res.flagged).toHaveLength(1);
    expect(res.captured).toBe(0); // flagged but the improvement was deduped (already open)
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('is resilient: one capture throwing does not skip the others', async () => {
    const capture = vi
      .fn<(input: { watchdogKey: string }) => Promise<CaptureResult>>()
      .mockImplementationOnce(async () => {
        throw new Error('capture boom');
      })
      .mockImplementation(async () => okCapture());
    const res = await runDrainReconcileOnce({
      loadDrainStats: async () =>
        new Map([
          ['ws::s1', { undrainedCount: 1, oldestUndrainedAgeMs: 90_000 }],
          ['ws::s2', { undrainedCount: 1, oldestUndrainedAgeMs: 90_000 }],
        ]),
      getStatus: fakeGetStatus([['ws', 's1'], ['ws', 's2']]),
      capture: capture as never,
      log: () => {},
    });
    expect(res.flagged).toHaveLength(2);
    expect(capture).toHaveBeenCalledTimes(2); // both attempted despite the first throwing
    expect(res.captured).toBe(1); // only the second succeeded
  });
});
