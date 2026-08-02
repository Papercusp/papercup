import { describe, it, expect, vi } from 'vitest';
import { sweepStalledLoops, type StalledLoopsSweepDeps } from './stalled-loops-guard';
import type { LoopStatus } from './loop';

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
    expect(res).toEqual({ checked: 0, paused: 0, sample: [], dryRun: false });
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
});
