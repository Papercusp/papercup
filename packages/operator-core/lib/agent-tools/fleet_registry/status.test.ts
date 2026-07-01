import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getFleet: vi.fn(),
  listFleetRoster: vi.fn(),
  getCompletionIntegrityStats: vi.fn(),
  resolveAgentIdentity: vi.fn(),
}));

vi.mock('../../agent-fleets-store', () => ({
  getFleet: (...a: unknown[]) => h.getFleet(...a),
}));
vi.mock('../../fleet/fleet-roster', () => ({
  listFleetRoster: (...a: unknown[]) => h.listFleetRoster(...a),
}));
vi.mock('../../work-items', () => ({
  getCompletionIntegrityStats: (...a: unknown[]) => h.getCompletionIntegrityStats(...a),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: (...a: unknown[]) => h.resolveAgentIdentity(...a),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws' }));

import statusTool from './status';

const CTX = { workspaceId: 'ws', role: 'operator' } as never;
const parse = (res: { content: { text: string }[] }) => JSON.parse(res.content[0].text);
const invoke = (args: Record<string, unknown>) =>
  (
    statusTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: { text: string }[] }>;
    }
  ).handler(args, CTX);

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveAgentIdentity.mockReturnValue({ ownerId: 'su-test', workspaceId: 'ws' });
  h.getFleet.mockResolvedValue({
    workspaceId: 'ws',
    fleetSlug: 'rocket',
    title: 'Rocket Fleet',
    description: 'Handles the rocket lane',
    owner: 'su-owner',
    leaderOwnerId: 'su-leader',
    colorScheme: 'forest',
    createdAt: 0,
    updatedAt: 0,
  });
  h.listFleetRoster.mockResolvedValue([
    {
      agentId: 'su-leader',
      ownerLabel: 'Leader',
      fleetRole: 'leader',
      intent: 'ship it',
      alive: true,
      sessionState: 'live',
      lastActiveSecAgo: 2,
      doing: 'WI-1',
      load: 1,
    },
  ]);
  h.getCompletionIntegrityStats.mockResolvedValue({
    harness: 'papercusp',
    terminalTotal: 10,
    genuineCompletions: 7,
    dedupOrUnverified: 3,
  });
});

describe('fleet:status', () => {
  it('returns the live roster without completion stats when no harness is requested', async () => {
    const out = parse(await invoke({ fleet: 'rocket' }));
    expect(out.ok).toBe(true);
    expect(out.completionStats).toBeUndefined();
    expect(h.getCompletionIntegrityStats).not.toHaveBeenCalled();
  });

  it('includes harness completion stats when `harness` is provided', async () => {
    const out = parse(await invoke({ fleet: 'rocket', harness: 'papercusp' }));
    expect(h.getCompletionIntegrityStats).toHaveBeenCalledWith('papercusp');
    expect(out.completionStats).toEqual({
      harness: 'papercusp',
      terminalTotal: 10,
      genuineCompletions: 7,
      dedupOrUnverified: 3,
    });
    expect(out.members).toEqual([
      expect.objectContaining({
        agentId: 'su-leader',
        doing: 'WI-1',
        load: 1,
      }),
    ]);
  });
});
