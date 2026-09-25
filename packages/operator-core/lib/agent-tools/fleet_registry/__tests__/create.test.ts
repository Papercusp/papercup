import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchGatewayHeadroomMock = vi.fn();
const createFleetIfAbsentMock = vi.fn();
const heartbeatPresenceMock = vi.fn();
const setPresenceFleetMock = vi.fn();
const recolorCallerTerminalMock = vi.fn();
const ensureFleetLeaderControlMock = vi.fn();
const getModeSubjectMock = vi.fn();

vi.mock('../../../modes/store', () => ({
  getModeSubject: (...args: unknown[]) => getModeSubjectMock(...args),
}));

vi.mock('../../../agent-fleets-store', () => ({
  FLEET_TYPES: ['single', 'paired'] as const,
  createFleetIfAbsent: (...args: unknown[]) => createFleetIfAbsentMock(...args),
  fleetSlugFromName: (name: string) => name.toLowerCase().replace(/\s+/g, '-'),
}));

vi.mock('../../coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../coordination/presence')>()),
  heartbeatPresence: (...args: unknown[]) => heartbeatPresenceMock(...args),
  setPresenceFleet: (...args: unknown[]) => setPresenceFleetMock(...args),
}));

vi.mock('../_shared', () => ({
  fleetRoleFor: () => 'leader',
  json: (payload: Record<string, unknown>, isError = false) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    isError,
  }),
  recolorCallerTerminal: (...args: unknown[]) => recolorCallerTerminalMock(...args),
  resolveFleetCaller: () => ({
    identity: { ownerId: 'owner-1' },
    ownerId: 'owner-1',
    workspaceId: 'ws-1',
  }),
  ROUTING_LADDER: 'ladder',
}));

vi.mock('../../../inference-gateway/observability', () => ({
  fetchGatewayHeadroom: (...args: unknown[]) => fetchGatewayHeadroomMock(...args),
}));

vi.mock('../leader-control', () => ({
  ensureFleetLeaderControl: (...args: unknown[]) => ensureFleetLeaderControlMock(...args),
}));

import tool from '../create';

describe('fleet:create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getModeSubjectMock.mockResolvedValue(null);
    createFleetIfAbsentMock.mockResolvedValue({
      record: { title: 'Alpha Fleet', leaderOwnerId: 'owner-1', colorScheme: { name: 'Ocean' } },
      created: true,
    });
    heartbeatPresenceMock.mockResolvedValue(undefined);
    setPresenceFleetMock.mockResolvedValue(undefined);
    recolorCallerTerminalMock.mockResolvedValue(undefined);
    ensureFleetLeaderControlMock.mockResolvedValue({
      healthy: true,
      mode: { healthy: true, changed: true },
    });
  });

  it('accepts planned fleet sizes above the retired local 12-member ceiling', () => {
    expect(tool.args.safeParse({ name: 'Wide Fleet', count: 64 }).success).toBe(true);
  });

  it('refuses GOAL-holder self-leadership before creating or joining a fleet', async () => {
    getModeSubjectMock.mockResolvedValue('goal-1');
    const res = await tool.handler({ name: 'Goal Fleet' } as never, {} as never);
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.error).toBe('goal_plan_fleet_self_leadership');
    expect(payload.recovery).toContain("leader:'spawn'");
    expect(createFleetIfAbsentMock).not.toHaveBeenCalled();
    expect(setPresenceFleetMock).not.toHaveBeenCalled();
  });

  it('surfaces a sizing advisory only when planned members exceed healthy account headroom', async () => {
    fetchGatewayHeadroomMock.mockResolvedValue({
      reachable: true,
      utilization: 0.1,
      utilizationPct: 10,
      paused: false,
      rejected: false,
      inFlight: 0,
      queueDepth: 0,
      priorityTiers: {
        healthyAccounts: 1,
        tier1Reserve: 0,
        tiers: [{ tier: 3, minShare: 4, inFlight: 0, queued: 0 }],
      },
    });

    const warned = await tool.handler({ name: 'Alpha Fleet', count: 2 } as never, {} as never);
    const warnedPayload = JSON.parse((warned as any).content[0].text);
    expect(warnedPayload.ok).toBe(true);
    expect(warnedPayload.requested).toBe(2);
    expect(warnedPayload.sizingAdvisory).toMatchObject({
      requestedMembers: 2,
      healthyHeadroom: 1,
      extraMembers: 1,
    });
    expect(warnedPayload.message).toMatch(/Sizing advisory:/);

    fetchGatewayHeadroomMock.mockResolvedValue({
      reachable: true,
      utilization: 0.1,
      utilizationPct: 10,
      paused: false,
      rejected: false,
      inFlight: 0,
      queueDepth: 0,
      priorityTiers: {
        healthyAccounts: 2,
        tier1Reserve: 0,
        tiers: [{ tier: 3, minShare: 4, inFlight: 0, queued: 0 }],
      },
    });

    const notWarned = await tool.handler({ name: 'Alpha Fleet', count: 2 } as never, {} as never);
    const notWarnedPayload = JSON.parse((notWarned as any).content[0].text);
    expect(notWarnedPayload.ok).toBe(true);
    expect(notWarnedPayload.requested).toBe(2);
    expect(notWarnedPayload.sizingAdvisory).toBeNull();
    expect(notWarnedPayload.message).toBeUndefined();
  });

  it('skips the gateway lookup when no planned member count is supplied', async () => {
    const res = await tool.handler({ name: 'Alpha Fleet' } as never, {} as never);
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.requested).toBeNull();
    expect(payload.sizingAdvisory).toBeNull();
    expect(fetchGatewayHeadroomMock).not.toHaveBeenCalled();
  });

  it('atomically installs and reports leader control after labeling the caller as leader', async () => {
    const res = await tool.handler({ name: 'Alpha Fleet' } as never, {} as never);
    const payload = JSON.parse((res as any).content[0].text);

    expect(ensureFleetLeaderControlMock).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      ownerId: 'owner-1',
      fleetSlug: 'alpha-fleet',
    });
    expect(setPresenceFleetMock.mock.invocationCallOrder[0]).toBeLessThan(
      ensureFleetLeaderControlMock.mock.invocationCallOrder[0],
    );
    expect(payload.control).toMatchObject({ healthy: true, mode: { healthy: true } });
  });
});
