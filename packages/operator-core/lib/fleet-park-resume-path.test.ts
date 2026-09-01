/**
 * Tests for the park-directive resume-path semantics (WI-2034563 / P-008).
 *
 * The property that matters most is the LEGACY one: every winding-down row that
 * predates mig 1065 must resolve exactly as it did before, or this change silently
 * wedges every fleet currently parked. That is asserted first and explicitly.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPolicyParkedCapacity,
  describeParkResumePath,
  fleetParkOffersResumePath,
  formatParkDuration,
  resolveFleetParkResumePath,
  type FleetParkDirectiveLike,
} from './fleet-park-resume-path';

const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const HOUR = 3_600_000;

function park(over: Partial<FleetParkDirectiveLike> = {}): FleetParkDirectiveLike {
  return { controlState: 'winding-down', controlAt: NOW - 3 * HOUR, ...over };
}

describe('resolveFleetParkResumePath', () => {
  it('reports an active fleet as not parked', () => {
    const path = resolveFleetParkResumePath({ controlState: 'active' }, NOW);
    expect(path.parked).toBe(false);
    expect(fleetParkOffersResumePath(path)).toBe(false);
  });

  it('treats a null/absent record as not parked', () => {
    expect(resolveFleetParkResumePath(null, NOW).parked).toBe(false);
    expect(resolveFleetParkResumePath(undefined, NOW).parked).toBe(false);
  });

  it('only the literal winding-down state is a park', () => {
    // Same defence rowToRecord applies: a hand-forged value must not become a park.
    expect(resolveFleetParkResumePath({ controlState: 'WINDING-DOWN' }, NOW).parked).toBe(false);
    expect(resolveFleetParkResumePath({ controlState: 'paused' }, NOW).parked).toBe(false);
  });

  // ── the legacy guarantee ────────────────────────────────────────────────
  it('a pre-mig-1065 wind-down (no gate, no deadline, no flag) resolves as before: no resume path', () => {
    const path = resolveFleetParkResumePath(park(), NOW);
    expect(path.parked).toBe(true);
    expect(path.kind).toBe('none');
    expect(path.gate).toBeNull();
    expect(path.expiresAt).toBeNull();
    expect(path.expired).toBe(false);
    expect(path.terminal).toBe(false);
    // The load-bearing one: loop:end's wind-down exception still authorizes these,
    // so no fleet parked today is wedged by this change.
    expect(fleetParkOffersResumePath(path)).toBe(false);
    // But it is reported as indefinite so leader-brief can name the lost capacity.
    expect(path.indefinite).toBe(true);
  });

  it('a declared gate is a resume path', () => {
    const path = resolveFleetParkResumePath(park({ controlResumeGate: 'fleet:backend:resume' }), NOW);
    expect(path.kind).toBe('gate');
    expect(path.gate).toBe('fleet:backend:resume');
    expect(fleetParkOffersResumePath(path)).toBe(true);
    expect(path.indefinite).toBe(false);
  });

  it('a live deadline alone is a resume path; kind is deadline', () => {
    const path = resolveFleetParkResumePath(park({ controlExpiresAt: NOW + HOUR }), NOW);
    expect(path.kind).toBe('deadline');
    expect(fleetParkOffersResumePath(path)).toBe(true);
  });

  it('gate + live deadline is the strongest shape', () => {
    const path = resolveFleetParkResumePath(
      park({ controlResumeGate: 'fleet:backend:resume', controlExpiresAt: NOW + HOUR }),
      NOW,
    );
    expect(path.kind).toBe('both');
    expect(fleetParkOffersResumePath(path)).toBe(true);
  });

  it('an expired deadline with no gate is OVERDUE and offers no live path to join', () => {
    const path = resolveFleetParkResumePath(park({ controlExpiresAt: NOW - HOUR }), NOW);
    expect(path.kind).toBe('overdue');
    expect(path.expired).toBe(true);
    expect(path.indefinite).toBe(true);
    // Deliberate: a lapsed promise must not wedge a member forever.
    expect(fleetParkOffersResumePath(path)).toBe(false);
  });

  it('an expired deadline WITH a gate keeps the gate as the live path', () => {
    const path = resolveFleetParkResumePath(
      park({ controlResumeGate: 'fleet:backend:resume', controlExpiresAt: NOW - HOUR }),
      NOW,
    );
    expect(path.kind).toBe('gate');
    expect(path.expired).toBe(true);
    expect(fleetParkOffersResumePath(path)).toBe(true);
  });

  it('a deadline exactly at now counts as expired (boundary is inclusive)', () => {
    expect(resolveFleetParkResumePath(park({ controlExpiresAt: NOW }), NOW).expired).toBe(true);
  });

  it('a terminal park offers no resume path even when a gate/deadline is set', () => {
    const path = resolveFleetParkResumePath(
      park({ controlNoResumePath: true, controlResumeGate: 'fleet:backend:resume', controlExpiresAt: NOW + HOUR }),
      NOW,
    );
    expect(path.kind).toBe('terminal');
    expect(path.terminal).toBe(true);
    expect(path.indefinite).toBe(false);
    expect(fleetParkOffersResumePath(path)).toBe(false);
  });

  it('a blank gate string is not a gate', () => {
    const path = resolveFleetParkResumePath(park({ controlResumeGate: '   ' }), NOW);
    expect(path.gate).toBeNull();
    expect(fleetParkOffersResumePath(path)).toBe(false);
  });

  it('an unknown controlAt yields a null duration, never a zero', () => {
    expect(resolveFleetParkResumePath({ controlState: 'winding-down' }, NOW).parkedForMs).toBeNull();
    expect(resolveFleetParkResumePath(park({ controlAt: NOW - HOUR }), NOW).parkedForMs).toBe(HOUR);
  });

  it('a controlAt in the future clamps to 0 rather than reporting a negative age', () => {
    expect(resolveFleetParkResumePath(park({ controlAt: NOW + HOUR }), NOW).parkedForMs).toBe(0);
  });

  it('a non-finite deadline is treated as absent', () => {
    const path = resolveFleetParkResumePath(park({ controlExpiresAt: Number.NaN }), NOW);
    expect(path.expiresAt).toBeNull();
    expect(path.expired).toBe(false);
  });

  it('carries by/reason so a reporter needs no second read', () => {
    const path = resolveFleetParkResumePath(park({ controlBy: 'su-abc', controlReason: 'D-059 stand-down' }), NOW);
    expect(path.by).toBe('su-abc');
    expect(path.reason).toBe('D-059 stand-down');
  });
});

describe('describeParkResumePath', () => {
  it('names the exact gate key to await, so a member copies it rather than retyping it', () => {
    const text = describeParkResumePath(
      resolveFleetParkResumePath(park({ controlResumeGate: 'fleet:backend:resume' }), NOW),
    );
    expect(text).toContain("events:await { event: 'fleet:backend:resume' }");
    expect(text).toContain('LATCHES');
  });

  it('tells a terminal park that ending the loop is correct', () => {
    const text = describeParkResumePath(resolveFleetParkResumePath(park({ controlNoResumePath: true }), NOW));
    expect(text).toContain('TERMINAL');
  });

  it('calls out an indefinite park with no gate and no deadline', () => {
    expect(describeParkResumePath(resolveFleetParkResumePath(park(), NOW))).toContain('INDEFINITE');
  });

  it('flags a passed deadline instead of quietly presenting it as a bound', () => {
    const text = describeParkResumePath(resolveFleetParkResumePath(park({ controlExpiresAt: NOW - HOUR }), NOW));
    expect(text).toContain('PASSED');
  });
});

describe('formatParkDuration', () => {
  it('reports unknown rather than a fabricated zero', () => {
    expect(formatParkDuration(null)).toBe('an unknown duration');
  });
  it('formats the ranges a park realistically spans', () => {
    expect(formatParkDuration(30_000)).toBe('under a minute');
    expect(formatParkDuration(45 * 60_000)).toBe('45m');
    expect(formatParkDuration(2 * HOUR)).toBe('2h');
    expect(formatParkDuration(2 * HOUR + 30 * 60_000)).toBe('2h30m');
    expect(formatParkDuration(50 * HOUR)).toBe('2d2h');
  });
});

describe('buildPolicyParkedCapacity', () => {
  it('returns nothing for an unparked fleet or a park with no live members', () => {
    expect(
      buildPolicyParkedCapacity({
        fleet: 'backend',
        liveMembers: 4,
        path: resolveFleetParkResumePath({ controlState: 'active' }, NOW),
      }),
    ).toBeUndefined();
    expect(
      buildPolicyParkedCapacity({ fleet: 'backend', liveMembers: 0, path: resolveFleetParkResumePath(park(), NOW) }),
    ).toBeUndefined();
  });

  it('names the count, the invoker, the reason and the duration', () => {
    const row = buildPolicyParkedCapacity({
      fleet: 'nonp2p-bug-drain',
      liveMembers: 23,
      path: resolveFleetParkResumePath(
        park({ controlBy: 'su-leader', controlReason: 'D-059 stand-down', controlAt: NOW - 3 * HOUR }),
        NOW,
      ),
    });
    expect(row?.members).toBe(23);
    expect(row?.message).toContain('23 members of nonp2p-bug-drain policy-parked by su-leader');
    expect(row?.message).toContain('D-059 stand-down');
    expect(row?.message).toContain('3h');
  });

  it('tells the leader NOT to relaunch recoverable parked members', () => {
    const row = buildPolicyParkedCapacity({
      fleet: 'backend',
      liveMembers: 5,
      path: resolveFleetParkResumePath(park({ controlResumeGate: 'fleet:backend:resume' }), NOW),
    });
    expect(row?.message).toContain('Do NOT relaunch');
    expect(row?.message).toContain('fleet:backend:resume');
  });

  it('reports an indefinite park as indefinite lost capacity', () => {
    const row = buildPolicyParkedCapacity({ fleet: 'backend', liveMembers: 2, path: resolveFleetParkResumePath(park(), NOW) });
    expect(row?.indefinite).toBe(true);
    expect(row?.message).toContain('INDEFINITE');
  });

  it('reports an overdue park as overdue, not as bounded', () => {
    const row = buildPolicyParkedCapacity({
      fleet: 'backend',
      liveMembers: 2,
      path: resolveFleetParkResumePath(park({ controlExpiresAt: NOW - HOUR }), NOW),
    });
    expect(row?.kind).toBe('overdue');
    expect(row?.message).toContain('OVERDUE');
  });

  it('does not count a terminal park against the headcount target', () => {
    const row = buildPolicyParkedCapacity({
      fleet: 'backend',
      liveMembers: 2,
      path: resolveFleetParkResumePath(park({ controlNoResumePath: true }), NOW),
    });
    expect(row?.message).toContain('retired capacity');
  });

  it('uses singular wording for one member', () => {
    const row = buildPolicyParkedCapacity({ fleet: 'backend', liveMembers: 1, path: resolveFleetParkResumePath(park(), NOW) });
    expect(row?.message).toContain('1 member of backend');
  });
});
