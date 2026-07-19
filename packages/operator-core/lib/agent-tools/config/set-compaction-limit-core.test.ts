/**
 * Unit tests for `setCompactionLimitForOwner` — the P-006 cross-session compaction-limit
 * setter (per-member-declarative-launch-specs). Presence / fleet-store / model-spec seams are
 * mocked; the REAL `classifyFleetControlInvoker` (pure) and REAL `agent-config-constants`
 * (clamp / role-cap) run, so leader/queen/owner authorization AND the target-role-derived
 * ceiling (300k member vs 400k leader on [1m]) are exercised for real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getFleet = vi.fn();
const setCompactionLimit = vi.fn();
const getPresence = vi.fn();
const fetchPresenceFleet = vi.fn();
const resolveModelSpecForOwner = vi.fn();
const classifyAgentPane = vi.fn();

const CALLER = 'su-caller';
const WS = 'ws';

vi.mock('@papercusp/agent-mcp', () => ({
  classifyAgentPane: (...a: unknown[]) => classifyAgentPane(...a),
}));
vi.mock('../../agent-fleets-store', () => ({ getFleet: (...a: unknown[]) => getFleet(...a) }));
vi.mock('../coordination/presence', () => ({
  setCompactionLimit: (...a: unknown[]) => setCompactionLimit(...a),
  getPresence: (...a: unknown[]) => getPresence(...a),
}));
vi.mock('../coordination/presence-fleet', () => ({
  fetchPresenceFleet: (...a: unknown[]) => fetchPresenceFleet(...a),
}));
vi.mock('../../compaction-usage', () => ({
  resolveModelSpecForOwner: (...a: unknown[]) => resolveModelSpecForOwner(...a),
}));
vi.mock('../fleet_registry/_shared', () => ({
  resolveFleetCaller: () => ({
    identity: { ownerId: CALLER, workspaceId: WS },
    ownerId: CALLER,
    workspaceId: WS,
  }),
}));

import { setCompactionLimitForOwner } from './set-compaction-limit-core';

/** target presence-fleet map helper */
function fleetMap(target: string, fleetSlug: string | null, fleetRole: string | null) {
  return new Map(fleetSlug ? [[target, { fleetSlug, fleetRole }]] : []);
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveModelSpecForOwner.mockResolvedValue('opus[1m]'); // 400k leader / 300k member gap
  classifyAgentPane.mockReturnValue({ kind: 'su' }); // default: owner-grade pane
  getPresence.mockResolvedValue({ agentRole: 'su', compactionLimit: null });
});

describe('setCompactionLimitForOwner (P-006 cross-session limit setter)', () => {
  it('a fleet leader sets a MEMBER limit, clamped to the 300k member ceiling', async () => {
    fetchPresenceFleet.mockResolvedValue(fleetMap('su-mem', 'rocket', 'member'));
    getFleet.mockResolvedValue({ leaderOwnerId: CALLER }); // caller IS this fleet's leader
    getPresence.mockImplementation(async (id: string) =>
      id === 'su-mem' ? { compactionLimit: 300_000 } : { agentRole: 'su' },
    );
    const out = await setCompactionLimitForOwner({ workspaceId: WS } as never, 'su-mem', 500_000);
    expect(setCompactionLimit).toHaveBeenCalledWith('su-mem', 300_000); // clamped down to member cap
    expect(out).toMatchObject({
      ok: true,
      invokedAs: 'leader',
      targetOwnerId: 'su-mem',
      compactionLimit: 300_000,
      cap: 300_000,
      clamped: true,
      requested: 500_000,
      fleet: 'rocket',
      targetRole: 'member',
    });
  });

  it('the queen (mug/kettle pane) may set a member limit even when not its leader', async () => {
    fetchPresenceFleet.mockResolvedValue(fleetMap('su-mem', 'rocket', 'member'));
    getFleet.mockResolvedValue({ leaderOwnerId: 'su-someone-else' });
    classifyAgentPane.mockReturnValue({ kind: 'mug' }); // queen
    getPresence.mockImplementation(async (id: string) =>
      id === 'su-mem' ? { compactionLimit: 250_000 } : { agentRole: 'mug' },
    );
    const out = await setCompactionLimitForOwner({ workspaceId: WS } as never, 'su-mem', 250_000);
    expect(setCompactionLimit).toHaveBeenCalledWith('su-mem', 250_000); // within cap → verbatim
    expect(out).toMatchObject({ ok: true, invokedAs: 'queen', compactionLimit: 250_000 });
    expect(out.clamped).toBeUndefined();
  });

  it('refuses a caller who is neither the leader nor a queen/owner pane', async () => {
    fetchPresenceFleet.mockResolvedValue(fleetMap('su-mem', 'rocket', 'member'));
    getFleet.mockResolvedValue({ leaderOwnerId: 'su-someone-else' });
    classifyAgentPane.mockReturnValue({ kind: 'cup' }); // not leader, not su/mug/kettle
    const out = await setCompactionLimitForOwner({ workspaceId: WS } as never, 'su-mem', 250_000);
    expect(out).toMatchObject({ ok: false, error: 'not_authorized' });
    expect(setCompactionLimit).not.toHaveBeenCalled();
  });

  it('clamps to the 400k LEADER ceiling when the target is itself a leader', async () => {
    fetchPresenceFleet.mockResolvedValue(fleetMap('su-lead2', 'other', 'leader'));
    getFleet.mockResolvedValue({ leaderOwnerId: 'su-lead2' }); // target leads; caller is owner (su)
    getPresence.mockImplementation(async (id: string) =>
      id === 'su-lead2' ? { compactionLimit: 400_000 } : { agentRole: 'su' },
    );
    const out = await setCompactionLimitForOwner({ workspaceId: WS } as never, 'su-lead2', 500_000);
    expect(setCompactionLimit).toHaveBeenCalledWith('su-lead2', 400_000); // leader cap, not 300k
    expect(out).toMatchObject({ ok: true, invokedAs: 'owner', cap: 400_000, targetRole: 'leader' });
  });

  it('reports ok:false + a note when the target has no live presence row to persist onto', async () => {
    fetchPresenceFleet.mockResolvedValue(fleetMap('su-gone', 'rocket', 'member'));
    getFleet.mockResolvedValue({ leaderOwnerId: CALLER });
    getPresence.mockImplementation(async (id: string) =>
      id === 'su-gone' ? null : { agentRole: 'su' },
    );
    const out = await setCompactionLimitForOwner({ workspaceId: WS } as never, 'su-gone', 250_000);
    expect(out.ok).toBe(false);
    expect(out.note).toMatch(/no live presence row/);
  });
});
