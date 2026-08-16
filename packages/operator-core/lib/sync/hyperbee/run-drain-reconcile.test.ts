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
      replicationLiveness: [],
      reachedSubstrateOwner: true,
      // EI-20575137548097507: this fixture models the SUBSTRATE OWNER (it
      // reports harnesses from its own boot map), so its health inputs are
      // genuinely observed — `replicationLiveness: []` here means "measured,
      // nothing stalled", not "could not measure". A non-owner fixture would
      // set this false and its harnesses would read 'degraded'.
      healthInputsObserved: true,
      harnesses: booted.map(([ws, slug]) => ({
        workspaceId: ws,
        harnessSlug: slug,
        verdict: 'healthy',
        reasons: [],
        drain: opts.resolveDrainStats(ws, slug),
        ownLogFork: { forked: false, keyHex: null, detectedAtMs: null, detail: null },
      })),
    }) as InProcessSubstrateStatus;
}

const okCapture = (): CaptureResult => ({ created: true, issue: { id: 'EI-X' } });

describe('runDrainReconcileOnce', () => {
  it('files ONE deduped improvement per stalled booted harness, none for fresh/clean', async () => {
    const drainByKey = new Map<string, SubstrateDrainStat>([
      ['ws::stalled', { undrainedCount: 5, oldestUndrainedAgeMs: 8 * 60_000 }],
      ['ws::veryStalled', { undrainedCount: 12, oldestUndrainedAgeMs: 25 * 60_000 }],
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
    expect(stalled?.severity).toBe('minor'); // 8min ≥ 5min but < 20min → degraded → minor
    expect(very?.severity).toBe('major'); // 25min ≥ 20min → unhealthy → major
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
      loadDrainStats: async () => new Map([['ws::s', { undrainedCount: 2, oldestUndrainedAgeMs: 8 * 60_000 }]]),
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
          ['ws::s1', { undrainedCount: 1, oldestUndrainedAgeMs: 8 * 60_000 }],
          ['ws::s2', { undrainedCount: 1, oldestUndrainedAgeMs: 8 * 60_000 }],
        ]),
      getStatus: fakeGetStatus([['ws', 's1'], ['ws', 's2']]),
      capture: capture as never,
      log: () => {},
    });
    expect(res.flagged).toHaveLength(2);
    expect(capture).toHaveBeenCalledTimes(2); // both attempted despite the first throwing
    expect(res.captured).toBe(1); // only the second succeeded
  });

  it('does NOT flag a routine host-recycle catch-up gap (97s, 2026-07-19 live incident)', async () => {
    // dev-box host self-recycle is normal/self-healing, not a stall — see
    // plan-drain-reconcile.ts's DRAIN_STALLED_MS doc comment for the live incident.
    const capture = vi.fn(async () => okCapture());
    const res = await runDrainReconcileOnce({
      loadDrainStats: async () => new Map([['ws::recycling', { undrainedCount: 14, oldestUndrainedAgeMs: 97_000 }]]),
      getStatus: fakeGetStatus([['ws', 'recycling']]),
      capture,
      log: () => {},
    });
    expect(res.flagged).toEqual([]);
    expect(capture).not.toHaveBeenCalled();
  });

  // 2026-07-20 ticket-storm fix (EI-18151359560402948 follow-up): a recurring stall
  // whose PRIOR issue was already closed recently must post a recurrence comment,
  // not mint a duplicate issue — see the module doc comment for the 20-tickets/9h
  // live evidence this guards against.
  describe('re-file cooldown', () => {
    it('comments on a recently-closed same-key issue instead of filing a duplicate', async () => {
      const capture = vi.fn(async () => okCapture());
      const commentOnRecurrence = vi.fn<NonNullable<RunDrainReconcileDeps['commentOnRecurrence']>>(async () => ({}));
      const findByWatchdogKey = vi.fn<NonNullable<RunDrainReconcileDeps['findByWatchdogKey']>>(async () => [
        { id: 'EI-prior', state: 'done', updatedAt: new Date(1_000_000 - 5 * 60_000).toISOString() },
      ]);
      const res = await runDrainReconcileOnce({
        loadDrainStats: async () => new Map([['ws::flapping', { undrainedCount: 9, oldestUndrainedAgeMs: 9 * 60_000 }]]),
        getStatus: fakeGetStatus([['ws', 'flapping']]),
        capture,
        findByWatchdogKey,
        commentOnRecurrence,
        nowMs: 1_000_000, // prior closed 5min ago — well inside the default 30min cooldown
        log: () => {},
      });
      expect(findByWatchdogKey).toHaveBeenCalledWith('federation-drain-stall:ws:flapping');
      expect(capture).not.toHaveBeenCalled();
      expect(commentOnRecurrence).toHaveBeenCalledTimes(1);
      expect(commentOnRecurrence.mock.calls[0][0]).toBe('EI-prior');
      expect(res.captured).toBe(0);
      expect(res.coolingDown).toBe(1);
    });

    it('files a fresh issue once the cooldown has elapsed', async () => {
      const capture = vi.fn(async () => okCapture());
      const commentOnRecurrence = vi.fn(async () => ({}));
      const findByWatchdogKey = vi.fn(async () => [
        { id: 'EI-prior', state: 'done', updatedAt: new Date(1_000_000 - 4 * 60 * 60_000).toISOString() },
      ]);
      const res = await runDrainReconcileOnce({
        loadDrainStats: async () => new Map([['ws::flapping', { undrainedCount: 9, oldestUndrainedAgeMs: 9 * 60_000 }]]),
        getStatus: fakeGetStatus([['ws', 'flapping']]),
        capture,
        findByWatchdogKey,
        commentOnRecurrence,
        nowMs: 1_000_000, // prior closed 4h ago — past the default 3h cooldown
        log: () => {},
      });
      expect(capture).toHaveBeenCalledTimes(1);
      expect(commentOnRecurrence).not.toHaveBeenCalled();
      expect(res.captured).toBe(1);
      expect(res.coolingDown).toBe(0);
    });

    it('does not cool down on a still-OPEN top hit — leaves the decision to capture()’s own dedup', async () => {
      const capture = vi.fn(async () => ({ created: false, reason: 'likely-duplicate' }) as CaptureResult);
      const commentOnRecurrence = vi.fn(async () => ({}));
      const findByWatchdogKey = vi.fn(async () => [{ id: 'EI-open', state: 'open', updatedAt: new Date(1_000_000).toISOString() }]);
      const res = await runDrainReconcileOnce({
        loadDrainStats: async () => new Map([['ws::flapping', { undrainedCount: 9, oldestUndrainedAgeMs: 9 * 60_000 }]]),
        getStatus: fakeGetStatus([['ws', 'flapping']]),
        capture,
        findByWatchdogKey,
        commentOnRecurrence,
        nowMs: 1_000_000,
        log: () => {},
      });
      expect(capture).toHaveBeenCalledTimes(1); // still asked — capture()'s own open-dedup declines it
      expect(commentOnRecurrence).not.toHaveBeenCalled();
      expect(res.coolingDown).toBe(0);
    });

    it('a lookup failure degrades to the always-refile path (fails open, never wedges the watchdog)', async () => {
      const capture = vi.fn(async () => okCapture());
      const findByWatchdogKey = vi.fn(async () => {
        throw new Error('pg boom');
      });
      const res = await runDrainReconcileOnce({
        loadDrainStats: async () => new Map([['ws::flapping', { undrainedCount: 9, oldestUndrainedAgeMs: 9 * 60_000 }]]),
        getStatus: fakeGetStatus([['ws', 'flapping']]),
        capture,
        findByWatchdogKey,
        nowMs: 1_000_000,
        log: () => {},
      });
      expect(capture).toHaveBeenCalledTimes(1);
      expect(res.captured).toBe(1);
      expect(res.coolingDown).toBe(0);
    });

    it('refileCooldownMs: 0 disables the guard entirely (opt-out escape hatch)', async () => {
      const capture = vi.fn(async () => okCapture());
      const findByWatchdogKey = vi.fn(async () => [
        { id: 'EI-prior', state: 'done', updatedAt: new Date(1_000_000).toISOString() },
      ]);
      const res = await runDrainReconcileOnce({
        loadDrainStats: async () => new Map([['ws::flapping', { undrainedCount: 9, oldestUndrainedAgeMs: 9 * 60_000 }]]),
        getStatus: fakeGetStatus([['ws', 'flapping']]),
        capture,
        findByWatchdogKey,
        refileCooldownMs: 0,
        nowMs: 1_000_000,
        log: () => {},
      });
      expect(capture).toHaveBeenCalledTimes(1);
      expect(res.coolingDown).toBe(0);
    });
  });
});
