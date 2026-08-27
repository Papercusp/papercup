import { describe, expect, it, vi, beforeEach } from 'vitest';

const fetchPresenceFleet = vi.fn();
const latestFleetMembership = vi.fn();
const listFleetMembers = vi.fn();

vi.mock('@papercusp/agent-mcp', () => ({
  classifyAgentPane: vi.fn(),
}));
vi.mock('../../agent-fleets-store', () => ({
  getFleet: vi.fn(),
  listFleetsLedBy: vi.fn(),
  fleetSlugFromName: (value: string) => value.trim().toLowerCase(),
}));
vi.mock('../coordination/presence', () => ({ getPresence: vi.fn() }));
vi.mock('../coordination/presence-fleet', () => ({
  fetchPresenceFleet: (...args: unknown[]) => fetchPresenceFleet(...args),
}));
vi.mock('../../fleet-membership-store', () => ({
  latestFleetMembership: (...args: unknown[]) => latestFleetMembership(...args),
}));
vi.mock('../coordination/audience-host', () => ({
  hostAudienceResolvers: {
    listFleetMembers: (...args: unknown[]) => listFleetMembers(...args),
  },
}));
vi.mock('./fleet-auth', () => ({ classifyFleetControlInvoker: vi.fn() }));
vi.mock('./_shared', () => ({ resolveFleetCaller: vi.fn() }));

import { resolveMemberInFleet } from './member-target';

const RECORDED = 'su-recorded-member';
const FLEET = 'rocket';
const WORKSPACE = 'ws';

beforeEach(() => {
  vi.clearAllMocks();
  fetchPresenceFleet.mockResolvedValue(new Map());
  latestFleetMembership.mockResolvedValue({ fleetSlug: FLEET, fleetRole: 'member' });
  listFleetMembers.mockResolvedValue([]);
});

describe('resolveMemberInFleet durable membership fallback (EI-21590236680691215)', () => {
  it('resolves an exact recorded owner after live presence has been reaped', async () => {
    const result = await resolveMemberInFleet(RECORDED, FLEET, WORKSPACE);

    expect(result).toEqual({ ok: true, ownerId: RECORDED, role: 'member' });
    expect(latestFleetMembership).toHaveBeenCalledWith(WORKSPACE, RECORDED);
    expect(listFleetMembers).not.toHaveBeenCalled();
  });

  it('keeps live-audience resolution for callers without a workspace scope', async () => {
    latestFleetMembership.mockClear();
    listFleetMembers.mockResolvedValue([RECORDED]);

    const result = await resolveMemberInFleet('su-recorded', FLEET);

    expect(result).toEqual({ ok: true, ownerId: RECORDED, role: 'member' });
    expect(latestFleetMembership).not.toHaveBeenCalled();
  });
});
