import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEADER_BLOCKER_STALL_THRESHOLD_HOURS,
  computeLeaderBlockerStallAlert,
  type LeaderBlockerStallAlertInput,
} from './leader-blocker-stall-alert';

const row = (over: Partial<LeaderBlockerStallAlertInput> = {}): LeaderBlockerStallAlertInput => ({
  itemRef: 'WI-40086',
  fleet: 'loop-observability',
  openBlockedCount: 2,
  holderId: null,
  holderLive: null,
  hoursSinceProgress: 5,
  ...over,
});

describe('computeLeaderBlockerStallAlert', () => {
  it('fires for an unowned blocker at the default four-hour threshold', () => {
    const verdict = computeLeaderBlockerStallAlert(row({ hoursSinceProgress: 4 }));

    expect(verdict.alert).toBe(true);
    expect(verdict.thresholdHours).toBe(DEFAULT_LEADER_BLOCKER_STALL_THRESHOLD_HOURS);
    if (verdict.alert !== true) throw new Error('expected the alert to fire');
    expect(verdict.reason).toContain('unowned');
    expect(verdict.reason).toContain('blocks 2 open item(s)');
  });

  it('fires when the resolved holder is non-live', () => {
    const verdict = computeLeaderBlockerStallAlert(
      row({ holderId: 'su-dead', holderLive: false, hoursSinceProgress: 9 }),
    );

    expect(verdict.alert).toBe(true);
    if (verdict.alert !== true) throw new Error('expected the alert to fire');
    expect(verdict.reason).toContain('held by non-live session su-dead');
  });

  it.each([
    ['nothing open is blocked', row({ openBlockedCount: 0 })],
    ['the holder is live', row({ holderId: 'su-live', holderLive: true })],
    ['progress is newer than the threshold', row({ hoursSinceProgress: 3.999 })],
  ])('stays clear when %s', (_label, input) => {
    const verdict = computeLeaderBlockerStallAlert(input);
    expect(verdict).toEqual({ alert: false, thresholdHours: 4 });
  });

  it('honours a custom threshold including its exact boundary', () => {
    expect(computeLeaderBlockerStallAlert(row({ hoursSinceProgress: 1.99, thresholdHours: 2 })).alert).toBe(false);
    const verdict = computeLeaderBlockerStallAlert(row({ hoursSinceProgress: 2, thresholdHours: 2 }));
    expect(verdict.alert).toBe(true);
    expect(verdict.thresholdHours).toBe(2);
  });

  it.each([
    ['open-blocked-count-unmeasured', row({ openBlockedCount: null })],
    ['open-blocked-count-unmeasured', row({ openBlockedCount: Number.NaN })],
    ['holder-ownership-unmeasured', row({ holderId: undefined })],
    ['holder-liveness-unmeasured', row({ holderId: 'su-unresolved', holderLive: null })],
    ['progress-age-unmeasured', row({ hoursSinceProgress: undefined })],
    ['progress-age-unmeasured', row({ hoursSinceProgress: Number.POSITIVE_INFINITY })],
  ] as const)('returns in-band unknown code %s', (code, input) => {
    const verdict = computeLeaderBlockerStallAlert(input);

    expect(verdict.alert).toBeNull();
    if (verdict.alert !== null) throw new Error('expected an unknown alert verdict');
    expect(verdict.unknown.code).toBe(code);
    expect(verdict.reason).toContain('UNKNOWN');
    expect(verdict.falsifier).toBeUndefined();
  });

  it('short-circuits later unknowns when an earlier condition is known false', () => {
    expect(
      computeLeaderBlockerStallAlert(
        row({ openBlockedCount: 0, holderId: undefined, holderLive: null, hoursSinceProgress: null }),
      ),
    ).toEqual({ alert: false, thresholdHours: 4 });
    expect(
      computeLeaderBlockerStallAlert(row({ holderId: 'su-live', holderLive: true, hoursSinceProgress: null })),
    ).toEqual({ alert: false, thresholdHours: 4 });
  });

  it('falls back to the safe default for an invalid threshold', () => {
    const verdict = computeLeaderBlockerStallAlert(row({ thresholdHours: -1 }));
    expect(verdict.thresholdHours).toBe(4);
    expect(verdict.alert).toBe(true);
  });

  it('ships a populated, read-only, independent falsifier only when firing', () => {
    const verdict = computeLeaderBlockerStallAlert(row());
    if (verdict.alert !== true) throw new Error('expected the alert to fire');

    expect(verdict.falsifier).toEqual({
      tool: 'fleet:assignments',
      check: "fleet:assignments { fleet: 'loop-observability', include_stale: true }",
      measurement: expect.stringContaining('independent of the dependency-ranked bottleneck row'),
      kills: expect.stringContaining('do not reclaim, wake, or reassign'),
    });
    expect(verdict.falsifier.check).not.toContain('scheduler:get_next');
    expect(computeLeaderBlockerStallAlert(row({ openBlockedCount: 0 })).falsifier).toBeUndefined();
    expect(computeLeaderBlockerStallAlert(row({ hoursSinceProgress: null })).falsifier).toBeUndefined();
  });

  it('escapes the fleet in the rendered falsifier call', () => {
    const verdict = computeLeaderBlockerStallAlert(row({ fleet: "fleet'\\suffix" }));
    if (verdict.alert !== true) throw new Error('expected the alert to fire');
    expect(verdict.falsifier.check).toBe("fleet:assignments { fleet: 'fleet\\'\\\\suffix', include_stale: true }");
  });

  it('degrades to the caller fleet when the explicit fleet is unresolved', () => {
    const verdict = computeLeaderBlockerStallAlert(row({ fleet: null }));
    if (verdict.alert !== true) throw new Error('expected the alert to fire');
    expect(verdict.falsifier.check).toBe('fleet:assignments { include_stale: true }');
  });
});
