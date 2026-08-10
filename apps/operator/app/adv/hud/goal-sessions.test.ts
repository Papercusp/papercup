/**
 * goal-sessions derivation coverage.
 *
 * The rail is a roster of WHO is on a goal, so the claims worth pinning are the
 * ones a passing render would not catch: who counts as being on the goal, which
 * section a session lands in, and that a fleet stays one fleet.
 */
import { describe, expect, it } from 'vitest';
import {
  GOAL_SESSION_SECTIONS,
  classifyGoalSession,
  deriveGoalSessions,
  type GoalSessionsModel,
} from './goal-sessions';
import type { HudRosterEntry } from './hud-board-model';

const NOW = Date.parse('2026-08-10T18:00:00.000Z');

function entry(over: Partial<HudRosterEntry> = {}): HudRosterEntry {
  return {
    ownerId: 'su-aaaaa',
    label: 'su-aaaaa',
    source: 'presence',
    intent: '',
    currentFiles: [],
    liveness: 'live',
    sessionState: 'live',
    stale: false,
    lastActiveAt: new Date(NOW - 30_000).toISOString(),
    intentDeclaredAt: null,
    loopArmed: false,
    modes: [],
    pidAlive: true,
    claims: [],
    declaredUnclaimed: false,
    currentPlanSlug: null,
    harnessSlug: 'papercusp',
    agentPaneKind: 'su',
    role: null,
    agent: 'claude',
    advSessionId: null,
    windowId: null,
    wakeMode: null,
    pendingWakes: 0,
    fleetSlug: null,
    fleetColor: null,
    fleetRole: null,
    contextTokens: null,
    compactionLimit: null,
    openAwait: null,
    thinking: false,
    ...over,
  } as HudRosterEntry;
}

function derive(entries: HudRosterEntry[], stamped: string[]): GoalSessionsModel {
  return deriveGoalSessions(entries, stamped, { nowMs: NOW });
}

function section(model: GoalSessionsModel, id: string) {
  return model.sections.find((s) => s.id === id)!;
}

describe('deriveGoalSessions — membership', () => {
  it('includes a stamped session that is in no fleet', () => {
    // The goal's OWN agent is the case the fleet leg structurally cannot see.
    const model = derive([entry({ ownerId: 'su-goal' })], ['su-goal']);
    expect(model.total).toBe(1);
    expect(section(model, 'misc').groups[0]!.lead.ownerId).toBe('su-goal');
  });

  it('pulls in fleet members who are NOT themselves stamped', () => {
    // The whole point of the second leg: members are launched on the PLAN, so
    // they never carry the goal stamp. Without this the rail would show a lead
    // with nothing under it and read as though nobody were working.
    const model = derive(
      [
        entry({ ownerId: 'su-lead', fleetSlug: 'f1', fleetRole: 'leader' }),
        entry({ ownerId: 'su-m1', fleetSlug: 'f1', fleetRole: 'member' }),
        entry({ ownerId: 'su-m2', fleetSlug: 'f1', fleetRole: 'member' }),
      ],
      ['su-lead'],
    );
    const g = section(model, 'plan').groups[0]!;
    expect(g.lead.ownerId).toBe('su-lead');
    expect(g.members.map((m) => m.ownerId).sort()).toEqual(['su-m1', 'su-m2']);
    expect(model.total).toBe(3);
  });

  it('does NOT drag in an unrelated fleet via a shared member', () => {
    // A fleet is on the goal because its LEAD is. Deriving goal-fleets from any
    // member would let one shared member import a whole unrelated fleet.
    const model = derive(
      [
        entry({ ownerId: 'su-lead', fleetSlug: 'f1', fleetRole: 'leader' }),
        entry({ ownerId: 'su-other', fleetSlug: 'f2', fleetRole: 'leader' }),
        entry({ ownerId: 'su-x', fleetSlug: 'f2', fleetRole: 'member' }),
      ],
      ['su-lead'],
    );
    expect(model.total).toBe(1);
    expect(section(model, 'plan').groups).toHaveLength(1);
  });

  it('keeps two plan fleets as two groups rather than one flat list', () => {
    const model = derive(
      [
        entry({ ownerId: 'su-l1', fleetSlug: 'f1', fleetRole: 'leader' }),
        entry({ ownerId: 'su-a', fleetSlug: 'f1', fleetRole: 'member' }),
        entry({ ownerId: 'su-l2', fleetSlug: 'f2', fleetRole: 'leader' }),
        entry({ ownerId: 'su-b', fleetSlug: 'f2', fleetRole: 'member' }),
      ],
      ['su-l1', 'su-l2'],
    );
    const groups = section(model, 'plan').groups;
    expect(groups).toHaveLength(2);
    for (const g of groups) {
      expect(g.members).toHaveLength(1);
      expect(g.members[0]!.fleetSlug).toBe(g.lead.fleetSlug);
    }
  });

  it('still renders a LEADERLESS fleet, promoting a member into the lead slot', () => {
    // Hiding it would hide the state most worth seeing. The promoted row keeps
    // isLead:false so the glyph does not claim a leadership nobody holds.
    const model = derive(
      [
        entry({ ownerId: 'su-m1', fleetSlug: 'f1', fleetRole: 'member' }),
        entry({ ownerId: 'su-m2', fleetSlug: 'f1', fleetRole: 'member' }),
      ],
      ['su-m1'],
    );
    const g = section(model, 'plan').groups[0]!;
    expect(g.lead.isLead).toBe(false);
    expect(g.lead.ownerId).toBeTruthy();
    expect(1 + g.members.length).toBe(2);
  });
});

describe('classifyGoalSession', () => {
  it('reads drain and grade off the standing MODES', () => {
    expect(classifyGoalSession(entry({ modes: [{ mode: 'drain' }] }))).toBe('drain');
    expect(classifyGoalSession(entry({ modes: [{ mode: 'grade' }] }))).toBe('grade');
  });

  it('tolerates the bare-string mode form an older payload sends', () => {
    expect(classifyGoalSession(entry({ modes: ['drain'] }))).toBe('drain');
  });

  it('reads TESTING off the role, because there is no testing MODE', () => {
    // Asymmetric on purpose — see the classifier's docblock. A future reader
    // "fixing" this by inventing a testing mode would break it silently, since
    // nothing sets one.
    expect(classifyGoalSession(entry({ role: 'validator' }))).toBe('testing');
    expect(classifyGoalSession(entry({ role: 'test-agent' }))).toBe('testing');
  });

  it('treats a fleet or a plan binding as PLAN, and a bare session as MISC', () => {
    expect(classifyGoalSession(entry({ fleetSlug: 'f1' }))).toBe('plan');
    expect(classifyGoalSession(entry({ currentPlanSlug: 'some-plan' }))).toBe('plan');
    expect(classifyGoalSession(entry())).toBe('misc');
  });

  it('lets a drain fleet stay DRAIN even though it also has a fleet', () => {
    // Mode wins over the plan/fleet fallback, or every fleet would read as Plan.
    expect(classifyGoalSession(entry({ modes: [{ mode: 'drain' }], fleetSlug: 'f1' }))).toBe('drain');
  });

  it('classifies a GROUP by its lead, so a fleet is never split across sections', () => {
    const model = derive(
      [
        entry({ ownerId: 'su-lead', fleetSlug: 'f1', fleetRole: 'leader', modes: [{ mode: 'drain' }] }),
        entry({ ownerId: 'su-m1', fleetSlug: 'f1', fleetRole: 'member' }),
      ],
      ['su-lead'],
    );
    expect(section(model, 'drain').count).toBe(2);
    expect(section(model, 'plan').count).toBe(0);
  });
});

describe('deriveGoalSessions — sections and terminal sessions', () => {
  it('always returns all five sections, in order, even with no sessions at all', () => {
    // The five types ARE the coverage model: a missing drain fleet is a finding,
    // so "no drain fleet" must stay distinguishable from "no drain section".
    const model = derive([], []);
    expect(model.sections.map((s) => s.id)).toEqual([...GOAL_SESSION_SECTIONS]);
    expect(model.empty).toBe(true);
    for (const s of model.sections) {
      expect(s.count).toBe(0);
      expect(s.emptyLine.length).toBeGreaterThan(0);
    }
  });

  it('KEEPS an ended session rather than dropping it, and sinks it below live peers', () => {
    // A finished test agent is evidence the testing happened; dropping it would
    // leave the pane showing only the present tense.
    const model = derive(
      [
        entry({ ownerId: 'su-lead', fleetSlug: 'f1', fleetRole: 'leader' }),
        entry({ ownerId: 'su-dead', fleetSlug: 'f1', fleetRole: 'member', sessionState: 'ended' }),
        entry({ ownerId: 'su-live', fleetSlug: 'f1', fleetRole: 'member' }),
      ],
      ['su-lead'],
    );
    const g = section(model, 'plan').groups[0]!;
    expect(g.members.map((m) => m.ownerId)).toEqual(['su-live', 'su-dead']);
    expect(g.members[1]!.ended).toBe(true);
  });

  it('caps how many ended rows a group keeps so the dead cannot bury the living', () => {
    const dead = Array.from({ length: 6 }, (_, i) =>
      entry({ ownerId: `su-d${i}`, fleetSlug: 'f1', fleetRole: 'member', sessionState: 'ended' }),
    );
    const model = deriveGoalSessions(
      [entry({ ownerId: 'su-lead', fleetSlug: 'f1', fleetRole: 'leader' }), ...dead],
      ['su-lead'],
      { nowMs: NOW, endedCap: 2 },
    );
    const g = section(model, 'plan').groups[0]!;
    expect(g.members.filter((m) => m.ended)).toHaveLength(2);
  });

  it('does not read a MISSING sessionState as ended', () => {
    // Absent means "not known to be ended", never "ended" — an older payload
    // carries no sessionState and must not render as a wall of corpses.
    const model = derive([entry({ ownerId: 'su-a', sessionState: undefined })], ['su-a']);
    expect(section(model, 'misc').groups[0]!.lead.ended).toBe(false);
  });
});
