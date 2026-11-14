import { describe, expect, it, vi } from 'vitest';
import { resolveCallerFleetTeam } from './caller-fleet-team';

// WI-6554700010049073: the caller's fleet must come from fleet membership. A
// leader with a per-cup claim-spec override has no claim-spec fleetSlug, which
// silently disabled plans:start's member-held-lane rule (WI-6554700010048902).
describe('resolveCallerFleetTeam', () => {
  const leader = 'su-leader';

  it('returns live fleet members (minus the caller) for a leader whose membership names a fleet', async () => {
    const membership = vi.fn(async () => ({ fleetSlug: 'fleet-a' }));
    const members = vi.fn(async () => [leader, 'su-member-1', 'su-member-2', 'su-member-1', '']);
    const team = await resolveCallerFleetTeam({ workspaceId: 'ws', ownerId: leader }, { membership, members });
    expect(team).toEqual(['su-member-1', 'su-member-2']);
    expect(membership).toHaveBeenCalledWith('ws', leader);
    expect(members).toHaveBeenCalledWith('fleet-a');
  });

  it('returns [] without reading a roster when the caller is in no fleet', async () => {
    const members = vi.fn(async () => ['su-member-1']);
    for (const row of [null, { fleetSlug: null }]) {
      const team = await resolveCallerFleetTeam(
        { workspaceId: 'ws', ownerId: leader },
        { membership: async () => row, members },
      );
      expect(team).toEqual([]);
    }
    expect(members).not.toHaveBeenCalled();
  });

  it('propagates a membership read failure so the caller degrades explicitly', async () => {
    await expect(resolveCallerFleetTeam(
      { workspaceId: 'ws', ownerId: leader },
      { membership: async () => { throw new Error('membership down'); }, members: async () => [] },
    )).rejects.toThrow('membership down');
  });
});
