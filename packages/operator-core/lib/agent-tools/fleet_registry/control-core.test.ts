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

const getFleetM = vi.mocked(getFleet);
const setControlM = vi.mocked(setFleetControlState);
const sendM = vi.mocked(sendMessage);
const presenceM = vi.mocked(getPresence);
const membersM = vi.mocked(hostAudienceResolvers.listFleetMembers);

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
    });
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
  });

  it('an su session invokes as OWNER (the owner-authority proxy) even when not leader', async () => {
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: 'su-someone-else' }));
    const r = await applyFleetControl({} as never, 'backend', 'wind-down');
    expect(r).toMatchObject({ ok: true, invokedAs: 'owner' });
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
    });
    expect((sendM.mock.calls[0][1] as { summary: string }).summary).toContain('RESUMED');
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
});
