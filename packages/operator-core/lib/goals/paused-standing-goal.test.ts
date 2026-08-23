/**
 * P-002 (work-on-everything-goal-2026-08-23): a PAUSED STANDING goal starts no
 * new work and its holder agent parks — the COMPOSITION guard.
 *
 * The machinery under test shipped in `goal-live-holder-guarantee-2026-08-18`
 * and is deliberately STANDING-BLIND: every layer keys on `goals.status` alone,
 * and `GoalRowLike` does not even carry the `standing` column (migration 913),
 * so a standing goal CANNOT take a different pause path. Each layer already has
 * its own tests (stop-fanout.test.ts, goal-liveness-watchdog.test.ts,
 * activity.test.ts, pause-record.test.ts — the record round-trip lives there and
 * is not repeated here). What none of them binds is the composition for the
 * exact shape this plan ships as the bundled work-on-everything package:
 * STANDING duty + requireLive holder + onLoss:'respawn'.
 *
 * That shape is where a lost pause exemption hurts most. Pause parks the holder
 * by disarming its loop (stop-fanout tier 2); if the sweep or the respawner ever
 * stopped honouring the paused short-circuit, the watchdog would read the parked
 * holder as LOST and relaunch it — the goal would "start new work" while paused,
 * a stop rendered as a crash and then UNDONE by the recovery actor.
 *
 * Falsifiable by construction: every SURVIVES case has a CONTROL differing only
 * in `status`, so a broken exemption reddens the SURVIVES twin while its control
 * stays green — the guard cannot pass vacuously.
 */
import { describe, expect, it } from 'vitest';

import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';
import {
  classifyGoalLiveness,
  goalEligibleForHolderRespawn,
  type GoalHolderLike,
  type GoalRowLike,
} from '../system-health/goal-liveness-watchdog';
import {
  GOAL_DORMANT_STATUS,
  GOAL_LIVENESS_SWEEP_STATUSES,
  resolveGoalEffectiveActivity,
} from './activity';

const NOW = Date.parse('2026-08-23T12:00:00Z');
const FIVE_DAYS_AGO = NOW - 5 * 24 * 60 * 60_000;
const HOLDER = 'su-standing-holder';

/**
 * The work-on-everything shape: a standing duty whose holder session must stay
 * live and earns automatic respawn on loss. `GoalRowLike` carries no `standing`
 * field — that absence is load-bearing (the watchdog cannot condition on it),
 * so this fixture IS the standing goal as the sweep sees it.
 */
function standingGoal(overrides: Partial<GoalRowLike> = {}): GoalRowLike {
  return {
    goalId: 'work-on-everything-standing',
    workspaceId: 'papercusp-workspace',
    title: 'Work on everything',
    updatedAtMs: FIVE_DAYS_AGO,
    installSlug: 'papercusp',
    launchSettings: { holder: { requireLive: true, onLoss: 'respawn' } },
    ...overrides,
  };
}

function holder(overrides: Partial<GoalHolderLike> = {}): GoalHolderLike {
  return {
    goalId: 'work-on-everything-standing',
    workspaceId: 'papercusp-workspace',
    ownerId: HOLDER,
    setAtMs: FIVE_DAYS_AGO,
    ...overrides,
  };
}

function endedVerdict(ownerId: string): LivenessVerdict {
  const sessionState: SessionState = 'ended';
  return {
    ownerId,
    sessionState,
    wakeable: false,
    liveTurn: false,
    confirmLiveness: null,
    heartbeatFresh: false,
  };
}

const vmap = (...vs: LivenessVerdict[]) => new Map(vs.map((v) => [v.ownerId, v]));

describe('the sweep set a paused standing goal relies on', () => {
  it("is exactly ['active'] — paused is out, and nothing standing-conditional got in", () => {
    // The SQL sweep (goal-liveness-watchdog.ts) and the in-memory fold
    // (activity.ts) both read this one constant. A standing goal's pause
    // exemption from the respawner rests entirely on 'paused' staying out.
    expect(GOAL_LIVENESS_SWEEP_STATUSES).toEqual(['active']);
  });
});

describe('classifyGoalLiveness on the paused standing shape', () => {
  it('SURVIVES: stays silent while paused, however dead the parked holder looks', () => {
    // The pause fan-out disarmed this holder's loop, so 'ended' + 5 days dark is
    // the EXPECTED consequence of the hold — not abandonment.
    const alert = classifyGoalLiveness(
      standingGoal({ status: 'paused' }),
      [holder()],
      vmap(endedVerdict(HOLDER)),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('CONTROL: the identical goal, merely active, IS reported abandoned', () => {
    const alert = classifyGoalLiveness(
      standingGoal({ status: 'active' }),
      [holder()],
      vmap(endedVerdict(HOLDER)),
      NOW,
    );
    expect(alert).not.toBeNull();
    expect(alert?.reason).toBe('abandoned');
    expect(alert?.holders).toEqual([{ ownerId: HOLDER, sessionState: 'ended' }]);
  });
});

describe('goalEligibleForHolderRespawn on the paused standing shape', () => {
  it('SURVIVES: refuses to respawn while paused — pause must not be undone by recovery', () => {
    expect(goalEligibleForHolderRespawn(standingGoal({ status: 'paused' }))).toBe(false);
  });

  it('CONTROL: the identical goal, merely active, DOES earn respawn', () => {
    expect(goalEligibleForHolderRespawn(standingGoal({ status: 'active' }))).toBe(true);
  });
});

describe('resolveGoalEffectiveActivity on the paused standing shape', () => {
  it('SURVIVES: paused wins over a lost holder — never dormant, never deactivated', () => {
    const eff = resolveGoalEffectiveActivity({
      status: 'paused',
      launchSettings: { holder: { requireLive: true, onLoss: 'respawn' } },
      liveness: 'lost',
    });
    expect(eff.activity).toBe('paused');
    expect(eff.deliberatelyPaused).toBe(true);
    expect(eff.deactivated).toBe(false);
    expect(eff.effectiveStatus).toBe('paused');
    // Status decided the answer; liveness was never consulted.
    expect(eff.liveness).toBeNull();
  });

  it('CONTROL: the identical inputs, merely active, deactivate to dormant', () => {
    const eff = resolveGoalEffectiveActivity({
      status: 'active',
      launchSettings: { holder: { requireLive: true, onLoss: 'respawn' } },
      liveness: 'lost',
    });
    expect(eff.deactivated).toBe(true);
    expect(eff.effectiveStatus).toBe(GOAL_DORMANT_STATUS);
  });
});
