/**
 * fleet-peers tests (chat-popup-fleet-peers-rail-2026-08-09 P-001).
 *
 * The rail is a NAVIGATION surface, so the cases that get the most coverage are
 * the ones where a wrong answer sends the reader to the wrong agent or hides one
 * that needs them: which fleet a peer belongs to, which row is the reader's own,
 * and the attention-first ordering.
 *
 * `deriveFleetPeers` returning null is a first-class outcome (render no rail at
 * all), so every null case is asserted explicitly rather than inferred from an
 * empty list — an empty rail and no rail are different products.
 */

import { describe, it, expect } from 'vitest';
import { deriveFleetPeers } from './fleet-peers';
import { HUD_DEFAULT_THRESHOLDS, type HudRosterEntry } from '../../adv/hud/hud-board-model';

const NOW = Date.parse('2026-08-09T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const OPTS = { nowMs: NOW, thresholds: HUD_DEFAULT_THRESHOLDS };

const SELF = 'su-e8a25005-9a96-4d09-baf7-89fc7c103965';
const LEAD = 'su-b8422496-64f5-482d-9361-0bc74ac0cd1a';

/** A live, working, unremarkable fleet member. Overrides carry the interest. */
function entry(over: Partial<HudRosterEntry> = {}): HudRosterEntry {
  return {
    ownerId: SELF,
    label: 'su · su-e8a25',
    source: 'omp-hook-session',
    intent: 'draining the non-p2p bug backlog',
    currentFiles: [],
    liveness: 'live',
    sessionState: 'live',
    stale: false,
    lastActiveAt: iso(5_000),
    intentDeclaredAt: iso(60_000),
    loopArmed: false,
    modes: [],
    pidAlive: true,
    claims: [],
    declaredUnclaimed: false,
    currentPlanSlug: null,
    harnessSlug: null,
    agentPaneKind: 'su',
    role: 'su',
    agent: 'claude',
    advSessionId: 7,
    windowId: null,
    wakeMode: 'auto',
    pendingWakes: 0,
    fleetSlug: 'nonp2p-bug-drain',
    fleetColor: '#c4b5fd',
    fleetRole: 'member',
    contextTokens: null,
    compactionLimit: null,
    openAwait: null,
    thinking: false,
    ...over,
  };
}

const leader = (over: Partial<HudRosterEntry> = {}) =>
  entry({ ownerId: LEAD, label: 'su · su-b8422', fleetRole: 'leader', ...over });

describe('deriveFleetPeers — when there is no rail to render', () => {
  it('returns null for a SOLO agent (no fleetSlug)', () => {
    const rows = [entry({ fleetSlug: null, fleetColor: null, fleetRole: null })];
    expect(deriveFleetPeers(rows, SELF, OPTS)).toBeNull();
  });

  it('returns null when no agent is open', () => {
    expect(deriveFleetPeers([entry()], null, OPTS)).toBeNull();
  });

  it('returns null when the open agent is not in the roster at all', () => {
    expect(deriveFleetPeers([entry()], 'su-not-in-the-roster', OPTS)).toBeNull();
  });

  it('returns null for an empty roster', () => {
    expect(deriveFleetPeers([], SELF, OPTS)).toBeNull();
  });

  it('STILL returns a model when every peer is gone but the agent is in a fleet', () => {
    // Distinct from solo, and the reader needs to see it: your peers died. A
    // vanishing rail would report this as "you were never in a fleet".
    const model = deriveFleetPeers([entry()], SELF, OPTS);
    expect(model).not.toBeNull();
    expect(model!.total).toBe(1);
    expect(model!.leader).toBeNull();
    expect(model!.warning).toContain('no leader');
  });
});

describe('deriveFleetPeers — membership', () => {
  it('includes only the open agent’s own fleet', () => {
    const rows = [
      entry(),
      leader(),
      entry({ ownerId: 'su-other-fleet', fleetSlug: 'okf-frontmatter', fleetRole: 'member' }),
      entry({ ownerId: 'su-solo', fleetSlug: null, fleetRole: null }),
    ];
    const model = deriveFleetPeers(rows, SELF, OPTS)!;
    expect(model.fleetSlug).toBe('nonp2p-bug-drain');
    expect(model.total).toBe(2);
    const ids = [model.leader!.ownerId, ...model.members.map((m) => m.ownerId)];
    expect(ids).toEqual([LEAD, SELF]);
    expect(ids).not.toContain('su-other-fleet');
    expect(ids).not.toContain('su-solo');
  });

  it('separates the leader from the members', () => {
    const model = deriveFleetPeers([entry(), leader()], SELF, OPTS)!;
    expect(model.leader!.ownerId).toBe(LEAD);
    expect(model.leader!.isLeader).toBe(true);
    expect(model.members.map((m) => m.ownerId)).toEqual([SELF]);
  });

  it('marks the open agent as current, and ONLY that one', () => {
    const rows = [entry(), leader(), entry({ ownerId: 'su-peer-2' })];
    const model = deriveFleetPeers(rows, SELF, OPTS)!;
    const current = [model.leader!, ...model.members].filter((p) => p.isCurrent);
    expect(current).toHaveLength(1);
    expect(current[0].ownerId).toBe(SELF);
  });

  it('marks the LEADER as current when the leader is who you are viewing', () => {
    const model = deriveFleetPeers([entry(), leader()], LEAD, OPTS)!;
    expect(model.leader!.isCurrent).toBe(true);
    expect(model.members.every((m) => !m.isCurrent)).toBe(true);
  });

  it('includes cups, not just su sessions', () => {
    // Four of the live nonp2p-bug-drain fleet's 24 members are nursery cups; a
    // rail that silently filtered to su would under-report the fleet by a sixth.
    const cup = entry({
      ownerId: 's-1786238596028-9cae28bf',
      label: 'cup · papercusp',
      agentPaneKind: 'cup',
      role: 'principal',
      agent: null,
    });
    const model = deriveFleetPeers([entry(), cup], SELF, OPTS)!;
    expect(model.members.map((m) => m.ownerId)).toContain('s-1786238596028-9cae28bf');
    expect(model.members.find((m) => m.ownerId === 's-1786238596028-9cae28bf')!.agentPaneKind).toBe(
      'cup',
    );
  });

  it('takes the fleet colour from the open agent’s own row', () => {
    const model = deriveFleetPeers([entry(), leader()], SELF, OPTS)!;
    expect(model.fleetColor).toBe('#c4b5fd');
  });
});

describe('deriveFleetPeers — ordering', () => {
  it('sorts members attention-first, not alphabetically', () => {
    const rows = [
      leader(),
      entry({ ownerId: 'su-working' }),
      entry({ ownerId: 'su-parked', sessionState: 'parked', liveness: 'idle' }),
      entry({ ownerId: 'su-needs-you', pendingWakes: 2 }),
      entry({
        ownerId: 'su-blocked',
        openAwait: { eventKey: 'fleet:nonp2p-bug-drain:gate', sinceIso: iso(9 * 60_000) } as never,
      }),
      entry({
        ownerId: 'su-stalled',
        lastActiveAt: iso(40 * 60_000),
        intentDeclaredAt: iso(90 * 60_000),
      }),
    ];
    // Viewed from su-working — one of the rows above. The reader must be IN the
    // roster for there to be a fleet to derive; viewing an absent owner is the
    // null case, covered separately.
    const model = deriveFleetPeers(rows, 'su-working', OPTS)!;
    expect(model.members.map((m) => m.ownerId)).toEqual([
      'su-needs-you',
      'su-blocked',
      'su-stalled',
      'su-working',
      'su-parked',
    ]);
  });

  it('puts the longest-suffering first within one state', () => {
    const rows = [
      entry({ ownerId: 'su-stalled-20m', lastActiveAt: iso(20 * 60_000), intentDeclaredAt: iso(40 * 60_000) }),
      entry({ ownerId: 'su-stalled-90m', lastActiveAt: iso(90 * 60_000), intentDeclaredAt: iso(120 * 60_000) }),
      entry({ ownerId: 'su-stalled-45m', lastActiveAt: iso(45 * 60_000), intentDeclaredAt: iso(60 * 60_000) }),
    ];
    const model = deriveFleetPeers(rows, 'su-stalled-20m', OPTS)!;
    expect(model.members.map((m) => m.ownerId)).toEqual([
      'su-stalled-90m',
      'su-stalled-45m',
      'su-stalled-20m',
    ]);
  });

  it('keeps the reader’s own row in its state-ordered position, never pinned to the top', () => {
    // The rail is not "me and the others" — it is the fleet. Pinning self would
    // break the attention ordering that is the list's whole navigational value.
    const rows = [
      entry({ ownerId: SELF, sessionState: 'parked', liveness: 'idle' }),
      entry({ ownerId: 'su-needs-you', pendingWakes: 1 }),
    ];
    const model = deriveFleetPeers(rows, SELF, OPTS)!;
    expect(model.members.map((m) => m.ownerId)).toEqual(['su-needs-you', SELF]);
  });
});

describe('deriveFleetPeers — the health note', () => {
  it('is null when the fleet is all clear', () => {
    const model = deriveFleetPeers([entry(), leader()], SELF, OPTS)!;
    expect(model.warning).toBeNull();
  });

  it('names a missing leader', () => {
    const model = deriveFleetPeers([entry(), entry({ ownerId: 'su-peer-2' })], SELF, OPTS)!;
    expect(model.leader).toBeNull();
    expect(model.warning).toContain('no leader');
  });

  it('counts what needs a human, in the board’s own wording', () => {
    const rows = [
      leader(),
      entry({ ownerId: 'su-needs-you', pendingWakes: 1 }),
      entry({
        ownerId: 'su-stalled',
        lastActiveAt: iso(40 * 60_000),
        intentDeclaredAt: iso(90 * 60_000),
      }),
    ];
    const model = deriveFleetPeers(rows, LEAD, OPTS)!;
    expect(model.warning).toContain('1 needs you');
    expect(model.warning).toContain('1 stalled');
    // A working peer is not a warning — an all-clear fleet must stay quiet.
    expect(model.warning).not.toContain('working');
  });
});

describe('deriveFleetPeers — per-peer facts', () => {
  it('borrows the board’s column verdict rather than inventing a state word', () => {
    const rows = [
      entry({ ownerId: 'su-zombie', pidAlive: false }),
      entry({ ownerId: 'su-fresh', lastActiveAt: null }),
    ];
    const model = deriveFleetPeers(rows, 'su-zombie', OPTS)!;
    const zombie = model.members.find((m) => m.ownerId === 'su-zombie')!;
    const fresh = model.members.find((m) => m.ownerId === 'su-fresh')!;
    expect(zombie.column).toBe('stalled');
    expect(zombie.reason).toContain('zombie');
    expect(fresh.column).toBe('needs-you');
    expect(fresh.reason).toContain('Fresh session');
  });

  it('reports context as a percentage, and null when it was never sampled', () => {
    const rows = [
      entry({ ownerId: 'su-measured', contextTokens: 81_490, compactionLimit: 200_000 }),
      entry({ ownerId: 'su-unmeasured', contextTokens: null, compactionLimit: 200_000 }),
    ];
    const model = deriveFleetPeers(rows, 'su-measured', OPTS)!;
    expect(model.members.find((m) => m.ownerId === 'su-measured')!.contextPct).toBe(41);
    // NOT 0 — an unmeasured context shown as 0% reads as "plenty of room left".
    expect(model.members.find((m) => m.ownerId === 'su-unmeasured')!.contextPct).toBeNull();
  });

  it('shortens the owner id to a readable handle', () => {
    const model = deriveFleetPeers([entry(), leader()], SELF, OPTS)!;
    expect(model.leader!.handle).toBe('su-b8422496');
  });
});
