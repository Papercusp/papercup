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
// P-007 (retire-mug-kettle-su-only-2026-08-09): the watchdog now shares ONE
// tier predicate with the started bit. It MUST be present in this mock — a
// partial vi.mock factory makes the whole suite fail to COLLECT, with an error
// naming neither the new import nor the change that added it.
//
// ⚠ WI-38314 — THE DEFAULT IS `false`, MATCHING PRODUCTION. The real predicate
// (`pot/started.ts`) is a hard `return false` since P-068/D-098 deleted the flag
// it used to read; no input can make it true. This mock defaulted to `true`, so
// the file's DEFAULT was a state production cannot reach and twelve cases below
// read as ordinary live coverage while exercising a body the sweep gate makes
// unreachable. That is invisible at the call site — which is the defect: the
// assertions pass, so nothing says the coverage is of a dead branch.
//
// Every case that still needs the tier OPEN now says so LOCALLY (the two
// describes below re-open it in their own beforeEach, with the reason), so the
// unreachable-body coverage is labelled rather than inherited. This mirrors
// `placement-watchdog.test.ts`, which already keeps its delivery-body cases
// behind an explicit local re-open beside the absence assertion they calibrate.
// Retiring those bodies (and these cases with them) is WI-38240's sweep — tests
// die WITH their code, per D-098's "per-file, with tests", never before it.
const mugKettleSystemEnabled = vi.fn(async () => false);
vi.mock('./started', () => ({
  getPotStarted: (...a: unknown[]) => getPotStarted(...a),
  listStartedPots: (...a: unknown[]) => listStartedPots(...a),
  listStartedWorkspaceLoops: (...a: unknown[]) => listStartedWorkspaceLoops(...a),
  setPotStarted: (...a: unknown[]) => setPotStarted(...a),
  mugKettleSystemEnabled: (...a: unknown[]) => mugKettleSystemEnabled(...(a as [])),
}));

// harness-registry.ts is OUT OF SCOPE — the real export is isRegisteredHive
// (watchdog.ts aliases it locally to isRegisteredPot).
const isRegisteredPot = vi.fn();
vi.mock('../harness-registry', () => ({
  isRegisteredHive: (...a: unknown[]) => isRegisteredPot(...a),
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
const fakeSql = Object.assign((strings: TemplateStringsArray | string[], ...values: unknown[]): Promise<unknown[]> => {
  const text = Array.isArray(strings) ? strings.join('?') : String(strings);
  if (/INSERT INTO harness_shared\.pot_watchdog_fires/i.test(text)) {
    fires.push(values);
    return Promise.resolve([]);
  }
  if (/todo_items/i.test(text)) return Promise.resolve([demandRow]);
  if (/adv_sessions/i.test(text)) return Promise.resolve(midTurnRows);
  if (/FROM harness_shared\.pending_wakes/i.test(text)) return Promise.resolve(pendingWakeRows);
  if (/count\(\*\)::int AS n/i.test(text)) return Promise.resolve([{ n: fires.length }]);
  return Promise.resolve([]);
}, { begin: vi.fn() });
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: fakeSql }) }));

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
  scopedFireReason,
  clearRetiredTierWakes,
  pausedPotRecoverySweep,
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
  // WI-38314: re-assert PRODUCTION truth before every case. `vi.clearAllMocks()`
  // clears calls but NOT implementations, so a `mockResolvedValue(true)` set by
  // one tier-open case would otherwise persist silently into every later case in
  // file order — turning a labelled local re-open back into an invisible default,
  // which is the exact defect this file was fixed for.
  mugKettleSystemEnabled.mockResolvedValue(false);
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

  // EI-18096707077291323: an event-only (or mode:'none', which still ensures
  // the default demand subscriptions per EI-10525) dormancy declaration is a
  // validly-armed next wake, not "forgot to declare" — armed via the EVENT
  // leg even though no time wake exists.
  it('armed via an event-wake subscription alone (no time wake) — EI-18096707077291323', async () => {
    getPotTimeWake.mockResolvedValue({ active: false, nextFireAt: null, lastFiredAt: null });
    readPotWakeState.mockResolvedValue({
      subscriptions: [{ on: 'pot:set-steering', note: 'dormancy wake' }],
    });
    const live = await potLivenessCheck(fakeSql as never, SLUG, { workspaceId: WS, now: NOW });
    expect(live.armed).toBe(true);
    expect(live.timeArmed).toBe(false);
    expect(live.eventArmed).toBe(true);
  });

  it('unarmed when neither a time wake nor any event subscription exists', async () => {
    const live = await potLivenessCheck(fakeSql as never, SLUG, { workspaceId: WS, now: NOW });
    expect(live.armed).toBe(false);
    expect(live.timeArmed).toBe(false);
    expect(live.eventArmed).toBe(false);
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

  // EI-18096707077291323 recurrence guard: turn-end used to re-fire the fallback
  // every cycle after a valid event-only declare-wake (no time.active, 4 event
  // subscriptions armed) because potLivenessCheck only recognized the time leg.
  it('turn-end does NOT re-fire after an event-only declare-wake (EI-18096707077291323)', async () => {
    getPotTimeWake.mockResolvedValue({ active: false, nextFireAt: null, lastFiredAt: null });
    readPotWakeState.mockResolvedValue({
      subscriptions: [
        { on: 'pot:set-steering', note: 'dormancy wake' },
        { on: 'plans:start', note: 'default demand wake' },
        { on: 'work_items:create', note: 'default demand wake' },
        { on: 'coord:escalate', note: 'default demand wake' },
      ],
    });
    const res = await potTurnEndCheck({ workspaceId: WS, installSlug: SLUG });
    expect(res.outcome).toBe('skipped');
    expect(res.reason).toBe('a wake is already armed');
    expect(declarePotTimeWake).not.toHaveBeenCalled();
  });

  it('boot check sweeps every started pot', async () => {
    listStartedWorkspaceLoops.mockResolvedValue([
      { workspaceId: WS, installSlug: 'h1' },
      { workspaceId: WS, installSlug: 'h2' },
    ]);
    // WI-38314: `potBootCheck` opens with `clearRetiredTierWakes()`, which under
    // the REAL (retired) predicate deletes any surviving routine row and warns.
    // The file-wide `unarmed()` helper models "not armed" as an INACTIVE row
    // (`{ active: false }`) — truthy, so the clear finds something to delete and
    // the warn fails the suite under fail-on-console. Model it as NO ROW instead
    // (`getPotTimeWake` returns null when the routine is absent — see wake.ts),
    // which is the state a booting host is actually in here and makes the clear
    // the no-op this case assumes. This was invisible while the tier mock was
    // defaulted ON: the clear returned early and never touched the row.
    getPotTimeWake.mockResolvedValue(null);
    const res = await potBootCheck();
    expect(res).toHaveLength(2);
    expect(res.every((r) => r.outcome === 'armed')).toBe(true);
  });
});

/**
 * ⚠ TIER-OPEN COVERAGE (WI-38314). Every case in this describe exercises the
 * sweep BODY, which `potWatchdogSweep` reaches only past
 * `if (!(await mugKettleSystemEnabled())) { await clearRetiredTierWakes(); return }`
 * (watchdog.ts) — and the real predicate is a hard `false`, so production always
 * takes the early return. These cases therefore pin a body that is currently
 * UNREACHABLE, and they are kept deliberately for the same reason
 * placement-watchdog.test.ts keeps its delivery-body cases: the "arms nothing
 * once the tier is retired" assertion in the P-007 describe below is worth
 * something only if the thing asserted absent is known to work when permitted.
 *
 * The gate is re-opened HERE rather than inherited from the file default, so the
 * label travels with the coverage. When WI-38240 deletes the sweep body, this
 * whole describe goes with it — that is the intended coupling, not collateral.
 */
describe('potWatchdogSweep (P-011 / D-003: every condition gates) — tier forced OPEN', () => {
  const stale = () =>
    readPotWakeState.mockResolvedValue({ subscriptions: [], lastWakeAt: NOW - (watchdogStaleSec() + 60) * 1_000 });

  beforeEach(() => {
    mugKettleSystemEnabled.mockResolvedValue(true);
  });

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

  it('event-armed (no time wake) → no fire (EI-18096707077291323)', async () => {
    readPotWakeState.mockResolvedValue({
      subscriptions: [{ on: 'pot:set-steering', note: 'dormancy wake' }],
      lastWakeAt: NOW - (watchdogStaleSec() + 60) * 1_000,
    });
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
    // WI-38314: tier forced OPEN for this case ONLY — `potWatchdogSweep` returns
    // before reading either set while the tier is retired, so without this the
    // assertion below would pass against an empty early return and prove nothing
    // about de-duplication. Its sibling case (boot check) needs no re-open: that
    // path gates on `getPotStarted`, which this file mocks directly.
    mugKettleSystemEnabled.mockResolvedValue(true);
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
    getPotTimeWake.mockResolvedValue(null); // nothing to clear — see the case above
    const res = await potBootCheck();
    expect(res).toHaveLength(1);
    // WI-38314: TWO reads, not one, and both on the DE-DUPED accessor —
    // `potBootCheck` calls `clearRetiredTierWakes()` (which reads the same set)
    // before its arming pass, and under the real retired predicate that clear no
    // longer returns early. The load-bearing claim of this case is unchanged and
    // is the line below: the raw per-pot accessor is never consulted, so a
    // workspace with N pot rows still yields ONE loop.
    expect(listStartedWorkspaceLoops).toHaveBeenCalledTimes(2);
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

// ── EI-18824142520274965: the scopeKey↔reason contract, enforced ─────────────
//
// A scoped debounce resolves as `reason LIKE '%scopeKey%'`, so a reason that does
// not contain its key builds a lookup that can never match its own prior fires —
// the alarm re-pages every tick and nothing reports a fault. Documenting that was
// not enough (the divergence sweep shipped exactly this bug and emitted 113 fires
// across 2 conditions in 37 minutes), so the invariant is now enforced in code.
describe('scopedFireReason — a scoped fire must be findable by its own key', () => {
  it('leaves a correct reason untouched', () => {
    const reason = '[su-a:work_items:claim] you called it 3×';
    expect(scopedFireReason(reason, 'su-a:work_items:claim', 'tick')).toBe(reason);
  });

  it('repairs a reason that omits the key, and warns so the caller gets fixed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = scopedFireReason('you called it 3×', 'su-a:work_items:claim', 'tick');
      expect(out).toContain('su-a:work_items:claim');
      // The repair keeps the alarm working; the warning is what stops it being
      // silent, which is the property that let the original bug run for weeks.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('would never match');
    } finally {
      warn.mockRestore();
    }
  });

  it('is a no-op when no scopeKey is in play — unscoped callers are unaffected', () => {
    expect(scopedFireReason('plain reason', undefined, 'tick')).toBe('plain reason');
  });
});

/**
 * P-007 — the watchdog side of the retirement gate
 * (retire-mug-kettle-su-only-2026-08-09, D-004/D-008).
 *
 * getPotStarted going false stops NEW arming (covered in
 * mug-kettle-engine-gate.test.ts). These cases cover the two things that gate
 * cannot do by itself: un-arming a wake scheduled BEFORE the flip, and stopping
 * the paused-pot sweep from writing started=true against a deliberately
 * retired tier.
 */
describe('P-007: the mug/kettle tier is RETIRED (papercusp-mug-kettle-system OFF)', () => {
  beforeEach(() => {
    mugKettleSystemEnabled.mockResolvedValue(false);
  });

  it('the 30s sweep arms nothing and never reaches the per-pot liveness queries', async () => {
    listStartedWorkspaceLoops.mockResolvedValue([{ workspaceId: 'ws', installSlug: 'papercusp' }]);
    getPotTimeWake.mockResolvedValue(null);

    const res = await potWatchdogSweep({ now: Date.now() });

    expect(res).toEqual([]);
    expect(declarePotTimeWake).not.toHaveBeenCalled();
    // The sweep must not keep paying for registry/liveness reads every 30s
    // forever once the tier is retired.
    expect(isRegisteredPot).not.toHaveBeenCalled();
  });

  it('CLEARS a wake armed BEFORE the flip, so it cannot fire post-retirement', async () => {
    // This is the one way the retirement leaks: the owner turns the Mug off and
    // it wakes anyway, once, for reasons nothing in the logs explains.
    listStartedWorkspaceLoops.mockResolvedValue([{ workspaceId: 'ws', installSlug: 'papercusp' }]);
    getPotTimeWake.mockResolvedValue({ nextWakeAt: Date.now() + 60_000 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { cleared } = await clearRetiredTierWakes();

    expect(cleared).toBe(1);
    expect(clearPotTimeWake).toHaveBeenCalledTimes(1);
    // The disarm must be ANNOUNCED, not silent. A wake vanishing with no log is
    // indistinguishable from the bug this fixes (a wake that never fires), and
    // whoever debugs the Mug next needs to see why it stopped.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/RETIRED.*cleared a wake armed before the flip/s);
    warn.mockRestore();
  });

  it('the clear is IDEMPOTENT — a second pass finds nothing, so it needs no marker row', async () => {
    listStartedWorkspaceLoops.mockResolvedValue([{ workspaceId: 'ws', installSlug: 'papercusp' }]);
    getPotTimeWake.mockResolvedValue(null); // already cleared by an earlier pass

    const { cleared } = await clearRetiredTierWakes();

    expect(cleared).toBe(0);
    expect(clearPotTimeWake).not.toHaveBeenCalled();
  });

  it('paused-pot AUTO-RESUME does not run — a retired tier is a deliberate pause', async () => {
    // Not just inert-by-downstream-read: a resume write WIPES the deliberate
    // pause provenance (WI-3261/WI-3309), so the owner's pause record would be
    // destroyed on a timer by a sweep whose effect no longer applies.
    const res = await pausedPotRecoverySweep({ now: Date.now() });

    expect(res).toEqual([]);
    expect(setPotStarted).not.toHaveBeenCalled();
  });

  it('CALIBRATION — tier ENABLED: the clear is a no-op and live wakes survive', async () => {
    mugKettleSystemEnabled.mockResolvedValue(true);
    listStartedWorkspaceLoops.mockResolvedValue([{ workspaceId: 'ws', installSlug: 'papercusp' }]);
    getPotTimeWake.mockResolvedValue({ nextWakeAt: Date.now() + 60_000 });

    const { cleared } = await clearRetiredTierWakes();

    // Without this, a clear that ignored the flag would pass every case above
    // while silently disarming the tier whenever it is flipped ON for testing.
    expect(cleared).toBe(0);
    expect(clearPotTimeWake).not.toHaveBeenCalled();
  });
});
