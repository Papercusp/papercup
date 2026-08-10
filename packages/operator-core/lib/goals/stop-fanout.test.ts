/**
 * Policy tests for the goal stop fan-out (EI-20013729460455061).
 *
 * The safety property in `does not disarm loops it cannot attribute` is the one
 * that matters most: a goal's owned project is routinely `papercusp` itself, where
 * dozens of unrelated su sessions hold active engine loops. If scope were ever
 * widened from "sessions attributed to this goal" to "loops in this goal's
 * projects", a single label change would become a fleet-wide kill switch. That test
 * fails if anyone makes that change.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const pausePotState = vi.hoisted(() => vi.fn(async () => ({})));
const resumePotState = vi.hoisted(() => vi.fn(async () => ({})));
const deactivateLoop = vi.hoisted(() => vi.fn(async () => true));
const projectsForGoal = vi.hoisted(() => vi.fn());
const sqlRows = vi.hoisted(() => ({
  owners: [] as string[],
  unattributed: 0,
  /** Attributed loops currently DISARMED — what the resume reports and leaves alone. */
  disarmed: 0,
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
  projectsForGoal,
}));
vi.mock('../pot/pause-core', () => ({ pausePotState, resumePotState }));
vi.mock('../harness/routines/loop', () => ({
  deactivateLoop,
  loopRoutineName: (ownerId: string) => `loop-${ownerId}`,
}));

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
  projectsForGoal.mockResolvedValue([]);
});

describe('executeGoalStop', () => {
  it('gates placement on projects the goal OWNS', async () => {
    projectsForGoal.mockResolvedValue([link('pot-a', 'owner'), link('pot-b', 'owner')]);

    const report = await run();

    expect(report.projectsStopped).toEqual(['pot-a', 'pot-b']);
    expect(pausePotState).toHaveBeenCalledTimes(2);
    expect(pausePotState).toHaveBeenCalledWith(expect.anything(), 'ws', 'pot-a');
  });

  it('SPARES a project it merely contributes to — that project is another goal\'s to stop', async () => {
    projectsForGoal.mockResolvedValue([link('mine', 'owner'), link('shared', 'contributing')]);

    const report = await run();

    expect(report.projectsStopped).toEqual(['mine']);
    expect(report.projectsSkippedContributing).toEqual(['shared']);
    // The load-bearing assertion: the contributing project was never touched.
    expect(pausePotState).toHaveBeenCalledTimes(1);
    expect(pausePotState).not.toHaveBeenCalledWith(expect.anything(), 'ws', 'shared');
  });

  it('disarms the loops of sessions ATTRIBUTED to this goal', async () => {
    projectsForGoal.mockResolvedValue([link('pot-a', 'owner')]);
    sqlRows.owners = ['su-1', 'su-2'];

    const report = await run();

    expect(report.loopsStopped).toEqual(['su-1', 'su-2']);
    expect(deactivateLoop).toHaveBeenCalledWith('su-1', { sql: expect.anything() });
  });

  it('does not count a session that had no armed loop as stopped', async () => {
    projectsForGoal.mockResolvedValue([link('pot-a', 'owner')]);
    sqlRows.owners = ['su-1', 'su-2'];
    // deactivateLoop is guarded `AND active = TRUE`; false means "nothing was armed".
    deactivateLoop.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const report = await run();

    expect(report.loopsStopped).toEqual(['su-1']);
  });

  /**
   * THE SAFETY PROPERTY. Three unrelated su loops are active in the goal's own
   * project and NONE is attributed to the goal. The stop must disarm zero of them
   * and say so — never silently, and never by widening scope to the harness.
   */
  it('does NOT disarm loops it cannot attribute to the goal, and reports them as still running', async () => {
    projectsForGoal.mockResolvedValue([link('papercusp', 'owner')]);
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
    projectsForGoal.mockResolvedValue([link('pot-a', 'owner')]);
    sqlRows.owners = ['su-1'];
    sqlRows.unattributed = 0;

    const report = await run();

    expect(report.degraded).toBe(false);
    expect(report.unattributedActiveLoops).toBe(0);
  });

  it('handles a goal with no linked projects without touching anything', async () => {
    const report = await run();

    expect(report.projectsStopped).toEqual([]);
    expect(pausePotState).not.toHaveBeenCalled();
    expect(report.degraded).toBe(false);
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
  it('re-opens placement on projects the goal OWNS', async () => {
    projectsForGoal.mockResolvedValue([link('pot-a', 'owner'), link('pot-b', 'owner')]);

    const report = await resume();

    expect(report.projectsResumed).toEqual(['pot-a', 'pot-b']);
    expect(resumePotState).toHaveBeenCalledTimes(2);
    // No `sql` first argument — resumePotState needs none (pausePotState takes one only
    // for clearPotTimeWake). Asserted positionally so a signature drift is caught here.
    expect(resumePotState).toHaveBeenCalledWith('ws', 'pot-a');
  });

  it('SPARES a project it merely contributes to, exactly as the stop does', async () => {
    projectsForGoal.mockResolvedValue([link('mine', 'owner'), link('shared', 'contributing')]);

    const report = await resume();

    expect(report.projectsResumed).toEqual(['mine']);
    expect(report.projectsSkippedContributing).toEqual(['shared']);
    expect(resumePotState).toHaveBeenCalledTimes(1);
    expect(resumePotState).not.toHaveBeenCalledWith('ws', 'shared');
  });

  /**
   * THE POLICY ASSERTION. A resume must NOT re-arm the loops the pause disarmed — those
   * sessions are routinely dead by now — but it must REPORT them, or the caller reads
   * "active" as "running" and is wrong in the same way the stop's caller would be.
   */
  it('does NOT re-arm disarmed loops, and reports them so "active" cannot read as "running"', async () => {
    projectsForGoal.mockResolvedValue([link('pot-a', 'owner')]);
    sqlRows.owners = ['su-1', 'su-2'];
    sqlRows.disarmed = 2;

    const report = await resume();

    expect(deactivateLoop).not.toHaveBeenCalled();
    expect(report.loopsLeftDisarmed).toBe(2);
    expect(report.degraded).toBe(true);
  });

  it('is NOT degraded when no attributed loop is left disarmed', async () => {
    projectsForGoal.mockResolvedValue([link('pot-a', 'owner')]);
    sqlRows.owners = ['su-1'];
    sqlRows.disarmed = 0;

    const report = await resume();

    expect(report.loopsLeftDisarmed).toBe(0);
    expect(report.degraded).toBe(false);
  });

  it('never claims to have restored the time wake — the pause deleted its cadence', async () => {
    projectsForGoal.mockResolvedValue([link('pot-a', 'owner')]);

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
  const transition = (status: 'paused' | 'killed' | 'active') =>
    executeGoalTransition({ goalId: 'g1', workspaceId: 'ws', status, actor: 'su-test' });

  beforeEach(() => projectsForGoal.mockResolvedValue([link('pot-a', 'owner')]));

  it('routes "active" to the RESUME arm — the WI-37615 no-op', async () => {
    const report = await transition('active');

    expect(report.status).toBe('active');
    expect(resumePotState).toHaveBeenCalledWith('ws', 'pot-a');
    // The load-bearing half: resuming must never gate placement.
    expect(pausePotState).not.toHaveBeenCalled();
  });

  it.each(['paused', 'killed'] as const)('routes "%s" to the STOP arm', async (status) => {
    const report = await transition(status);

    expect(report.status).toBe(status);
    expect(pausePotState).toHaveBeenCalledWith(expect.anything(), 'ws', 'pot-a');
    // Positive control for the assertion above: these arms must NOT resume.
    expect(resumePotState).not.toHaveBeenCalled();
  });
});
