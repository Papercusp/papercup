import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getFleet: vi.fn(),
  setFleetLeader: vi.fn(),
  releaseSeatConsumption: vi.fn(),
  setPresenceFleet: vi.fn(),
  fetchPresenceFleet: vi.fn(),
  resetCallerTerminal: vi.fn(),
  retireFleetLeaderWatches: vi.fn(),
}));

vi.mock('../../agent-fleets-store', () => ({
  getFleet: (...args: unknown[]) => h.getFleet(...args),
  setFleetLeader: (...args: unknown[]) => h.setFleetLeader(...args),
}));
vi.mock('../../fleet/seat-accounting', () => ({
  releaseSeatConsumption: (...args: unknown[]) => h.releaseSeatConsumption(...args),
}));
vi.mock('../coordination/presence', () => ({
  setPresenceFleet: (...args: unknown[]) => h.setPresenceFleet(...args),
}));
vi.mock('../coordination/presence-fleet', () => ({
  fetchPresenceFleet: (...args: unknown[]) => h.fetchPresenceFleet(...args),
}));
vi.mock('./_shared', () => ({
  ROUTING_LADDER: 'ladder',
  json: (payload: Record<string, unknown>, isError = false) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  }),
  resetCallerTerminal: (...args: unknown[]) => h.resetCallerTerminal(...args),
  resolveFleetCaller: () => ({
    identity: { ownerId: 'su-me', workspaceId: 'ws-1' },
    ownerId: 'su-me',
    workspaceId: 'ws-1',
  }),
}));
vi.mock('./leader-control', () => ({
  retireFleetLeaderWatches: (...args: unknown[]) => h.retireFleetLeaderWatches(...args),
}));

import tool from './leave';

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);
const invoke = () =>
  tool.handler({}, { workspaceId: 'ws-1' } as never) as Promise<{
    content: Array<{ text: string }>;
  }>;

beforeEach(() => {
  vi.clearAllMocks();
  h.fetchPresenceFleet.mockResolvedValue(new Map([['su-me', { fleetSlug: 'alpha', fleetRole: 'leader' }]]));
  h.releaseSeatConsumption.mockResolvedValue(undefined);
  h.setPresenceFleet.mockResolvedValue(undefined);
  h.resetCallerTerminal.mockResolvedValue(undefined);
  h.retireFleetLeaderWatches.mockResolvedValue(0);
  h.setFleetLeader.mockResolvedValue(undefined);
});

describe('fleet:leave leader lifecycle', () => {
  it('clears leadership when an active fleet leader leaves', async () => {
    h.getFleet.mockResolvedValue({ fleetSlug: 'alpha', leaderOwnerId: 'su-me', controlState: 'active' });

    expect(parse(await invoke())).toMatchObject({
      ok: true,
      leftFleet: 'alpha',
      clearedLeadershipOf: 'alpha',
    });
    expect(h.setFleetLeader).toHaveBeenCalledWith('ws-1', 'alpha', null);
  });

  it('retains the registry leader as the durable final-report recipient during wind-down', async () => {
    h.getFleet.mockResolvedValue({ fleetSlug: 'alpha', leaderOwnerId: 'su-me', controlState: 'winding-down' });

    expect(parse(await invoke())).toMatchObject({
      ok: true,
      leftFleet: 'alpha',
      clearedLeadershipOf: null,
    });
    expect(h.setFleetLeader).not.toHaveBeenCalled();
  });
});
