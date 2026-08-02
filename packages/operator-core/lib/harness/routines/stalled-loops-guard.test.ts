import { describe, it, expect, vi } from 'vitest';
import { sweepStalledLoops, type StalledLoopsSweepDeps } from './stalled-loops-guard';
import { turnsStalledFloorMs, type LoopStatus } from './loop';

// Bind the mocks to the REAL dep signatures (the convention session-ingest-lag-watchdog.test.ts
// already uses). A bare `vi.fn(async () => true)` records a ZERO-arg call tuple, so reading
// `broadcast.mock.calls[0][0]` below is a type error — and vitest is type-blind, so a green test
// run cannot see it. It surfaces only at `lint:tsc`, i.e. at the fleet gate.
type BroadcastFn = NonNullable<StalledLoopsSweepDeps['broadcast']>;

/** Minimal fake `harness_shared.routines` SELECT — the sweep's only direct SQL read. */
function fakeSql(rows: Array<{ id: string; target_owner_id: string }>) {
  return ((strings: TemplateStringsArray) => {
    if (/SELECT/i.test(strings.join('?'))) return Promise.resolve(rows);
    return Promise.resolve([]);
  }) as never;
}

function status(overrides: Partial<LoopStatus> & { turnsStalled: boolean }): LoopStatus {
  return {
    name: 'loop-x',
    ownerId: 'owner-x',
    harnessSlug: 'papercusp',
    active: true,
    intervalSec: 60,
    carry: 'warm',
    continuation: 'settle',
    mode: 'work',
    fireCount: 10,
    parked: false,
    nextFireAt: null,
    lastFiredAt: '2026-08-01T00:00:00.000Z',
    armedAt: null,
    costCapCents: null,
    maxFires: null,
    maxDurationSec: null,
    stalled: false,
    stalledSinceMs: null,
    lastDeliveryOutcome: null,
    consecutiveErrors: 0,
    lastWakeChannel: null,
    lastWakeStatus: null,
    lastWakeAt: null,
    lastWakeError: null,
    lastTurnAt: null,
    lastRealTurnAt: null,
    ...overrides,
  };
}

describe('sweepStalledLoops (WI-6639 — act on turnsStalled instead of leaving it inert)', () => {
  it('no active loop-% rows → zero reads beyond discovery, no auto-pause, no broadcast', async () => {
    const sql = fakeSql([]);
    const getStatuses = vi.fn();
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast });
    expect(res).toEqual({ checked: 0, paused: 0, sample: [], vetoedByRecentTurn: [], dryRun: false });
    expect(getStatuses).not.toHaveBeenCalled();
    expect(autoPause).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('disarms every owner whose status is turnsStalled:true, leaves healthy owners untouched', async () => {
    const sql = fakeSql([
      { id: 'rt_dead1', target_owner_id: 'su-dead1' },
      { id: 'rt_dead2', target_owner_id: 'su-dead2' },
      { id: 'rt_ok', target_owner_id: 'su-ok' },
    ]);
    const getStatuses = vi.fn(async () =>
      new Map([
        ['su-dead1', status({ ownerId: 'su-dead1', turnsStalled: true, fireCount: 40, lastFiredAt: '2026-08-01T10:00:00.000Z', lastTurnAt: null })],
        ['su-dead2', status({ ownerId: 'su-dead2', turnsStalled: true, fireCount: 12, lastTurnAt: '2026-07-30T00:00:00.000Z' })],
        ['su-ok', status({ ownerId: 'su-ok', turnsStalled: false })],
      ]),
    );
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast });

    expect(res.checked).toBe(3);
    expect(res.paused).toBe(2);
    expect(res.sample.sort()).toEqual(['su-dead1', 'su-dead2']);
    expect(res.dryRun).toBe(false);

    expect(autoPause).toHaveBeenCalledTimes(2);
    expect(autoPause).toHaveBeenCalledWith(sql, 'rt_dead1', expect.stringContaining('WI-6639'));
    expect(autoPause).toHaveBeenCalledWith(sql, 'rt_dead2', expect.stringContaining('WI-6639'));
    // The healthy owner's routine id must never be touched.
    expect(autoPause).not.toHaveBeenCalledWith(sql, 'rt_ok', expect.anything());

    // ONE broadcast for the whole batch, not one per disarmed owner.
    expect(broadcast).toHaveBeenCalledTimes(1);
    const call = broadcast.mock.calls[0]?.[0];
    expect(call?.summary).toContain('2 armed engine loop');
    expect(call?.body).toContain('su-dead1');
    expect(call?.body).toContain('su-dead2');
    expect(call?.body).not.toContain('su-ok');
  });

  it('no stalled owners → no auto-pause and no broadcast at all', async () => {
    const sql = fakeSql([{ id: 'rt_ok', target_owner_id: 'su-ok' }]);
    const getStatuses = vi.fn(async () => new Map([['su-ok', status({ ownerId: 'su-ok', turnsStalled: false })]]));
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast });

    expect(res.paused).toBe(0);
    expect(autoPause).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('a missing status (owner absent from the batch read) is never treated as stalled', async () => {
    const sql = fakeSql([{ id: 'rt_x', target_owner_id: 'su-x' }]);
    const getStatuses = vi.fn(async () => new Map<string, LoopStatus>());
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast });

    expect(res.paused).toBe(0);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('dryRun reports matches but neither disarms nor broadcasts', async () => {
    const sql = fakeSql([{ id: 'rt_dead', target_owner_id: 'su-dead' }]);
    const getStatuses = vi.fn(async () => new Map([['su-dead', status({ ownerId: 'su-dead', turnsStalled: true })]]));
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops({ sql, workspaceId: 'ws', dryRun: true }, { getStatuses, autoPause, broadcast });

    expect(res.dryRun).toBe(true);
    expect(res.paused).toBe(1);
    expect(res.sample).toEqual(['su-dead']);
    expect(autoPause).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('passes the discovered owner ids to getStatuses, deduped by owner (last routine row wins)', async () => {
    const sql = fakeSql([
      { id: 'rt_old', target_owner_id: 'su-dup' },
      { id: 'rt_new', target_owner_id: 'su-dup' },
    ]);
    const getStatuses = vi.fn(async (owners: readonly string[]) => {
      expect(owners).toEqual(['su-dup']);
      return new Map([['su-dup', status({ ownerId: 'su-dup', turnsStalled: true })]]);
    });
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast });

    // Map insertion order means the LAST row for a duplicate owner wins.
    expect(autoPause).toHaveBeenCalledWith(sql, 'rt_new', expect.anything());
    expect(autoPause).not.toHaveBeenCalledWith(sql, 'rt_old', expect.anything());
  });

  // EI-19362678179163398 — the second-source veto. `turnsStalled` rests on `last_turn_at`,
  // which has under-reported twice; these lock in that a demonstrably-working agent is never
  // disarmed on that column alone, WITHOUT blunting the comatose-host case the guard is for.
  describe('second-source veto on lastRealTurnAt (EI-19362678179163398)', () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

    it('REFUSES to disarm a turnsStalled owner that produced a real turn inside the floor', async () => {
      const sql = fakeSql([{ id: 'rt_live', target_owner_id: 'su-live' }]);
      const getStatuses = vi.fn(async () =>
        new Map([
          [
            'su-live',
            // Exactly the measured false positive: last_turn_at hours stale, yet a real
            // assistant turn landed ~2 min ago.
            status({
              ownerId: 'su-live',
              turnsStalled: true,
              intervalSec: 60,
              lastTurnAt: ago(4 * 60 * 60_000),
              lastRealTurnAt: ago(2 * 60_000),
            }),
          ],
        ]),
      );
      const autoPause = vi.fn(async () => {});
      const broadcast = vi.fn<BroadcastFn>(async () => true);

      const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast });

      expect(res.paused).toBe(0);
      expect(res.vetoedByRecentTurn).toEqual(['su-live']);
      expect(autoPause).not.toHaveBeenCalled();
      // Nothing was disarmed, so there is no fleet-wide event to announce.
      expect(broadcast).not.toHaveBeenCalled();
    });

    it('still disarms a comatose host — an ancient real turn must NOT engage the veto', async () => {
      const sql = fakeSql([{ id: 'rt_dead', target_owner_id: 'su-comatose' }]);
      const getStatuses = vi.fn(async () =>
        new Map([
          [
            'su-comatose',
            status({
              ownerId: 'su-comatose',
              turnsStalled: true,
              intervalSec: 60,
              lastRealTurnAt: ago(6 * 60 * 60_000),
            }),
          ],
        ]),
      );
      const autoPause = vi.fn(async () => {});
      const broadcast = vi.fn<BroadcastFn>(async () => true);

      const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast });

      expect(res.paused).toBe(1);
      expect(res.vetoedByRecentTurn).toEqual([]);
      expect(autoPause).toHaveBeenCalledWith(sql, 'rt_dead', expect.stringContaining('WI-6639'));
    });

    it('a MISSING lastRealTurnAt never engages the veto (liveness is never inferred from absent data)', async () => {
      const sql = fakeSql([{ id: 'rt_null', target_owner_id: 'su-null' }]);
      const getStatuses = vi.fn(async () =>
        new Map([['su-null', status({ ownerId: 'su-null', turnsStalled: true, lastRealTurnAt: null })]]),
      );
      const autoPause = vi.fn(async () => {});
      const broadcast = vi.fn<BroadcastFn>(async () => true);

      const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast });

      expect(res.paused).toBe(1);
      expect(res.vetoedByRecentTurn).toEqual([]);
      expect(autoPause).toHaveBeenCalledTimes(1);
    });

    it('sizes the veto window from turnsStalledFloorMs — the SAME floor the verdict uses', async () => {
      // One real turn age (45 min), two intervals. floor(60s) = 30min  -> 45min is OUTSIDE, disarm.
      // floor(1200s) = 80min -> 45min is INSIDE, veto. Pins the guard's window to the verdict's.
      const mk = async (intervalSec: number) => {
        const sql = fakeSql([{ id: 'rt', target_owner_id: 'su-x' }]);
        const getStatuses = vi.fn(async () =>
          new Map([
            [
              'su-x',
              status({ ownerId: 'su-x', turnsStalled: true, intervalSec, lastRealTurnAt: ago(45 * 60_000) }),
            ],
          ]),
        );
        const autoPause = vi.fn(async () => {});
        const broadcast = vi.fn<BroadcastFn>(async () => true);
        return sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast });
      };

      expect(turnsStalledFloorMs(60)).toBe(30 * 60_000);
      expect(turnsStalledFloorMs(1200)).toBe(80 * 60_000);

      const tight = await mk(60);
      expect(tight.paused).toBe(1);
      expect(tight.vetoedByRecentTurn).toEqual([]);

      const wide = await mk(1200);
      expect(wide.paused).toBe(0);
      expect(wide.vetoedByRecentTurn).toEqual(['su-x']);
    });
  });
});
