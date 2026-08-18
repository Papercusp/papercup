import { describe, expect, it, vi } from 'vitest';

import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';
import {
  GOAL_LIVENESS_GRACE_MS,
  classifyGoalLiveness,
  classifyGoalReadiness,
  goalReadinessKey,
  holderCountsAsAlive,
  runGoalLivenessSweepOnce,
  scanGoalLiveness,
  type GoalHolderLike,
  type GoalLivenessAlert,
  type GoalReadinessAlert,
  type GoalRowLike,
} from './goal-liveness-watchdog';
import type { GoalReadiness } from '@papercusp/agent-mcp/goal-deps';

const NOW = Date.parse('2026-08-16T04:00:00Z');
const LONG_AGO = NOW - 5 * 24 * 60 * 60_000; // 5 days — the measured sidestage case
const JUST_NOW = NOW - 60_000;

function goal(overrides: Partial<GoalRowLike> = {}): GoalRowLike {
  return {
    goalId: 'make-sidestage-web-ios-and-android-ready-for-pub-dd62af',
    workspaceId: 'papercusp-workspace',
    title: 'Make SideStage web, iOS, and Android ready for public release',
    updatedAtMs: LONG_AGO,
    ...overrides,
  };
}

function holder(overrides: Partial<GoalHolderLike> = {}): GoalHolderLike {
  return {
    goalId: 'make-sidestage-web-ios-and-android-ready-for-pub-dd62af',
    workspaceId: 'papercusp-workspace',
    ownerId: 'su-2c130be1',
    setAtMs: LONG_AGO,
    ...overrides,
  };
}

function verdict(
  ownerId: string,
  sessionState: SessionState,
  selfWake?: 'loop' | 'event' | 'none',
): LivenessVerdict {
  return {
    ownerId,
    sessionState,
    wakeable: sessionState !== 'ended',
    liveTurn: sessionState === 'live',
    confirmLiveness: null,
    heartbeatFresh: sessionState === 'live',
    ...(selfWake ? { selfWake, loopArmed: selfWake === 'loop' } : {}),
  };
}

const vmap = (...vs: LivenessVerdict[]) => new Map(vs.map((v) => [v.ownerId, v]));

describe('holderCountsAsAlive', () => {
  it('counts live and recorded holders as alive', () => {
    expect(holderCountsAsAlive(verdict('a', 'live'))).toBe(true);
    expect(holderCountsAsAlive(verdict('a', 'recorded'))).toBe(true);
  });

  it('counts an ended holder as dead', () => {
    expect(holderCountsAsAlive(verdict('a', 'ended'))).toBe(false);
  });

  it('counts a parked holder with a self-wake source as alive', () => {
    expect(holderCountsAsAlive(verdict('a', 'parked', 'loop'))).toBe(true);
    expect(holderCountsAsAlive(verdict('a', 'parked', 'event'))).toBe(true);
  });

  it('counts a parked holder that nothing will ever wake as dead', () => {
    // The "dead member in a healthy costume" case — parked LOOKS alive.
    expect(holderCountsAsAlive(verdict('a', 'parked', 'none'))).toBe(false);
  });

  it('treats an ABSENT self-wake leg as alive, never as none', () => {
    // The leg is opt-in and can degrade; undefined means UNKNOWN. Collapsing
    // unknown to 'none' would alarm on every parked agent whenever the self-wake
    // query failed.
    expect(holderCountsAsAlive(verdict('a', 'parked'))).toBe(true);
  });

  it('treats mid-verdict states as alive and lets the next sweep decide', () => {
    expect(holderCountsAsAlive(verdict('a', 'draining'))).toBe(true);
    expect(holderCountsAsAlive(verdict('a', 'suspect'))).toBe(true);
  });
});

describe('classifyGoalLiveness', () => {
  it('reports a goal whose only holder is dead and long past the grace window', () => {
    const alert = classifyGoalLiveness(
      goal(),
      [holder()],
      vmap(verdict('su-2c130be1', 'ended')),
      NOW,
    );
    expect(alert).not.toBeNull();
    expect(alert?.reason).toBe('abandoned');
    expect(alert?.goalId).toBe('make-sidestage-web-ios-and-android-ready-for-pub-dd62af');
    expect(alert?.holders).toEqual([{ ownerId: 'su-2c130be1', sessionState: 'ended' }]);
    expect(alert?.darkMs).toBeGreaterThan(GOAL_LIVENESS_GRACE_MS);
  });

  it('reports a goal with no holder row at all as unheld, not abandoned', () => {
    const alert = classifyGoalLiveness(goal(), [], new Map(), NOW);
    expect(alert?.reason).toBe('unheld');
    expect(alert?.holders).toEqual([]);
  });

  it('stays silent while ANY holder is alive', () => {
    const alert = classifyGoalLiveness(
      goal(),
      [holder({ ownerId: 'dead' }), holder({ ownerId: 'alive' })],
      vmap(verdict('dead', 'ended'), verdict('alive', 'live')),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('stays silent inside the grace window — a gap between sessions is not abandonment', () => {
    const alert = classifyGoalLiveness(
      goal({ updatedAtMs: JUST_NOW }),
      [holder({ setAtMs: JUST_NOW })],
      vmap(verdict('su-2c130be1', 'ended')),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('measures darkness from the MOST RECENT evidence, goal row or holder row', () => {
    // Goal row is ancient but someone took the mode recently: not dark.
    const alert = classifyGoalLiveness(
      goal({ updatedAtMs: LONG_AGO }),
      [holder({ setAtMs: JUST_NOW })],
      vmap(verdict('su-2c130be1', 'ended')),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('NEVER infers death from a missing verdict — an unresolvable holder suppresses the alert', () => {
    // resolveSessionStates omits an entry when its fetch degraded. If that read
    // as "dead", one transient DB hiccup would alarm on every goal at once.
    const alert = classifyGoalLiveness(goal(), [holder()], new Map(), NOW);
    expect(alert).toBeNull();
  });

  it('suppresses the alert when only SOME holders are unresolvable', () => {
    const alert = classifyGoalLiveness(
      goal(),
      [holder({ ownerId: 'dead' }), holder({ ownerId: 'unknown' })],
      vmap(verdict('dead', 'ended')),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('does not attribute another workspace\'s holder to this goal', () => {
    const alert = classifyGoalLiveness(
      goal(),
      [holder({ workspaceId: 'other-workspace', ownerId: 'alive' })],
      vmap(verdict('alive', 'live')),
      NOW,
    );
    // The live holder belongs to a different workspace, so this goal is unheld.
    expect(alert?.reason).toBe('unheld');
  });

  it('does not attribute a holder pointing at a different goal', () => {
    const alert = classifyGoalLiveness(
      goal(),
      [holder({ goalId: 'some-other-goal', ownerId: 'alive' })],
      vmap(verdict('alive', 'live')),
      NOW,
    );
    expect(alert?.reason).toBe('unheld');
  });
});

describe('scanGoalLiveness — the measured 2026-08-16 population', () => {
  // Reproduces the exact live state that motivated this watchdog: 6 active goals,
  // 2 with live holders, 4 dark. If this ever stops producing 4 alerts the
  // classification changed meaning.
  const goals: GoalRowLike[] = [
    goal({ goalId: 'keep-the-blender-output-loop', title: 'blender', updatedAtMs: JUST_NOW }),
    goal({ goalId: 'the-papercusp-desktop-app-is-verified', title: 'desktop', updatedAtMs: JUST_NOW }),
    goal({ goalId: 'make-sidestage', title: 'sidestage' }),
    goal({ goalId: 'the-gui-chat-surface', title: 'gui chat' }),
    goal({ goalId: 'test-84df0d', title: 'test' }),
    goal({ goalId: 'build-a-website-displaying-cute-bears', title: 'bears' }),
  ];
  const holders: GoalHolderLike[] = [
    holder({ goalId: 'keep-the-blender-output-loop', ownerId: 'su-e9d9bc18' }),
    holder({ goalId: 'the-papercusp-desktop-app-is-verified', ownerId: 'su-b9e0ec11' }),
    holder({ goalId: 'make-sidestage', ownerId: 'su-2c130be1' }),
    holder({ goalId: 'the-gui-chat-surface', ownerId: 'su-89beac53' }),
    holder({ goalId: 'test-84df0d', ownerId: 'su-e7ebadf8' }),
    holder({ goalId: 'build-a-website-displaying-cute-bears', ownerId: 'su-a8689a0b' }),
  ];
  const verdicts = vmap(
    verdict('su-e9d9bc18', 'live'),
    verdict('su-b9e0ec11', 'live'),
    verdict('su-2c130be1', 'ended'),
    verdict('su-89beac53', 'ended'),
    verdict('su-e7ebadf8', 'ended'),
    verdict('su-a8689a0b', 'ended'),
  );

  it('flags exactly the 4 dark goals and neither live one', () => {
    const alerts = scanGoalLiveness(goals, holders, verdicts, NOW);
    expect(alerts.map((a) => a.goalId).sort()).toEqual([
      'build-a-website-displaying-cute-bears',
      'make-sidestage',
      'test-84df0d',
      'the-gui-chat-surface',
    ]);
    expect(alerts.every((a) => a.reason === 'abandoned')).toBe(true);
  });

  // CALIBRATION CONTROL. The scan must be capable of returning nothing — a
  // classifier that always fires would pass the assertion above for the wrong
  // reason.
  it('returns nothing when every holder is live', () => {
    const allLive = vmap(...holders.map((h) => verdict(h.ownerId, 'live')));
    expect(scanGoalLiveness(goals, holders, allLive, NOW)).toEqual([]);
  });

  // FALSIFIABILITY CONTROL, kept permanently in the test file rather than by
  // mutating the shared tree (see CLAUDE.md § proving a guard is falsifiable).
  // This is the naive implementation the whole watchdog exists to replace: it
  // counts holder ROWS instead of resolving liveness. It reports the live state
  // as perfectly healthy — which is exactly the production bug — so if the real
  // classifier ever degrades into row-counting, the assertions above fail while
  // this one still passes, naming the regression.
  it('control: counting holder ROWS instead of resolving liveness sees nothing wrong', () => {
    const rowCountingVerdict = (g: GoalRowLike) =>
      holders.filter((h) => h.goalId === g.goalId).length > 0 ? null : 'unheld';
    expect(goals.map(rowCountingVerdict)).toEqual([null, null, null, null, null, null]);
  });
});

describe('runGoalLivenessSweepOnce', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    readGoals: async () => ({ goals: [goal()], holders: [holder()] }),
    resolveLiveness: async () => vmap(verdict('su-2c130be1', 'ended')),
    // P-005: the readiness leg is injected inert here — its own behavior has a
    // dedicated describe block below.
    readReadiness: async () => new Map<string, GoalReadiness>(),
    escalateReadiness: async () => {},
    flagEnabled: async () => true,
    now: () => NOW,
    graceMs: GOAL_LIVENESS_GRACE_MS,
    ...over,
  });
  const sql = {} as never; // never touched — every PG dep is injected

  it('escalates a dark goal', async () => {
    const seen: GoalLivenessAlert[] = [];
    const r = await runGoalLivenessSweepOnce(sql, {
      ...deps(),
      escalate: async (a) => {
        seen.push(a);
      },
    });
    expect(r).toEqual({ scanned: 1, escalated: 1, readinessEscalated: 0, skipped: false });
    expect(seen[0]?.reason).toBe('abandoned');
  });

  it('no-ops entirely when the flag is off', async () => {
    let called = false;
    const r = await runGoalLivenessSweepOnce(sql, {
      ...deps({
        flagEnabled: async () => false,
        readGoals: async () => {
          called = true;
          return { goals: [], holders: [] };
        },
      }),
      escalate: async () => {},
    });
    expect(r).toEqual({ scanned: 0, escalated: 0, readinessEscalated: 0, skipped: true });
    expect(called).toBe(false); // the kill-switch stops it BEFORE reading the DB
  });

  it('one failing escalation does not cost the rest of the batch', async () => {
    const ok: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await runGoalLivenessSweepOnce(sql, {
      ...deps({
        readGoals: async () => ({
          goals: [goal({ goalId: 'a' }), goal({ goalId: 'b' }), goal({ goalId: 'c' })],
          holders: [
            holder({ goalId: 'a', ownerId: 'x' }),
            holder({ goalId: 'b', ownerId: 'x' }),
            holder({ goalId: 'c', ownerId: 'x' }),
          ],
        }),
        resolveLiveness: async () => vmap(verdict('x', 'ended')),
      }),
      escalate: async (a: GoalLivenessAlert) => {
        if (a.goalId === 'b') throw new Error('escalation surface down');
        ok.push(a.goalId);
      },
    });
    expect(ok).toEqual(['a', 'c']);
    expect(r.escalated).toBe(2);
    // The failure is REPORTED, not swallowed silently — a sweep that quietly
    // dropped an alert would be indistinguishable from a healthy goal.
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('escalate failed for b');
    warn.mockRestore();
  });

  it('does not pay oracle cost for holders pointing at inactive goals', async () => {
    let asked: string[] = [];
    await runGoalLivenessSweepOnce(sql, {
      ...deps({
        readGoals: async () => ({
          goals: [goal({ goalId: 'active-one' })],
          holders: [
            holder({ goalId: 'active-one', ownerId: 'relevant' }),
            holder({ goalId: 'a-closed-goal', ownerId: 'irrelevant' }),
          ],
        }),
        resolveLiveness: async (ids: string[]) => {
          asked = ids;
          return vmap(verdict('relevant', 'ended'));
        },
      }),
      escalate: async () => {},
    });
    expect(asked).toEqual(['relevant']);
  });
});
