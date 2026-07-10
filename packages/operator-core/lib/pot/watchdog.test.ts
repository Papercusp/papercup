/**
 * Unit tests for the pot liveness watchdog
 * (start-hive-wake-orchestration-2026-06-09 P-008…P-013, D-002/D-003/D-004).
 *
 * The wake/started/wake-mode/brain seams are mocked; the PG handle is a fake
 * tagged-template that routes by statement text. These tests pin the watchdog's
 * CONTRACT: when it may arm, what it arms (a default SLEEP, never an immediate
 * re-invoke), how Pause disarms it, and how manual wake-mode stages instead.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getPotTimeWake = vi.fn();
const readPotWakeState = vi.fn();
const declarePotTimeWake = vi.fn();
const clearPotTimeWake = vi.fn();
vi.mock('./wake', () => ({
  getPotTimeWake: (...a: unknown[]) => getPotTimeWake(...a),
  readPotWakeState: (...a: unknown[]) => readPotWakeState(...a),
  declarePotTimeWake: (...a: unknown[]) => declarePotTimeWake(...a),
  clearPotTimeWake: (...a: unknown[]) => clearPotTimeWake(...a),
}));

const getPotStarted = vi.fn();
const listStartedPots = vi.fn();
// K1 (workspace-scoped-coordination P-003): the watchdog liveness loops consume
// the de-duped workspace-loop set; OFF it is byte-identical to listStartedPots.
const listStartedWorkspaceLoops = vi.fn();
const setPotStarted = vi.fn();
vi.mock('./started', () => ({
  getPotStarted: (...a: unknown[]) => getPotStarted(...a),
  listStartedPots: (...a: unknown[]) => listStartedPots(...a),
  listStartedWorkspaceLoops: (...a: unknown[]) => listStartedWorkspaceLoops(...a),
  setPotStarted: (...a: unknown[]) => setPotStarted(...a),
}));

const isRegisteredPot = vi.fn();
vi.mock('../harness-registry', () => ({
  isRegisteredPot: (...a: unknown[]) => isRegisteredPot(...a),
}));

const getDefaultWakeMode = vi.fn();
vi.mock('../agent-tools/coordination/wake-mode', () => ({
  getDefaultWakeMode: (...a: unknown[]) => getDefaultWakeMode(...a),
}));

const resolveBrainOwner = vi.fn();
vi.mock('../harness/routines/wake-brain-action', () => ({
  resolveBrainOwner: (...a: unknown[]) => resolveBrainOwner(...a),
}));

const wakeRecipients = vi.fn();
vi.mock('../agent-tools/coordination/inbox-wake', () => ({
  wakeRecipients: (...a: unknown[]) => wakeRecipients(...a),
}));

// Fake PG: route by statement text. Collects INSERTs into `fires` for P-012
// assertions; serves the demand + mid-turn + recent-fires + staged-wake reads.
const fires: Array<unknown[]> = [];
let demandRow = { todo_items: 0, started_plans: 0 };
let midTurnRows: unknown[] = [];
let pendingWakeRows: unknown[] = []; // EI-312 leg 1: pre-staged watchdog wakes
const fakeSql = (strings: TemplateStringsArray | string[], ...values: unknown[]): Promise<unknown[]> => {
  const text = Array.isArray(strings) ? strings.join('?') : String(strings);
  if (/INSERT INTO harness_shared\.hive_watchdog_fires/i.test(text)) {
    fires.push(values);
    return Promise.resolve([]);
  }
  if (/todo_items/i.test(text)) return Promise.resolve([demandRow]);
  if (/adv_sessions/i.test(text)) return Promise.resolve(midTurnRows);
  if (/FROM harness_shared\.pending_wakes/i.test(text)) return Promise.resolve(pendingWakeRows);
  if (/count\(\*\)::int AS n/i.test(text)) return Promise.resolve([{ n: fires.length }]);
  return Promise.resolve([]);
};
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: fakeSql }) }));

import {
  armFallbackPotWake,
  potBootCheck,
  potDemandCheck,
  potLivenessCheck,
  potTurnEndCheck,
  potWatchdogSweep,
  watchdogFallbackSleepSec,
  watchdogDemandSleepSec,
  watchdogStaleSec,
} from './watchdog';

const NOW = 1_750_000_000_000;
const WS = 'ws-1';
const SLUG = 'my-pot';

const unarmed = () => {
  getPotTimeWake.mockResolvedValue({ active: false, nextFireAt: null, lastFiredAt: null });
  readPotWakeState.mockResolvedValue({ subscriptions: [] });
};

beforeEach(() => {
  vi.clearAllMocks();
  fires.length = 0;
  demandRow = { todo_items: 0, started_plans: 0 };
  midTurnRows = [];
  pendingWakeRows = [];
  getPotStarted.mockResolvedValue(true);
  listStartedPots.mockResolvedValue([{ workspaceId: WS, installSlug: SLUG }]);
  listStartedWorkspaceLoops.mockResolvedValue([{ workspaceId: WS, installSlug: SLUG }]);
  getDefaultWakeMode.mockResolvedValue('auto');
  resolveBrainOwner.mockResolvedValue(null);
  wakeRecipients.mockResolvedValue({ targets: [], keys: [], woken: 0, staged: 1 });
  isRegisteredPot.mockResolvedValue(true);
  declarePotTimeWake.mockImplementation(async (_sql: unknown, opts: { at: Date }) => ({
    at: opts.at,
    clamped: false,
  }));
  unarmed();
});

describe('potLivenessCheck (P-008 / D-002)', () => {
  it('armed ⇔ an active routine row with next_fire_at', async () => {
    getPotTimeWake.mockResolvedValue({ active: true, nextFireAt: new Date(NOW + 60_000), lastFiredAt: null });
    const live = await potLivenessCheck(fakeSql as never, SLUG, { workspaceId: WS, now: NOW });
    expect(live.armed).toBe(true);

    getPotTimeWake.mockResolvedValue({ active: false, nextFireAt: new Date(NOW + 60_000), lastFiredAt: null });
    expect((await potLivenessCheck(fakeSql as never, SLUG, { now: NOW })).armed).toBe(false);

    getPotTimeWake.mockResolvedValue(null);
    expect((await potLivenessCheck(fakeSql as never, SLUG, { now: NOW })).armed).toBe(false);
  });

  it('staleness = since the most recent wake activity (launch fire vs routine fire)', async () => {
    getPotTimeWake.mockResolvedValue({ active: false, nextFireAt: null, lastFiredAt: new Date(NOW - 120_000) });
    readPotWakeState.mockResolvedValue({ subscriptions: [], lastWakeAt: NOW - 60_000 });
    const live = await potLivenessCheck(fakeSql as never, SLUG, { workspaceId: WS, now: NOW });
    expect(live.staleForMs).toBe(60_000);
  });

  it('a never-woken pot has null staleness', async () => {
    const live = await potLivenessCheck(fakeSql as never, SLUG, { now: NOW });
    expect(live.staleForMs).toBeNull();
  });
});

describe('armFallbackPotWake (D-004: a default sleep, never an immediate re-invoke)', () => {
  it('skips when the pot is not started (Pause disarms the watchdog, P-013)', async () => {
    getPotStarted.mockResolvedValue(false);
    const res = await armFallbackPotWake({ workspaceId: WS, installSlug: SLUG, source: 'tick', reason: 'r' });
    expect(res.outcome).toBe('skipped');
    expect(declarePotTimeWake).not.toHaveBeenCalled();
    expect(fires).toHaveLength(0);
  });

  it('skips when a wake is already armed (idempotent across racing seams)', async () => {
    getPotTimeWake.mockResolvedValue({ active: true, nextFireAt: new Date(NOW + 5_000), lastFiredAt: null });
    const res = await armFallbackPotWake({ workspaceId: WS, installSlug: SLUG, source: 'turn-end', reason: 'r' });
    expect(res.outcome).toBe('skipped');
    expect(declarePotTimeWake).not.toHaveBeenCalled();
  });

  it('arms the DEFAULT SLEEP (not now+floor) with a self-announcing kickoff, and records the fire (P-012)', async () => {
    const res = await armFallbackPotWake({
      workspaceId: WS,
      installSlug: SLUG,
      source: 'turn-end',
      reason: 'turn ended unarmed',
      now: NOW,
    });
    expect(res.outcome).toBe('armed');
    const call = declarePotTimeWake.mock.calls[0][1] as { at: Date; kickoff: string };
    expect(call.at.getTime()).toBe(NOW + watchdogFallbackSleepSec() * 1_000);
    expect(call.kickoff).toMatch(/[Ww]atchdog/);
    expect(call.kickoff).toMatch(/declare/i);
    expect(fires).toHaveLength(1);
  });

  it('with STANDING DEMAND arms a SHORT (demand-adaptive) sleep — a crashed/non-self-arming Mug with a backlog re-wakes FAST, not in 30 min (2026-07-01)', async () => {
    const res = await armFallbackPotWake({
      workspaceId: WS,
      installSlug: SLUG,
      source: 'turn-end',
      reason: 'turn ended unarmed with a backlog queued',
      demand: { demand: true, todoItems: 395, startedPlans: 0 },
      now: NOW,
    });
    expect(res.outcome).toBe('armed');
    const call = declarePotTimeWake.mock.calls[0][1] as { at: Date };
    expect(call.at.getTime()).toBe(NOW + watchdogDemandSleepSec() * 1_000);
    expect(watchdogDemandSleepSec()).toBeLessThan(watchdogFallbackSleepSec()); // ~120s ≪ 1800s
  });

  it('manual wake-mode → routed through wakeRecipients to the brain (the gate stages it), no time wake (P-013)', async () => {
    getDefaultWakeMode.mockResolvedValue('manual');
    resolveBrainOwner.mockResolvedValue('s-brain');
    const res = await armFallbackPotWake({ workspaceId: WS, installSlug: SLUG, source: 'tick', reason: 'r' });
    expect(res.outcome).toBe('staged');
    // EI-908 regression: the brain pin is workspace-scoped — the backstop MUST
    // resolve the owner against THIS pot's workspace, not an unscoped () call
    // (which resolved against `undefined` → always null → nothing staged).
    expect(resolveBrainOwner).toHaveBeenCalledWith(WS);
    expect(wakeRecipients).toHaveBeenCalledWith(['s-brain'], expect.objectContaining({ source: 'pot-watchdog:tick' }));
    expect(declarePotTimeWake).not.toHaveBeenCalled();
    expect(fires).toHaveLength(1);
  });

  it('manual wake-mode with NO pinned brain → skip (recorded, nothing armed)', async () => {
    getDefaultWakeMode.mockResolvedValue('manual');
    const res = await armFallbackPotWake({ workspaceId: WS, installSlug: SLUG, source: 'boot', reason: 'r' });
    expect(res.outcome).toBe('skipped');
    expect(declarePotTimeWake).not.toHaveBeenCalled();
    expect(fires).toHaveLength(1);
  });

  it('manual wake-mode is IDEMPOTENT: a watchdog wake already staged → skip, no re-stage, no fire record (EI-312 leg 1)', async () => {
    // A staged wake arms no time wake, so live.armed never engages in manual
    // mode — this check is the manual-mode mirror of "a wake is already armed".
    // Without it every seam (boot, 30s tick, turn-end) staged ANOTHER wake
    // forever (the 230-fires-in-8h storm).
    getDefaultWakeMode.mockResolvedValue('manual');
    resolveBrainOwner.mockResolvedValue('s-brain');
    pendingWakeRows = [{ '?column?': 1 }]; // owner already has a pot-watchdog:* staged wake
    const res = await armFallbackPotWake({ workspaceId: WS, installSlug: SLUG, source: 'boot', reason: 'r' });
    expect(res.outcome).toBe('skipped');
    expect(res.reason).toMatch(/already staged/);
    expect(wakeRecipients).not.toHaveBeenCalled();
    expect(declarePotTimeWake).not.toHaveBeenCalled();
    expect(fires).toHaveLength(0);
  });
});

describe('potTurnEndCheck (P-009) + potBootCheck (P-010)', () => {
  it('turn-end arms with no demand/stale gate — turn ended unarmed IS the violation', async () => {
    const res = await potTurnEndCheck({ workspaceId: WS, installSlug: SLUG });
    expect(res.outcome).toBe('armed');
  });

  it('boot check sweeps every started pot', async () => {
    listStartedWorkspaceLoops.mockResolvedValue([
      { workspaceId: WS, installSlug: 'h1' },
      { workspaceId: WS, installSlug: 'h2' },
    ]);
    const res = await potBootCheck();
    expect(res).toHaveLength(2);
    expect(res.every((r) => r.outcome === 'armed')).toBe(true);
  });
});

describe('potWatchdogSweep (P-011 / D-003: every condition gates)', () => {
  const stale = () =>
    readPotWakeState.mockResolvedValue({ subscriptions: [], lastWakeAt: NOW - (watchdogStaleSec() + 60) * 1_000 });

  it('no started hives → nothing', async () => {
    listStartedWorkspaceLoops.mockResolvedValue([]);
    expect(await potWatchdogSweep({ now: NOW })).toHaveLength(0);
  });

  it('missing registry pot → self-clears the started bit and wake, then alerts instead of re-arming', async () => {
    isRegisteredPot.mockResolvedValue(false);
    const res = await potWatchdogSweep({ now: NOW });
    expect(res).toEqual([{ outcome: 'skipped', reason: 'started Pot missing from registry; self-cleared' }]);
    expect(setPotStarted).toHaveBeenCalledWith(WS, SLUG, false, { deliberate: true });
    expect(clearPotTimeWake).toHaveBeenCalledWith(fakeSql, SLUG, { workspaceId: WS });
    expect(declarePotTimeWake).not.toHaveBeenCalled();
  });

  it('armed → no fire', async () => {
    getPotTimeWake.mockResolvedValue({ active: true, nextFireAt: new Date(NOW + 9_000), lastFiredAt: null });
    demandRow = { todo_items: 5, started_plans: 1 };
    expect(await potWatchdogSweep({ now: NOW })).toHaveLength(0);
  });

  it('recently active (not yet stale) → no fire (the turn-end/boot seams own the fresh cases)', async () => {
    readPotWakeState.mockResolvedValue({ subscriptions: [], lastWakeAt: NOW - 30_000 });
    demandRow = { todo_items: 5, started_plans: 0 };
    expect(await potWatchdogSweep({ now: NOW })).toHaveLength(0);
  });

  it('mid-turn → no fire (never wake a Mug who is awake)', async () => {
    stale();
    demandRow = { todo_items: 5, started_plans: 0 };
    midTurnRows = [{ 1: 1 }];
    expect(await potWatchdogSweep({ now: NOW })).toHaveLength(0);
  });

  it('no demand → no fire (never mandate action on an empty frontier, D-007)', async () => {
    stale();
    demandRow = { todo_items: 0, started_plans: 0 };
    expect(await potWatchdogSweep({ now: NOW })).toHaveLength(0);
  });

  it('started + stale + unarmed + demand + idle → FIRES with the demand snapshot', async () => {
    stale();
    demandRow = { todo_items: 3, started_plans: 1 };
    const res = await potWatchdogSweep({ now: NOW });
    expect(res).toHaveLength(1);
    expect(res[0].outcome).toBe('armed');
    expect(res[0].reason).toContain('3 todo');
    expect(fires).toHaveLength(1);
  });

  it('a never-woken pot (null staleness) passes the stale gate', async () => {
    demandRow = { todo_items: 1, started_plans: 0 };
    const res = await potWatchdogSweep({ now: NOW });
    expect(res).toHaveLength(1);
    expect(res[0].outcome).toBe('armed');
  });
});

describe('K1 workspace-loop de-dup (workspace-scoped-coordination P-003)', () => {
  const stale = () =>
    readPotWakeState.mockResolvedValue({ subscriptions: [], lastWakeAt: NOW - (watchdogStaleSec() + 60) * 1_000 });

  it('the sweep consumes the DE-DUPED workspace-loop set, not the raw per-pot set (ON ⇒ one loop)', async () => {
    // Simulate flag ON: listStartedPots would return N per-pot rows, but the
    // de-duped liveness set collapses to ONE workspace loop — the sweep must run
    // exactly once, not N times.
    listStartedPots.mockResolvedValue([
      { workspaceId: WS, installSlug: 'pot-a' },
      { workspaceId: WS, installSlug: 'pot-b' },
      { workspaceId: WS, installSlug: 'pot-c' },
    ]);
    listStartedWorkspaceLoops.mockResolvedValue([{ workspaceId: WS, installSlug: 'papercusp' }]);
    stale();
    demandRow = { todo_items: 2, started_plans: 0 };
    const res = await potWatchdogSweep({ now: NOW });
    // ONE workspace loop → ONE arm, not three.
    expect(res).toHaveLength(1);
    expect(listStartedWorkspaceLoops).toHaveBeenCalledTimes(1);
    expect(listStartedPots).not.toHaveBeenCalled();
  });

  it('boot check also consumes the de-duped workspace-loop set', async () => {
    listStartedPots.mockResolvedValue([
      { workspaceId: WS, installSlug: 'pot-a' },
      { workspaceId: WS, installSlug: 'pot-b' },
    ]);
    listStartedWorkspaceLoops.mockResolvedValue([{ workspaceId: WS, installSlug: 'papercusp' }]);
    const res = await potBootCheck();
    expect(res).toHaveLength(1);
    expect(listStartedWorkspaceLoops).toHaveBeenCalledTimes(1);
    expect(listStartedPots).not.toHaveBeenCalled();
  });
});

describe('potDemandCheck (P-011)', () => {
  it('demand = queued feature-family work OR started plans', async () => {
    demandRow = { todo_items: 0, started_plans: 0 };
    expect((await potDemandCheck(WS)).demand).toBe(false);
    demandRow = { todo_items: 2, started_plans: 0 };
    expect((await potDemandCheck(WS)).demand).toBe(true);
    demandRow = { todo_items: 0, started_plans: 1 };
    expect((await potDemandCheck(WS)).demand).toBe(true);
  });
});
