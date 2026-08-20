/**
 * control-core tests (coord-authority-hardening-2026-07-11 P-009 / H4):
 * fleet:wind-down / resume / pause's shared engine — invoker guard (owner /
 * that fleet's leader / queen), typed registry persist, fleet-scoped cue to
 * the live member set. Store / presence / messages / audience are mocked
 * WHOLESALE (the DB-free unit surface); classifyAgentPane runs real (pure).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const callerRef = { ownerId: 'su-4c85f9d7-aaaa-bbbb-cccc-ddddeeee0001' };

vi.mock('./_shared', () => ({
  resolveFleetCaller: vi.fn(() => ({
    identity: { ownerId: callerRef.ownerId },
    ownerId: callerRef.ownerId,
    workspaceId: 'ws-1',
  })),
}));
vi.mock('../../agent-fleets-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-fleets-store')>()),
  getFleet: vi.fn(),
  setFleetControlState: vi.fn(),
}));
vi.mock('../coordination/messages', () => ({ sendMessage: vi.fn(async () => ({ msg_id: 'm-cue' })) }));
vi.mock('../coordination/presence', () => ({ getPresence: vi.fn(async () => null) }));
vi.mock('../coordination/audience-host', () => ({
  hostAudienceResolvers: { listFleetMembers: vi.fn(async () => [] as string[]) },
}));
vi.mock('../../session-brief', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session-brief')>()),
  markSessionBriefReleased: vi.fn(async () => true),
  clearSessionBriefReleasedForFleet: vi.fn(async () => 0),
}));
// P-006: the drain-stamp helper hits PG (scheduler oracle) — mock it so control-core
// unit tests stay DB-free + deterministic. Default: no stamp (fails-soft path); a
// dedicated test overrides it to assert the auto-stamp augments the reason + result.
vi.mock('./drain-stamp', () => ({ buildFleetDrainStamp: vi.fn(async () => null) }));

import {
  applyFleetControl,
  classifyFleetControlInvoker,
  fleetControlCueText,
} from './control-core';
import { getFleet, setFleetControlState, type AgentFleetRecord } from '../../agent-fleets-store';
import { sendMessage } from '../coordination/messages';
import { getPresence } from '../coordination/presence';
import { hostAudienceResolvers } from '../coordination/audience-host';
import { CUE_AUTHORITY_FIELD } from '../coordination/cue-authority';
import { buildFleetDrainStamp } from './drain-stamp';
import { clearSessionBriefReleasedForFleet, markSessionBriefReleased } from '../../session-brief';

const getFleetM = vi.mocked(getFleet);
const setControlM = vi.mocked(setFleetControlState);
const sendM = vi.mocked(sendMessage);
const presenceM = vi.mocked(getPresence);
const membersM = vi.mocked(hostAudienceResolvers.listFleetMembers);
const drainStampM = vi.mocked(buildFleetDrainStamp);
const markReleasedM = vi.mocked(markSessionBriefReleased);
const clearReleasedM = vi.mocked(clearSessionBriefReleasedForFleet);

function fleet(over: Partial<AgentFleetRecord> = {}): AgentFleetRecord {
  return {
    workspaceId: 'ws-1',
    fleetSlug: 'backend',
    title: null,
    description: null,
    owner: null,
    leaderOwnerId: null,
    colorScheme: null,
    controlState: 'active',
    controlReason: null,
    controlBy: null,
    controlAt: null,
    lastLaunchTransaction: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  callerRef.ownerId = 'su-4c85f9d7-aaaa-bbbb-cccc-ddddeeee0001';
  presenceM.mockResolvedValue(null as never);
  sendM.mockResolvedValue({ msg_id: 'm-cue' } as never);
  membersM.mockResolvedValue([]);
  drainStampM.mockResolvedValue(null); // default: fails-soft, no auto-stamp
  markReleasedM.mockResolvedValue(true);
  clearReleasedM.mockResolvedValue(0);
  // setFleetControlState echoes the applied state back (the RETURNING row).
  setControlM.mockImplementation(async (_ws, slug, control) =>
    fleet({ fleetSlug: slug, controlState: control.state, controlReason: control.reason ?? null, controlBy: control.by ?? null, controlAt: 99 }),
  );
});

describe('classifyFleetControlInvoker (pure guard)', () => {
  it('leader beats pane-kind; queen = mug/kettle; owner = su; everything else refused', () => {
    expect(classifyFleetControlInvoker({ callerOwnerId: 'a', leaderOwnerId: 'a', paneKind: 'cup' })).toBe('leader');
    expect(classifyFleetControlInvoker({ callerOwnerId: 'a', leaderOwnerId: 'b', paneKind: 'mug' })).toBe('queen');
    expect(classifyFleetControlInvoker({ callerOwnerId: 'a', leaderOwnerId: 'b', paneKind: 'kettle' })).toBe('queen');
    expect(classifyFleetControlInvoker({ callerOwnerId: 'a', leaderOwnerId: 'b', paneKind: 'su' })).toBe('owner');
    expect(classifyFleetControlInvoker({ callerOwnerId: 'a', leaderOwnerId: 'b', paneKind: 'cup' })).toBeNull();
    expect(classifyFleetControlInvoker({ callerOwnerId: 'a', leaderOwnerId: null, paneKind: 'papercup' })).toBeNull();
    expect(classifyFleetControlInvoker({ callerOwnerId: 'a', leaderOwnerId: null, paneKind: 'planner' })).toBeNull();
  });
});

describe('fleetControlCueText (pure)', () => {
  it('wind-down: binding, checkpoint-and-release, no new work until resume', () => {
    const { summary, body } = fleetControlCueText('wind-down', 'backend', 'release cut', '4c85f');
    expect(summary).toContain('WIND-DOWN');
    expect(summary).toContain('release cut');
    expect(body).toContain('BINDING');
    expect(body).toContain('work_items:checkpoint');
    expect(body).toContain('fleet:resume');
  });
  it('resume: lifts the wind-down, resume the pull cadence', () => {
    const { summary, body } = fleetControlCueText('resume', 'backend', null, '4c85f');
    expect(summary).toContain('RESUMED');
    expect(body).toContain('control_state=active');
  });
});

describe('applyFleetControl', () => {
  it('the fleet LEADER winds down: typed persist + fleet-scoped cue to members (self excluded)', async () => {
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));
    membersM.mockResolvedValue(['m-1', 'm-2', callerRef.ownerId]);
    const r = await applyFleetControl({} as never, 'backend', 'wind-down', 'release cut');
    expect(r).toMatchObject({
      ok: true,
      fleet: 'backend',
      controlState: 'winding-down',
      invokedAs: 'leader',
      notified: ['m-1', 'm-2'],
      cueMsgId: 'm-cue',
    });
    expect(setControlM).toHaveBeenCalledWith('ws-1', 'backend', {
      state: 'winding-down',
      reason: 'release cut',
      by: callerRef.ownerId,
    }, undefined, callerRef.ownerId);
    const sendOpts = sendM.mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(sendOpts.to).toEqual(['m-1', 'm-2']);
    expect(sendOpts.extra).toEqual({
      [CUE_AUTHORITY_FIELD]: {
        authority: 'fleet-leader',
        authorityRef: 'backend',
        scope: 'fleet-members',
        scopeRef: 'backend',
      },
    });
    expect(markReleasedM).toHaveBeenCalledTimes(2);
    expect(markReleasedM).toHaveBeenCalledWith(
      'm-1',
      'ws-1',
      expect.objectContaining({ fleet: 'backend', by: callerRef.ownerId }),
    );
    expect(Math.min(...markReleasedM.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...sendM.mock.invocationCallOrder),
    );
  });

  it('an su session invokes as OWNER (the owner-authority proxy) even when not leader', async () => {
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: 'su-someone-else' }));
    const r = await applyFleetControl({} as never, 'backend', 'wind-down');
    expect(r).toMatchObject({ ok: true, invokedAs: 'owner' });
  });

  it('refuses a stale leader control write when leadership changed after authorization', async () => {
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));
    setControlM.mockResolvedValueOnce(null);
    const r = await applyFleetControl({} as never, 'backend', 'wind-down');
    expect(r).toMatchObject({ ok: false, error: 'fleet_leadership_superseded' });
    expect(sendM).not.toHaveBeenCalled();
  });

  it('a mug (queen) invokes as QUEEN', async () => {
    callerRef.ownerId = 's-172000-queen'; // not su-prefixed — kind comes from the role
    presenceM.mockResolvedValue({ agentRole: 'mug' } as never);
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: 'su-someone-else' }));
    const r = await applyFleetControl({} as never, 'backend', 'wind-down');
    expect(r).toMatchObject({ ok: true, invokedAs: 'queen' });
  });

  it('REFUSES a non-leader cup (the EI-9501 class) — nothing persisted, nothing sent', async () => {
    callerRef.ownerId = 's-172000-bee7';
    presenceM.mockResolvedValue({ agentRole: 'worker' } as never);
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: 'su-someone-else' }));
    const r = await applyFleetControl({} as never, 'backend', 'wind-down');
    expect(r).toMatchObject({ ok: false, error: 'not_authorized' });
    expect(r.message).toContain('EI-9501');
    expect(setControlM).not.toHaveBeenCalled();
    expect(sendM).not.toHaveBeenCalled();
  });

  it('unknown fleet → fleet_not_found', async () => {
    getFleetM.mockResolvedValue(null);
    const r = await applyFleetControl({} as never, 'nope', 'wind-down');
    expect(r).toMatchObject({ ok: false, error: 'fleet_not_found' });
  });

  it('already in the requested state: refresh persisted, NO duplicate cue', async () => {
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId, controlState: 'winding-down' }));
    membersM.mockResolvedValue(['m-1']);
    const r = await applyFleetControl({} as never, 'backend', 'wind-down', 'still winding');
    expect(r).toMatchObject({ ok: true, alreadyInState: true, notified: [] });
    expect(setControlM).toHaveBeenCalledTimes(1); // reason/by/at refresh
    expect(sendM).not.toHaveBeenCalled();
  });

  it('resume flips back to active with the resume cue', async () => {
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId, controlState: 'winding-down' }));
    membersM.mockResolvedValue(['m-1']);
    const r = await applyFleetControl({} as never, 'backend', 'resume', 'incident cleared');
    expect(r).toMatchObject({ ok: true, controlState: 'active', notified: ['m-1'] });
    expect(setControlM).toHaveBeenCalledWith('ws-1', 'backend', {
      state: 'active',
      reason: 'incident cleared',
      by: callerRef.ownerId,
    }, undefined, callerRef.ownerId);
    expect((sendM.mock.calls[0][1] as { summary: string }).summary).toContain('RESUMED');
    expect(clearReleasedM).toHaveBeenCalledWith('ws-1', 'backend');
  });

  it('a cue-leg failure never fails the state flip (registry is the source of truth)', async () => {
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));
    membersM.mockRejectedValue(new Error('presence down'));
    const r = await applyFleetControl({} as never, 'backend', 'wind-down');
    expect(r).toMatchObject({ ok: true, controlState: 'winding-down', notified: [], cueMsgId: null });
  });

  it('accepts a human fleet NAME (slugified like every registry surface)', async () => {
    getFleetM.mockResolvedValue(fleet({ fleetSlug: 'backend-team', leaderOwnerId: callerRef.ownerId }));
    await applyFleetControl({} as never, 'Backend Team', 'wind-down');
    expect(getFleetM).toHaveBeenCalledWith('ws-1', 'backend-team');
  });

  describe('P-006 auto-drain stamp', () => {
    const STAMP = {
      harness: 'papercusp',
      breakdown: {
        matchedByFilter: 302,
        claimable: 0,
        excluded: {
          taken: 0,
          claimHold: 33,
          needsHuman: 80,
          observationLane: 21,
          externalBlocker: 0,
          planLaneReserved: 0,
          federationDetector: 169,
          loopNoise: 0,
          alreadyCompleted: 0,
          crossMachineRig: 0,
          blockedDep: 0,
          cooldown: 0,
          remoteOrigin: 0,
        },
      },
      spec: { specId: 'bug-drain', revision: 4, source: 'cup' as const },
      summary:
        "[auto-drain-stamp 2026-07-21T00:00:00.000Z · spec bug-drain@4] 302 in-lane issue-family row(s) matched the fleet spec's filter; stranded by: federationDetector=169, needsHuman=80. Re-verify against the authoritative oracle (no hand-rolled SQL): scheduler:get_next { harness: 'papercusp' }.",
      reVerifyCommand: "scheduler:get_next { harness: 'papercusp' }",
    };

    it('winds down: the live scheduler-oracle breakdown auto-stamps the reason + rides the result & cue', async () => {
      getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));
      membersM.mockResolvedValue(['m-1']);
      drainStampM.mockResolvedValue(STAMP);
      const r = await applyFleetControl({} as never, 'backend', 'wind-down', 'plans shipped', {
        harness: 'papercusp',
      });
      // caller's reason PREPENDED, the auto-stamp APPENDED — both durable on the row.
      const persisted = setControlM.mock.calls[0][2];
      expect(persisted.reason).toBe(`plans shipped | ${STAMP.summary}`);
      // structured stamp rides the result for the immediate caller.
      expect(r.drainStamp).toEqual(STAMP);
      // the member cue body carries the augmented reason (successor sees it at orient too).
      const cueBody = (sendM.mock.calls[0][1] as { body: string }).body;
      expect(cueBody).toContain(STAMP.reVerifyCommand);
      // the helper was fed the caller's harness first, then the session harness as fallback.
      expect(drainStampM).toHaveBeenCalledWith(
        expect.objectContaining({ fleetSlug: 'backend', harnessCandidates: ['papercusp', undefined] }),
      );
    });

    it('no explicit reason: the stamp becomes the whole reason', async () => {
      getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));
      drainStampM.mockResolvedValue(STAMP);
      await applyFleetControl({} as never, 'backend', 'wind-down');
      expect(setControlM.mock.calls[0][2].reason).toBe(STAMP.summary);
    });

    it('RESUME never computes a drain stamp (wind-down-only)', async () => {
      getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId, controlState: 'winding-down' }));
      await applyFleetControl({} as never, 'backend', 'resume', 'lane refilled');
      expect(drainStampM).not.toHaveBeenCalled();
      expect(setControlM.mock.calls[0][2].reason).toBe('lane refilled');
    });

    it('a stamp failure (null) leaves the bare reason untouched — never blocks the flip', async () => {
      getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));
      drainStampM.mockResolvedValue(null);
      const r = await applyFleetControl({} as never, 'backend', 'wind-down', 'just because');
      expect(setControlM.mock.calls[0][2].reason).toBe('just because');
      expect(r.drainStamp).toBeUndefined();
    });
  });
});
