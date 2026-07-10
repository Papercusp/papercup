import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getFleet: vi.fn(),
  listFleetRosterDiagnosed: vi.fn(),
  countRunningWorkspaceBees: vi.fn(),
  countRunningFleetBees: vi.fn(),
  getCompletionIntegrityStats: vi.fn(),
  resolveAgentIdentity: vi.fn(),
}));

vi.mock('../../agent-fleets-store', () => ({
  getFleet: (...a: unknown[]) => h.getFleet(...a),
}));
// Real split helpers (pure) + a mocked roster/bee-count IO seam. status.ts now calls
// listFleetRosterDiagnosed (WI-3818) — mocked to resolve { entries, degradedLegs }.
vi.mock('../../fleet/fleet-roster', async () => {
  const actual =
    await vi.importActual<typeof import('../../fleet/fleet-roster')>('../../fleet/fleet-roster');
  return {
    isBeeRole: actual.isBeeRole,
    splitFleetRosterCounts: actual.splitFleetRosterCounts,
    listFleetRosterDiagnosed: (...a: unknown[]) => h.listFleetRosterDiagnosed(...a),
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
  h.listFleetRosterDiagnosed.mockResolvedValue({
    entries: [
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
    ],
    degradedLegs: [],
  });
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
    h.listFleetRosterDiagnosed.mockResolvedValueOnce({
      entries: [
        { agentId: 'su-leader', agentRole: 'su', fleetRole: 'leader', alive: true },
        { agentId: 'su-m2', agentRole: 'su', fleetRole: 'member', alive: true },
        { agentId: 's-bee1', agentRole: 'cup', fleetRole: 'member', alive: true },
      ],
      degradedLegs: [],
    });
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

  // EI-7137: an `ended` former member (a dead wave, presence row not yet reaped) must
  // not inflate memberCount forever — but stays visible in the full `members[]` list.
  it('excludes sessionState:"ended" entries from memberCount but keeps them in members[]', async () => {
    h.listFleetRosterDiagnosed.mockResolvedValueOnce({
      entries: [
        { agentId: 'su-live1', agentRole: 'su', fleetRole: 'member', alive: true, sessionState: 'live' },
        { agentId: 'su-live2', agentRole: 'su', fleetRole: 'member', alive: true, sessionState: 'parked' },
        // A dead prior-wave member: heartbeat may still look fresh, but wakeability
        // reconciliation (EI-5858) has already determined the session truly ended.
        { agentId: 'su-dead1', agentRole: 'su', fleetRole: 'member', alive: false, sessionState: 'ended' },
        { agentId: 'su-dead2', agentRole: 'su', fleetRole: 'member', alive: false, sessionState: 'ended' },
        { agentId: 's-bee1', agentRole: 'cup', fleetRole: 'member', alive: true, sessionState: 'live' },
      ],
      degradedLegs: [],
    });
    const out = parse(await invoke({ fleet: 'rocket' }));
    expect(out.memberCount).toBe(2); // su-live1 + su-live2 only — the 2 ended rows excluded
    // The full roster (all 5, including the dead ones) is still surfaced for visibility.
    expect(out.members).toHaveLength(5);
    expect(out.members.map((m: { agentId: string }) => m.agentId).sort()).toEqual(
      ['s-bee1', 'su-dead1', 'su-dead2', 'su-live1', 'su-live2'].sort(),
    );
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

  // WI-3818: a slow optional leg (completionStats / bee counts) must degrade to its
  // fallback within its own budget instead of hanging the whole handler — and the
  // degradation must be REPORTED (`degraded`/`degradedLegs`), not silently swallowed.
  describe('WI-3818 bounded fan-out — degraded legs', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('drops completionStats first when it never resolves, still returning the roster promptly', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.getCompletionIntegrityStats.mockReturnValue(new Promise(() => {}));
      const resultPromise = invoke({ fleet: 'rocket', harness: 'papercusp' });
      await vi.advanceTimersByTimeAsync(10_000);
      const out = parse(await resultPromise);
      expect(out.ok).toBe(true);
      expect(out.completionStats).toBeUndefined();
      expect(out.members).toHaveLength(1); // the roster itself still came back
      expect(out.degraded).toBe(true);
      expect(out.degradedLegs).toEqual(['completionStats']);
      warnSpy.mockRestore();
    });

    it('falls back bee counts to 0 + reports the legs when the nursery counts hang', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.countRunningWorkspaceBees.mockReturnValue(new Promise(() => {}));
      h.countRunningFleetBees.mockReturnValue(new Promise(() => {}));
      const resultPromise = invoke({ fleet: 'rocket' });
      await vi.advanceTimersByTimeAsync(10_000);
      const out = parse(await resultPromise);
      expect(out.runningBees).toBe(0);
      expect(out.beeCount).toBe(0);
      expect(out.degraded).toBe(true);
      expect(out.degradedLegs.sort()).toEqual(['beeCount', 'runningBees']);
      warnSpy.mockRestore();
    });

    it('surfaces a degraded roster sub-read as a prefixed `roster.<leg>` entry', async () => {
      h.listFleetRosterDiagnosed.mockResolvedValueOnce({
        entries: [{ agentId: 'su-leader', agentRole: 'su', fleetRole: 'leader', alive: true }],
        degradedLegs: ['assignments'],
      });
      const out = parse(await invoke({ fleet: 'rocket' }));
      expect(out.degraded).toBe(true);
      expect(out.degradedLegs).toEqual(['roster.assignments']);
      // the roster itself is still returned — the whole point of WI-3818.
      expect(out.members).toHaveLength(1);
    });

    it('omits degraded/degradedLegs entirely when every leg answers in time', async () => {
      const out = parse(await invoke({ fleet: 'rocket', harness: 'papercusp' }));
      expect(out.degraded).toBeUndefined();
      expect(out.degradedLegs).toBeUndefined();
    });
  });
});
