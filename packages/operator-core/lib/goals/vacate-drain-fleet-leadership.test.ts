import { describe, expect, it, vi } from 'vitest';
import {
  vacateDrainFleetLeadership,
  type VacateDrainFleetLeadershipDeps,
} from './vacate-drain-fleet-leadership';

/**
 * EI-22402152554463916. The observed failure was a STOOD-DOWN agent left registered as the
 * drain fleet's leader — a filled slot that never acts, which every liveness surface reports
 * as healthy. These tests pin the two halves that matter: the seat is cleared when the
 * outgoing holder still holds it, and it is NEVER disturbed otherwise.
 */
function makeDeps(
  over: Partial<VacateDrainFleetLeadershipDeps> = {},
): VacateDrainFleetLeadershipDeps {
  return {
    readDrainFleetSlug: vi.fn(async () => 'goal-drain-demo'),
    readLeader: vi.fn(async () => ({ leaderOwnerId: 'holder-old' })),
    clearLeader: vi.fn(async () => true),
    demotePresence: vi.fn(async () => {}),
    retireWatches: vi.fn(async () => {}),
    ...over,
  };
}

describe('vacateDrainFleetLeadership', () => {
  it('clears the seat when the stood-down holder still holds it, and CAS-guards on that holder', async () => {
    const deps = makeDeps();

    const result = await vacateDrainFleetLeadership('ws-1', 'goal-1', 'holder-old', deps);

    expect(result).toEqual({ fleetSlug: 'goal-drain-demo', vacated: true, reason: 'vacated' });
    // The compare-and-set expectation must be the OUTGOING holder: that is what makes a
    // concurrent fleet:take-leadership win instead of being clobbered back to vacant.
    expect(deps.clearLeader).toHaveBeenCalledWith('ws-1', 'goal-drain-demo', 'holder-old');
    expect(deps.demotePresence).toHaveBeenCalledWith('ws-1', 'holder-old', 'goal-drain-demo');
    expect(deps.retireWatches).toHaveBeenCalledWith('holder-old', 'goal-drain-demo');
  });

  it('leaves a DIFFERENT live leader completely untouched', async () => {
    // The steward declined this seat three times: the fix must never re-seat the drain fleet
    // on someone else's behalf. A member who already took it is leading legitimately.
    const deps = makeDeps({ readLeader: vi.fn(async () => ({ leaderOwnerId: 'member-12612' })) });

    const result = await vacateDrainFleetLeadership('ws-1', 'goal-1', 'holder-old', deps);

    expect(result).toMatchObject({ vacated: false, reason: 'not-leader' });
    expect(deps.clearLeader).not.toHaveBeenCalled();
    expect(deps.demotePresence).not.toHaveBeenCalled();
    expect(deps.retireWatches).not.toHaveBeenCalled();
  });

  it('does nothing when the goal declares no drain fleet', async () => {
    const deps = makeDeps({ readDrainFleetSlug: vi.fn(async () => null) });

    const result = await vacateDrainFleetLeadership('ws-1', 'goal-1', 'holder-old', deps);

    expect(result).toEqual({ fleetSlug: null, vacated: false, reason: 'no-drain-fleet' });
    expect(deps.readLeader).not.toHaveBeenCalled();
    expect(deps.clearLeader).not.toHaveBeenCalled();
  });

  it('reports a lost CAS as superseded and does NOT demote the new leader’s predecessor label', async () => {
    // clearLeader false == someone took the seat between our read and our write. Demoting
    // presence anyway would mislabel an agent that is no longer part of this transition.
    const deps = makeDeps({ clearLeader: vi.fn(async () => false) });

    const result = await vacateDrainFleetLeadership('ws-1', 'goal-1', 'holder-old', deps);

    expect(result).toMatchObject({ vacated: false, reason: 'superseded' });
    expect(deps.demotePresence).not.toHaveBeenCalled();
    expect(deps.retireWatches).not.toHaveBeenCalled();
  });

  it('reports a missing fleet row rather than treating it as an absent declaration', async () => {
    const deps = makeDeps({ readLeader: vi.fn(async () => null) });

    const result = await vacateDrainFleetLeadership('ws-1', 'goal-1', 'holder-old', deps);

    expect(result).toMatchObject({ fleetSlug: 'goal-drain-demo', reason: 'fleet-missing' });
    expect(deps.clearLeader).not.toHaveBeenCalled();
  });

  it('never throws — a failure is reported so the stand-down itself still completes', async () => {
    // This runs inside the holder-handoff seam whose primary duty is disarming and notifying
    // the outgoing holder. A drain-fleet problem must never cost the stand-down.
    const deps = makeDeps({
      clearLeader: vi.fn(async () => {
        throw new Error('registry unavailable');
      }),
    });

    const result = await vacateDrainFleetLeadership('ws-1', 'goal-1', 'holder-old', deps);

    expect(result).toMatchObject({
      fleetSlug: 'goal-drain-demo',
      vacated: false,
      reason: 'error',
      detail: 'registry unavailable',
    });
  });
});
