/**
 * EI-19450193083358682 — join SEMANTICS for fleet:join.
 *
 * The sibling `join.test.ts` is scoped to P-016 watch suggestions: it invokes both
 * branches but asserts only on `suggestedWatches`, so the presence writes that ARE the
 * join were unpinned. `as:'leader'` is covered transitively by the three
 * take-leadership suites; this file covers the DEFAULT `as:'member'` path and the D-002
 * nuance that a fleet's own leader re-joining must not demote themselves.
 *
 * That nuance is the one worth a test: it is a single conditional (`fleetRoleFor` at
 * join.ts:97) whose failure mode is silent and self-inflicted — a leader calls
 * fleet:join, is written back as `member`, and the fleet is left leaderless with nobody
 * monitoring it, which is the exact state D-002 exists to prevent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getFleet: vi.fn(),
  heartbeatPresence: vi.fn(),
  setPresenceFleet: vi.fn(),
  recolorCallerTerminal: vi.fn(),
  takeFleetLeadership: vi.fn(),
  getModeSubject: vi.fn(),
}));

vi.mock('../../agent-fleets-store', () => ({
  FLEET_TYPES: ['single', 'paired'] as const,
  getFleet: (...args: unknown[]) => h.getFleet(...args),
}));
vi.mock('../coordination/presence', () => ({
  heartbeatPresence: (...args: unknown[]) => h.heartbeatPresence(...args),
  setPresenceFleet: (...args: unknown[]) => h.setPresenceFleet(...args),
}));
vi.mock('./_shared', () => ({
  fleetRoleFor: (leaderOwnerId: string | null, ownerId: string) =>
    leaderOwnerId === ownerId ? 'leader' : 'member',
  json: (payload: Record<string, unknown>, isError = false) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    isError,
  }),
  recolorCallerTerminal: (...args: unknown[]) => h.recolorCallerTerminal(...args),
  resolveFleetCaller: () => ({
    identity: { ownerId: 'su-me', workspaceId: 'ws-1' },
    ownerId: 'su-me',
    workspaceId: 'ws-1',
  }),
  ROUTING_LADDER: 'ladder',
}));
vi.mock('./take-leadership-core', () => ({
  takeFleetLeadership: (...args: unknown[]) => h.takeFleetLeadership(...args),
}));
vi.mock('../../modes/store', () => ({
  getModeSubject: (...args: unknown[]) => h.getModeSubject(...args),
}));

import tool from './join';

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
const invoke = (args: Record<string, unknown>) =>
  tool.handler(args as never, { workspaceId: 'ws-1' } as never) as Promise<ToolResult>;
const parse = (r: ToolResult) => JSON.parse(r.content[0].text);

beforeEach(() => {
  vi.clearAllMocks();
  // The caller ('su-me') is NOT this fleet's leader unless a test says otherwise.
  h.getFleet.mockResolvedValue({ fleetSlug: 'alpha', leaderOwnerId: 'su-leader', colorScheme: 'forest' });
  h.heartbeatPresence.mockResolvedValue(undefined);
  h.setPresenceFleet.mockResolvedValue(undefined);
  h.recolorCallerTerminal.mockResolvedValue(undefined);
  h.takeFleetLeadership.mockResolvedValue({ leader: 'su-me', previousLeader: 'su-leader', notified: true });
  h.getModeSubject.mockResolvedValue(null);
});

describe('fleet:join — member branch (the default path)', () => {
  it('MOCK FIDELITY: the fleetRoleFor stub matches the real implementation', async () => {
    // Every demotion assertion below runs through the stubbed `_shared`, so if the stub
    // and the real function ever diverge this suite would be testing its own mock and
    // would keep passing while join.ts broke. Pin the two together.
    const actual = await vi.importActual<typeof import('./_shared')>('./_shared');
    expect(actual.fleetRoleFor('su-me', 'su-me')).toBe('leader');
    expect(actual.fleetRoleFor('su-leader', 'su-me')).toBe('member');
    expect(actual.fleetRoleFor(null, 'su-me')).toBe('member');
  });

  it("defaults `as` to 'member' at the schema, so an omitted role never takes over a fleet", () => {
    expect(tool.args.parse({ fleet: 'alpha' }).as).toBe('member');
  });

  it('labels a non-leader as member and returns the fleet scheme', async () => {
    const out = parse(await invoke({ fleet: 'alpha', as: 'member' }));

    expect(h.setPresenceFleet).toHaveBeenCalledWith('ws-1', 'su-me', 'alpha', 'member');
    expect(out).toMatchObject({ ok: true, slug: 'alpha', role: 'member', scheme: 'forest' });
  });

  it('heartbeats BEFORE labelling, so there is a presence row to label', async () => {
    await invoke({ fleet: 'alpha', as: 'member' });

    expect(h.heartbeatPresence).toHaveBeenCalled();
    expect(h.heartbeatPresence.mock.invocationCallOrder[0]).toBeLessThan(
      h.setPresenceFleet.mock.invocationCallOrder[0],
    );
  });

  it('never routes a member join through the leadership-transfer path', async () => {
    await invoke({ fleet: 'alpha', as: 'member' });

    expect(h.takeFleetLeadership).not.toHaveBeenCalled();
  });
});

describe("fleet:join — D-002: a leader re-joining their OWN fleet is not demoted", () => {
  beforeEach(() => {
    // Now the caller IS the recorded leader.
    h.getFleet.mockResolvedValue({ fleetSlug: 'alpha', leaderOwnerId: 'su-me', colorScheme: 'forest' });
  });

  it("keeps the leader label on a plain as:'member' re-join", async () => {
    const out = parse(await invoke({ fleet: 'alpha', as: 'member' }));

    expect(
      h.setPresenceFleet,
      'A member-join by the fleet\'s own leader wrote a role other than "leader": that ' +
        'self-demotion leaves the fleet with no leader and nobody monitoring it (D-002).',
    ).toHaveBeenCalledWith('ws-1', 'su-me', 'alpha', 'leader');
    expect(out).toMatchObject({ ok: true, role: 'leader' });
  });

  it('reports the leader role without re-running a leadership transfer', async () => {
    await invoke({ fleet: 'alpha', as: 'member' });

    // Already leader: nothing to transfer, and no prior-leader demotion/notification.
    expect(h.takeFleetLeadership).not.toHaveBeenCalled();
  });
});

describe("fleet:join — as:'leader' delegates rather than reimplementing", () => {
  // Deliberately THIN. The transfer's deep behaviour (installing the caller, demoting and
  // notifying the prior leader) belongs to take-leadership-core.test.ts and is not
  // duplicated here. What is pinned is only the seam this tool owns: that the leader
  // branch routes to the shared path instead of growing a second implementation, and
  // surfaces its result as role:'leader'.
  it('routes to takeFleetLeadership and reports the leader role', async () => {
    const out = parse(await invoke({ fleet: 'alpha', as: 'leader' }));

    expect(h.takeFleetLeadership).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ ok: true, role: 'leader', previousLeader: 'su-leader', notified: true });
    // The member path's own presence write must NOT also run — that would relabel the
    // new leader immediately after the transfer installed them.
    expect(h.setPresenceFleet).not.toHaveBeenCalled();
  });
});

describe('fleet:join — unknown fleet', () => {
  it('refuses without touching presence', async () => {
    h.getFleet.mockResolvedValue(null);

    const res = await invoke({ fleet: 'ghost', as: 'member' });

    expect(res.isError).toBe(true);
    expect(parse(res).ok).toBe(false);
    // The refusal must be inert: a half-applied join would label the caller into a
    // fleet that does not exist.
    expect(h.setPresenceFleet).not.toHaveBeenCalled();
    expect(h.heartbeatPresence).not.toHaveBeenCalled();
    expect(h.recolorCallerTerminal).not.toHaveBeenCalled();
  });
});

describe('fleet:join — GOAL holder boundary', () => {
  it.each(['member', 'leader'])('refuses a GOAL holder joining as %s before touching the execution fleet', async (as) => {
    h.getModeSubject.mockResolvedValue('goal-1');

    const res = await invoke({ fleet: 'alpha', as });

    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, error: as === 'leader'
      ? 'goal_plan_fleet_self_leadership'
      : 'goal_execution_fleet_membership_forbidden' });
    expect(h.getFleet).not.toHaveBeenCalled();
    expect(h.heartbeatPresence).not.toHaveBeenCalled();
    expect(h.takeFleetLeadership).not.toHaveBeenCalled();
  });
});
