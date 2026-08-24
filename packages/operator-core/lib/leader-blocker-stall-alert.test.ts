import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEADER_BLOCKER_STALL_THRESHOLD_HOURS,
  computeLeaderBlockerStallAlert,
  computeLeaderBlockerStallView,
  type LeaderBlockerStallAlertInput,
  type LeaderBlockerStallRankedRow,
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

const rankedRow = (over: Partial<LeaderBlockerStallRankedRow> = {}): LeaderBlockerStallRankedRow => ({
  rank: 1,
  ref: 'work_item:WI-40086',
  workItemRefs: ['WI-40086'],
  openBlockedCount: 2,
  hoursSinceProgress: 5,
  holder: { state: 'unowned', count: 0, agents: [], truncated: false },
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

describe('computeLeaderBlockerStallView', () => {
  it('selects the highest-ranked known alert and names its work-item identity', () => {
    const view = computeLeaderBlockerStallView({
      fleet: 'loop-observability',
      rows: [
        rankedRow({ rank: 2, workItemRefs: ['WI-2'] }),
        rankedRow({ rank: 1, workItemRefs: ['WI-1'], hoursSinceProgress: 8 }),
      ],
    });

    expect(view.status).toBe('alert');
    expect(view.row).toEqual({ rank: 1, itemRef: 'WI-1' });
    expect(view.alert).toBe(true);
  });

  it('lets a known alert dominate an earlier unknown row', () => {
    const view = computeLeaderBlockerStallView({
      rows: [rankedRow({ rank: 1, hoursSinceProgress: null }), rankedRow({ rank: 2, workItemRefs: ['WI-alert'] })],
    });

    expect(view.status).toBe('alert');
    expect(view.row).toEqual({ rank: 2, itemRef: 'WI-alert' });
  });

  it('returns clear only when every ranked row is a known negative', () => {
    expect(
      computeLeaderBlockerStallView({
        rows: [
          rankedRow({ rank: 1, openBlockedCount: 0 }),
          rankedRow({
            rank: 2,
            holder: {
              state: 'held',
              count: 1,
              agents: [{ agentId: 'su-live', alive: true }],
              truncated: false,
            },
          }),
        ],
      }),
    ).toEqual({ status: 'clear', alert: false, thresholdHours: 4, checkedRows: 2 });
  });

  it('keeps the highest-ranked unknown explicit when no row proves an alert', () => {
    const view = computeLeaderBlockerStallView({
      rows: [rankedRow({ rank: 2, hoursSinceProgress: null }), rankedRow({ rank: 1, openBlockedCount: null })],
    });

    expect(view.status).toBe('unknown');
    expect(view.row).toEqual({ rank: 1, itemRef: 'WI-40086' });
    expect(view.unknown).toEqual({ code: 'open-blocked-count-unmeasured' });
    expect(view.checkedRows).toBe(2);
  });

  it('treats a visible live holder as a complete falsifier even when the sample is truncated', () => {
    const view = computeLeaderBlockerStallView({
      rows: [
        rankedRow({
          holder: {
            state: 'held',
            count: 5,
            agents: [
              { agentId: 'su-dead', alive: false },
              { agentId: 'su-live', alive: true },
            ],
            truncated: true,
          },
        }),
      ],
    });

    expect(view.status).toBe('clear');
  });

  it('does not infer all holders are dead from a truncated non-live sample', () => {
    const view = computeLeaderBlockerStallView({
      rows: [
        rankedRow({
          holder: {
            state: 'held',
            count: 4,
            agents: [{ agentId: 'su-dead', alive: false }],
            truncated: true,
          },
        }),
      ],
    });

    expect(view.status).toBe('unknown');
    expect(view.unknown).toEqual({ code: 'holder-ownership-unmeasured' });
  });

  it('fires when a complete holder population is entirely non-live', () => {
    const view = computeLeaderBlockerStallView({
      rows: [
        rankedRow({
          holder: {
            state: 'held',
            count: 2,
            agents: [
              { agentId: 'su-dead-a', alive: false },
              { agentId: 'su-dead-b', alive: false },
            ],
            truncated: false,
          },
        }),
      ],
    });

    expect(view.status).toBe('alert');
    expect(view.reason).toContain('held by non-live session su-dead-a');
  });

  it('treats a measured empty ranking as clear and normalizes the threshold', () => {
    expect(computeLeaderBlockerStallView({ rows: [], thresholdHours: -1 })).toEqual({
      status: 'clear',
      alert: false,
      thresholdHours: 4,
      checkedRows: 0,
    });
  });
});
