/**
 * leader-brief-alerts (popup-agent-state-coverage-2026-08-18 P-003 + P-004).
 *
 * The bar these tests hold the derivation to is NOT "does it render the flag" —
 * it is "can an ABSENCE here ever be read as an all-clear". Every case below
 * that looks paranoid is a shape the brief's own source comments name as one
 * that already fooled a leader: a failed read that looks like a quiet fleet, a
 * null lane count that looks like a drained queue, an invariant that errored
 * instead of passing, and a bench nudge pointed at a starving member.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveLeaderBriefAlerts,
  deriveMemberAlerts,
  type MemberAlert,
} from './leader-brief-alerts';
import type {
  AgentLeaderBrief,
  LeaderBriefData,
  LeaderBriefMemberRow,
} from '../../adv/sessions/use-agent-leader-brief';

function member(over: Partial<LeaderBriefMemberRow> = {}): LeaderBriefMemberRow {
  return { agentId: 'su-aaaa', ...over };
}

function briefed(brief: Partial<LeaderBriefData>, over: Partial<AgentLeaderBrief> = {}): AgentLeaderBrief {
  return {
    ownerId: 'su-leader',
    fleetSlug: 'p2p-release',
    presenceFleetRole: 'leader',
    registeredLeader: 'su-leader',
    isLeader: true,
    skipped: null,
    brief: { ok: true, ...brief },
    ...over,
  };
}

const keys = (alerts: MemberAlert[]) => alerts.map((a) => a.key);

describe('deriveMemberAlerts — the six intervene-now signals', () => {
  it('marks a dormant member as act-now, not merely a warning', () => {
    const [alert] = deriveMemberAlerts(member({ dormant: true }));
    expect(alert.key).toBe('dormant');
    expect(alert.glyph).toBe('D');
    expect(alert.severity).toBe('bad');
    // The sentence must say WHY it cannot self-recover; "dormant" alone reads
    // like "idle", which is the misreading the signal exists to prevent.
    expect(alert.title).toMatch(/no self-wake/i);
  });

  it('reports spinning with the age of the last PRODUCTIVE call', () => {
    const [alert] = deriveMemberAlerts(member({ spinning: true, productiveToolCallAgeMs: 3_060_000 }));
    expect(alert.key).toBe('spinning');
    expect(alert.title).toContain('51m');
    // The whole point of this signal: every other liveness surface says healthy.
    expect(alert.title).toMatch(/healthy/i);
  });

  it('says a spinning member is unmeasured rather than fresh when no productive call is on record', () => {
    const [alert] = deriveMemberAlerts(member({ spinning: true, productiveToolCallAgeMs: null }));
    // A null age must never render as "0s ago" — that reads as a member that
    // just did productive work, the exact inverse of the finding.
    expect(alert.title).toContain('unknown');
    expect(alert.title).not.toMatch(/\b0s\b/);
  });

  it('renders throttled with the wall it is waiting on, not a cadence reading', () => {
    const [alert] = deriveMemberAlerts(
      member({ throttled: { reason: 'usage_limit', until: '2026-08-19T04:41:00Z' } }),
    );
    expect(alert.key).toBe('throttled');
    expect(alert.title).toContain('04:41Z');
    expect(alert.title).toContain('usage_limit');
    expect(alert.title).toMatch(/not a normal cadence tick/i);
  });

  it('keeps an unparseable throttle timestamp instead of dropping it', () => {
    const [alert] = deriveMemberAlerts(member({ throttled: { reason: 'rate_limited', until: 'soon' } }));
    expect(alert.title).toContain('soon');
  });

  it('distinguishes the two coord-deaf states', () => {
    expect(deriveMemberAlerts(member({ coordHook: 'missing' }))[0].title).toMatch(/no inbox read/i);
    expect(deriveMemberAlerts(member({ coordHook: 'stale' }))[0].title).toMatch(/budget window/i);
    // Both must say the operational consequence, which is the actionable half.
    for (const state of ['missing', 'stale'] as const) {
      expect(deriveMemberAlerts(member({ coordHook: state }))[0].title).toMatch(/coord:send/i);
    }
  });

  it('carries the takeover remedy and the event being waited on', () => {
    const [alert] = deriveMemberAlerts(
      member({
        verifiedWaitTakeovers: [
          { eventKey: 'fleet:p2p:green', classification: 'stalled', remedy: 'Take the diagnosis over.' },
        ],
      }),
    );
    expect(alert.key).toBe('takeover');
    expect(alert.severity).toBe('bad');
    expect(alert.title).toContain('fleet:p2p:green');
    expect(alert.title).toContain('Take the diagnosis over.');
  });

  it('counts the takeovers it did not name rather than showing only the first', () => {
    const [alert] = deriveMemberAlerts(
      member({
        verifiedWaitTakeovers: [
          { eventKey: 'a', classification: 'stalled' },
          { eventKey: 'b', classification: 'absent' },
          { eventKey: 'c', classification: 'absent' },
        ],
      }),
    );
    expect(alert.title).toContain('+2 more');
  });
});

describe('deriveMemberAlerts — bench suggestion must not invert the remedy', () => {
  // EI-18681259560385029: `idle-with-claimable` counts a STARVATION symptom.
  // Benching it is the one action that cannot help, and a leader reading a
  // generic "bench suggested" does exactly that.
  it('tells the leader NOT to bench an idle-with-claimable member', () => {
    const [alert] = deriveMemberAlerts(
      member({
        benchSuggestion: {
          kind: 'idle-with-claimable',
          reason: 'queue has 14 rows',
          item: null,
          itemTitle: null,
        },
      }),
    );
    expect(alert.key).toBe('bench');
    expect(alert.title).toMatch(/do NOT bench/i);
    expect(alert.title).toMatch(/starvation/i);
  });

  it('reads as an ordinary bench nudge for the benchable branches', () => {
    const [alert] = deriveMemberAlerts(
      member({
        benchSuggestion: {
          kind: 'laneless-idle',
          reason: 'no lane',
          item: 'WI-1',
          itemTitle: 'a thing',
        },
      }),
    );
    expect(alert.title).toMatch(/^Bench suggested/);
    expect(alert.title).toContain('WI-1');
    expect(alert.title).toContain('a thing');
    expect(alert.title).not.toMatch(/do NOT bench/i);
  });
});

describe('deriveMemberAlerts — what they SAID vs what HAPPENED', () => {
  it('separates unanswered directed mail from directive actuation', () => {
    const alerts = deriveMemberAlerts(
      member({
        unanswered: { count: 2, oldestAgeMs: 4_800_000, newest: [{ summary: 'ship it' }] },
        directives: { total: 3, satisfied: 1, notYet: 2, unprovable: 0, outstanding: ['WI-9 not closed'] },
      }),
    );
    const unanswered = alerts.find((a) => a.key === 'unanswered')!;
    const directives = alerts.find((a) => a.key === 'directives')!;
    expect(unanswered.title).toMatch(/ASKED/);
    expect(unanswered.title).toContain('ship it');
    expect(unanswered.title).toContain('80m');
    expect(directives.title).toMatch(/HAPPENED/);
    expect(directives.title).toContain('WI-9 not closed');
  });

  it('is silent on both when the counts are zero', () => {
    const alerts = deriveMemberAlerts(
      member({
        unanswered: { count: 0, oldestAgeMs: 0, newest: [] },
        directives: { total: 4, satisfied: 4, notYet: 0, unprovable: 0, outstanding: [] },
      }),
    );
    expect(alerts).toEqual([]);
  });
});

describe('deriveMemberAlerts — ordering', () => {
  it('puts act-now signals ahead of look-at-it ones', () => {
    const alerts = deriveMemberAlerts(
      member({
        unanswered: { count: 1, oldestAgeMs: 1000 },
        throttled: { reason: 'rate_limited', until: null },
        spinning: true,
        dormant: true,
        coordHook: 'stale',
      }),
    );
    expect(keys(alerts)).toEqual(['dormant', 'spinning', 'coord-deaf', 'throttled', 'unanswered']);
  });

  it('returns nothing at all for a healthy member', () => {
    expect(deriveMemberAlerts(member({ lastToolCallAgeMs: 1200, stalled: false }))).toEqual([]);
  });
});

describe('deriveLeaderBriefAlerts — an absence is never an all-clear', () => {
  it('returns null when there is no brief to render', () => {
    expect(deriveLeaderBriefAlerts(null)).toBeNull();
    expect(deriveLeaderBriefAlerts(undefined)).toBeNull();
  });

  it('stays silent for the three quiet skip reasons', () => {
    for (const skipped of ['no-fleet', 'not-leader', 'no-workspace'] as const) {
      const model = deriveLeaderBriefAlerts({
        ownerId: 'su-x',
        fleetSlug: skipped === 'no-fleet' ? null : 'f',
        presenceFleetRole: null,
        registeredLeader: null,
        isLeader: false,
        skipped,
        brief: null,
      });
      expect(model, skipped).toBeNull();
    }
  });

  it('SHOUTS when the read itself failed — the one skip reason that is news', () => {
    const model = deriveLeaderBriefAlerts({
      ownerId: 'su-x',
      fleetSlug: null,
      presenceFleetRole: null,
      registeredLeader: null,
      isLeader: false,
      skipped: 'read-failed',
      brief: null,
    })!;
    expect(model.fleet!.alerts[0].key).toBe('read-failed');
    expect(model.fleet!.alerts[0].severity).toBe('bad');
    // `briefed:false` is what lets the rail avoid implying the members below it
    // were checked and found healthy.
    expect(model.briefed).toBe(false);
    expect(model.fleet!.alerts[0].detail).toMatch(/nothing below was checked/i);
  });

  it('renders an ok:false brief as a finding, not as silence', () => {
    const model = deriveLeaderBriefAlerts(
      briefed({ ok: false, error: 'no_fleet', hint: 'pass { fleet }' }),
    )!;
    expect(model.fleet!.alerts[0].key).toBe('brief-error');
    expect(model.fleet!.alerts[0].detail).toBe('pass { fleet }');
    expect(model.briefed).toBe(false);
  });

  it('renders no fleet block at all for a clean fleet', () => {
    const model = deriveLeaderBriefAlerts(
      briefed({ summary: { fleet: 'p2p', members: 3 }, members: [member()] }),
    )!;
    expect(model.fleet).toBeNull();
    expect(model.byMember).toEqual({});
    // …but it DID read a brief, which is different from having none.
    expect(model.briefed).toBe(true);
  });
});

describe('deriveLeaderBriefAlerts — the fleet-level block (P-004)', () => {
  it('carries each flag WITH the reason sentence behind it', () => {
    const model = deriveLeaderBriefAlerts(
      briefed({
        summary: { specStarvedAlert: true, idleWithClaimableAlert: true, idle_with_claimable: 2 },
        specStarvedAlertReason: '0 rows match, pool has 14',
        idleWithClaimableAlertReason: '2 members idle',
      }),
    )!;
    const spec = model.fleet!.alerts.find((a) => a.key === 'spec-starved')!;
    expect(spec.detail).toBe('0 rows match, pool has 14');
    const idle = model.fleet!.alerts.find((a) => a.key === 'idle-with-claimable')!;
    expect(idle.text).toBe('2 idle with claimable');
  });

  it('orders act-now findings above look-at-it ones', () => {
    const model = deriveLeaderBriefAlerts(
      briefed({
        summary: {
          strandedFleetAlert: true,
          specAuthorshipAlert: true,
          floorStarvedAlert: true,
          fleet_paused: true,
        },
      }),
    )!;
    const sevs = model.fleet!.alerts.map((a) => a.severity);
    expect(sevs.indexOf('warn')).toBeGreaterThan(sevs.lastIndexOf('bad'));
  });

  it('fires on an invariant that could not RUN, not only on a violated one', () => {
    const model = deriveLeaderBriefAlerts(
      briefed({
        summary: { customInvariantAlert: true },
        customInvariants: [
          { key: 'spec-drift', status: 'error', error: 'column does not exist' },
          { key: 'other', status: 'satisfied' },
        ],
      }),
    )!;
    const inv = model.fleet!.alerts.find((a) => a.key === 'invariants')!;
    expect(inv.text).toContain('could not run');
    expect(inv.detail).toContain('column does not exist');
    // A check that errors protects the leader from nothing, so it must not be
    // counted toward "all satisfied".
    expect(model.fleet!.invariantsNote).toBeNull();
  });

  it('says invariants ran clean ONLY when the block is already open', () => {
    const allSatisfied = [
      { key: 'a', status: 'satisfied' as const },
      { key: 'b', status: 'satisfied' as const },
    ];
    // Nothing else firing ⇒ no block at all, so the note has nowhere to live
    // and the clean fleet stays silent (D-003).
    expect(deriveLeaderBriefAlerts(briefed({ customInvariants: allSatisfied }))!.fleet).toBeNull();
    // Something else firing ⇒ the leader is reading the block, and now needs to
    // know their checks are actually running.
    const open = deriveLeaderBriefAlerts(
      briefed({ summary: { fleet_paused: true }, customInvariants: allSatisfied }),
    )!;
    expect(open.fleet!.invariantsNote).toBe('2 invariants · all satisfied');
  });

  it('explains a pause as compliance rather than failure', () => {
    const model = deriveLeaderBriefAlerts(
      briefed({ summary: { fleet_paused: true }, fleetPausedReason: 'owner said stand down' }),
    )!;
    const paused = model.fleet!.alerts.find((a) => a.key === 'paused')!;
    expect(paused.detail).toContain('owner said stand down');
    expect(paused.detail).toMatch(/COMPLYING/);
  });

  it('does not double-report a gated lane as both floor-starved and laneless-idle', () => {
    const model = deriveLeaderBriefAlerts(
      briefed({ summary: { floorStarvedAlert: true, laneless_idle: 3 } }),
    )!;
    expect(model.fleet!.alerts.map((a) => a.key)).toContain('floor-starved');
    expect(model.fleet!.alerts.map((a) => a.key)).not.toContain('laneless-idle');
  });

  it('reports laneless idle on its own when the floor alert did not fire', () => {
    const model = deriveLeaderBriefAlerts(briefed({ summary: { laneless_idle: 3 } }))!;
    expect(model.fleet!.alerts.map((a) => a.key)).toContain('laneless-idle');
  });

  it('renders a degraded pool even when no member is individually throttled', () => {
    // WI-37161: the pool can be exhausted for everyone at once while every
    // member's own `throttled` reads absent. A rail that only showed the
    // per-member signal would call that fleet healthy.
    const model = deriveLeaderBriefAlerts(
      briefed({
        summary: { throttled: 0, pool_capacity: { degraded: true, factor: 0, queueDepth: 7 } },
      }),
    )!;
    const cap = model.fleet!.alerts.find((a) => a.key === 'capacity')!;
    expect(cap.text).toContain('degraded');
    expect(cap.text).toContain('q 7');
    expect(model.fleet!.capacity).toContain('degraded');
  });

  it('does not treat an UNREAD pool as a healthy one', () => {
    // null means unread this call. It must not render a capacity line at all —
    // and it must certainly not render as "healthy".
    const model = deriveLeaderBriefAlerts(
      briefed({ summary: { fleet_paused: true, pool_capacity: null } }),
    )!;
    expect(model.fleet!.capacity).toBeNull();
    expect(model.fleet!.alerts.map((a) => a.key)).not.toContain('capacity');
  });

  it('escalates unowned criticals as an escalation to act on', () => {
    const model = deriveLeaderBriefAlerts(briefed({ summary: { unowned_criticals: 4 } }))!;
    const alert = model.fleet!.alerts.find((a) => a.key === 'unowned-criticals')!;
    expect(alert.text).toBe('4 unowned criticals');
    expect(alert.severity).toBe('bad');
    expect(alert.detail).toMatch(/not weather to wait out/i);
  });
});

describe('deriveLeaderBriefAlerts — member index', () => {
  it('keys alerts by agentId and omits members with nothing to say', () => {
    const model = deriveLeaderBriefAlerts(
      briefed({
        members: [
          member({ agentId: 'su-dorm', dormant: true }),
          member({ agentId: 'su-fine' }),
          member({ agentId: 'su-deaf', coordHook: 'stale' }),
        ],
      }),
    )!;
    expect(Object.keys(model.byMember).sort()).toEqual(['su-deaf', 'su-dorm']);
    expect(keys(model.byMember['su-dorm'])).toEqual(['dormant']);
  });

  it('survives a member row with no agentId rather than keying alerts under undefined', () => {
    const model = deriveLeaderBriefAlerts(
      briefed({ members: [{ dormant: true } as LeaderBriefMemberRow, member({ agentId: 'su-ok' })] }),
    )!;
    expect(Object.keys(model.byMember)).toEqual([]);
  });

  it('tolerates a payload with no members array at all (SPA/sidecar wire skew)', () => {
    const model = deriveLeaderBriefAlerts(briefed({ summary: { fleet_paused: true } }))!;
    expect(model.byMember).toEqual({});
    expect(model.fleet!.alerts).toHaveLength(1);
  });
});
