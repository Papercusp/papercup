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

import statusTool, {
  classifyLaunchTransactionUnconfirmedMembers,
  FLEET_STATUS_TIER_CAPS,
  reconcileFleetStatusLiveness,
  shapeFleetStatus,
} from './status';
import type { FleetRosterEntry } from '../../fleet/fleet-roster';

const CTX = { workspaceId: 'ws', role: 'operator' } as never;
const parse = (res: { content?: { text: string }[]; data?: unknown }) =>
  res.data ?? JSON.parse(res.content?.[0]?.text ?? '{}');
const invoke = (args: Record<string, unknown>) =>
  (
    statusTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content?: { text: string }[]; data?: unknown }>;
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
    lastLaunchTransaction: {
      version: 1,
      transactionId: 'tx-1',
      state: 'partial',
      recovery: { retryOwnerIds: ['su-missing'], nextAction: 'retry unresolved members' },
    },
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
    gateJudged: 4,
  });
});

describe('fleet:status', () => {
  it('opts out of the dispatcher ambient workspace transaction', () => {
    expect((statusTool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('keeps the deliberate full-roster response parseable for machine consumers', () => {
    expect((statusTool as { skipResultDoor?: string }).skipResultDoor).toBe('oversize-by-design');
  });

  it('returns the live roster without completion stats when no harness is requested', async () => {
    const result = await invoke({ fleet: 'rocket' });
    expect(result).toMatchObject({
      data: expect.objectContaining({ ok: true, members: expect.any(Array) }),
    });
    const out = parse(result);
    expect(out.ok).toBe(true);
    expect(out.completionStats).toBeUndefined();
    expect(out.launchTransaction).toMatchObject({ transactionId: 'tx-1', state: 'partial' });
    expect(h.getCompletionIntegrityStats).not.toHaveBeenCalled();
  });

  it('labels unconfirmed launch ids by the roster presence read', async () => {
    h.getFleet.mockResolvedValueOnce({
      workspaceId: 'ws',
      fleetSlug: 'rocket',
      leaderOwnerId: 'su-leader',
      controlState: 'active',
      lastLaunchTransaction: {
        unconfirmedMemberIds: ['su-unconfirmed-live', 'su-unconfirmed-absent'],
      },
    });
    h.listFleetRosterDiagnosed.mockResolvedValueOnce({
      entries: [
        {
          agentId: 'su-leader',
          ownerLabel: 'Leader',
          agentRole: 'su',
          fleetRole: 'leader',
          alive: true,
          sessionState: 'live',
        },
        {
          agentId: 'su-unconfirmed-live',
          agentRole: 'su',
          fleetRole: 'member',
          alive: true,
          heartbeatFresh: true,
          sessionState: 'live',
          lastActiveSecAgo: 4,
        },
      ],
      degradedLegs: [],
    });

    const out = parse(await invoke({ fleet: 'rocket' }));

    expect(out.launchTransactionUnconfirmedMembers).toEqual([
      {
        ownerId: 'su-unconfirmed-live',
        presence: 'present',
        sessionState: 'live',
        heartbeatFresh: true,
        lastActiveSecAgo: 4,
      },
      {
        ownerId: 'su-unconfirmed-absent',
        presence: 'absent',
        sessionState: null,
        heartbeatFresh: null,
        lastActiveSecAgo: null,
      },
    ]);
  });

  it('returns an ended leader with an explicit liveness annotation', async () => {
    h.listFleetRosterDiagnosed.mockResolvedValueOnce({
      entries: [
        {
          agentId: 'su-leader',
          agentRole: 'su',
          fleetRole: 'leader',
          alive: false,
          sessionState: 'ended',
        },
        {
          agentId: 'su-member',
          agentRole: 'su',
          fleetRole: 'member',
          alive: true,
          sessionState: 'live',
        },
      ],
      degradedLegs: [],
    });

    const out = parse(await invoke({ fleet: 'rocket' }));

    expect(out.leader).toEqual({
      agentId: 'su-leader',
      sessionState: 'ended',
      heartbeatFresh: false,
      lastActiveSecAgo: null,
      presenceRow: true,
    });
    expect(out.leaderId).toBe('su-leader');
    expect(out.leaderLive).toBe(false);
    expect(out.leaderSessionState).toBe('ended');
    expect(out.leaderVacant).toBe(true);
  });

  it('does not present a durable leader with no presence row as live', async () => {
    h.listFleetRosterDiagnosed.mockResolvedValueOnce({
      entries: [
        {
          agentId: 'su-member',
          agentRole: 'su',
          fleetRole: 'member',
          alive: true,
          sessionState: 'live',
        },
      ],
      degradedLegs: [],
    });

    const out = parse(await invoke({ fleet: 'rocket' }));

    expect(out.leader).toEqual({
      agentId: 'su-leader',
      sessionState: 'unknown',
      heartbeatFresh: false,
      lastActiveSecAgo: null,
      presenceRow: false,
    });
    expect(out.leaderId).toBe('su-leader');
    expect(out.leaderLive).toBe(false);
    // Missing presence is not enough evidence to seize leadership on a read.
    expect(out.leaderSessionState).toBeNull();
    expect(out.leaderVacant).toBe(false);
  });

  it('uses a leader liveness-only enrichment without changing the queried fleet census', async () => {
    h.listFleetRosterDiagnosed.mockResolvedValueOnce({
      entries: [
        {
          agentId: 'su-member',
          agentRole: 'su',
          fleetRole: 'member',
          alive: true,
          sessionState: 'live',
        },
      ],
      // The leader is live, but its one presence row is labelled with another
      // fleet. This entry must inform the leader verdict without becoming a
      // member of `rocket`.
      leaderEntry: {
        agentId: 'su-leader',
        agentRole: 'su',
        fleetRole: 'leader',
        fleetSlug: 'other-fleet',
        alive: true,
        sessionState: 'live',
        heartbeatFresh: true,
        lastActiveSecAgo: 1,
      },
      degradedLegs: [],
    });

    const out = parse(await invoke({ fleet: 'rocket' }));

    expect(out.leader).toEqual({
      agentId: 'su-leader',
      sessionState: 'live',
      heartbeatFresh: true,
      lastActiveSecAgo: 1,
      presenceRow: true,
    });
    expect(out.leaderLive).toBe(true);
    expect(out.leaderVacant).toBe(false);
    expect(out.memberCount).toBe(1);
    expect(out.members.map((member: { agentId: string }) => member.agentId)).toEqual(['su-member']);
    expect(h.listFleetRosterDiagnosed).toHaveBeenCalledWith({
      fleetSlug: 'rocket',
      workspaceId: 'ws',
      leaderOwnerId: 'su-leader',
    });
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

  it('excludes sessionState:"recorded" entries from memberCount but keeps them in members[]', async () => {
    h.listFleetRosterDiagnosed.mockResolvedValueOnce({
      entries: [
        { agentId: 'su-live', agentRole: 'su', fleetRole: 'member', alive: true, sessionState: 'live' },
        // A recorded session has no live presence, but its stale row can remain in the roster.
        { agentId: 'su-recorded', agentRole: 'su', fleetRole: 'member', alive: false, sessionState: 'recorded' },
        { agentId: 's-bee1', agentRole: 'cup', fleetRole: 'member', alive: true, sessionState: 'live' },
      ],
      degradedLegs: [],
    });

    const out = parse(await invoke({ fleet: 'rocket' }));

    expect(out.memberCount).toBe(1);
    expect(out.members).toHaveLength(3);
    expect(out.members.map((m: { agentId: string }) => m.agentId).sort()).toEqual(
      ['s-bee1', 'su-live', 'su-recorded'].sort(),
    );
  });

  it('ends hostless visible rows while preserving headless su members and nursery cups', () => {
    const roster = [
      {
        agentId: 'su-visible-live',
        agentRole: 'su',
        tty: '/dev/pts/11',
        sessionState: 'live',
        alive: true,
      },
      {
        agentId: 'su-visible-dead',
        agentRole: 'su',
        tty: '/dev/pts/12',
        sessionState: 'parked',
        alive: true,
      },
      {
        agentId: 'su-headless',
        agentRole: 'su',
        tty: null,
        sessionState: 'live',
        alive: true,
      },
      {
        agentId: 'cup-without-pty',
        agentRole: 'cup',
        tty: '/dev/pts/13',
        sessionState: 'live',
        alive: true,
      },
    ] as unknown as FleetRosterEntry[];

    reconcileFleetStatusLiveness(roster, (ownerId) =>
      ownerId === 'su-visible-live' ? { host: 'local' } : null,
    );

    expect(roster.find((m) => m.agentId === 'su-visible-live')).toMatchObject({
      sessionState: 'live',
      alive: true,
    });
    expect(roster.find((m) => m.agentId === 'su-visible-dead')).toMatchObject({
      sessionState: 'ended',
      alive: false,
    });
    expect(roster.find((m) => m.agentId === 'su-headless')).toMatchObject({
      sessionState: 'live',
      alive: true,
    });
    expect(roster.find((m) => m.agentId === 'cup-without-pty')).toMatchObject({
      sessionState: 'live',
      alive: true,
    });
  });

  it('includes harness completion stats when `harness` is provided', async () => {
    const out = parse(await invoke({ fleet: 'rocket', harness: 'papercusp' }));
    expect(h.getCompletionIntegrityStats).toHaveBeenCalledWith('papercusp');
    expect(out.completionStats).toEqual({
      harness: 'papercusp',
      gateJudged: 4,
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

describe('launch transaction unconfirmed presence classification', () => {
  it('does not turn a degraded presence read into a false absent verdict', () => {
    expect(
      classifyLaunchTransactionUnconfirmedMembers(
        ['su-missing'],
        [],
        ['presence'],
      ),
    ).toEqual([
      {
        ownerId: 'su-missing',
        presence: 'unknown',
        sessionState: null,
        heartbeatFresh: null,
        lastActiveSecAgo: null,
        reason: 'fleet roster presence read degraded; absence is unverified',
      },
    ]);
  });
});

describe('fleet:status payload-tier shaping', () => {
  it('bounds oversized rosters and keeps leader/non-runnable rows visible', () => {
    const source = [
      { agentId: 'su-live-0', sessionState: 'live', intent: 'ordinary' },
      { agentId: 'su-leader', sessionState: 'live', intent: 'leader work' },
      { agentId: 'su-ended', sessionState: 'ended', intent: 'recover me', resumable: true },
      ...Array.from({ length: 24 }, (_, i) => ({ agentId: `su-live-${i + 1}`, sessionState: 'live' })),
    ];

    const out = shapeFleetStatus(
      {
        ok: true,
        slug: 'rocket',
        leaderId: 'su-leader',
        controlState: 'winding-down',
        memberCount: 25,
        members: source,
      },
      'trimmed',
    ) as { controlState: string; members: Array<Record<string, unknown>>; members_note: string };

    expect(out.controlState).toBe('winding-down');
    expect(out.members).toHaveLength(FLEET_STATUS_TIER_CAPS.trimmed.members + 1);
    expect(out.members.map((m) => m.agentId)).toContain('su-leader');
    expect(out.members.map((m) => m.agentId)).toContain('su-ended');
    expect(out.members.at(-1)).toMatchObject({ agentId: '(truncated)' });
    expect(out.members_note).toContain('roster capped at');
  });

  it('retains the liveness decision core and exposes both tier registrations', () => {
    const out = shapeFleetStatus(
      {
        members: [
          {
            agentId: 'su-ended',
            label: 'A'.repeat(400),
            intent: 'B'.repeat(400),
            sessionState: 'ended',
            heartbeatFresh: true,
            resumable: true,
            endedAt: '2026-08-12T10:00:00Z',
            resumeHint: 'launch fresh',
          },
        ],
      },
      'standard',
    ) as { members: Array<Record<string, unknown>> };
    const row = out.members[0];

    expect(row).toMatchObject({
      agentId: 'su-ended',
      heartbeatFresh: true,
      sessionState: 'ended',
      resumable: true,
      endedAt: '2026-08-12T10:00:00Z',
    });
    expect(String(row.label).length).toBeLessThanOrEqual(FLEET_STATUS_TIER_CAPS.standard.label);
    expect(String(row.intent).length).toBeLessThanOrEqual(FLEET_STATUS_TIER_CAPS.standard.intent);
    expect((statusTool as unknown as { shape: { trimmed?: unknown; standard?: unknown } }).shape).toEqual({
      trimmed: expect.any(Function),
      standard: expect.any(Function),
    });
  });
});
