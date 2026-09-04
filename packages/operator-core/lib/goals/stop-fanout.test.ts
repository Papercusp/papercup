/**
 * Policy tests for the goal stop fan-out (EI-20013729460455061).
 *
 * The safety property in `does not disarm loops it cannot attribute` is the one
 * that matters most: a goal’s owned pot is routinely `papercusp` itself, where
 * dozens of unrelated su sessions hold active engine loops. If scope were ever
 * widened from "sessions attributed to this goal" to "loops in this goal's
 * pots", a single label change would become a fleet-wide kill switch. That test
 * fails if anyone makes that change.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  STOPPING_STATUSES,
  TERMINAL_STATUSES,
  isStopReport,
  type StoppingStatus,
} from '@papercusp/agent-mcp';

const pausePotState = vi.hoisted(() => vi.fn(async () => ({})));
const resumePotState = vi.hoisted(() => vi.fn(async () => ({})));
const deactivateLoop = vi.hoisted(() => vi.fn(async () => true));
const windDownGoalFleet = vi.hoisted(() =>
  vi.fn(
    async (): Promise<import('../agent-tools/fleet_registry/control-core').FleetControlResult> => ({
      ok: true,
      fleet: 'goal-drain-g1',
      controlState: 'winding-down',
    }),
  ),
);
/**
 * Default: the clear succeeds. Tests that need the OWNER-STICKY refusal override it.
 *
 * Typed as the REAL SetModeResult rather than letting the default `{ ok: true }` narrow
 * the mock to `{ ok: boolean }` — that narrowing is what makes an override look like an
 * excess-property error and tempts an `as never`, which would defeat the one check
 * vi.fn gives us here (lint:mock-cast-escape).
 */
const setMode = vi.hoisted(() =>
  vi.fn(async (): Promise<import('../modes/store').SetModeResult> => ({ ok: true })),
);
const clearImpliedModes = vi.hoisted(() => vi.fn(async (): Promise<string[]> => []));
const potsForGoal = vi.hoisted(() => vi.fn());
const unlinkPot = vi.hoisted(() => vi.fn(async () => true));
const sqlRows = vi.hoisted(() => ({
  owners: [] as string[],
  unattributed: 0,
  /** Attributed loops currently DISARMED — what the resume reports and leaves alone. */
  disarmed: 0,
  drainFleet: null as string | null,
}));

/**
 * A tagged-template stand-in for postgres.js that answers by which table the query
 * names. Deliberately not a full fake: the assertions here are about WHICH rows the
 * policy acts on, not about SQL generation.
 *
 * The two `routines` counts are told apart by their guard, not by call order: the
 * stop counts what is STILL RUNNING (`active = TRUE`), the resume counts what is
 * still DISARMED (`active = FALSE`). Keying on order instead would let the two
 * fixtures silently swap and still pass.
 */
const sql = vi.hoisted(() => {
  const fn = (strings: TemplateStringsArray) => {
    const text = strings.join(' ');
    if (text.includes('agent_modes')) {
      return Promise.resolve(sqlRows.owners.map((o) => ({ owner_id: o })));
    }
    if (text.includes('routines')) {
      const disarmedQuery = text.includes('active = FALSE');
      return Promise.resolve([
        { n: String(disarmedQuery ? sqlRows.disarmed : sqlRows.unattributed) },
      ]);
    }
    if (text.includes('harness_shared.goals')) {
      return Promise.resolve(sqlRows.drainFleet ? [{ drain_fleet: sqlRows.drainFleet }] : []);
    }
    return Promise.resolve([]);
  };
  return fn as unknown as never;
});

// PARTIAL mock: @papercusp/db-org is a large shared surface (agent-mcp's harness
// tools read `generated` from it at module scope), so replacing it wholesale breaks
// unrelated importers in the same module graph. Override only the two functions
// this policy calls.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql }),
  potsForGoal,
  unlinkPot,
}));
vi.mock('../pot/pause-core', () => ({ pausePotState, resumePotState }));
vi.mock('../harness/routines/loop', () => ({
  deactivateLoop,
  loopRoutineName: (ownerId: string) => `loop-${ownerId}`,
}));
vi.mock('../modes/store', () => ({ setMode, clearImpliedModes }));
vi.mock('../agent-tools/fleet_registry/control-core', () => ({ windDownGoalFleet }));

// Imported after the mocks so the module-load install picks them up.
const { executeGoalStop, executeGoalResume, executeGoalTransition } = await import('./stop-fanout');

const link = (harnessSlug: string, role: 'owner' | 'contributing') => ({
  id: '1',
  goalId: 'g1',
  harnessSlug,
  role,
  addedAt: '2026-08-09T00:00:00Z',
  addedBy: null,
  note: null,
  killCriterion: null,
});

const run = () =>
  executeGoalStop({ goalId: 'g1', workspaceId: 'ws', status: 'paused', actor: 'su-test' });

const resume = () =>
  executeGoalResume({ goalId: 'g1', workspaceId: 'ws', status: 'active', actor: 'su-test' });

beforeEach(() => {
  vi.clearAllMocks();
  sqlRows.owners = [];
  sqlRows.unattributed = 0;
  sqlRows.disarmed = 0;
  sqlRows.drainFleet = null;
  clearImpliedModes.mockResolvedValue([]);
  potsForGoal.mockResolvedValue([]);
  unlinkPot.mockResolvedValue(true);
  windDownGoalFleet.mockResolvedValue({
    ok: true,
    fleet: 'goal-drain-g1',
    controlState: 'winding-down',
  });
});

describe('executeGoalStop', () => {
  it('gates placement on pots the goal OWNS', async () => {
    potsForGoal.mockResolvedValue([link('pot-a', 'owner'), link('pot-b', 'owner')]);

    const report = await run();

    expect(report.potsStopped).toEqual(['pot-a', 'pot-b']);
    expect(pausePotState).toHaveBeenCalledTimes(2);
    expect(pausePotState).toHaveBeenCalledWith(expect.anything(), 'ws', 'pot-a');
  });

  it('SPARES a pot it merely contributes to — that pot is another goal\'s to stop', async () => {
    potsForGoal.mockResolvedValue([link('mine', 'owner'), link('shared', 'contributing')]);

    const report = await run();

    expect(report.potsStopped).toEqual(['mine']);
    expect(report.potsSkippedContributing).toEqual(['shared']);
    // The load-bearing assertion: the contributing pot was never touched.
    expect(pausePotState).toHaveBeenCalledTimes(1);
    expect(pausePotState).not.toHaveBeenCalledWith(expect.anything(), 'ws', 'shared');
  });

  it('disarms the loops of sessions ATTRIBUTED to this goal', async () => {
    potsForGoal.mockResolvedValue([link('pot-a', 'owner')]);
    sqlRows.owners = ['su-1', 'su-2'];

    const report = await run();

    expect(report.loopsStopped).toEqual(['su-1', 'su-2']);
    expect(deactivateLoop).toHaveBeenCalledWith('su-1', {
      sql: expect.anything(),
      actor: 'goal-stop-fanout',
      reason: 'goal g1 entered paused — goal-stop fan-out',
    });
  });

  it('does not count a session that had no armed loop as stopped', async () => {
    potsForGoal.mockResolvedValue([link('pot-a', 'owner')]);
    sqlRows.owners = ['su-1', 'su-2'];
    // deactivateLoop is guarded `AND active = TRUE`; false means "nothing was armed".
    deactivateLoop.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const report = await run();

    expect(report.loopsStopped).toEqual(['su-1']);
  });

  /**
   * THE SAFETY PROPERTY. Three unrelated su loops are active in the goal's own
   * pot and NONE is attributed to the goal. The stop must disarm zero of them
   * and say so — never silently, and never by widening scope to the harness.
   */
  it('does NOT disarm loops it cannot attribute to the goal, and reports them as still running', async () => {
    potsForGoal.mockResolvedValue([link('papercusp', 'owner')]);
    sqlRows.owners = []; // no GOAL-mode session for this goal
    sqlRows.unattributed = 3; // but three su loops are live in that harness

    const report = await run();

    expect(deactivateLoop).not.toHaveBeenCalled();
    expect(report.loopsStopped).toEqual([]);
    expect(report.unattributedActiveLoops).toBe(3);
    // The caller must not be able to read this as a clean stop.
    expect(report.degraded).toBe(true);
  });

  it('is NOT degraded when nothing is left burning', async () => {
    potsForGoal.mockResolvedValue([link('pot-a', 'owner')]);
    sqlRows.owners = ['su-1'];
    sqlRows.unattributed = 0;

    const report = await run();

    expect(report.degraded).toBe(false);
    expect(report.unattributedActiveLoops).toBe(0);
  });

  it('handles a goal with no linked pots without touching anything', async () => {
    const report = await run();

    expect(report.potsStopped).toEqual([]);
    expect(pausePotState).not.toHaveBeenCalled();
    expect(report.degraded).toBe(false);
  });

  it.each(['killed', 'achieved'] as const)(
    'tombstones owned goal_pots links on terminal %s using the supplied transaction',
    async (status) => {
      const transaction = sql as never;
      potsForGoal.mockResolvedValue([
        link('owned-pot', 'owner'),
        link('contributing-pot', 'contributing'),
      ]);

      await executeGoalStop({
        goalId: 'g1',
        workspaceId: 'ws',
        status,
        actor: 'su-test',
        sql: transaction,
      });

      expect(unlinkPot).toHaveBeenCalledTimes(1);
      expect(unlinkPot).toHaveBeenCalledWith(transaction, {
        workspaceId: 'ws',
        goalId: 'g1',
        harnessSlug: 'owned-pot',
        by: 'su-test',
      });
      // The contributing relationship is not this goal's ownership authority.
      expect(unlinkPot).not.toHaveBeenCalledWith(
        transaction,
        expect.objectContaining({ harnessSlug: 'contributing-pot' }),
      );
    },
  );

  it('keeps goal_pots links on pause so active can resume the same relationship', async () => {
    const transaction = sql as never;
    potsForGoal.mockResolvedValue([link('owned-pot', 'owner')]);

    await executeGoalStop({
      goalId: 'g1',
      workspaceId: 'ws',
      status: 'paused',
      actor: 'su-test',
      sql: transaction,
    });

    expect(unlinkPot).not.toHaveBeenCalled();
  });

  it('treats an already-tombstoned owner link as an idempotent no-op', async () => {
    const transaction = sql as never;
    potsForGoal.mockResolvedValue([link('owned-pot', 'owner')]);
    unlinkPot.mockResolvedValue(false);

    await expect(
      executeGoalStop({
        goalId: 'g1',
        workspaceId: 'ws',
        status: 'killed',
        actor: 'su-test',
        sql: transaction,
      }),
    ).resolves.toMatchObject({ status: 'killed' });
    expect(unlinkPot).toHaveBeenCalledTimes(1);
  });
});

/**
 * The resume half (WI-37615, plan D-013).
 *
 * The bug these guard: `status:'active'` wrote the label and nothing else, so the card
 * left the `blocked` lane while placement stayed gated — permanently, because the pause
 * marks itself `deliberate` so no watchdog undoes it.
 */
describe('executeGoalResume', () => {
  it('re-opens placement on pots the goal OWNS', async () => {
    potsForGoal.mockResolvedValue([link('pot-a', 'owner'), link('pot-b', 'owner')]);

    const report = await resume();

    expect(report.potsResumed).toEqual(['pot-a', 'pot-b']);
    expect(resumePotState).toHaveBeenCalledTimes(2);
    // No `sql` first argument — resumePotState needs none (pausePotState takes one only
    // for clearPotTimeWake). Asserted positionally so a signature drift is caught here.
    expect(resumePotState).toHaveBeenCalledWith('ws', 'pot-a');
  });

  it('SPARES a pot it merely contributes to, exactly as the stop does', async () => {
    potsForGoal.mockResolvedValue([link('mine', 'owner'), link('shared', 'contributing')]);

    const report = await resume();

    expect(report.potsResumed).toEqual(['mine']);
    expect(report.potsSkippedContributing).toEqual(['shared']);
    expect(resumePotState).toHaveBeenCalledTimes(1);
    expect(resumePotState).not.toHaveBeenCalledWith('ws', 'shared');
  });

  /**
   * THE POLICY ASSERTION. A resume must NOT re-arm the loops the pause disarmed — those
   * sessions are routinely dead by now — but it must REPORT them, or the caller reads
   * "active" as "running" and is wrong in the same way the stop's caller would be.
   */
  it('does NOT re-arm disarmed loops, and reports them so "active" cannot read as "running"', async () => {
    potsForGoal.mockResolvedValue([link('pot-a', 'owner')]);
    sqlRows.owners = ['su-1', 'su-2'];
    sqlRows.disarmed = 2;

    const report = await resume();

    expect(deactivateLoop).not.toHaveBeenCalled();
    expect(report.loopsLeftDisarmed).toBe(2);
    expect(report.degraded).toBe(true);
  });

  it('is NOT degraded when no attributed loop is left disarmed', async () => {
    potsForGoal.mockResolvedValue([link('pot-a', 'owner')]);
    sqlRows.owners = ['su-1'];
    sqlRows.disarmed = 0;

    const report = await resume();

    expect(report.loopsLeftDisarmed).toBe(0);
    expect(report.degraded).toBe(false);
  });

  it('never claims to have restored the time wake — the pause deleted its cadence', async () => {
    potsForGoal.mockResolvedValue([link('pot-a', 'owner')]);

    expect((await resume()).timeWakeRestored).toBe(false);
  });
});

/**
 * The routing guard, and the direct recurrence guard for WI-37615.
 *
 * `executeGoalResume` being correct is worth nothing if `status:'active'` never reaches
 * it — which is exactly the shape the original bug had (a fan-out that existed for one
 * arm only). These assert the dispatch, not the arms.
 */
describe('executeGoalTransition routing', () => {
  const transition = (status: StoppingStatus | 'active') =>
    executeGoalTransition({ goalId: 'g1', workspaceId: 'ws', status, actor: 'su-test' });

  beforeEach(() => potsForGoal.mockResolvedValue([link('pot-a', 'owner')]));

  it('routes "active" to the RESUME arm — the WI-37615 no-op', async () => {
    const report = await transition('active');

    expect(report.status).toBe('active');
    expect(resumePotState).toHaveBeenCalledWith('ws', 'pot-a');
    // The load-bearing half: resuming must never gate placement.
    expect(pausePotState).not.toHaveBeenCalled();
  });

  // Driven from the seam's OWN list rather than a literal copy of it: a status added
  // to STOPPING_STATUSES gets behavioural coverage automatically, instead of joining
  // the set while every test keeps asserting the old two (WI-37832).
  it.each(STOPPING_STATUSES)('routes "%s" to the STOP arm', async (status) => {
    const report = await transition(status);

    expect(report.status).toBe(status);
    expect(pausePotState).toHaveBeenCalledWith(expect.anything(), 'ws', 'pot-a');
    // Positive control for the assertion above: these arms must NOT resume.
    expect(resumePotState).not.toHaveBeenCalled();
  });
});

/**
 * WI-37832 — the SUCCESS terminal must wind down, not leak.
 *
 * Stated separately from the parameterised routing test above because it is a
 * REGRESSION, not a table row: `achieved` was a first-class member of GOAL_STATUSES
 * while being invisible to this seam, so the status you set when a goal SUCCEEDS was
 * the only one that wound nothing down — pots left ungated and attributed loops left
 * burning, while `killed` cleaned both up. Measured live at filing: a goal sat
 * `achieved` for 2h38m owning a pot (goal_pots role='owner', removed_at NULL) with its
 * attributed session's engine loop still active.
 *
 * Asserting both tiers matters: routing alone would still pass if the stop arm ever
 * gated placement without disarming loops, which is the half with actual teeth.
 */
describe('a goal closed as achieved', () => {
  beforeEach(() => {
    potsForGoal.mockResolvedValue([link('pot-a', 'owner')]);
    sqlRows.owners = ['su-attributed'];
  });

  it('gates placement on its owned pots AND disarms its attributed loops', async () => {
    const report = await executeGoalTransition({
      goalId: 'g1',
      workspaceId: 'ws',
      status: 'achieved',
      actor: 'su-test',
    });

    expect(pausePotState).toHaveBeenCalledWith(expect.anything(), 'ws', 'pot-a');
    expect(deactivateLoop).toHaveBeenCalledWith('su-attributed', expect.anything());
    expect(isStopReport(report) && report.potsStopped).toEqual(['pot-a']);
    expect(isStopReport(report) && report.loopsStopped).toEqual(['su-attributed']);
  });
});

/**
 * WI-37834 — tier 3: a TERMINAL goal must stop TELLING the session it is the mission.
 *
 * `agent_modes` has no `enabled` column, so the row's existence IS the active state:
 * gating placement and disarming loops while leaving the row behind still hands a live
 * session a finished goal as its standing mission on every orient.
 *
 * The asymmetry with `paused` is the part worth guarding. It is not an oversight — the
 * GOAL-mode rows are the attribution index `executeGoalResume` reads, so clearing them
 * on a pause would leave resume unable to name the very sessions it reports on.
 */
describe('tier 3 — GOAL-mode rows on a terminal goal', () => {
  beforeEach(() => {
    potsForGoal.mockResolvedValue([link('pot-a', 'owner')]);
    sqlRows.owners = ['su-attributed'];
  });

  it.each(TERMINAL_STATUSES)('clears the attributed session\'s goal mode on "%s"', async (status) => {
    const report = await executeGoalTransition({
      goalId: 'g1',
      workspaceId: 'ws',
      status,
      actor: 'su-test',
    });

    expect(setMode).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'su-attributed', modeId: 'goal', enabled: false }),
    );
    expect(isStopReport(report) && report.modesCleared).toEqual(['su-attributed']);
    expect(isStopReport(report) && report.modesLeftArmed).toEqual([]);
  });

  it('does NOT clear them on "paused" — resume reads those rows as its attribution index', async () => {
    const report = await executeGoalTransition({
      goalId: 'g1',
      workspaceId: 'ws',
      status: 'paused',
      actor: 'su-test',
    });

    // The load-bearing assertion: a pause still gates + disarms, but must not retire
    // the rows. Asserting the report alone would pass if the call were made and its
    // result merely dropped, so assert the CALL did not happen.
    expect(setMode).not.toHaveBeenCalled();
    expect(isStopReport(report) && report.modesCleared).toEqual([]);
    expect(pausePotState).toHaveBeenCalledWith(expect.anything(), 'ws', 'pot-a');
  });

  it('REPORTS an owner-directed row it could not clear instead of claiming success', async () => {
    // modes/store.ts OWNER-STICKY (D-003): a peer caller cannot clear an
    // owner-directed incumbent. The fan-out is not an owner-authority channel, so
    // this refusal is the CORRECT outcome — the defect would be reporting it as done.
    setMode.mockResolvedValueOnce({ ok: false, stickyConflict: true });

    const report = await executeGoalTransition({
      goalId: 'g1',
      workspaceId: 'ws',
      status: 'achieved',
      actor: 'su-test',
    });

    expect(isStopReport(report) && report.modesCleared).toEqual([]);
    expect(isStopReport(report) && report.modesLeftArmed).toEqual(['su-attributed']);
    // A session still being told a finished goal is its mission IS material incompleteness.
    expect(isStopReport(report) && report.degraded).toBe(true);
  });

  it('does not report an already-cleared row as newly cleared', async () => {
    setMode.mockResolvedValueOnce({ ok: true, noop: true });

    const report = await executeGoalTransition({
      goalId: 'g1',
      workspaceId: 'ws',
      status: 'killed',
      actor: 'su-test',
    });

    // noop = the row was already gone (concurrent clear, or the session exited the
    // mode itself). That is the desired end state, so it is neither cleared nor left armed.
    expect(isStopReport(report) && report.modesCleared).toEqual([]);
    expect(isStopReport(report) && report.modesLeftArmed).toEqual([]);
    expect(isStopReport(report) && report.degraded).toBe(false);
    expect(clearImpliedModes).toHaveBeenCalledWith({
      sql: expect.anything(),
      workspaceId: 'ws',
      ownerId: 'su-attributed',
      source: { mode: 'goal', subject: 'g1' },
      reason: 'goal g1 reached a terminal status — retire implied posture rows',
      setBy: 'su-test',
    });
  });

  it('clears implied posture rows only after the terminal GOAL row is cleared', async () => {
    const callOrder: string[] = [];
    setMode.mockImplementationOnce(async () => {
      callOrder.push('goal');
      return { ok: true };
    });
    clearImpliedModes.mockImplementationOnce(async () => {
      callOrder.push('implied');
      return ['ideate'];
    });

    await executeGoalTransition({
      goalId: 'g1',
      workspaceId: 'ws',
      status: 'killed',
      actor: 'su-test',
    });

    expect(callOrder).toEqual(['goal', 'implied']);
    expect(clearImpliedModes).toHaveBeenCalledOnce();
  });

  it('does not clear implied rows when the terminal GOAL clear is refused by the sticky guard', async () => {
    setMode.mockResolvedValueOnce({ ok: false, stickyConflict: true });

    await executeGoalTransition({
      goalId: 'g1',
      workspaceId: 'ws',
      status: 'killed',
      actor: 'su-test',
    });

    expect(clearImpliedModes).not.toHaveBeenCalled();
  });
});

describe('tier 4 — the standing goal drain fleet', () => {
  beforeEach(() => {
    potsForGoal.mockResolvedValue([link('pot-a', 'owner')]);
    sqlRows.drainFleet = 'goal-drain-g1';
  });

  it.each(TERMINAL_STATUSES)('puts the recorded fleet into typed winding-down state on "%s"', async (status) => {
    const report = await executeGoalTransition({
      goalId: 'g1',
      workspaceId: 'ws',
      status,
      actor: 'su-test',
    });

    expect(windDownGoalFleet).toHaveBeenCalledWith({
      workspaceId: 'ws',
      fleetSlug: 'goal-drain-g1',
      goalId: 'g1',
      status,
      actor: 'su-test',
    });
    expect(isStopReport(report) && report.drainFleet).toBe('goal-drain-g1');
    expect(isStopReport(report) && report.drainFleetWoundDown).toBe(true);
  });

  it('keeps the fleet resumable while the goal is paused', async () => {
    const report = await executeGoalTransition({
      goalId: 'g1',
      workspaceId: 'ws',
      status: 'paused',
      actor: 'su-test',
    });

    expect(windDownGoalFleet).not.toHaveBeenCalled();
    expect(isStopReport(report) && report.drainFleet).toBeNull();
    expect(isStopReport(report) && report.drainFleetWoundDown).toBeNull();
  });

  it('marks a terminal stop degraded when typed fleet retirement fails', async () => {
    windDownGoalFleet.mockResolvedValueOnce({
      ok: false,
      error: 'fleet_leadership_superseded',
      message: 'leader changed',
    });

    const report = await executeGoalTransition({
      goalId: 'g1',
      workspaceId: 'ws',
      status: 'killed',
      actor: 'su-test',
    });

    expect(isStopReport(report) && report.drainFleetWoundDown).toBe(false);
    expect(isStopReport(report) && report.drainFleetWindDownError).toBe('fleet_leadership_superseded');
    expect(isStopReport(report) && report.degraded).toBe(true);
  });
});
