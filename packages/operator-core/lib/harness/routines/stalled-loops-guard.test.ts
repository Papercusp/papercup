import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sweepStalledLoops, type StalledLoopsSweepDeps } from './stalled-loops-guard';
import { turnsStalledFloorMs, type LoopStatus } from './loop';

// Bind the mocks to the REAL dep signatures (the convention session-ingest-lag-watchdog.test.ts
// already uses). A bare `vi.fn(async () => true)` records a ZERO-arg call tuple, so reading
// `broadcast.mock.calls[0][0]` below is a type error — and vitest is type-blind, so a green test
// run cannot see it. It surfaces only at `lint:tsc`, i.e. at the fleet gate.
type BroadcastFn = NonNullable<StalledLoopsSweepDeps['broadcast']>;
// Same reason as BroadcastFn above: the re-arm assertions read `rearm.mock.calls[0][1]`, which
// is a type error against a bare `vi.fn(async () => {})`'s zero-arg call tuple — invisible to a
// green vitest run, red at lint:tsc i.e. at the fleet gate (EI-19406534159939583 hit exactly it).
type RearmFn = NonNullable<StalledLoopsSweepDeps['rearm']>;
// Same reason as the two above, and it bites harder here: the owner-page assertions read
// `notify.mock.calls[0][0].kind` / `.importance`, so a bare `vi.fn(async () => {})` is a zero-arg
// call tuple and every one of those reads is a lint:tsc error a green vitest run cannot see
// (EI-19899301656065801).
type NotifyFn = NonNullable<StalledLoopsSweepDeps['notify']>;

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
    firesSinceArm: 10,
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
    lifecycleBackoff: null,
    ...overrides,
  };
}

/**
 * The wake-reachability oracle, stubbed. `reachable` is the only field the guard reads.
 *
 * Module-scoped rather than per-describe (EI-19899301656065801): since the owner page landed,
 * the DISARM path probes reachability too, so a disarm test that does not inject this falls
 * through to the real `probeWakeReachability` and opens a live Postgres connection from a unit
 * test. Every describe that can disarm therefore needs it, not just the fire-starved one.
 */
const reach = (reachable: boolean) =>
  vi.fn(async () => ({
    reachable,
    channel: (reachable ? 'psu-socket' : 'none') as never,
    durableWhileAlive: reachable,
    summary: reachable ? 'live injectable session' : 'no wake path',
  }));

describe('sweepStalledLoops (WI-6639 — act on turnsStalled instead of leaving it inert)', () => {
  it('no active loop-% rows → zero reads beyond discovery, no auto-pause, no broadcast', async () => {
    const sql = fakeSql([]);
    const getStatuses = vi.fn();
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast, probeReachability: reach(false) });
    expect(res).toEqual({
      checked: 0,
      paused: 0,
      sample: [],
      vetoedByRecentTurn: [],
      reArmedFireStarved: [],
      vetoedByProviderWall: [],
      disarmedWhileReachable: [],
      dryRun: false,
    });
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

    const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast, probeReachability: reach(false) });

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

    const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast, probeReachability: reach(false) });

    expect(res.paused).toBe(0);
    expect(autoPause).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('a missing status (owner absent from the batch read) is never treated as stalled', async () => {
    const sql = fakeSql([{ id: 'rt_x', target_owner_id: 'su-x' }]);
    const getStatuses = vi.fn(async () => new Map<string, LoopStatus>());
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast, probeReachability: reach(false) });

    expect(res.paused).toBe(0);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('dryRun reports matches but neither disarms nor broadcasts', async () => {
    const sql = fakeSql([{ id: 'rt_dead', target_owner_id: 'su-dead' }]);
    const getStatuses = vi.fn(async () => new Map([['su-dead', status({ ownerId: 'su-dead', turnsStalled: true })]]));
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops({ sql, workspaceId: 'ws', dryRun: true }, { getStatuses, autoPause, broadcast, probeReachability: reach(false) });

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

    await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast, probeReachability: reach(false) });

    // Map insertion order means the LAST row for a duplicate owner wins.
    expect(autoPause).toHaveBeenCalledWith(sql, 'rt_new', expect.anything());
    expect(autoPause).not.toHaveBeenCalledWith(sql, 'rt_old', expect.anything());
  });

  // EI-19362678179163398 — the second-source veto. `turnsStalled` rests on `last_turn_at`,
  // which has under-reported twice; these lock in that a demonstrably-working agent is never
  // disarmed on that column alone, WITHOUT blunting the comatose-host case the guard is for.
  describe('second-source veto on lastRealTurnAt (EI-19362678179163398)', () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

    // The veto deliberately warns: a non-zero veto count is the live tell that
    // `last_turn_at` is under-reporting again, and it must reach the operator log rather
    // than vanish. Captured (not silenced) so the tests assert it actually fires.
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
    });

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

      const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast, probeReachability: reach(false) });

      expect(res.paused).toBe(0);
      expect(res.vetoedByRecentTurn).toEqual(['su-live']);
      expect(autoPause).not.toHaveBeenCalled();
      // Nothing was disarmed, so there is no fleet-wide event to announce.
      expect(broadcast).not.toHaveBeenCalled();
      // The refusal must be visible in the operator log, not silent.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('VETO su-live'));
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

      const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast, probeReachability: reach(false) });

      expect(res.paused).toBe(1);
      expect(res.vetoedByRecentTurn).toEqual([]);
      expect(autoPause).toHaveBeenCalledWith(sql, 'rt_dead', expect.stringContaining('WI-6639'));
      expect(warn).not.toHaveBeenCalled();
    });

    it('a MISSING lastRealTurnAt never engages the veto (liveness is never inferred from absent data)', async () => {
      const sql = fakeSql([{ id: 'rt_null', target_owner_id: 'su-null' }]);
      const getStatuses = vi.fn(async () =>
        new Map([['su-null', status({ ownerId: 'su-null', turnsStalled: true, lastRealTurnAt: null })]]),
      );
      const autoPause = vi.fn(async () => {});
      const broadcast = vi.fn<BroadcastFn>(async () => true);

      const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast, probeReachability: reach(false) });

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
        return sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast, probeReachability: reach(false) });
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

/**
 * EI-19441932615368003 — WALLED, not stalled.
 *
 * The live incident: on 2026-08-03 three sweeps (11:07Z / 13:07Z / 14:07Z) disarmed 7 + 2 + 6
 * loops on one workspace. At least two were provider-walled rather than dead — su-b9269a31
 * (~4h silent) and su-3a5df0ae (~2h50m, ended only when a human typed "continue where you left
 * off"). Each was correctly backed off by the lifecycle-death re-arm and would have resumed on
 * its own; disarming converted a self-healing wait into a permanent halt.
 *
 * These cases are written as SINGLE-CONDITION REMOVALS around that shape, so the suite fails if
 * the exemption is ever widened into a blanket "never disarm anything with an error outcome" —
 * which would blunt the guard back into the inert state WI-6639 exists to fix.
 */
describe('sweepStalledLoops — walled vs stalled (EI-19441932615368003)', () => {
  const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  let warn: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    logSpy.mockRestore();
  });

  /** The exact shape of the 2026-08-03 incident: fire landed, provider killed the turn, the
   *  backoff parked next_fire_at ~3h out, and no turn can land until the wall lifts. */
  const walled = (ownerId: string, overrides: Partial<LoopStatus> = {}) =>
    status({
      ownerId,
      turnsStalled: true,
      intervalSec: 1200,
      lastFiredAt: ago(2 * 60 * 60_000),
      lastTurnAt: ago(4 * 60 * 60_000),
      lastRealTurnAt: ago(4 * 60 * 60_000),
      lastDeliveryOutcome: 'loop-lifecycle-death:usage_limit',
      nextFireAt: inFuture(3 * 60 * 60_000),
      ...overrides,
    });

  it('REFUSES to disarm a loop backed off on a provider wall — the measured incident', async () => {
    const sql = fakeSql([{ id: 'rt_walled', target_owner_id: 'su-walled' }]);
    const getStatuses = vi.fn(async () => new Map([['su-walled', walled('su-walled')]]));
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, rearm, broadcast });

    expect(res.paused).toBe(0);
    expect(res.vetoedByProviderWall).toEqual(['su-walled']);
    expect(autoPause).not.toHaveBeenCalled();
    // SKIP, never re-arm: the backoff already computed a provider-informed next_fire_at, and
    // overwriting it with a plain interval would fire straight back into the wall.
    expect(rearm).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WALLED su-walled'));
  });

  it('recognizes the OTHER observer prefix too (resume-turn-death:) — matching only one was itself a past bug', async () => {
    const sql = fakeSql([{ id: 'rt_fast', target_owner_id: 'su-fast' }]);
    const getStatuses = vi.fn(async () =>
      new Map([['su-fast', walled('su-fast', { lastDeliveryOutcome: 'resume-turn-death:usage_limit' })]]),
    );
    const autoPause = vi.fn(async () => {});

    const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause });

    expect(res.vetoedByProviderWall).toEqual(['su-fast']);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('SINGLE CONDITION REMOVED — backoff has ELAPSED (next fire in the past) ⇒ genuinely stuck, DISARM', async () => {
    const sql = fakeSql([{ id: 'rt_elapsed', target_owner_id: 'su-elapsed' }]);
    const getStatuses = vi.fn(async () =>
      // Same wall, but the retry window has passed and STILL no turn followed. That is no
      // longer "waiting out a transient condition" — it is wedged, and the guard must act.
      new Map([['su-elapsed', walled('su-elapsed', { nextFireAt: ago(30 * 60_000) })]]),
    );
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast, probeReachability: reach(false) });

    expect(res.vetoedByProviderWall).toEqual([]);
    expect(res.paused).toBe(1);
    expect(autoPause).toHaveBeenCalledTimes(1);
  });

  it('SINGLE CONDITION REMOVED — an ORDINARY stall outcome ⇒ DISARM (the exemption is not a blanket error-amnesty)', async () => {
    const sql = fakeSql([{ id: 'rt_plain', target_owner_id: 'su-plain' }]);
    const getStatuses = vi.fn(async () =>
      // A future nextFireAt alone must never exempt: every healthy armed loop has one.
      new Map([['su-plain', walled('su-plain', { lastDeliveryOutcome: 'loop-stuck-backstop' })]]),
    );
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast, probeReachability: reach(false) });

    expect(res.vetoedByProviderWall).toEqual([]);
    expect(res.paused).toBe(1);
  });

  it('SINGLE CONDITION REMOVED — a comatose host with NO delivery outcome is still disarmed', async () => {
    const sql = fakeSql([{ id: 'rt_dead', target_owner_id: 'su-dead' }]);
    const getStatuses = vi.fn(async () =>
      new Map([['su-dead', walled('su-dead', { lastDeliveryOutcome: null })]]),
    );
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast, probeReachability: reach(false) });

    expect(res.paused).toBe(1);
    expect(res.vetoedByProviderWall).toEqual([]);
  });

  it('separates walled from comatose in ONE sweep — the shape of the live 14:07Z batch', async () => {
    const sql = fakeSql([
      { id: 'rt_w', target_owner_id: 'su-walled' },
      { id: 'rt_d', target_owner_id: 'su-dead' },
    ]);
    const getStatuses = vi.fn(async () =>
      new Map([
        ['su-walled', walled('su-walled')],
        ['su-dead', walled('su-dead', { lastDeliveryOutcome: null, nextFireAt: null })],
      ]),
    );
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, broadcast, probeReachability: reach(false) });

    // The whole point: one sweep, two populations, opposite dispositions.
    expect(res.vetoedByProviderWall).toEqual(['su-walled']);
    expect(res.sample).toEqual(['su-dead']);
    expect(res.paused).toBe(1);
    expect(autoPause).toHaveBeenCalledTimes(1);
  });
});

describe('sweepStalledLoops — fire-starved vs turn-stalled (EI-19406534159939583)', () => {
  // Both populations below were observed LIVE in the same fleet on 2026-08-03, which is what
  // makes this a discrimination test rather than a shape test: the guard used to disarm both.
  //
  // NOTE the shapes deliberately: FIRE_STARVED and DEAD_SAME_SHAPE are BYTE-IDENTICAL. That is
  // the whole point — turn ordering alone cannot tell a live fire-starved agent from a WI-6639
  // corpse (whose last turn also lands shortly after its last fire), so the two tests using them
  // differ ONLY in what the reachability probe says. If someone later "simplifies" the guard back
  // to an ordering check, those two tests cannot both pass.
  const FIRE_STARVED = {
    // Answered its last fire (turn AFTER fire), then nothing fired at it again.
    lastFiredAt: '2026-08-03T03:21:00.000Z',
    lastTurnAt: '2026-08-03T03:25:00.000Z',
  };
  const DEAD_SAME_SHAPE = FIRE_STARVED;
  const COMATOSE = {
    // A fire landed and no turn ever followed it (turn BEFORE fire) — the classic WI-6639 shape.
    lastFiredAt: '2026-08-03T03:25:00.000Z',
    lastTurnAt: '2026-08-03T01:00:00.000Z',
  };

  // The FIRE-STARVED branch warns deliberately (it is an infrastructure finding that must reach
  // the operator log). Silence it here the same way the veto tests above do.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('re-arms a fire-starved loop and NEVER disarms it', async () => {
    const sql = fakeSql([{ id: 'rt_starved', target_owner_id: 'su-starved' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          ['su-starved', status({ ownerId: 'su-starved', turnsStalled: true, ...FIRE_STARVED })],
        ]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(true);
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, rearm, probeReachability, broadcast });

    expect(autoPause).not.toHaveBeenCalled();
    expect(rearm).toHaveBeenCalledTimes(1);
    expect(rearm.mock.calls[0][1]).toBe('rt_starved');
    expect(res.paused).toBe(0);
    expect(res.reArmedFireStarved).toEqual(['su-starved']);
  });

  it('THE DISCRIMINATION: identical turn/fire shape, UNREACHABLE owner → disarmed, not re-armed', async () => {
    // Byte-identical to the fire-starved case above. Only the reachability probe differs, and
    // that alone must flip the outcome — this is the WI-6639 corpse the ordering check would
    // have wrongly rescued.
    const sql = fakeSql([{ id: 'rt_dead', target_owner_id: 'su-dead' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([['su-dead', status({ ownerId: 'su-dead', turnsStalled: true, ...DEAD_SAME_SHAPE })]]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(false);
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, probeReachability, broadcast },
    );

    expect(probeReachability).toHaveBeenCalledWith('su-dead');
    expect(rearm).not.toHaveBeenCalled();
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(res.paused).toBe(1);
    expect(res.reArmedFireStarved).toEqual([]);
  });

  it('an ERRORING reachability probe fails soft toward the REVERSIBLE mistake (re-arm)', async () => {
    // An uncertain read must never license an irreversible disarm — mirrors
    // checkUnreachableTerminalGuard's own fail-soft catch.
    const sql = fakeSql([{ id: 'rt_x', target_owner_id: 'su-x' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-x', status({ ownerId: 'su-x', turnsStalled: true, ...FIRE_STARVED })]]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = vi.fn(async () => {
      throw new Error('probe unavailable');
    }) as never;
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, probeReachability, broadcast },
    );

    expect(autoPause).not.toHaveBeenCalled();
    expect(res.reArmedFireStarved).toEqual(['su-x']);
  });

  it('still disarms the comatose population — the fix must not blunt the guard', async () => {
    const sql = fakeSql([{ id: 'rt_dead', target_owner_id: 'su-dead' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([['su-dead', status({ ownerId: 'su-dead', turnsStalled: true, ...COMATOSE })]]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(true);
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, rearm, probeReachability, broadcast });

    expect(rearm).not.toHaveBeenCalled();
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(res.paused).toBe(1);
    expect(res.reArmedFireStarved).toEqual([]);
  });

  it('separates the two in ONE sweep — the shape of the live incident', async () => {
    const sql = fakeSql([
      { id: 'rt_a', target_owner_id: 'su-starved-a' },
      { id: 'rt_b', target_owner_id: 'su-starved-b' },
      { id: 'rt_c', target_owner_id: 'su-dead-c' },
      { id: 'rt_d', target_owner_id: 'su-healthy-d' },
    ]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          ['su-starved-a', status({ ownerId: 'su-starved-a', turnsStalled: true, ...FIRE_STARVED })],
          ['su-starved-b', status({ ownerId: 'su-starved-b', turnsStalled: true, ...FIRE_STARVED })],
          ['su-dead-c', status({ ownerId: 'su-dead-c', turnsStalled: true, ...COMATOSE })],
          ['su-healthy-d', status({ ownerId: 'su-healthy-d', turnsStalled: false })],
        ]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(true);
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, rearm, probeReachability, broadcast });

    expect(res.reArmedFireStarved).toEqual(['su-starved-a', 'su-starved-b']);
    expect(res.sample).toEqual(['su-dead-c']);
    expect(res.paused).toBe(1);
    expect(res.checked).toBe(4);
    // One broadcast, and it must name BOTH findings — a reader who sees only the disarm half
    // goes looking for dead agents when the real fault is in the firing path.
    expect(broadcast).toHaveBeenCalledTimes(1);
    const body = broadcast.mock.calls[0][0].body;
    expect(body).toContain('su-dead-c');
    expect(body).toContain('FIRE-STARVED');
    expect(body).toContain('su-starved-a');
  });

  it('broadcasts a fire-starved batch even when NOTHING was disarmed', async () => {
    // Before the split this case was silent: the only broadcast was gated on the disarm count,
    // so "every live agent stopped receiving fires" produced no fleet-wide signal at all.
    const sql = fakeSql([{ id: 'rt_a', target_owner_id: 'su-starved-a' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          ['su-starved-a', status({ ownerId: 'su-starved-a', turnsStalled: true, ...FIRE_STARVED })],
        ]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(true);
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, rearm, probeReachability, broadcast });

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0].summary).toContain('stopped RECEIVING fires');
  });

  it('dryRun reports the fire-starved set without writing', async () => {
    const sql = fakeSql([{ id: 'rt_a', target_owner_id: 'su-starved-a' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          ['su-starved-a', status({ ownerId: 'su-starved-a', turnsStalled: true, ...FIRE_STARVED })],
        ]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(true);
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws', dryRun: true },
      { getStatuses, autoPause, rearm, probeReachability, broadcast },
    );

    expect(res.reArmedFireStarved).toEqual(['su-starved-a']);
    expect(rearm).not.toHaveBeenCalled();
    expect(autoPause).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  // ── EI-19899301656065801: the OWNER page beside the FLEET broadcast ──────────────
  // The guard already escalated a disarm to the fleet via broadcastSevereEvent. The gap was
  // AUDIENCE, not silence: no peer has a mandate to revive someone else's session, and a
  // disarmed loop cannot re-arm itself (reconcileLoopRoutines gates its rescue on active=TRUE),
  // so a still-REACHABLE session that gets disarmed is permanently dark until a human acts.
  // Measured instance: su-4a6e2255 disarmed 2026-08-04T09:07:15Z, dark 4d6h, recovered only
  // because the owner resumed it by hand.
  //
  // The gate is REACHABILITY, and these tests are built so that gate cannot be quietly widened:
  // the reachable and unreachable cases are byte-identical but for `reach(true|false)`, so a
  // change that pages unconditionally fails the second, and one that never pages fails the first.

  it('EI-19899301656065801: pages the OWNER when a still-REACHABLE session is disarmed', async () => {
    const sql = fakeSql([{ id: 'rt_comatose', target_owner_id: 'su-comatose' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([['su-comatose', status({ ownerId: 'su-comatose', turnsStalled: true, ...COMATOSE })]]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(true);
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, probeReachability, broadcast, notify },
    );

    // It really was DISARMED (not re-armed) — otherwise the page would be about the wrong event.
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(rearm).not.toHaveBeenCalled();
    expect(res.paused).toBe(1);

    expect(notify).toHaveBeenCalledTimes(1);
    const page = notify.mock.calls[0][0];
    expect(page.kind).toBe('intervention');
    expect(page.importance).toBe('urgent');
    expect(page.title).toContain('su-comatose');
    expect(page.body).toContain('su-comatose');

    // BESIDE the broadcast, never replacing it — the fleet signal is a different job.
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('EI-19899301656065801: does NOT page when the disarmed owner is already gone (the WI-6639 corpse)', async () => {
    // Byte-identical to the case above except the reachability probe. Disarming a session that
    // ended long ago is pure hygiene and must stay as silent as it was before this landed —
    // WI-6639's original population was 15 loops whose sessions had ALREADY ended.
    const sql = fakeSql([{ id: 'rt_corpse', target_owner_id: 'su-corpse' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-corpse', status({ ownerId: 'su-corpse', turnsStalled: true, ...COMATOSE })]]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(false);
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, probeReachability, broadcast, notify },
    );

    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(res.paused).toBe(1);
    expect(notify).not.toHaveBeenCalled();
    // The FLEET is still told — only the owner page is withheld.
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('EI-19899301656065801: does NOT page a FIRE-STARVED loop — it was re-armed, not disarmed', async () => {
    // Self-healing: the loop is re-armed, so there is nothing for a human to do.
    const sql = fakeSql([{ id: 'rt_starved', target_owner_id: 'su-starved' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([['su-starved', status({ ownerId: 'su-starved', turnsStalled: true, ...FIRE_STARVED })]]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(true);
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, probeReachability, broadcast, notify },
    );

    expect(rearm).toHaveBeenCalledTimes(1);
    expect(autoPause).not.toHaveBeenCalled();
    expect(res.reArmedFireStarved).toEqual(['su-starved']);
    expect(notify).not.toHaveBeenCalled();
  });

  it('EI-19899301656065801: a FAILING owner page never costs the disarm or the broadcast', async () => {
    // Paging is strictly an addition to this sweep's job. A dead push transport must not roll
    // back bookkeeping that already succeeded.
    const sql = fakeSql([{ id: 'rt_comatose', target_owner_id: 'su-comatose' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([['su-comatose', status({ ownerId: 'su-comatose', turnsStalled: true, ...COMATOSE })]]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(true);
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const notify = vi.fn<NotifyFn>(async () => {
      throw new Error('push transport down');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, probeReachability, broadcast, notify },
    );

    expect(notify).toHaveBeenCalledTimes(1);
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(res.paused).toBe(1);
    expect(res.dryRun).toBe(false);
    // and it says so rather than swallowing the failure silently
    expect(warn.mock.calls.some((c) => String(c[0]).includes('owner page failed'))).toBe(true);
    warn.mockRestore();
  });

  it('EI-19899301656065801: dryRun pages nobody', async () => {
    const sql = fakeSql([{ id: 'rt_comatose', target_owner_id: 'su-comatose' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([['su-comatose', status({ ownerId: 'su-comatose', turnsStalled: true, ...COMATOSE })]]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(true);
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws', dryRun: true },
      { getStatuses, autoPause, rearm, probeReachability, broadcast, notify },
    );

    expect(res.dryRun).toBe(true);
    expect(autoPause).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
