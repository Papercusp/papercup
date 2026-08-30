import { describe, expect, it, vi } from 'vitest';
import { DARK_FLAGS, FLAGS, FLAG_DEFAULTS } from '@papercusp/flags';

import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';
import { GOAL_HOLDER_PRODUCTIVITY_GRACE_MS } from '../goals/activity';
import {
  GOAL_LIVENESS_GRACE_MS,
  classifyGoalLiveness,
  classifyGoalReadiness,
  classifyGoalWedge,
  goalEligibleForHolderRespawn,
  goalHolderRespawnKey,
  goalReadinessKey,
  holderCountsAsAlive,
  makeReadHolderProductivity,
  runGoalHolderRespawnOnce,
  runGoalLivenessSweepOnce,
  scanGoalLiveness,
  type GoalHolderRespawnDeps,
  type GoalHolderLike,
  type GoalLiveHold,
  type GoalLivenessAlert,
  type GoalReadinessAlert,
  type GoalRowLike,
  type GoalWedgeAlert,
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

  /**
   * P-005 / D-009 — the falsifier for the paused exemption.
   *
   * Identical inputs to the test above (dead holder, five days dark) with ONE
   * field changed: the goal is deliberately paused. A pause disarms exactly
   * these sessions' loops, so the dead holder is the EXPECTED consequence of
   * the hold, not evidence of abandonment. Alarming here would report a stop as
   * a crash — the failure `isAdministrativelyPaused` already prevents one layer
   * down, and the reason P-005 has to land before P-004's deactivation.
   */
  it('stays silent on a DELIBERATELY PAUSED goal, however dead its holders', () => {
    const alert = classifyGoalLiveness(
      goal({ status: 'paused' }),
      [holder()],
      vmap(verdict('su-2c130be1', 'ended')),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('stays silent on a goal that is already over (achieved / killed)', () => {
    for (const status of ['achieved', 'killed']) {
      expect(
        classifyGoalLiveness(goal({ status }), [holder()], vmap(verdict('su-2c130be1', 'ended')), NOW),
      ).toBeNull();
    }
  });

  it('an ACTIVE status changes nothing — the exemption is not accidentally universal', () => {
    const alert = classifyGoalLiveness(
      goal({ status: 'active' }),
      [holder()],
      vmap(verdict('su-2c130be1', 'ended')),
      NOW,
    );
    expect(alert?.reason).toBe('abandoned');
  });

  it('reports a goal with no holder row at all as unheld, not abandoned', () => {
    const alert = classifyGoalLiveness(goal(), [], new Map(), NOW);
    expect(alert?.reason).toBe('unheld');
    expect(alert?.holders).toEqual([]);
  });

  it('stays silent while the elected holder is alive', () => {
    const alert = classifyGoalLiveness(
      goal(),
      [
        holder({ ownerId: 'dead', goalLeaseEpoch: 1 }),
        holder({ ownerId: 'alive', goalLeaseEpoch: 2 }),
      ],
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
      [
        holder({ ownerId: 'dead', goalLeaseEpoch: 1 }),
        holder({ ownerId: 'unknown', goalLeaseEpoch: 2 }),
      ],
      vmap(verdict('dead', 'ended')),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('allows the elected successor and named predecessor inside the handoff window', () => {
    const alert = classifyGoalLiveness(
      goal(),
      [
        holder({ ownerId: 'old', goalLeaseEpoch: 1 }),
        holder({
          ownerId: 'new',
          goalLeaseEpoch: 2,
          goalHandoffFromOwnerId: 'old',
          goalHandoffExpiresAtMs: NOW + 60_000,
        }),
      ],
      vmap(verdict('old', 'live'), verdict('new', 'live')),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('reports live holder overlap immediately after the elected handoff expires', () => {
    const alert = classifyGoalLiveness(
      goal(),
      [
        holder({ ownerId: 'old', goalLeaseEpoch: 1 }),
        holder({
          ownerId: 'new',
          goalLeaseEpoch: 2,
          goalHandoffFromOwnerId: 'old',
          goalHandoffExpiresAtMs: NOW - 5_000,
        }),
      ],
      vmap(verdict('old', 'live'), verdict('new', 'live')),
      NOW,
    );
    expect(alert).toMatchObject({
      reason: 'overlap',
      darkMs: 5_000,
      holders: [
        { ownerId: 'old', sessionState: 'live' },
        { ownerId: 'new', sessionState: 'live' },
      ],
    });
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
    expect(r).toEqual({
      scanned: 1,
      escalated: 1,
      readinessEscalated: 0,
      autoStarted: 0,
      wedgeEscalated: 0,
      skipped: false,
    });
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
    expect(r).toEqual({
      scanned: 0,
      escalated: 0,
      readinessEscalated: 0,
      autoStarted: 0,
      wedgeEscalated: 0,
      skipped: true,
    });
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

// ── goal-dag-shared-substrate-2026-08-18 P-005: the readiness leg ──────────
type BlockerView = GoalReadiness['blockers'][number];
const bv = (over: Partial<BlockerView> = {}): BlockerView => ({
  kind: 'goal',
  ref: 'prereq-goal-aa11bb',
  status: 'achieved',
  verdict: 'satisfied',
  ...over,
});
const ready = (blockers: BlockerView[]): GoalReadiness => ({
  actionable: blockers.every((b) => b.verdict === 'satisfied'),
  premiseInvalidated: blockers.some((b) => b.verdict === 'invalidating'),
  blockers,
});

describe('classifyGoalReadiness (P-005)', () => {
  it('offers a BECAME-READY goal: all blockers satisfied, nobody on it', () => {
    const alert = classifyGoalReadiness(goal(), ready([bv()]), 'unheld');
    expect(alert?.kind).toBe('became-ready');
    expect(alert?.blockers).toHaveLength(1);
    // A lost (dead-holder) goal is just as unattended as an unheld one.
    expect(classifyGoalReadiness(goal(), ready([bv()]), 'lost')?.kind).toBe('became-ready');
  });

  it('never offers a goal somebody is ALIVE on — held means no offer needed', () => {
    expect(classifyGoalReadiness(goal(), ready([bv()]), 'held')).toBeNull();
  });

  it("suppresses the offer on UNKNOWN holder liveness — the liveness leg's conservative rule", () => {
    expect(classifyGoalReadiness(goal(), ready([bv()]), 'unknown')).toBeNull();
  });

  it('stays silent on a goal with NO edges — a plain goal was always startable', () => {
    expect(classifyGoalReadiness(goal(), undefined, 'unheld')).toBeNull();
    expect(classifyGoalReadiness(goal(), ready([]), 'unheld')).toBeNull();
  });

  it('offers an edge-less goal only when it explicitly opts into autoStart', () => {
    const g = goal({ launchSettings: { autoStart: true } });
    expect(classifyGoalReadiness(g, ready([]), 'unheld')).toMatchObject({
      kind: 'became-ready',
      blockers: [],
    });
    expect(classifyGoalReadiness(g, ready([]), 'lost')?.kind).toBe('became-ready');
  });

  it('stays silent while a blocker is merely PENDING — waiting is the intended state', () => {
    expect(
      classifyGoalReadiness(goal(), ready([bv({ status: 'active', verdict: 'pending' })]), 'unheld'),
    ).toBeNull();
  });

  it('flags PREMISE-INVALIDATED on a killed blocker, naming only the invalidating ones', () => {
    const alert = classifyGoalReadiness(
      goal(),
      ready([bv(), bv({ ref: 'dead-goal-ff00aa', status: 'killed', verdict: 'invalidating' })]),
      'unheld',
    );
    expect(alert?.kind).toBe('premise-invalidated');
    expect(alert?.blockers.map((b) => b.ref)).toEqual(['dead-goal-ff00aa']);
  });

  it('premise-invalidated fires EVEN WHEN held — a live holder needs the review too', () => {
    const alert = classifyGoalReadiness(
      goal(),
      ready([bv({ ref: 'dead-goal-ff00aa', status: 'killed', verdict: 'invalidating' })]),
      'held',
    );
    expect(alert?.kind).toBe('premise-invalidated');
  });
});

describe('runGoalLivenessSweepOnce — the readiness leg (P-005)', () => {
  const sql = {} as never;
  const base = (over: Record<string, unknown> = {}) => ({
    // Holder dead but INSIDE the grace window: the liveness leg stays silent,
    // so anything escalated here is the readiness leg's own doing.
    readGoals: async () => ({
      goals: [goal({ updatedAtMs: NOW - 60_000 })],
      holders: [],
    }),
    resolveLiveness: async () => new Map(),
    escalate: async () => {},
    flagEnabled: async () => true,
    now: () => NOW,
    graceMs: GOAL_LIVENESS_GRACE_MS,
    ...over,
  });

  it('escalates a became-ready goal through the readiness surface', async () => {
    const seen: GoalReadinessAlert[] = [];
    const g = goal({ updatedAtMs: NOW - 60_000 });
    const r = await runGoalLivenessSweepOnce(sql, {
      ...base(),
      readReadiness: async () => new Map([[goalReadinessKey(g), ready([bv()])]]),
      escalateReadiness: async (a) => {
        seen.push(a);
      },
    });
    expect(r.readinessEscalated).toBe(1);
    expect(r.escalated).toBe(0); // the liveness leg had nothing to say
    expect(seen[0]?.kind).toBe('became-ready');
  });

  it('a readiness-escalation failure is contained and reported, never fatal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = goal({ updatedAtMs: NOW - 60_000 });
    const r = await runGoalLivenessSweepOnce(sql, {
      ...base(),
      readReadiness: async () => new Map([[goalReadinessKey(g), ready([bv()])]]),
      escalateReadiness: async () => {
        throw new Error('escalation surface down');
      },
    });
    expect(r.readinessEscalated).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('readiness escalate failed');
    warn.mockRestore();
  });

  it('an empty readiness map escalates nothing — ordinary edge-less goals stay quiet', async () => {
    const r = await runGoalLivenessSweepOnce(sql, {
      ...base(),
      readReadiness: async () => new Map(),
      escalateReadiness: async () => {
        throw new Error('must not be called');
      },
    });
    expect(r.readinessEscalated).toBe(0);
  });

  it('default readiness synthesizes [] for autoStart and leaves a plain no-edge goal quiet', async () => {
    const auto = goal({
      goalId: 'auto-start-no-edges',
      updatedAtMs: NOW - 60_000,
      launchSettings: { autoStart: true },
    });
    const plain = goal({
      goalId: 'plain-no-edges',
      updatedAtMs: NOW - 60_000,
    });
    // The default reader only needs an empty edge query for this regression.
    const sql = vi.fn(async () => []) as never;
    const startGoal = vi.fn(async () => ({
      ok: true as const,
      goalId: auto.goalId,
      ownerId: 'su-auto-held-no-edge',
      warnings: [],
      startBlockedOverride: null,
    }));
    const escalateReadiness = vi.fn(async () => {});
    const r = await runGoalLivenessSweepOnce(sql, {
      readGoals: async () => ({ goals: [auto, plain], holders: [] }),
      resolveLiveness: async () => new Map(),
      escalate: async () => {},
      escalateReadiness,
      startGoal,
      flagEnabled: async () => true,
      now: () => NOW,
      graceMs: GOAL_LIVENESS_GRACE_MS,
    });

    expect(r.autoStarted).toBe(1);
    expect(r.readinessEscalated).toBe(0);
    expect(startGoal).toHaveBeenCalledWith({
      workspaceId: auto.workspaceId,
      goalId: auto.goalId,
      launcherOwnerId: 'goal-liveness-watchdog:auto-start',
    });
    expect(escalateReadiness).not.toHaveBeenCalled();
  });
});

// ── work-on-everything-goal-2026-08-23 P-020: the autoStart leg ────────────

describe('runGoalLivenessSweepOnce — the autoStart leg (P-020)', () => {
  const sql = {} as never;
  const autoGoal = (over: Partial<GoalRowLike> = {}) =>
    goal({ updatedAtMs: NOW - 60_000, launchSettings: { autoStart: true }, ...over });
  const base = (g: GoalRowLike, over: Record<string, unknown> = {}) => ({
    readGoals: async () => ({ goals: [g], holders: [] }),
    resolveLiveness: async () => new Map(),
    escalate: async () => {},
    readReadiness: async () => new Map([[goalReadinessKey(g), ready([bv()])]]),
    flagEnabled: async () => true,
    now: () => NOW,
    graceMs: GOAL_LIVENESS_GRACE_MS,
    ...over,
  });

  it('dispatches a became-ready autoStart goal through the primitive and suppresses the offer', async () => {
    const g = autoGoal();
    const startGoal = vi.fn(async () => ({
      ok: true as const,
      goalId: g.goalId,
      ownerId: 'su-auto-held-1',
      warnings: [],
      startBlockedOverride: null,
    }));
    const r = await runGoalLivenessSweepOnce(sql, {
      ...base(g),
      startGoal,
      escalateReadiness: async () => {
        throw new Error('the offer must be suppressed after a successful dispatch');
      },
    });
    expect(r.autoStarted).toBe(1);
    expect(r.readinessEscalated).toBe(0);
    expect(startGoal).toHaveBeenCalledWith({
      workspaceId: g.workspaceId,
      goalId: g.goalId,
      launcherOwnerId: 'goal-liveness-watchdog:auto-start',
    });
  });

  it('a primitive refusal falls through to the offer, carrying WHY the dispatch declined', async () => {
    const g = autoGoal();
    const seen: GoalReadinessAlert[] = [];
    const r = await runGoalLivenessSweepOnce(sql, {
      ...base(g),
      startGoal: vi.fn(async () => ({
        ok: false as const,
        reason: 'already-held' as never,
        detail: 'live holder su-elsewhere',
      })),
      escalateReadiness: async (a) => {
        seen.push(a);
      },
    });
    expect(r.autoStarted).toBe(0);
    expect(r.readinessEscalated).toBe(1);
    expect(seen[0]?.autoStartFailure).toBe('refused: already-held — live holder su-elsewhere');
  });

  it('a thrown launch failure is contained: the offer still surfaces, naming the throw', async () => {
    const g = autoGoal();
    const seen: GoalReadinessAlert[] = [];
    const r = await runGoalLivenessSweepOnce(sql, {
      ...base(g),
      startGoal: vi.fn(async () => {
        throw new Error('spawn infra down');
      }),
      escalateReadiness: async (a) => {
        seen.push(a);
      },
    });
    expect(r.autoStarted).toBe(0);
    expect(r.readinessEscalated).toBe(1);
    expect(seen[0]?.autoStartFailure).toBe('launch threw: spawn infra down');
  });

  it('without the opt-in the offer stays an offer — no dispatch (D-003 preserved)', async () => {
    const g = goal({ updatedAtMs: NOW - 60_000 }); // no launchSettings at all
    const startGoal = vi.fn();
    const seen: GoalReadinessAlert[] = [];
    const r = await runGoalLivenessSweepOnce(sql, {
      ...base(g),
      startGoal,
      escalateReadiness: async (a) => {
        seen.push(a);
      },
    });
    expect(startGoal).not.toHaveBeenCalled();
    expect(r.autoStarted).toBe(0);
    expect(seen[0]?.kind).toBe('became-ready');
    expect(seen[0]?.autoStartFailure).toBeUndefined();
  });

  it('premise-invalidated NEVER auto-starts, opt-in or not — a killed blocker needs review (D-002)', async () => {
    const g = autoGoal();
    const startGoal = vi.fn();
    const seen: GoalReadinessAlert[] = [];
    const r = await runGoalLivenessSweepOnce(sql, {
      ...base(g, {
        readReadiness: async () =>
          new Map([
            [
              goalReadinessKey(g),
              ready([bv({ ref: 'dead-goal-ff00aa', status: 'killed', verdict: 'invalidating' })]),
            ],
          ]),
      }),
      startGoal,
      escalateReadiness: async (a) => {
        seen.push(a);
      },
    });
    expect(startGoal).not.toHaveBeenCalled();
    expect(r.autoStarted).toBe(0);
    expect(seen[0]?.kind).toBe('premise-invalidated');
  });
});

// ── goal-live-holder-guarantee-2026-08-18 P-009: bounded recovery ──────────

function respawnGoal(overrides: Partial<GoalRowLike> = {}): GoalRowLike {
  return goal({
    status: 'active',
    installSlug: 'papercusp',
    launchSettings: { holder: { requireLive: true, onLoss: 'respawn' } },
    ...overrides,
  });
}

function respawnDeps(overrides: Partial<GoalHolderRespawnDeps> = {}): GoalHolderRespawnDeps {
  const target = respawnGoal();
  return {
    readGoals: async () => ({ goals: [target], holders: [holder()] }),
    resolveLiveness: async () => vmap(verdict('su-2c130be1', 'ended')),
    flagEnabled: async () => true,
    launch: async (g) => ({ ownerId: `replacement-${g.goalId}`, warnings: [] }),
    attach: async () => {},
    refreshControlAnchor: vi.fn().mockResolvedValue(null),
    escalateGiveUp: async () => {},
    now: () => NOW,
    states: new Map(),
    ...overrides,
  };
}

describe('goal holder respawn eligibility (P-009)', () => {
  it('requires an ACTIVE goal that explicitly earns respawn', () => {
    expect(goalEligibleForHolderRespawn(respawnGoal())).toBe(true);
    // requireLive inherits true, but onLoss never inherits respawn.
    expect(goalEligibleForHolderRespawn(respawnGoal({ launchSettings: { holder: { onLoss: 'respawn' } } }))).toBe(true);

    expect(goalEligibleForHolderRespawn(goal({ status: 'active' }))).toBe(false);
    expect(goalEligibleForHolderRespawn(respawnGoal({ launchSettings: { holder: { onLoss: 'deactivate' } } }))).toBe(
      false,
    );
    expect(
      goalEligibleForHolderRespawn(
        respawnGoal({
          launchSettings: { holder: { requireLive: false, onLoss: 'respawn' } },
        }),
      ),
    ).toBe(false);
  });

  it('never respawns a paused or terminal goal', () => {
    for (const status of ['paused', 'achieved', 'killed']) {
      expect(goalEligibleForHolderRespawn(respawnGoal({ status }))).toBe(false);
    }
  });

  it('pins the recovery flag as a separate owner-authority dark flag', () => {
    expect(FLAGS.GOAL_HOLDER_RESPAWN).toBe('papercusp-goal-holder-respawn');
    expect(FLAG_DEFAULTS[FLAGS.GOAL_HOLDER_RESPAWN]).toBe(false);
    expect(DARK_FLAGS.get(FLAGS.GOAL_HOLDER_RESPAWN)?.case).toBe('owner-authority');
  });
});

describe('runGoalHolderRespawnOnce (P-009)', () => {
  const sql = {} as never;

  it('launches first and attaches the returned identity for a lost holder', async () => {
    const target = respawnGoal();
    const operations: string[] = [];
    const refreshControlAnchor = vi.fn().mockResolvedValue(null);
    const result = await runGoalHolderRespawnOnce(
      sql,
      respawnDeps({
        readGoals: async () => ({ goals: [target], holders: [holder()] }),
        launch: async () => {
          operations.push('launch');
          return { ownerId: 'su-replacement', warnings: [] };
        },
        attach: async (g, ownerId) => {
          operations.push(`attach:${g.goalId}:${ownerId}`);
        },
        refreshControlAnchor,
      }),
    );

    expect(operations).toEqual(['launch', `attach:${target.goalId}:su-replacement`]);
    expect(refreshControlAnchor).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'su-replacement',
        workspaceId: target.workspaceId,
        origin: 'system',
        actorId: 'goal-holder-respawner',
        source: 'mode:set',
        ownerDirected: false,
        sql,
      }),
    );
    expect(result).toEqual({
      scanned: 1,
      eligible: 1,
      attempted: 1,
      respawned: 1,
      launchFailed: 0,
      attachFailed: 0,
      gaveUp: 0,
      skipped: false,
    });
  });

  it('does no read or launch when its independent flag is off', async () => {
    const readGoals = vi.fn(async () => ({ goals: [], holders: [] }));
    const launch = vi.fn(async () => ({ ownerId: 'must-not-launch', warnings: [] }));
    const result = await runGoalHolderRespawnOnce(
      sql,
      respawnDeps({
        flagEnabled: async () => false,
        readGoals,
        launch,
      }),
    );

    expect(result.skipped).toBe(true);
    expect(readGoals).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('does not auto-start a never-started unheld goal or infer loss from unknown liveness', async () => {
    const unheld = respawnGoal({ goalId: 'unheld' });
    const unknown = respawnGoal({ goalId: 'unknown' });
    const launch = vi.fn(async () => ({ ownerId: 'must-not-launch', warnings: [] }));
    const result = await runGoalHolderRespawnOnce(
      sql,
      respawnDeps({
        readGoals: async () => ({
          goals: [unheld, unknown],
          holders: [holder({ goalId: unknown.goalId, ownerId: 'unresolved-holder' })],
        }),
        resolveLiveness: async () => new Map(),
        launch,
      }),
    );

    expect(result).toMatchObject({ scanned: 2, eligible: 2, attempted: 0, respawned: 0 });
    expect(launch).not.toHaveBeenCalled();
  });

  it('recovers a started goal whose durable GOAL-mode row was lost', async () => {
    const target = respawnGoal({
      goalId: 'started-but-row-lost',
      startedHolderOwnerId: 'su-former-holder',
    });
    const launch = vi.fn(async () => ({ ownerId: 'su-replacement', warnings: [] }));
    const attach = vi.fn(async () => {});

    const result = await runGoalHolderRespawnOnce(
      sql,
      respawnDeps({
        readGoals: async () => ({ goals: [target], holders: [] }),
        resolveLiveness: vi.fn(async () => new Map()),
        launch,
        attach,
      }),
    );

    expect(result).toMatchObject({ scanned: 1, eligible: 1, attempted: 1, respawned: 1 });
    expect(launch).toHaveBeenCalledWith(target);
    expect(attach).toHaveBeenCalledWith(target, 'su-replacement');
  });

  it('never attaches a phantom holder when launch fails', async () => {
    const attach = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const states: GoalHolderRespawnDeps['states'] = new Map();
    const target = respawnGoal();
    try {
      const result = await runGoalHolderRespawnOnce(
        sql,
        respawnDeps({
          states,
          readGoals: async () => ({ goals: [target], holders: [holder()] }),
          launch: async () => {
            throw new Error('launcher refused');
          },
          attach,
        }),
      );

      expect(result).toMatchObject({ attempted: 1, launchFailed: 1, attachFailed: 0, respawned: 0 });
      expect(attach).not.toHaveBeenCalled();
      expect(warn.mock.calls[0]?.[0]).toContain('launch failed');
      const state = states.get(goalHolderRespawnKey(target));
      expect(state?.restarts).toEqual([]);
      expect(state?.lastRestartAt).toBeNull();
      expect(state?.lastAttemptAt).not.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('contains one attach failure and continues recovering the rest of the batch', async () => {
    const a = respawnGoal({ goalId: 'goal-a' });
    const b = respawnGoal({ goalId: 'goal-b' });
    const attached: string[] = [];
    const states: GoalHolderRespawnDeps['states'] = new Map();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await runGoalHolderRespawnOnce(
        sql,
        respawnDeps({
          readGoals: async () => ({
            goals: [a, b],
            holders: [holder({ goalId: a.goalId, ownerId: 'dead-a' }), holder({ goalId: b.goalId, ownerId: 'dead-b' })],
          }),
          states,
          resolveLiveness: async (ownerIds) => vmap(...ownerIds.map((ownerId) => verdict(ownerId, 'ended'))),
          launch: async (g) => ({ ownerId: `replacement-${g.goalId}`, warnings: [] }),
          attach: async (g) => {
            attached.push(g.goalId);
            if (g.goalId === a.goalId) throw new Error('mode store unavailable');
          },
        }),
      );

      expect(attached).toEqual(['goal-a', 'goal-b']);
      expect(result).toMatchObject({ attempted: 2, respawned: 1, attachFailed: 1 });
      expect(warn.mock.calls[0]?.[0]).toContain('attach failed for goal-a');
      expect(states.get(goalHolderRespawnKey(a))?.restarts).toEqual([]);
      expect(states.get(goalHolderRespawnKey(a))?.lastRestartAt).toBeNull();
      expect(states.get(goalHolderRespawnKey(b))?.restarts).toHaveLength(1);
      expect(states.get(goalHolderRespawnKey(b))?.lastRestartAt).not.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('uses shared backoff, gives up after six attempts, and latches the escalation', async () => {
    const states: GoalHolderRespawnDeps['states'] = new Map();
    let nowMs = 0;
    const launch = vi.fn(async () => ({ ownerId: 'replacement', warnings: [] }));
    const attach = vi.fn(async () => {});
    const escalateGiveUp = vi.fn(async () => {});
    const deps = respawnDeps({ states, now: () => nowMs, launch, attach, escalateGiveUp });

    for (const attemptAt of [0, 1_000, 6_000, 21_000, 81_000, 141_000]) {
      nowMs = attemptAt;
      const result = await runGoalHolderRespawnOnce(sql, deps);
      expect(result.attempted).toBe(1);
    }
    nowMs = 201_000;
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ attempted: 0, gaveUp: 1 });
    nowMs = 261_000;
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ attempted: 0, gaveUp: 0 });

    expect(launch).toHaveBeenCalledTimes(6);
    expect(attach).toHaveBeenCalledTimes(6);
    expect(escalateGiveUp).toHaveBeenCalledOnce();
    expect(escalateGiveUp).toHaveBeenCalledWith(expect.anything(), 6);
  });

  it('retries a failed give-up escalation instead of silently keeping its latch', async () => {
    const target = respawnGoal();
    const key = goalHolderRespawnKey(target);
    const states: GoalHolderRespawnDeps['states'] = new Map([
      [
        key,
        {
          restarts: [1, 2, 3, 4, 5, 6],
          backoffIndex: 3,
          lastAttemptAt: 6,
          lastRestartAt: 6,
          healthySince: null,
          gaveUp: false,
        },
      ],
    ]);
    let escalationCalls = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = respawnDeps({
      readGoals: async () => ({ goals: [target], holders: [holder()] }),
      states,
      now: () => 60_006,
      escalateGiveUp: async () => {
        escalationCalls += 1;
        if (escalationCalls === 1) throw new Error('escalation store unavailable');
      },
    });
    try {
      expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ gaveUp: 0 });
      expect(states.get(key)?.gaveUp).toBe(false);
      expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ gaveUp: 1 });
      expect(states.get(key)?.gaveUp).toBe(true);
      expect(escalationCalls).toBe(2);
      expect(warn.mock.calls[0]?.[0]).toContain('give-up escalation failed');
    } finally {
      warn.mockRestore();
    }
  });

  it('clears give-up only after five continuous healthy minutes, then may recover again', async () => {
    const target = respawnGoal();
    const key = goalHolderRespawnKey(target);
    const states: GoalHolderRespawnDeps['states'] = new Map([
      [
        key,
        {
          restarts: [1, 2, 3, 4, 5, 6],
          backoffIndex: 3,
          lastAttemptAt: 6,
          lastRestartAt: 6,
          healthySince: null,
          gaveUp: true,
        },
      ],
    ]);
    let nowMs = 1_000;
    let holderState: SessionState = 'live';
    const launch = vi.fn(async () => ({ ownerId: 'replacement', warnings: [] }));
    const deps = respawnDeps({
      readGoals: async () => ({ goals: [target], holders: [holder()] }),
      resolveLiveness: async () => vmap(verdict('su-2c130be1', holderState)),
      states,
      now: () => nowMs,
      launch,
    });

    await runGoalHolderRespawnOnce(sql, deps);
    expect(states.get(key)?.gaveUp).toBe(true);
    nowMs += 5 * 60_000;
    await runGoalHolderRespawnOnce(sql, deps);
    expect(states.get(key)).toMatchObject({
      gaveUp: false,
      restarts: [],
      backoffIndex: 0,
      lastRestartAt: null,
    });

    holderState = 'ended';
    nowMs += 1;
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ attempted: 1, respawned: 1 });
    expect(launch).toHaveBeenCalledOnce();
  });
});

/* ── the wedge leg: held, alive, and producing nothing ────────────────────── */

describe('classifyGoalWedge', () => {
  const GOAL_ID = 'make-sidestage-web-ios-and-android-ready-for-pub-dd62af';
  const KEY = `papercusp-workspace:${GOAL_ID}`;
  const HELD_LONG_ENOUGH = NOW - (GOAL_HOLDER_PRODUCTIVITY_GRACE_MS + 60_000);
  const live = vmap(verdict('su-2c130be1', 'live'));

  it('reports a live holder that has produced nothing past the grace', () => {
    const alert = classifyGoalWedge(
      goal(),
      [holder({ setAtMs: HELD_LONG_ENOUGH })],
      live,
      new Map([[KEY, 0]]),
      NOW,
    );
    expect(alert).toMatchObject({
      goalId: GOAL_ID,
      agentOriginCalls: 0,
      holders: [{ ownerId: 'su-2c130be1', sessionState: 'live' }],
    });
  });

  it('stays silent when the holder HAS produced agent-origin work', () => {
    const alert = classifyGoalWedge(
      goal(),
      [holder({ setAtMs: HELD_LONG_ENOUGH })],
      live,
      new Map([[KEY, 1]]),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('stays silent inside the grace window', () => {
    const alert = classifyGoalWedge(
      goal(),
      [holder({ setAtMs: NOW - 60_000 })],
      live,
      new Map([[KEY, 0]]),
      NOW,
    );
    expect(alert).toBeNull();
  });

  // The distinction the whole leg turns on: an ABSENT measurement is not a
  // passing one. A degraded read must report nothing, not everyone wedged.
  it('stays silent when productivity was NOT MEASURED (absent key, not zero)', () => {
    const alert = classifyGoalWedge(
      goal(),
      [holder({ setAtMs: HELD_LONG_ENOUGH })],
      live,
      new Map(),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('only asks the question of a HELD goal — a dead or absent holder is the liveness leg', () => {
    const dead = vmap(verdict('su-2c130be1', 'ended'));
    expect(
      classifyGoalWedge(
        goal(),
        [holder({ setAtMs: HELD_LONG_ENOUGH })],
        dead,
        new Map([[KEY, 0]]),
        NOW,
      ),
    ).toBeNull();
    // unheld: no holder rows at all
    expect(classifyGoalWedge(goal(), [], live, new Map([[KEY, 0]]), NOW)).toBeNull();
    // unknown: the oracle returned no verdict, which is not evidence of anything
    expect(
      classifyGoalWedge(
        goal(),
        [holder({ setAtMs: HELD_LONG_ENOUGH })],
        new Map(),
        new Map([[KEY, 0]]),
        NOW,
      ),
    ).toBeNull();
  });

  it('exempts a deliberately paused goal — it produces nothing BY DESIGN', () => {
    const alert = classifyGoalWedge(
      goal({ status: 'paused' }),
      [holder({ setAtMs: HELD_LONG_ENOUGH })],
      live,
      new Map([[KEY, 0]]),
      NOW,
    );
    expect(alert).toBeNull();
  });

  // Conservative pairing: calls counted since the EARLIEST hold, grace measured
  // from the MOST RECENT one — so a fresh holder re-arms the window rather than
  // inheriting a predecessor's silence.
  it('re-arms the grace from the MOST RECENT hold when a second holder joins', () => {
    const holders = [
      holder({ ownerId: 'su-old', setAtMs: HELD_LONG_ENOUGH }),
      holder({ ownerId: 'su-new', setAtMs: NOW - 60_000 }),
    ];
    const verdicts = vmap(verdict('su-old', 'live'), verdict('su-new', 'live'));
    expect(classifyGoalWedge(goal(), holders, verdicts, new Map([[KEY, 0]]), NOW)).toBeNull();
  });
});

describe('the wedge leg inside runGoalLivenessSweepOnce', () => {
  const GOAL_ID = 'make-sidestage-web-ios-and-android-ready-for-pub-dd62af';
  const KEY = `papercusp-workspace:${GOAL_ID}`;
  const HELD_LONG_ENOUGH = NOW - (GOAL_HOLDER_PRODUCTIVITY_GRACE_MS + 60_000);
  const sql = {} as never;

  const wedgeDeps = (over: Record<string, unknown> = {}) => ({
    readGoals: async () => ({
      goals: [goal()],
      holders: [holder({ setAtMs: HELD_LONG_ENOUGH })],
    }),
    resolveLiveness: async () => vmap(verdict('su-2c130be1', 'live')),
    escalate: async () => {},
    readReadiness: async () => new Map<string, GoalReadiness>(),
    escalateReadiness: async () => {},
    flagEnabled: async () => true,
    now: () => NOW,
    graceMs: GOAL_LIVENESS_GRACE_MS,
    ...over,
  });

  it('escalates a wedged holder and counts it', async () => {
    const seen: GoalWedgeAlert[] = [];
    const r = await runGoalLivenessSweepOnce(
      sql,
      wedgeDeps({
        readHolderProductivity: async () => new Map([[KEY, 0]]),
        escalateWedge: async (a: GoalWedgeAlert) => {
          seen.push(a);
        },
      }),
    );
    expect(r.wedgeEscalated).toBe(1);
    expect(seen[0]).toMatchObject({ goalId: GOAL_ID, agentOriginCalls: 0 });
  });

  it("passes the live holds to the measurement, with each holder's own since-clock", async () => {
    let got: readonly GoalLiveHold[] = [];
    await runGoalLivenessSweepOnce(
      sql,
      wedgeDeps({
        readHolderProductivity: async (holds: readonly GoalLiveHold[]) => {
          got = holds;
          return new Map([[KEY, 5]]);
        },
        escalateWedge: async () => {},
      }),
    );
    expect(got).toEqual([
      {
        workspaceId: 'papercusp-workspace',
        goalId: GOAL_ID,
        ownerId: 'su-2c130be1',
        setAtMs: HELD_LONG_ENOUGH,
      },
    ]);
  });

  // A degraded measurement costs SILENCE, never a wave of false wedges.
  it('survives a throwing productivity read and escalates nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const escalateWedge = vi.fn();
      const r = await runGoalLivenessSweepOnce(
        sql,
        wedgeDeps({
          readHolderProductivity: async () => {
            throw new Error('pg down');
          },
          escalateWedge,
        }),
      );
      expect(r.wedgeEscalated).toBe(0);
      expect(escalateWedge).not.toHaveBeenCalled();
      expect(r.skipped).toBe(false);
      // Degraded, not silent-degraded: the sweep says so.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('holder-productivity read failed'));
    } finally {
      warn.mockRestore();
    }
  });

  it('never measures when no goal is held — the ledger read is skipped entirely', async () => {
    const readHolderProductivity = vi.fn(async () => new Map<string, number>());
    await runGoalLivenessSweepOnce(
      sql,
      wedgeDeps({
        resolveLiveness: async () => vmap(verdict('su-2c130be1', 'ended')),
        readHolderProductivity,
        escalateWedge: async () => {},
      }),
    );
    expect(readHolderProductivity).not.toHaveBeenCalled();
  });

  it('a failing wedge escalation does not cost the sweep', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await runGoalLivenessSweepOnce(
        sql,
        wedgeDeps({
          readHolderProductivity: async () => new Map([[KEY, 0]]),
          escalateWedge: async () => {
            throw new Error('escalation store down');
          },
        }),
      );
      expect(r.wedgeEscalated).toBe(0);
      expect(r.scanned).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('wedge escalate failed'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('makeReadHolderProductivity', () => {
  function captureSql() {
    const queries: string[] = [];
    const tag = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      queries.push(strings.join(' ? '));
      void vals;
      return Promise.resolve([] as unknown[]);
    }) as unknown as Parameters<typeof makeReadHolderProductivity>[0];
    return { tag, queries };
  }

  const hold: GoalLiveHold = {
    workspaceId: 'papercusp-workspace',
    goalId: 'g1',
    ownerId: 'su-1',
    setAtMs: NOW - 60_000,
  };

  it('short-circuits on zero holds without touching the ledger', async () => {
    const { tag, queries } = captureSql();
    expect(await makeReadHolderProductivity(tag)([])).toEqual(new Map());
    expect(queries).toEqual([]);
  });

  // The load-bearing predicate. `<> 'hook'` is FALSE for a NULL origin, which
  // would drop those rows, undercount, and manufacture a FALSE WEDGE — the one
  // direction this leg must never err in.
  it('excludes hook-origin calls with IS DISTINCT FROM, never `<>`', async () => {
    const { tag, queries } = captureSql();
    await makeReadHolderProductivity(tag)([hold]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/call_origin\s+IS DISTINCT FROM\s+'hook'/);
    expect(queries[0]).not.toMatch(/call_origin\s*<>/);
  });

  it('measures each hold from its own set-at clock, not a shared floor', async () => {
    const { tag, queries } = captureSql();
    await makeReadHolderProductivity(tag)([hold]);
    expect(queries[0]).toMatch(/ti\.invoked_at\s*>=\s*h\.since/);
  });
});
