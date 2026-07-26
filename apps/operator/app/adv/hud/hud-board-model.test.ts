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
import {
  buildHudBoard,
  contextPct,
  deriveBadges,
  deriveColumn,
  deriveFleetRollups,
  formatAge,
  HUD_DEFAULT_THRESHOLDS,
  isSuSession,
  shortHandle,
  toHudSession,
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
});

describe('deriveBadges', () => {
  it('marks the fleet leader', () => {
    const b = deriveBadges(entry({ fleetRole: 'leader', fleetSlug: 'atlas' }), OPTS);
    expect(b.find((x) => x.id === 'lead')?.label).toBe('LEAD');
  });

  it('surfaces standing modes with an explanation of what they mean for the human', () => {
    const b = deriveBadges(entry({ modes: ['auto', 'ideate'] }), OPTS);
    expect(b.map((x) => x.label)).toEqual(expect.arrayContaining(['AUTO', 'IDEATE']));
    expect(b.find((x) => x.id === 'mode-auto')?.title).toContain('without asking');
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

  it('ignores an ask with no attributable agent rather than mis-assigning it', () => {
    const board = buildHudBoard([entry()], [ask({ ownerAgentId: null })], { nowMs: NOW });
    expect(board.counts['needs-you']).toBe(0);
  });
});
