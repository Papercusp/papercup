/**
 * getAgentLeaderBrief — leadership drift (popup-agent-state-coverage-2026-08-18
 * P-013 / D-012).
 *
 * The bar here is the one this whole plan keeps re-applying: an ABSENCE must
 * never read as an all-clear. The specific absence is the one that used to be
 * structural — `if (!fleetSlug) return empty('no-fleet')` fired BEFORE the
 * registry was ever consulted, so an agent whose presence row carried no fleet
 * while `agent_fleets.leader_owner_id` said it LEADS one (the original
 * EI-18731216945970087 shape) rendered as the quiet, overwhelmingly-common
 * "leads nothing" skip. The pane blanked for exactly the agent whose own orient
 * was shouting drift at it, which is the case a leader most needs to see.
 *
 * These tests therefore assert the ORDER of reads as much as their result: that
 * the registry is consulted even when presence says there is nothing to consult
 * it about.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const activeWorkspaceId = vi.fn<() => string | null>(() => 'ws-1');
const fetchPresenceFleet =
  vi.fn<(owners: string[]) => Promise<Map<string, { fleetSlug: string | null; fleetRole: string | null }>>>();
const getFleet = vi.fn<(ws: string, slug: string) => Promise<{ leaderOwnerId: string | null } | null>>();
const listFleetsLedBy = vi.fn<(ws: string, owner: string) => Promise<Array<{ fleetSlug: string }>>>();
const buildLeaderBrief = vi.fn<() => Promise<{ data: unknown }>>();

vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => activeWorkspaceId() }));
vi.mock('./agent-tools/coordination/presence-fleet', () => ({
  fetchPresenceFleet: (owners: string[]) => fetchPresenceFleet(owners),
}));
vi.mock('./agent-fleets-store', () => ({
  getFleet: (ws: string, slug: string) => getFleet(ws, slug),
  listFleetsLedBy: (ws: string, owner: string) => listFleetsLedBy(ws, owner),
}));
vi.mock('./agent-tools/fleet/leader-brief', () => ({
  buildLeaderBrief: () => buildLeaderBrief(),
}));

import { getAgentLeaderBrief } from './adv-agent-leader-brief';

/** Presence places `owner` in `fleetSlug` with `fleetRole`; null = no fleet. */
function presence(fleetSlug: string | null, fleetRole: string | null = null) {
  fetchPresenceFleet.mockResolvedValue(new Map([['su-me', { fleetSlug, fleetRole }]]));
}

beforeEach(() => {
  vi.clearAllMocks();
  activeWorkspaceId.mockReturnValue('ws-1');
  buildLeaderBrief.mockResolvedValue({ data: { ok: true, members: [] } });
  getFleet.mockResolvedValue({ leaderOwnerId: null });
  listFleetsLedBy.mockResolvedValue([]);
});

describe('getAgentLeaderBrief — the registry cross-check runs before "leads nothing"', () => {
  it('reports drift and BUILDS the brief when presence has no fleet but the registry says it leads one', async () => {
    // The original failure, and the reason this cross-check exists.
    presence(null);
    listFleetsLedBy.mockResolvedValue([{ fleetSlug: 'p2p-release' }]);
    getFleet.mockResolvedValue({ leaderOwnerId: 'su-me' });

    const r = await getAgentLeaderBrief('su-me');

    expect(r.skipped).toBeNull();
    expect(r.brief).not.toBeNull();
    expect(r.fleetSlug).toBe('p2p-release');
    expect(r.presenceDrift?.kind).toBe('presence-behind');
    // The note must say the brief is REAL — a leader told only "drift" cannot
    // tell whether to trust what is under it.
    expect(r.presenceDrift?.note).toMatch(/REAL/);
    expect(r.presenceDrift?.note).toMatch(/showed no fleet at all/);
  });

  it('still returns the plain no-fleet skip — with NO drift — when the registry agrees it leads nothing', async () => {
    // The overwhelmingly common case must stay quiet and cheap.
    presence(null);
    const r = await getAgentLeaderBrief('su-me');

    expect(r.skipped).toBe('no-fleet');
    expect(r.presenceDrift).toBeUndefined();
    expect(buildLeaderBrief).not.toHaveBeenCalled();
  });

  it('consults the registry even when presence reports no fleet at all', async () => {
    // Asserts the ORDERING directly: this is the read whose absence was the bug,
    // and a passing "no-fleet" result above cannot distinguish "asked and got
    // nothing" from "never asked".
    presence(null);
    await getAgentLeaderBrief('su-me');
    expect(listFleetsLedBy).toHaveBeenCalledWith('ws-1', 'su-me');
  });

  it('reports drift when presence places it in the fleet but not as its leader', async () => {
    presence('p2p-release', 'member');
    listFleetsLedBy.mockResolvedValue([{ fleetSlug: 'p2p-release' }]);
    getFleet.mockResolvedValue({ leaderOwnerId: 'su-me' });

    const r = await getAgentLeaderBrief('su-me');

    expect(r.presenceDrift?.kind).toBe('presence-behind');
    expect(r.presenceDrift?.note).toMatch(/as 'member'/);
    expect(r.isLeader).toBe(true);
  });

  it('reports drift when the fleet it LEADS is not the fleet presence put it in', async () => {
    presence('other-fleet', 'member');
    listFleetsLedBy.mockResolvedValue([{ fleetSlug: 'p2p-release' }]);
    getFleet.mockResolvedValue({ leaderOwnerId: 'su-me' });

    const r = await getAgentLeaderBrief('su-me');

    expect(r.presenceDrift?.kind).toBe('presence-behind');
    expect(r.presenceDrift?.presenceFleetSlug).toBe('other-fleet');
    expect(r.presenceDrift?.note).toMatch(/placed it in 'other-fleet' instead/);
    // The brief is built for the fleet it actually leads, not the stale one.
    expect(r.fleetSlug).toBe('p2p-release');
  });
});

describe('getAgentLeaderBrief — the dangerous inverse', () => {
  it('flags registry-disowned when presence claims leadership the registry gives to someone else', async () => {
    // The hazard the function's own docblock names: a stale presence row
    // conjuring a brief for a fleet somebody else now leads.
    presence('p2p-release', 'leader');
    getFleet.mockResolvedValue({ leaderOwnerId: 'su-someone-else' });

    const r = await getAgentLeaderBrief('su-me');

    expect(r.presenceDrift?.kind).toBe('registry-disowned');
    expect(r.presenceDrift?.registeredLeader).toBe('su-someone-else');
    // The brief is still returned (the pane must not blank), but the note has
    // to say it may be describing a fleet this agent no longer leads.
    expect(r.brief).not.toBeNull();
    expect(r.presenceDrift?.note).toMatch(/no longer leads/);
  });

  it('flags an UNLED fleet too, naming that there is no leader rather than going quiet', async () => {
    presence('p2p-release', 'leader');
    getFleet.mockResolvedValue({ leaderOwnerId: null });

    const r = await getAgentLeaderBrief('su-me');

    expect(r.presenceDrift?.kind).toBe('registry-disowned');
    expect(r.presenceDrift?.note).toMatch(/no leader at all/);
  });

  it('reports NO drift when both sources agree this agent leads', async () => {
    // The all-clear, and the one case that must add nothing to the rail.
    presence('p2p-release', 'leader');
    listFleetsLedBy.mockResolvedValue([{ fleetSlug: 'p2p-release' }]);
    getFleet.mockResolvedValue({ leaderOwnerId: 'su-me' });

    const r = await getAgentLeaderBrief('su-me');

    expect(r.presenceDrift).toBeUndefined();
    expect(r.isLeader).toBe(true);
    expect(r.brief).not.toBeNull();
  });

  it('reports NO drift for an ordinary member of a fleet led by someone else', async () => {
    presence('p2p-release', 'member');
    getFleet.mockResolvedValue({ leaderOwnerId: 'su-someone-else' });

    const r = await getAgentLeaderBrief('su-me');

    expect(r.skipped).toBe('not-leader');
    expect(r.presenceDrift).toBeUndefined();
  });
});

describe('getAgentLeaderBrief — an unmeasured source is not a drift (D-011)', () => {
  it('takes the read-failed skip and reports NO drift when the registry read throws', async () => {
    // D-011's per-field test: a source we could not read is UNMEASURED, so it
    // cannot disagree with anything. Inventing a drift here would be a
    // fabricated finding, and suppressing the failure would be a false clean —
    // `read-failed` is the honest third answer.
    presence(null);
    listFleetsLedBy.mockRejectedValue(new Error('pg down'));
    // Asserted, not silenced: the source swears the failure is "surfaced, never
    // swallowed into a look-alike empty", and that promise is the only thing
    // separating this from a pane that quietly says "leads nothing".
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = await getAgentLeaderBrief('su-me');

    expect(r.skipped).toBe('read-failed');
    expect(r.presenceDrift).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('getAgentLeaderBrief(su-me) failed'),
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('does not consult the registry at all without a concrete workspace', async () => {
    activeWorkspaceId.mockReturnValue('*');
    const r = await getAgentLeaderBrief('su-me');
    expect(r.skipped).toBe('no-workspace');
    expect(listFleetsLedBy).not.toHaveBeenCalled();
  });

  it('prefers the fleet presence already agrees about when the agent leads several', async () => {
    // A multi-fleet leader's pane must not jump to an unrelated fleet of its
    // own on some other fleet's drift.
    presence('fleet-b', 'leader');
    listFleetsLedBy.mockResolvedValue([{ fleetSlug: 'fleet-a' }, { fleetSlug: 'fleet-b' }]);
    getFleet.mockResolvedValue({ leaderOwnerId: 'su-me' });

    const r = await getAgentLeaderBrief('su-me');

    expect(r.fleetSlug).toBe('fleet-b');
    expect(r.presenceDrift).toBeUndefined();
  });
});
