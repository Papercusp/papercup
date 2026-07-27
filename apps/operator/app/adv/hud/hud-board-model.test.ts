/**
 * hud-board-model tests (adv-hud-fleet-board-2026-07-25 P-002).
 *
 * The precedence chain is the design, so it gets the most coverage: a session
 * can satisfy several column predicates at once and only ONE ordering is
 * correct. The `blocked` > `stalled` case matters most — mislabelling a
 * legitimately-gated agent as stalled would cry wolf on the signal the board
 * exists to make trustworthy.
 */

import { describe, it, expect } from 'vitest';
import { MODES, modeById } from '@papercusp/operator-core/lib/modes/registry';
import {
  buildHudBoard,
  contextPct,
  deriveBadges,
  deriveColumn,
  deriveFleetRollups,
  derivePlanRollups,
  formatAge,
  HUD_DEFAULT_THRESHOLDS,
  isInfrastructureAwait,
  isSuSession,
  shortHandle,
  toHudSession,
  unattributedAsks,
  type HudAsk,
  type HudRosterEntry,
} from './hud-board-model';

const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const OPTS = { nowMs: NOW, thresholds: HUD_DEFAULT_THRESHOLDS };

function entry(over: Partial<HudRosterEntry> = {}): HudRosterEntry {
  return {
    ownerId: 'su-11112222-3333-4444-5555-666677778888',
    label: 'su · su-11112',
    source: 'omp-hook-session',
    intent: 'greening the release gate',
    currentFiles: [],
    liveness: 'live',
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
    fleetSlug: null,
    fleetColor: null,
    fleetRole: null,
    contextTokens: null,
    compactionLimit: null,
    openAwait: null,
    thinking: false,
    ...over,
  };
}

const ask = (over: Partial<HudAsk> = {}): HudAsk => ({
  ownerAgentId: 'su-11112222-3333-4444-5555-666677778888',
  title: 'Drop the legacy shim, or migrate the 4 callers?',
  occurredAt: iso(12 * 60_000),
  id: 'work-item-needs-human:WI-1',
  kind: 'work-item-needs-human',
  itemRef: null,
  planSlug: null,
  harnessSlug: 'papercusp',
  ...over,
});

describe('shortHandle', () => {
  it('trims a uuid owner id to its readable leading segment', () => {
    expect(shortHandle('su-709bb0d6-12de-465e-bb82-0f4bb282c87a')).toBe('su-709bb0d6');
  });
  it('leaves an already-short id alone', () => {
    expect(shortHandle('su-abc')).toBe('su-abc');
  });
  it('truncates an unrecognised long id rather than overflowing a card', () => {
    expect(shortHandle('a'.repeat(40))).toHaveLength(17); // 16 + ellipsis
  });
});

describe('contextPct', () => {
  it('computes a percentage from tokens and limit', () => {
    expect(contextPct(120_000, 200_000)).toBe(60);
  });
  it('returns null — never 0 — when either input is unknown', () => {
    // 0 would render as "plenty of room left", the exact opposite of "unknown".
    expect(contextPct(null, 200_000)).toBeNull();
    expect(contextPct(120_000, null)).toBeNull();
  });
  it('guards a zero/negative limit instead of dividing by it', () => {
    expect(contextPct(10, 0)).toBeNull();
  });
  it('clamps a context that has overrun its limit', () => {
    expect(contextPct(300_000, 200_000)).toBe(100);
  });
});

describe('formatAge', () => {
  it('scales the unit with the magnitude', () => {
    expect(formatAge(40)).toBe('40s');
    expect(formatAge(12 * 60)).toBe('12m');
    expect(formatAge(3 * 3600)).toBe('3h');
    expect(formatAge(2 * 86400)).toBe('2d');
  });
  it('renders unknown as an em dash, not "0s"', () => {
    expect(formatAge(null)).toBe('—');
  });
});

describe('isSuSession', () => {
  it('accepts an su pane kind and rejects a nursery cup', () => {
    expect(isSuSession(entry({ agentPaneKind: 'su' }))).toBe(true);
    expect(isSuSession(entry({ agentPaneKind: 'cup' }))).toBe(false);
    expect(isSuSession(entry({ agentPaneKind: 'mug' }))).toBe(false);
  });
});

describe('deriveColumn — precedence', () => {
  it('routes an unanswered ask to needs-you, dated from the ask', () => {
    const v = deriveColumn(entry(), [ask()], OPTS);
    expect(v.column).toBe('needs-you');
    expect(v.reason).toContain('legacy shim');
    expect(v.sinceSec).toBe(12 * 60);
  });

  it('picks the OLDEST ask when several are outstanding', () => {
    const v = deriveColumn(
      entry(),
      [ask({ title: 'recent', occurredAt: iso(60_000) }), ask({ title: 'oldest', occurredAt: iso(30 * 60_000) })],
      OPTS,
    );
    expect(v.reason).toBe('oldest');
    expect(v.sinceSec).toBe(30 * 60);
  });

  it('treats a staged manual-mode wake as needs-you — the message is undelivered', () => {
    const v = deriveColumn(entry({ pendingWakes: 2, wakeMode: 'manual' }), undefined, OPTS);
    expect(v.column).toBe('needs-you');
    expect(v.reason).toContain('2 wakes staged');
  });

  it('needs-you OUTRANKS blocked — a gated agent that also asked you is yours first', () => {
    const v = deriveColumn(
      entry({ openAwait: { eventKey: 'fleet:gate', note: null, sinceIso: iso(60 * 60_000), expiresIso: null } }),
      [ask()],
      OPTS,
    );
    expect(v.column).toBe('needs-you');
  });

  it('routes an open await to blocked, naming the gate and how long it has waited', () => {
    const v = deriveColumn(
      entry({
        openAwait: {
          eventKey: 'fleet:release-gate:suite-green',
          note: null,
          sinceIso: iso(41 * 60_000),
          expiresIso: null,
        },
      }),
      undefined,
      OPTS,
    );
    expect(v.column).toBe('blocked');
    expect(v.reason).toBe('Waiting on fleet:release-gate:suite-green');
    expect(v.sinceSec).toBe(41 * 60);
  });

  it("prefers the agent's own note over the raw key, keeping the key for reference", () => {
    const v = deriveColumn(
      entry({
        openAwait: {
          eventKey: 'fleet:gate',
          note: 'waiting for the suite verdict',
          sinceIso: iso(1000),
          expiresIso: null,
        },
      }),
      undefined,
      OPTS,
    );
    expect(v.reason).toBe('waiting for the suite verdict (fleet:gate)');
  });

  it('does NOT treat the always-armed inbox wake as a block', () => {
    // The single most important guard in this file. Every agent carries a
    // permanent `coord:inbox-wake:<self>` await (migration 183) meaning "I am
    // reachable" — the opposite of blocked. Measured live on 2026-07-25 while
    // building this board: 126 of 139 open awaits were inbox-wakes, one per
    // agent, against 13 real gates. Counting them put ~93% of the roster in
    // Blocked, which does not merely add noise — it destroys the column, since
    // a signal that fires for nearly everyone distinguishes no one.
    const v = deriveColumn(
      entry({
        openAwait: {
          eventKey: 'coord:inbox-wake:su-11112222-3333-4444-5555-666677778888',
          note: null,
          sinceIso: iso(3 * 60 * 60_000),
          expiresIso: null,
        },
      }),
      undefined,
      OPTS,
    );
    expect(v.column).toBe('working');
  });

  it('classifies infrastructure vs real gates', () => {
    expect(isInfrastructureAwait({ eventKey: 'coord:inbox-wake:su-1', note: null, sinceIso: iso(0), expiresIso: null })).toBe(true);
    // Real gates seen live: work-item:*, gate-first-green, composed-root.
    expect(isInfrastructureAwait({ eventKey: 'work-item:done:WI-5779', note: null, sinceIso: iso(0), expiresIso: null })).toBe(false);
    expect(isInfrastructureAwait({ eventKey: 'gate-first-green', note: null, sinceIso: iso(0), expiresIso: null })).toBe(false);
    expect(isInfrastructureAwait(null)).toBe(false);
  });

  it('still blocks on a real gate held by an agent that also has an inbox wake', () => {
    // The server picks the OLDEST non-inbox await, so a real gate must survive.
    const v = deriveColumn(
      entry({
        openAwait: { eventKey: 'work-item:done:WI-5779', note: null, sinceIso: iso(20 * 60_000), expiresIso: null },
      }),
      undefined,
      OPTS,
    );
    expect(v.column).toBe('blocked');
    expect(v.reason).toContain('work-item:done:WI-5779');
  });

  it('blocked OUTRANKS stalled — a gated agent is behaving correctly, not stuck', () => {
    // This entry satisfies every stall predicate: no activity for an hour and an
    // intent two hours old. It is still Blocked, because it is *waiting on
    // purpose*. Calling it stalled is the false positive that would make the
    // stall column untrustworthy.
    const v = deriveColumn(
      entry({
        lastActiveAt: iso(60 * 60_000),
        intentDeclaredAt: iso(120 * 60_000),
        openAwait: { eventKey: 'fleet:gate', note: null, sinceIso: iso(60 * 60_000), expiresIso: null },
      }),
      undefined,
      OPTS,
    );
    expect(v.column).toBe('blocked');
  });

  it('flags stalled only when BOTH the activity and intent clocks are dead', () => {
    const stalled = deriveColumn(
      entry({ lastActiveAt: iso(20 * 60_000), intentDeclaredAt: iso(40 * 60_000) }),
      undefined,
      OPTS,
    );
    expect(stalled.column).toBe('stalled');
    expect(stalled.reason).toContain('No tool call in 20m');
  });

  it('does NOT call a long task with fresh tool calls stalled', () => {
    // Old intent (one long job) but active 5s ago — this is working, and
    // labelling it stalled is the other way to make the column useless.
    const v = deriveColumn(
      entry({ lastActiveAt: iso(5_000), intentDeclaredAt: iso(90 * 60_000) }),
      undefined,
      OPTS,
    );
    expect(v.column).toBe('working');
  });

  it('does NOT call a quiet-but-recently-redeclared agent stalled', () => {
    const v = deriveColumn(
      entry({ lastActiveAt: iso(20 * 60_000), intentDeclaredAt: iso(60_000) }),
      undefined,
      OPTS,
    );
    expect(v.column).not.toBe('stalled');
  });

  it('reports a zombie (fresh heartbeat, dead process) as stalled with its own reason', () => {
    const v = deriveColumn(entry({ pidAlive: false, liveness: 'live' }), undefined, OPTS);
    expect(v.column).toBe('stalled');
    expect(v.reason).toContain('zombie');
  });

  it('keeps a loop-armed agent working through the idle gap between wakes', () => {
    const v = deriveColumn(
      entry({ liveness: 'idle', loopArmed: true, lastActiveAt: iso(30_000), intentDeclaredAt: iso(30_000) }),
      undefined,
      OPTS,
    );
    expect(v.column).toBe('working');
  });

  it('parks an idle session, and distinguishes ended from not-yet-started', () => {
    expect(deriveColumn(entry({ liveness: 'idle', lastActiveAt: iso(120_000), intentDeclaredAt: iso(120_000) }), undefined, OPTS).column).toBe('parked');
    expect(deriveColumn(entry({ liveness: 'stale', stale: true }), undefined, OPTS).reason).toContain('ended');
    expect(deriveColumn(entry({ liveness: 'pending' }), undefined, OPTS).reason).toContain('not started');
  });

  /**
   * Owner ask 2026-07-27: "all fresh sessions start as needs you". A just-launched
   * session used to land in `parked`, which read as "idle, fine" for the one case
   * where the human is the only thing that can move it forward.
   */
  describe('fresh sessions (never taken a turn)', () => {
    it('puts a pending launch in needs-you, not parked', () => {
      const v = deriveColumn(entry({ liveness: 'pending', lastActiveAt: null }), undefined, OPTS);
      expect(v.column).toBe('needs-you');
      expect(v.reason).toMatch(/Fresh session/);
      expect(v.reason).toMatch(/not started yet/);
    });

    it('puts a booted-but-never-active session in needs-you too', () => {
      const v = deriveColumn(entry({ liveness: 'live', lastActiveAt: null }), undefined, OPTS);
      expect(v.column).toBe('needs-you');
      expect(v.reason).toMatch(/no turn taken yet/);
    });

    it('does NOT call a never-active session that has since DIED fresh — that one is parked', () => {
      // The column's value is that everything in it is actionable; a dead session
      // is not, however little it ever ran.
      expect(deriveColumn(entry({ liveness: 'stale', stale: true, lastActiveAt: null }), undefined, OPTS).column).toBe(
        'parked',
      );
      expect(deriveColumn(entry({ liveness: 'stale', stale: false, lastActiveAt: null }), undefined, OPTS).column).toBe(
        'parked',
      );
    });

    it('still shows a real ask ahead of the generic fresh reason', () => {
      const v = deriveColumn(entry({ liveness: 'pending', lastActiveAt: null }), [ask()], OPTS);
      expect(v.column).toBe('needs-you');
      expect(v.reason).not.toMatch(/Fresh session/);
    });

    it('leaves a session that HAS taken a turn classified exactly as before', () => {
      // Non-vacuity guard: the same accessor returns a different column once
      // lastActiveAt is set, so the assertions above cannot be passing trivially.
      expect(deriveColumn(entry({ liveness: 'live' }), undefined, OPTS).column).toBe('working');
      expect(
        deriveColumn(entry({ liveness: 'idle', lastActiveAt: iso(120_000), intentDeclaredAt: iso(120_000) }), undefined, OPTS)
          .column,
      ).toBe('parked');
    });
  });
});

describe('deriveBadges', () => {
  it('does NOT badge fleet leadership — that is identity, rendered beside the handle', () => {
    // Emitting it here too rendered "LEAD" twice on every leader card and burnt
    // one of the capped badge slots. `isLeader` on the session carries it.
    const b = deriveBadges(entry({ fleetRole: 'leader', fleetSlug: 'atlas' }), OPTS);
    expect(b.find((x) => x.id === 'lead')).toBeUndefined();
    expect(toHudSession(entry({ fleetRole: 'leader' }), undefined, OPTS).isLeader).toBe(true);
  });

  it('surfaces standing modes with an explanation of what they mean for the human', () => {
    const b = deriveBadges(
      entry({ modes: [{ mode: 'auto' }, { mode: 'ideate' }] }),
      OPTS,
    );
    expect(b.map((x) => x.label)).toEqual(expect.arrayContaining(['AUTO', 'IDEATE']));
    expect(b.find((x) => x.id === 'mode-auto')?.title).toContain(modeById('auto')!.oneLiner);
  });

  // The hand-written label/title map this replaced covered auto/ideate/drain
  // only, so `cold-auto` and `grade` rendered "Standing mode: grade" — a chip
  // that names a thing and explains nothing. Deriving from the registry means a
  // mode added there is explained the same day; this fails if that regresses.
  it('explains EVERY registered mode, not just the three someone wrote copy for', () => {
    for (const def of MODES) {
      const chip = deriveBadges(entry({ modes: [{ mode: def.id }] }), OPTS).find(
        (x) => x.id === `mode-${def.id}`,
      );
      expect(chip, def.id).toBeDefined();
      expect(chip!.title, def.id).toContain(def.oneLiner);
      expect(chip!.title, def.id).not.toContain('Standing mode:');
      // 'cold-auto' must read as a label, not an id.
      expect(chip!.label, def.id).toBe(def.id.toUpperCase().replace(/-/g, ' '));
    }
  });

  // Provenance is the half that makes the chip actionable: "it is in AUTO because
  // I put it there" (sticky against peers) vs "it put ITSELF in AUTO".
  it('distinguishes an owner-armed mode from one the agent set itself', () => {
    const owner = deriveBadges(entry({ modes: [{ mode: 'auto', ownerDirected: true }] }), OPTS)
      .find((x) => x.id === 'mode-auto')!;
    const self = deriveBadges(entry({ modes: [{ mode: 'auto', ownerDirected: false }] }), OPTS)
      .find((x) => x.id === 'mode-auto')!;
    expect(owner.ownerDirected).toBe(true);
    expect(owner.title).toContain('Set by the owner');
    expect(self.ownerDirected).toBe(false);
    expect(self.title).toContain('set this itself');
  });

  // A payload from an operator predating the provenance upgrade (federation, or a
  // mid-deploy SSE push) still carries bare strings. Render chips, don't throw.
  it('tolerates the legacy bare-string mode payload', () => {
    const b = deriveBadges(entry({ modes: ['drain'] }), OPTS);
    const chip = b.find((x) => x.id === 'mode-drain');
    expect(chip?.label).toBe('DRAIN');
    expect(chip?.ownerDirected).toBe(false);
  });

  it('marks mode chips as modes so the card can exempt them from the chip cap', () => {
    const b = deriveBadges(entry({ modes: [{ mode: 'auto' }], claims: [{ status: 'wip' }] }), OPTS);
    expect(b.find((x) => x.id === 'mode-auto')?.kind).toBe('mode');
    expect(b.find((x) => x.id === 'claims')?.kind).not.toBe('mode');
  });

  it('shows claim progress and turns good when the lane is complete', () => {
    const b = deriveBadges(
      entry({ claims: [{ status: 'done' }, { status: 'done' }, { status: 'wip' }] }),
      OPTS,
    );
    const chip = b.find((x) => x.id === 'claims');
    expect(chip?.label).toBe('2/3');
    expect(chip?.tone).toBe('neutral');
    const all = deriveBadges(entry({ claims: [{ status: 'done' }] }), OPTS).find((x) => x.id === 'claims');
    expect(all?.tone).toBe('good');
  });

  it('shows context only once it matters, escalating to bad past the critical band', () => {
    expect(deriveBadges(entry({ contextTokens: 20_000, compactionLimit: 200_000 }), OPTS).find((x) => x.id === 'ctx')).toBeUndefined();
    expect(deriveBadges(entry({ contextTokens: 130_000, compactionLimit: 200_000 }), OPTS).find((x) => x.id === 'ctx')?.tone).toBe('warn');
    expect(deriveBadges(entry({ contextTokens: 180_000, compactionLimit: 200_000 }), OPTS).find((x) => x.id === 'ctx')?.tone).toBe('bad');
  });

  it('warns on manual wake mode — the difference between ignored and never heard', () => {
    const chip = deriveBadges(entry({ wakeMode: 'manual' }), OPTS).find((x) => x.id === 'wake');
    expect(chip?.tone).toBe('warn');
    expect(chip?.title).toContain('staged');
  });

  it('flags a declared-but-unclaimed lane', () => {
    const chip = deriveBadges(entry({ declaredUnclaimed: true, currentPlanSlug: 'p' }), OPTS).find((x) => x.id === 'unclaimed');
    expect(chip?.tone).toBe('warn');
  });
});

describe('deriveFleetRollups', () => {
  const mk = (over: Partial<HudRosterEntry>) => toHudSession(entry(over), undefined, OPTS);

  it('groups by fleet, records the leader, and counts per column', () => {
    const sessions = [
      mk({ ownerId: 'su-aaaaaaaa-1', fleetSlug: 'atlas', fleetRole: 'leader' }),
      mk({ ownerId: 'su-bbbbbbbb-2', fleetSlug: 'atlas', fleetRole: 'member' }),
      mk({
        ownerId: 'su-cccccccc-3',
        fleetSlug: 'atlas',
        fleetRole: 'member',
        openAwait: { eventKey: 'g', note: null, sinceIso: iso(1000), expiresIso: null },
      }),
    ];
    const [atlas] = deriveFleetRollups(sessions);
    expect(atlas.total).toBe(3);
    expect(atlas.leaderOwnerId).toBe('su-aaaaaaaa-1');
    expect(atlas.byColumn.blocked).toBe(1);
    expect(atlas.warning).toBe('1 blocked');
  });

  it('stays silent when a fleet is healthy — an absent warning is meaningful', () => {
    const [g] = deriveFleetRollups([mk({ fleetSlug: 'atlas', fleetRole: 'leader' })]);
    expect(g.warning).toBeNull();
  });

  it('calls out a leaderless fleet — nobody can reclaim claims or open its gates', () => {
    const [g] = deriveFleetRollups([mk({ fleetSlug: 'atlas', fleetRole: 'member' })]);
    expect(g.warning).toBe('no leader');
  });

  it('does not demand a leader for the solo group', () => {
    const [g] = deriveFleetRollups([mk({ fleetSlug: null })]);
    expect(g.warning).toBeNull();
  });

  it('sorts the neediest fleet first and solo last', () => {
    const rollups = deriveFleetRollups([
      mk({ ownerId: 'su-11111111-a', fleetSlug: null }),
      mk({ ownerId: 'su-22222222-b', fleetSlug: 'calm', fleetRole: 'leader' }),
      mk({
        ownerId: 'su-33333333-c',
        fleetSlug: 'busy',
        fleetRole: 'leader',
        openAwait: { eventKey: 'g', note: null, sinceIso: iso(1000), expiresIso: null },
      }),
    ]);
    expect(rollups.map((r) => r.label)).toEqual(['busy', 'calm', 'solo']);
  });
});

describe('derivePlanRollups (P-004)', () => {
  const mk = (over: Partial<HudRosterEntry>) => toHudSession(entry(over), undefined, OPTS);

  it('groups by plan and counts per column', () => {
    const rollups = derivePlanRollups([
      mk({ ownerId: 'su-aaaaaaaa-1', currentPlanSlug: 'alpha' }),
      mk({ ownerId: 'su-bbbbbbbb-2', currentPlanSlug: 'alpha' }),
      mk({
        ownerId: 'su-cccccccc-3',
        currentPlanSlug: 'alpha',
        openAwait: { eventKey: 'g', note: null, sinceIso: iso(1000), expiresIso: null },
      }),
    ]);
    expect(rollups).toHaveLength(1);
    expect(rollups[0].total).toBe(3);
    expect(rollups[0].byColumn.blocked).toBe(1);
    expect(rollups[0].warning).toBe('1 blocked');
  });

  it('stays silent when a plan is healthy', () => {
    const [g] = derivePlanRollups([mk({ currentPlanSlug: 'alpha' })]);
    expect(g.warning).toBeNull();
  });

  // A plan has no leader, so the fleet rollup's "no leader" warning must NOT
  // come along for the ride — it would be chrome that lies.
  it('never invents a leaderless warning for a plan', () => {
    const [g] = derivePlanRollups([mk({ currentPlanSlug: 'alpha', fleetRole: 'member' })]);
    expect(g.warning).toBeNull();
  });

  it('makes the unbound sessions their own filterable group, sorted last', () => {
    const rollups = derivePlanRollups([
      mk({ ownerId: 'su-11111111-a', currentPlanSlug: null }),
      mk({ ownerId: 'su-22222222-b', currentPlanSlug: 'calm' }),
      mk({
        ownerId: 'su-33333333-c',
        currentPlanSlug: 'busy',
        openAwait: { eventKey: 'g', note: null, sinceIso: iso(1000), expiresIso: null },
      }),
    ]);
    expect(rollups.map((r) => r.label)).toEqual(['busy', 'calm', 'no plan']);
    expect(rollups[2].planSlug).toBeNull();
  });
});

describe('buildHudBoard', () => {
  it('filters to su sessions by default so nursery cups cannot rebuild the firehose', () => {
    const board = buildHudBoard(
      [entry({ ownerId: 'su-aaaaaaaa-1' }), entry({ ownerId: 's-1700-cup', agentPaneKind: 'cup' })],
      [],
      { nowMs: NOW },
    );
    expect(board.total).toBe(1);
    expect(board.counts.working).toBe(1);
  });

  it('can opt in to the whole roster', () => {
    const board = buildHudBoard(
      [entry({ ownerId: 'su-aaaaaaaa-1' }), entry({ ownerId: 's-1700-cup', agentPaneKind: 'cup' })],
      [],
      { nowMs: NOW, suOnly: false },
    );
    expect(board.total).toBe(2);
  });

  it('filters by fleet, with null selecting the solo group', () => {
    const roster = [
      entry({ ownerId: 'su-aaaaaaaa-1', fleetSlug: 'atlas' }),
      entry({ ownerId: 'su-bbbbbbbb-2', fleetSlug: null }),
    ];
    expect(buildHudBoard(roster, [], { nowMs: NOW, fleets: ['atlas'] }).total).toBe(1);
    expect(buildHudBoard(roster, [], { nowMs: NOW, fleets: [null] }).total).toBe(1);
    expect(buildHudBoard(roster, [], { nowMs: NOW, fleets: [] }).total).toBe(2);
  });

  it('filters by plan, with null selecting the unbound group', () => {
    const roster = [
      entry({ ownerId: 'su-aaaaaaaa-1', currentPlanSlug: 'alpha' }),
      entry({ ownerId: 'su-bbbbbbbb-2', currentPlanSlug: null }),
    ];
    expect(buildHudBoard(roster, [], { nowMs: NOW, plans: ['alpha'] }).total).toBe(1);
    expect(buildHudBoard(roster, [], { nowMs: NOW, plans: [null] }).total).toBe(1);
    expect(buildHudBoard(roster, [], { nowMs: NOW, plans: [] }).total).toBe(2);
  });

  // P-004's "driven by the fleets currently in view", as an assertion: the plan
  // options are derived from the FLEET-filtered set, so selecting a fleet
  // narrows what the plan picker offers.
  it('derives the plan options from the fleet-filtered sessions', () => {
    const roster = [
      entry({ ownerId: 'su-aaaaaaaa-1', fleetSlug: 'atlas', currentPlanSlug: 'alpha' }),
      entry({ ownerId: 'su-bbbbbbbb-2', fleetSlug: 'borealis', currentPlanSlug: 'beta' }),
    ];
    expect(buildHudBoard(roster, [], { nowMs: NOW }).plans.map((p) => p.label))
      .toEqual(['alpha', 'beta']);
    expect(buildHudBoard(roster, [], { nowMs: NOW, fleets: ['atlas'] }).plans.map((p) => p.label))
      .toEqual(['alpha']);
  });

  /* The other half of that ordering, and the one a refactor is most likely to
     break: the options are derived BEFORE the plan filter narrows the board.
     Derive them after and the picker eats its own list — the control collapses
     to the single row already selected and the only way to reach another plan
     is to clear the filter first. */
  it('keeps every in-view plan on offer while one of them is selected', () => {
    const roster = [
      entry({ ownerId: 'su-aaaaaaaa-1', currentPlanSlug: 'alpha' }),
      entry({ ownerId: 'su-bbbbbbbb-2', currentPlanSlug: 'beta' }),
    ];
    const board = buildHudBoard(roster, [], { nowMs: NOW, plans: ['alpha'] });
    expect(board.total).toBe(1);
    expect(board.plans.map((p) => p.label)).toEqual(['alpha', 'beta']);

    // Non-vacuity, by fixture rather than by breaking the source: this is what
    // `plans` WOULD hold if it were derived one line later, from the sessions
    // that survive the filter. The assertion above passes only because the two
    // differ, so a refactor that moves the derivation reds this test.
    const ifDerivedAfterTheFilter = derivePlanRollups(
      board.columns.flatMap((c) => c.sessions),
    ).map((p) => p.label);
    expect(ifDerivedAfterTheFilter).toEqual(['alpha']);
    expect(board.plans.map((p) => p.label)).not.toEqual(ifDerivedAfterTheFilter);
  });

  it('emits every column even when empty, with an all-clear message', () => {
    const board = buildHudBoard([entry()], [], { nowMs: NOW });
    expect(board.columns.map((c) => c.id)).toEqual([
      'needs-you', 'working', 'blocked', 'stalled', 'parked',
    ]);
    expect(board.columns.find((c) => c.id === 'blocked')?.empty).toBe('Nothing is waiting on a gate');
  });

  it('sorts the longest-waiting card to the top of its column', () => {
    const board = buildHudBoard(
      [
        entry({
          ownerId: 'su-aaaaaaaa-1',
          openAwait: { eventKey: 'a', note: null, sinceIso: iso(5 * 60_000), expiresIso: null },
        }),
        entry({
          ownerId: 'su-bbbbbbbb-2',
          openAwait: { eventKey: 'b', note: null, sinceIso: iso(90 * 60_000), expiresIso: null },
        }),
      ],
      [],
      { nowMs: NOW },
    );
    const blocked = board.columns.find((c) => c.id === 'blocked')!;
    expect(blocked.sessions.map((s) => s.handle)).toEqual(['su-bbbbbbbb', 'su-aaaaaaaa']);
  });

  it('routes an ask to its own agent only, leaving peers untouched', () => {
    const board = buildHudBoard(
      [entry({ ownerId: 'su-aaaaaaaa-1' }), entry({ ownerId: 'su-bbbbbbbb-2' })],
      [ask({ ownerAgentId: 'su-aaaaaaaa-1' })],
      { nowMs: NOW },
    );
    expect(board.counts['needs-you']).toBe(1);
    expect(board.columns.find((c) => c.id === 'needs-you')!.sessions[0].ownerId).toBe('su-aaaaaaaa-1');
  });

  it('ignores an ask with no attributable agent rather than mis-assigning it, but surfaces it on board.unattributed', () => {
    const board = buildHudBoard([entry()], [ask({ ownerAgentId: null, id: 'improvement:EI-1', kind: 'improvement' })], {
      nowMs: NOW,
    });
    // Not assigned to any session's needs-you column...
    expect(board.counts['needs-you']).toBe(0);
    // ...but not dropped either — hud-consolidation-2026-07-26 P-002's coverage
    // gate: a needs-human ask with no owning agent must still render SOMEWHERE.
    expect(board.unattributed).toHaveLength(1);
    expect(board.unattributed[0].id).toBe('improvement:EI-1');
  });
});

describe('unattributedAsks (hud-consolidation-2026-07-26 P-002)', () => {
  it('keeps only asks with no ownerAgentId', () => {
    const out = unattributedAsks([
      ask({ id: 'a', ownerAgentId: 'su-aaaaaaaa-1' }),
      ask({ id: 'b', ownerAgentId: null }),
      ask({ id: 'c', ownerAgentId: '' as unknown as null }),
    ]);
    expect(out.map((a) => a.id)).toEqual(['b', 'c']);
  });

  it('sorts oldest first, unknown occurredAt last', () => {
    const out = unattributedAsks([
      ask({ id: 'newer', ownerAgentId: null, occurredAt: iso(5 * 60_000) }),
      ask({ id: 'older', ownerAgentId: null, occurredAt: iso(60 * 60_000) }),
      ask({ id: 'unknown', ownerAgentId: null, occurredAt: null }),
    ]);
    expect(out.map((a) => a.id)).toEqual(['older', 'newer', 'unknown']);
  });

  it('is empty for an all-attributed input, never throwing on an empty array', () => {
    expect(unattributedAsks([])).toEqual([]);
    expect(unattributedAsks([ask({ ownerAgentId: 'su-aaaaaaaa-1' })])).toEqual([]);
  });
});
