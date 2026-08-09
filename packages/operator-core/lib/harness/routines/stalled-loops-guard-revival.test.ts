/**
 * WI-37546 — the LIVENESS VETO and the RECOVERABLE DISARM.
 *
 * Split out of `stalled-loops-guard.test.ts` (already 76KB) because these two branches are one
 * coherent fix with a single motivating measurement, and they need fixtures the older file does
 * not have: a tool-activity oracle and a set of ALREADY-DISARMED loops.
 *
 * THE MEASUREMENT UNDER TEST (census of 2026-08-09, workspace papercusp-workspace): of 19 loops
 * this module disarmed as turn-stalled that day, 18 owners were making tool calls in the hour
 * BEFORE their disarm. The control that makes it a finding rather than a correlation is the same
 * module's OTHER verdict path — `dead-owner`, 7 disarms, 7/7 correct — so the signal is fine and
 * the `turns-stalled` INFERENCE is what over-fires.
 *
 * Both halves are represented here, and both have an explicit CONTROL, because each is a
 * REAPER-BLUNTING change and WI-36792's measured lesson is that blunting a reaper is invisible
 * (it still reports `checked: N`). A veto with no falsifying test is indistinguishable from a
 * disabled guard.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  sweepStalledLoops,
  isProgressingToolActivity,
  TURN_STALLED_PAUSE_PREFIX,
  TOOL_LIVENESS_VETO_CEILING_MS,
  REVIVE_WINDOW_MS,
  MAX_REVIVALS,
  type StalledLoopsSweepDeps,
  type OwnerToolActivity,
} from './stalled-loops-guard';
import { type LoopStatus } from './loop';

// Bound to the REAL dep signatures for the reason the sibling file documents at length: a bare
// `vi.fn(async () => {})` records a ZERO-arg call tuple, so every `.mock.calls[0][1]` read below
// is a lint:tsc error that a green vitest run cannot see.
type AutoPauseFn = NonNullable<StalledLoopsSweepDeps['autoPause']>;
type ReviveFn = NonNullable<StalledLoopsSweepDeps['revive']>;
type BroadcastFn = NonNullable<StalledLoopsSweepDeps['broadcast']>;
type NotifyFn = NonNullable<StalledLoopsSweepDeps['notify']>;
type ReadActivityFn = NonNullable<StalledLoopsSweepDeps['readOwnerToolActivity']>;
type ReadRevivableFn = NonNullable<StalledLoopsSweepDeps['readRevivableLoops']>;

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
    // Deliberately RECENT-ish relative to the fixtures below, and always EARLIER than lastTurnAt
    // is not assumed: these tests drive the turn-stalled path, so the last turn must not sit at
    // or after the last fire (that is the fire-starved branch, tested elsewhere).
    lastFiredAt: '2026-08-09T17:07:00.000Z',
    armedAt: '2026-08-09T10:00:00.000Z',
    costCapCents: null,
    maxFires: null,
    maxDurationSec: null,
    stalled: false,
    stalledSinceMs: null,
    lastDeliveryOutcome: null,
    consecutiveErrors: 0,
    lastWakeChannel: null,
    lastWakeStatus: null,
    // Non-null and tracking the fire, so the WAKE-STARVED branch does not claim these fixtures.
    lastWakeAt: '2026-08-09T17:07:00.000Z',
    lastWakeError: null,
    lastTurnAt: '2026-08-09T16:29:00.000Z',
    lastRealTurnAt: '2026-08-09T16:29:00.000Z',
    lastWithheldAt: null,
    lifecycleBackoff: null,
    ...overrides,
  } as LoopStatus;
}

/** The corpse-shaped reachability verdict: nothing live, nothing repairable. */
const reach = (reachable: boolean) =>
  vi.fn(async () => ({
    reachable,
    channel: (reachable ? 'psu-socket' : 'none') as never,
    durableWhileAlive: reachable,
    summary: reachable ? 'live injectable session' : 'no wake path',
    awaitRepairable: false,
    wouldBeChannel: null,
  }));

function activity(o: Partial<OwnerToolActivity>): OwnerToolActivity {
  return { calls: 0, distinctTools: 0, okCalls: 0, lastCallAt: null, ...o };
}

/** An agent doing real work: several tools, calls that succeed. */
const WORKING = activity({ calls: 629, distinctTools: 24, okCalls: 601, lastCallAt: '2026-08-09T19:21:00.000Z' });

/**
 * D-006's CONVERGENT POPULATION, as a fixture: an agent wedged in a tight retry loop. Thousands
 * of calls, ONE tool, ZERO successes. This is the shape that makes raw call volume an unsafe
 * liveness signal, and every test that uses it is asserting the veto does NOT fire.
 */
const RETRY_STORM = activity({ calls: 4000, distinctTools: 1, okCalls: 0, lastCallAt: '2026-08-09T19:21:00.000Z' });

const noActivity = () => vi.fn<ReadActivityFn>(async () => new Map<string, OwnerToolActivity>());
const noRevivable = () => vi.fn<ReadRevivableFn>(async () => []);

describe('isProgressingToolActivity (WI-37546 — progress, not volume)', () => {
  it('absent or empty activity is not progress', () => {
    expect(isProgressingToolActivity(undefined)).toBe(false);
    expect(isProgressingToolActivity(null)).toBe(false);
    expect(isProgressingToolActivity(activity({ calls: 0, distinctTools: 0, okCalls: 0 }))).toBe(false);
  });

  it('CONTROL — a 4000-call single-tool error storm is NOT progress (the population D-006 named)', () => {
    expect(isProgressingToolActivity(RETRY_STORM)).toBe(false);
  });

  it('a second distinct tool is progress, even with no successes yet', () => {
    expect(isProgressingToolActivity(activity({ calls: 2, distinctTools: 2, okCalls: 0 }))).toBe(true);
  });

  it('one successful call is progress, even on a single tool', () => {
    expect(isProgressingToolActivity(activity({ calls: 3, distinctTools: 1, okCalls: 1 }))).toBe(true);
  });

  it('CALIBRATION — the real working shape passes, so the two controls above are not just strict', () => {
    expect(isProgressingToolActivity(WORKING)).toBe(true);
  });
});

describe('sweepStalledLoops — liveness veto (WI-37546: 18 of 19 disarms on 2026-08-09)', () => {
  const deps = (over: Partial<StalledLoopsSweepDeps> = {}): StalledLoopsSweepDeps => ({
    probeReachability: reach(false),
    broadcast: vi.fn<BroadcastFn>(async () => true),
    notify: vi.fn<NotifyFn>(async () => {}),
    readRevivableLoops: noRevivable(),
    ...over,
  });

  it('refuses to disarm an owner still making PROGRESSING tool calls since its last fire', async () => {
    const sql = fakeSql([{ id: 'rt1', target_owner_id: 'su-live' }]);
    const getStatuses = vi.fn(async () => new Map([['su-live', status({ turnsStalled: true })]]));
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-live', WORKING]]));

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      deps({ getStatuses, autoPause, readOwnerToolActivity }),
    );

    expect(res.vetoedByToolActivity).toEqual(['su-live']);
    expect(res.paused).toBe(0);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('CONTROL — an owner with NO tool activity is still disarmed (the guard is not blunted)', async () => {
    const sql = fakeSql([{ id: 'rt1', target_owner_id: 'su-corpse' }]);
    const getStatuses = vi.fn(async () => new Map([['su-corpse', status({ turnsStalled: true })]]));
    const autoPause = vi.fn<AutoPauseFn>(async () => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      deps({ getStatuses, autoPause, readOwnerToolActivity: noActivity() }),
    );

    expect(res.vetoedByToolActivity).toEqual([]);
    expect(res.paused).toBe(1);
    expect(autoPause).toHaveBeenCalledTimes(1);
  });

  it('CONTROL — a retry storm is disarmed: volume alone never buys the veto', async () => {
    const sql = fakeSql([{ id: 'rt1', target_owner_id: 'su-spin' }]);
    const getStatuses = vi.fn(async () => new Map([['su-spin', status({ turnsStalled: true })]]));
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-spin', RETRY_STORM]]));

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      deps({ getStatuses, autoPause, readOwnerToolActivity }),
    );

    expect(res.vetoedByToolActivity).toEqual([]);
    expect(res.paused).toBe(1);
  });

  it('CONTROL — progressing calls stop counting past the ceiling, so the veto cannot become permanent', async () => {
    const sql = fakeSql([{ id: 'rt1', target_owner_id: 'su-eternal' }]);
    const longAgo = new Date(Date.now() - TOOL_LIVENESS_VETO_CEILING_MS - 60_000).toISOString();
    const getStatuses = vi.fn(
      async () =>
        new Map([
          ['su-eternal', status({ turnsStalled: true, lastTurnAt: longAgo, lastRealTurnAt: longAgo, armedAt: longAgo })],
        ]),
    );
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-eternal', WORKING]]));

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      deps({ getStatuses, autoPause, readOwnerToolActivity }),
    );

    expect(res.vetoedByToolActivity).toEqual([]);
    expect(res.paused).toBe(1);
  });

  it('an owner with NO turn history at all takes the veto — unknown is not old', async () => {
    const sql = fakeSql([{ id: 'rt1', target_owner_id: 'su-new' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([['su-new', status({ turnsStalled: true, lastTurnAt: null, lastRealTurnAt: null, armedAt: null })]]),
    );
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-new', WORKING]]));

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      deps({ getStatuses, autoPause, readOwnerToolActivity }),
    );

    expect(res.vetoedByToolActivity).toEqual(['su-new']);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it("probes each owner from ITS OWN last fire, and only for owners the verdict condemned", async () => {
    const sql = fakeSql([
      { id: 'rt1', target_owner_id: 'su-a' },
      { id: 'rt2', target_owner_id: 'su-b' },
      { id: 'rt3', target_owner_id: 'su-healthy' },
    ]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          ['su-a', status({ turnsStalled: true, lastFiredAt: '2026-08-09T17:07:00.000Z' })],
          ['su-b', status({ turnsStalled: true, lastFiredAt: '2026-08-09T13:07:00.000Z' })],
          ['su-healthy', status({ turnsStalled: false })],
        ]),
    );
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map<string, OwnerToolActivity>());

    await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      deps({ getStatuses, autoPause: vi.fn<AutoPauseFn>(async () => {}), readOwnerToolActivity }),
    );

    const probes = readOwnerToolActivity.mock.calls[0][0];
    expect(probes).toEqual([
      { ownerId: 'su-a', sinceIso: '2026-08-09T17:07:00.000Z' },
      { ownerId: 'su-b', sinceIso: '2026-08-09T13:07:00.000Z' },
    ]);
  });

  it('a FAILING activity read falls back to the pre-WI-37546 behaviour, never a blanket veto', async () => {
    const sql = fakeSql([{ id: 'rt1', target_owner_id: 'su-x' }]);
    const getStatuses = vi.fn(async () => new Map([['su-x', status({ turnsStalled: true })]]));
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => {
      throw new Error('tool_invocations unreachable');
    });

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      deps({ getStatuses, autoPause, readOwnerToolActivity }),
    );

    expect(res.vetoedByToolActivity).toEqual([]);
    expect(res.paused).toBe(1);
  });
});

describe('sweepStalledLoops — recoverable disarm (WI-37546 sub-case B)', () => {
  const pausedAtMs = Date.parse('2026-08-09T17:07:00.000Z');
  const candidate = (over: Partial<{ routineId: string; ownerId: string; pausedAtMs: number; revivedCount: number }> = {}) => ({
    routineId: 'rt-dead',
    ownerId: 'su-b8422496',
    pausedAtMs,
    revivedCount: 0,
    ...over,
  });

  const deps = (over: Partial<StalledLoopsSweepDeps> = {}): StalledLoopsSweepDeps => ({
    probeReachability: reach(false),
    broadcast: vi.fn<BroadcastFn>(async () => true),
    notify: vi.fn<NotifyFn>(async () => {}),
    getStatuses: vi.fn(async () => new Map<string, LoopStatus>()),
    autoPause: vi.fn<AutoPauseFn>(async () => {}),
    readOwnerToolActivity: noActivity(),
    ...over,
  });

  it('re-arms a wrongly-disarmed loop whose owner has since made progressing tool calls', async () => {
    const revive = vi.fn<ReviveFn>(async () => {});
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => [candidate()]);
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-b8422496', WORKING]]));

    const res = await sweepStalledLoops(
      { sql: fakeSql([]), workspaceId: 'ws' },
      deps({ revive, readRevivableLoops, readOwnerToolActivity }),
    );

    expect(res.revivedAfterDisarm).toEqual(['su-b8422496']);
    expect(revive).toHaveBeenCalledTimes(1);
    expect(revive.mock.calls[0][1]).toBe('rt-dead');
    expect(revive.mock.calls[0][2]).toContain('WI-37546');
  });

  it('THE EARLY-RETURN TRAP — revives even when the workspace has ZERO active loops left', async () => {
    // The state a fleet lands in once every loop has been disarmed. The rest of the sweep reads
    // this as "nothing to do"; it is precisely when a revival pass matters most.
    const revive = vi.fn<ReviveFn>(async () => {});
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => [candidate()]);
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-b8422496', WORKING]]));

    const res = await sweepStalledLoops(
      { sql: fakeSql([]), workspaceId: 'ws' }, // zero ACTIVE loop rows
      deps({ revive, readRevivableLoops, readOwnerToolActivity }),
    );

    expect(res.checked).toBe(0);
    expect(res.revivedAfterDisarm).toEqual(['su-b8422496']);
    expect(revive).toHaveBeenCalledTimes(1);
  });

  it('CONTROL — a retry storm since the disarm does NOT earn a revival', async () => {
    const revive = vi.fn<ReviveFn>(async () => {});
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => [candidate()]);
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-b8422496', RETRY_STORM]]));

    const res = await sweepStalledLoops(
      { sql: fakeSql([]), workspaceId: 'ws' },
      deps({ revive, readRevivableLoops, readOwnerToolActivity }),
    );

    expect(res.revivedAfterDisarm).toEqual([]);
    expect(revive).not.toHaveBeenCalled();
  });

  it('CONTROL — a genuinely silent owner stays disarmed', async () => {
    const revive = vi.fn<ReviveFn>(async () => {});
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => [candidate()]);

    const res = await sweepStalledLoops(
      { sql: fakeSql([]), workspaceId: 'ws' },
      deps({ revive, readRevivableLoops, readOwnerToolActivity: noActivity() }),
    );

    expect(res.revivedAfterDisarm).toEqual([]);
    expect(revive).not.toHaveBeenCalled();
  });

  it('probes activity from the DISARM time, and asks for candidates inside the documented bounds', async () => {
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => [candidate()]);
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map<string, OwnerToolActivity>());
    const before = Date.now();

    await sweepStalledLoops(
      { sql: fakeSql([]), workspaceId: 'ws' },
      deps({ revive: vi.fn<ReviveFn>(async () => {}), readRevivableLoops, readOwnerToolActivity }),
    );

    const args = readRevivableLoops.mock.calls[0][0];
    expect(args.workspaceId).toBe('ws');
    expect(args.maxRevivals).toBe(MAX_REVIVALS);
    // The window is applied as a floor on the pause time, so a stale disarm is never revived.
    expect(args.pausedAfterMs).toBeGreaterThanOrEqual(before - REVIVE_WINDOW_MS);
    expect(args.pausedAfterMs).toBeLessThanOrEqual(Date.now() - REVIVE_WINDOW_MS);
    // The activity boundary is the DISARM, not the last fire: the question is what the owner has
    // done since we gave up on it.
    expect(readOwnerToolActivity.mock.calls[0][0]).toEqual([
      { ownerId: 'su-b8422496', sinceIso: new Date(pausedAtMs).toISOString() },
    ]);
  });

  it('does not re-disarm a loop it revived in the SAME sweep', async () => {
    // The revival flips `active = TRUE`, so the discovery query that runs after it returns the
    // very row just revived — still carrying the stale turnsStalled verdict, because its rescue
    // fire is scheduled for now() and has not happened. Without the skip the sweep would undo its
    // own repair and spend a bounded revival attempt doing it.
    const revive = vi.fn<ReviveFn>(async () => {});
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => [candidate({ ownerId: 'su-back' })]);
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-back', WORKING]]));
    const getStatuses = vi.fn(async () => new Map([['su-back', status({ turnsStalled: true })]]));

    const res = await sweepStalledLoops(
      { sql: fakeSql([{ id: 'rt-dead', target_owner_id: 'su-back' }]), workspaceId: 'ws' },
      deps({ revive, autoPause, readRevivableLoops, readOwnerToolActivity, getStatuses }),
    );

    expect(res.revivedAfterDisarm).toEqual(['su-back']);
    expect(res.paused).toBe(0);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('dryRun reports the revival without writing it', async () => {
    const revive = vi.fn<ReviveFn>(async () => {});
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => [candidate()]);
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-b8422496', WORKING]]));

    const res = await sweepStalledLoops(
      { sql: fakeSql([]), workspaceId: 'ws', dryRun: true },
      deps({ revive, readRevivableLoops, readOwnerToolActivity }),
    );

    expect(res.revivedAfterDisarm).toEqual(['su-b8422496']);
    expect(revive).not.toHaveBeenCalled();
  });

  it('a FAILING candidate read revives nobody rather than throwing the sweep', async () => {
    const revive = vi.fn<ReviveFn>(async () => {});
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => {
      throw new Error('routines unreachable');
    });

    const res = await sweepStalledLoops(
      { sql: fakeSql([]), workspaceId: 'ws' },
      deps({ revive, readRevivableLoops }),
    );

    expect(res.revivedAfterDisarm).toEqual([]);
    expect(revive).not.toHaveBeenCalled();
  });

  it('broadcasts a revival-only sweep under its OWN headline, not a starvation one', async () => {
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => [candidate()]);
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-b8422496', WORKING]]));

    await sweepStalledLoops(
      { sql: fakeSql([]), workspaceId: 'ws' },
      deps({ broadcast, revive: vi.fn<ReviveFn>(async () => {}), readRevivableLoops, readOwnerToolActivity }),
    );

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0].summary).toContain('RE-ARMED');
    expect(broadcast.mock.calls[0][0].body).toContain('su-b8422496');
  });
});

describe('the disarm reason and the revival predicate are ONE string (WI-37546 anti-drift)', () => {
  /**
   * The load-bearing pairing, and the one a reader cannot check by eye: the revival query selects
   * `metadata->>'loop_paused_reason' LIKE TURN_STALLED_PAUSE_PREFIX || '%'`. If the disarm ever
   * stops writing a reason that starts with that exact prefix, the revival pass silently matches
   * NOTHING — and a revival pass that finds nobody looks identical to one that had nobody to find.
   *
   * Asserted against the reason this module ACTUALLY writes, so a reword breaks this test rather
   * than the recovery path.
   */
  it('the reason autoPause receives is selected by the prefix the revival query uses', async () => {
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const getStatuses = vi.fn(async () => new Map([['su-dead', status({ turnsStalled: true })]]));

    await sweepStalledLoops(
      { sql: fakeSql([{ id: 'rt1', target_owner_id: 'su-dead' }]), workspaceId: 'ws' },
      {
        getStatuses,
        autoPause,
        probeReachability: reach(false),
        broadcast: vi.fn<BroadcastFn>(async () => true),
        notify: vi.fn<NotifyFn>(async () => {}),
        readOwnerToolActivity: noActivity(),
        readRevivableLoops: noRevivable(),
      },
    );

    const reason = autoPause.mock.calls[0][2];
    expect(reason.startsWith(TURN_STALLED_PAUSE_PREFIX)).toBe(true);
    // And the prefix is still specific enough to exclude the OTHER disarm path, which measured
    // 7/7 CORRECT on 2026-08-09 and must never be revived by this module.
    expect(TURN_STALLED_PAUSE_PREFIX).toContain('turns-stalled');
    expect(TURN_STALLED_PAUSE_PREFIX).not.toContain('dead-owner');
  });
});
