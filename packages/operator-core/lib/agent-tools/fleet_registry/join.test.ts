/**
 * Handler-level P-016 coverage for fleet:join's opt-in watch suggestions.
 *
 * The pure resolver suite proves profile rows become valid calls. These tests pin
 * the integration seam: joining returns those calls in the tool response, while
 * the handler itself never arms a watch.
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

vi.mock('../../modes/store', () => ({
  getModeSubject: (...args: unknown[]) => h.getModeSubject(...args),
}));

vi.mock('../../agent-fleets-store', () => ({
  FLEET_TYPES: ['single', 'paired'] as const,
  getFleet: (...args: unknown[]) => h.getFleet(...args),
}));
vi.mock('../coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/presence')>()),
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

import tool from './join';

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);
const invoke = (args: Record<string, unknown>) =>
  tool.handler(args as never, { workspaceId: 'ws-1' } as never) as Promise<{
    content: Array<{ text: string }>;
  }>;

beforeEach(() => {
  vi.clearAllMocks();
  h.getModeSubject.mockResolvedValue(null);
  h.getFleet.mockResolvedValue({
    fleetSlug: 'alpha',
    leaderOwnerId: 'su-leader',
    colorScheme: 'forest',
  });
  h.heartbeatPresence.mockResolvedValue(undefined);
  h.setPresenceFleet.mockResolvedValue(undefined);
  h.recolorCallerTerminal.mockResolvedValue(undefined);
  h.takeFleetLeadership.mockResolvedValue({
    leader: 'su-me',
    previousLeader: 'su-leader',
    notified: true,
  });
});

describe('fleet:join P-016 suggested watches', () => {
  it('refuses both member and leader joins for a GOAL holder before membership writes', async () => {
    h.getModeSubject.mockResolvedValue('goal-1');
    const member = parse(await invoke({ fleet: 'alpha', as: 'member' }));
    const leader = parse(await invoke({ fleet: 'alpha', as: 'leader' }));
    expect(member.error).toBe('goal_execution_fleet_membership_forbidden');
    expect(leader.error).toBe('goal_plan_fleet_self_leadership');
    expect(h.getFleet).not.toHaveBeenCalled();
    expect(h.setPresenceFleet).not.toHaveBeenCalled();
    expect(h.takeFleetLeadership).not.toHaveBeenCalled();
  });
  it('advertises only the growable trimmed context for leader joins', () => {
    expect(tool.args.safeParse({ fleet: 'alpha', as: 'leader', contextSize: 'trimmed' }).success).toBe(true);
    expect(tool.args.safeParse({ fleet: 'alpha', as: 'leader', contextSize: 'full' }).success).toBe(false);
  });

  it('returns an explicit empty suggestion list for a member without arming anything', async () => {
    const out = parse(await invoke({ fleet: 'alpha', as: 'member' }));

    expect(out).toMatchObject({
      ok: true,
      slug: 'alpha',
      role: 'member',
      suggestedWatches: [],
    });
    expect(h.setPresenceFleet).toHaveBeenCalledWith('ws-1', 'su-me', 'alpha', 'member');
    expect(h.takeFleetLeadership).not.toHaveBeenCalled();
  });

  it('returns the leader suggest-tier call after the leadership transfer', async () => {
    const out = parse(await invoke({ fleet: 'alpha', as: 'leader' }));

    expect(out).toMatchObject({
      ok: true,
      role: 'leader',
      suggestedWatches: [
        {
          tool: 'events:await',
          args: { event: 'fleet:member-stalled:alpha' },
        },
      ],
    });
    expect(out.suggestedWatches[0].why).toMatch(/stalled member/i);
    expect(h.takeFleetLeadership).toHaveBeenCalledOnce();
  });
});
