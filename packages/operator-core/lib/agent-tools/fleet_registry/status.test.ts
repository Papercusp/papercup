import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getFleet: vi.fn(),
  listFleetRoster: vi.fn(),
  countRunningWorkspaceBees: vi.fn(),
  countRunningFleetBees: vi.fn(),
  getCompletionIntegrityStats: vi.fn(),
  resolveAgentIdentity: vi.fn(),
}));

vi.mock('../../agent-fleets-store', () => ({
  getFleet: (...a: unknown[]) => h.getFleet(...a),
}));
// Real split helpers (pure) + a mocked roster/bee-count IO seam.
vi.mock('../../fleet/fleet-roster', async () => {
  const actual =
    await vi.importActual<typeof import('../../fleet/fleet-roster')>('../../fleet/fleet-roster');
  return {
    isBeeRole: actual.isBeeRole,
    splitFleetRosterCounts: actual.splitFleetRosterCounts,
    listFleetRoster: (...a: unknown[]) => h.listFleetRoster(...a),
    countRunningWorkspaceBees: (...a: unknown[]) => h.countRunningWorkspaceBees(...a),
    countRunningFleetBees: (...a: unknown[]) => h.countRunningFleetBees(...a),
  };
});
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
      agentRole: 'su',
      intent: 'ship it',
      alive: true,
      sessionState: 'live',
      lastActiveSecAgo: 2,
      doing: 'WI-1',
      load: 1,
    },
  ]);
  h.countRunningWorkspaceBees.mockResolvedValue(0);
  h.countRunningFleetBees.mockResolvedValue(0);
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

  it('reports memberCount from the roster (presence) and beeCount from the nursery, plus workspace runningBees (WI-1764 #4 / WI-1813)', async () => {
    h.listFleetRoster.mockResolvedValueOnce([
      { agentId: 'su-leader', agentRole: 'su', fleetRole: 'leader', alive: true },
      { agentId: 'su-m2', agentRole: 'su', fleetRole: 'member', alive: true },
      { agentId: 's-bee1', agentRole: 'bee', fleetRole: 'member', alive: true },
    ]);
    h.countRunningWorkspaceBees.mockResolvedValueOnce(4);
    // WI-1813: beeCount is the nursery-authoritative per-fleet count, NOT the roster's
    // presence-labeled bee (the roster has 1 bee; the nursery reports 3 — beeCount = 3).
    h.countRunningFleetBees.mockResolvedValueOnce(3);
    const out = parse(await invoke({ fleet: 'rocket' }));
    expect(out.memberCount).toBe(2); // su-leader + su-m2 (roster split, presence)
    expect(out.beeCount).toBe(3); // from countRunningFleetBees, not the 1 presence-labeled bee
    expect(out.runningBees).toBe(4);
    expect(h.countRunningFleetBees).toHaveBeenCalledWith('rocket', 'ws');
    // full roster still returned regardless of the split
    expect(out.members).toHaveLength(3);
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
