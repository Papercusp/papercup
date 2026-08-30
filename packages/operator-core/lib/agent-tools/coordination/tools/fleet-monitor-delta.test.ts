/**
 * fleet-monitor-delta — the pure fingerprint/diff/slim half of orient's
 * monitor-mode fleet delta (fleet-deltas-leader-primitives-2026-07-10 P-004).
 */
import { describe, it, expect } from 'vitest';
import {
  FLEET_DELTA_SCHEMA_VERSION,
  fingerprintFleet,
  diffFleet,
  slimAssignmentsForDelta,
  type FleetFingerprint,
  type FleetFingerprintContext,
} from './fleet-monitor-delta';

const roster = (agents: unknown[], extra: Record<string, unknown> = {}) => ({
  ok: true,
  summary: { agents: agents.length },
  agents,
  orphaned: [],
  stalled: [],
  ...extra,
});

const canonicalContext = (
  snapshotOverrides: Record<string, unknown> = {},
  contextOverrides: Partial<FleetFingerprintContext> = {},
): FleetFingerprintContext => ({
  fleet: 'spec-fleet',
  harness: 'papercusp',
  leaderBrief: {
    fleetMetrics: {
      ok: true,
      snapshot: {
        schemaVersion: 'fleet-metrics-v1',
        scope: {
          fleet: 'spec-fleet',
          harness: 'papercusp',
          window: {
            kind: 'fleet-lifetime',
            startAt: '2026-08-21T00:00:00.000Z',
            startSource: 'fleet-created-at',
          },
          stock: { mode: 'current-spec', specId: 'spec-1', revision: 7 },
          flow: { mode: 'current-spec', specId: 'spec-1', revision: 7, source: 'fleet' },
          population: { stock: 'current-spec-work-items', flow: 'current-spec-work-items' },
        },
        flow: {
          opened: 0,
          terminalLifecycle: 0,
          terminalCounted: 0,
          netLifecycle: 0,
          netCounted: 0,
          unit: 'work-items',
        },
        remaining: {
          total: 0,
          buckets: {
            needsHuman: 0,
            blocked: 0,
            claimHeld: 0,
            inFlight: 0,
            claimable: 0,
            otherUnclaimable: 0,
          },
        },
        authority: {
          lifecycleTerminal: 0,
          counted: 0,
          committed: 0,
          validated: 0,
          proposed: 0,
          pendingHuman: 0,
          invalid: 0,
          legacy: 0,
        },
        issueUnits: { canonicalBugs: 0, observations: 0, occurrences: 0, duplicateOccurrences: 0 },
        populationLifecycle: {
          schemaVersion: 'fleet-population-lifecycle-v1',
          window: { startAt: '2026-08-21T00:00:00.000Z', startSource: 'fleet-created-at' },
          target: { enabled: true, target: 2, current: 2, shortfall: 0, underStrength: false },
          liveness: { live: 2, parked: 0, dead: 0 },
          claimFlow: { status: 'measured', population: 'current-relevant-roster', claimable: 0, inFlight: 0 },
        },
        ...snapshotOverrides,
      },
    },
    summary: { pool_capacity: { poolExhausted: false, degraded: false, queueDepth: 0 } },
  },
  announcedGates: [{ event: 'fleet:spec-fleet:release-ready' }],
  pipeline: { gate: 'green', deploy: 'current' },
  ...contextOverrides,
});

const fp = (
  agents: unknown[],
  context: FleetFingerprintContext = canonicalContext(),
  extra: Record<string, unknown> = {},
): FleetFingerprint => fingerprintFleet(roster(agents, extra), context)!;

const withSnapshot = (
  transform: (snapshot: Record<string, unknown>) => Record<string, unknown>,
): FleetFingerprintContext => {
  const context = canonicalContext();
  const leaderBrief = context.leaderBrief as Record<string, unknown>;
  const fleetMetrics = leaderBrief.fleetMetrics as Record<string, unknown>;
  const snapshot = fleetMetrics.snapshot as Record<string, unknown>;
  return {
    ...context,
    leaderBrief: {
      ...leaderBrief,
      fleetMetrics: { ...fleetMetrics, snapshot: transform(snapshot) },
    },
  };
};

describe('fingerprintFleet', () => {
  it('projects assignments rows to compact per-member scalars', () => {
    const fp = fingerprintFleet(
      roster([
        { agentId: 'su-a', verdict: 'speaking', sessionState: 'live', doing: 'WI-1', claims: 2 },
        { agentId: 'su-b', verdict: 'stalled', sessionState: 'live', doing: { id: 'WI-2', title: 'x' }, claims: 1 },
      ]),
    );
    expect(fp).toMatchObject({
      schemaVersion: FLEET_DELTA_SCHEMA_VERSION,
      members: {
        'su-a': { v: 'speaking', s: 'live', d: 'WI-1', c: 2 },
        'su-b': { v: 'stalled', s: 'live', d: 'WI-2', c: 1 },
      },
      orphaned: 0,
      stalled: 0,
    });
  });

  it('counts orphaned/stalled claims and skips id-less rows', () => {
    const fp = fingerprintFleet(roster([{ verdict: 'dead' }], { orphaned: [{}, {}], stalled: [{}] }));
    expect(fp).toMatchObject({
      schemaVersion: FLEET_DELTA_SCHEMA_VERSION,
      members: {},
      orphaned: 2,
      stalled: 1,
    });
  });

  it('returns null on an unrecognizable shape (fail-open for the caller)', () => {
    expect(fingerprintFleet(null)).toBeNull();
    expect(fingerprintFleet('a TOON string')).toBeNull();
    expect(fingerprintFleet({ ok: true })).toBeNull();
  });

  it('P-007: stamps contextPressure as `p` when present; omits it (no fake key) when absent/null', () => {
    const fp = fingerprintFleet(
      roster([
        { agentId: 'su-a', verdict: 'speaking', sessionState: 'live', claims: 0, contextPressure: 'critical' },
        { agentId: 'su-b', verdict: 'speaking', sessionState: 'live', claims: 0, contextPressure: null },
        { agentId: 'su-c', verdict: 'speaking', sessionState: 'live', claims: 0 },
      ]),
    );
    expect(fp?.members['su-a']).toEqual({ v: 'speaking', s: 'live', c: 0, p: 'critical' });
    expect(fp?.members['su-b']).toEqual({ v: 'speaking', s: 'live', c: 0 });
    expect(fp?.members['su-c']).toEqual({ v: 'speaking', s: 'live', c: 0 });
  });

  it('projects the canonical snapshot with explicit population/unit/window labels and preserves measured zero', () => {
    const result = fp([]);
    expect(result.scope).toEqual({
      fleet: 'spec-fleet',
      harness: 'papercusp',
      metricsSchemaVersion: 'fleet-metrics-v1',
      specId: 'spec-1',
      flowMode: 'current-spec',
      flowSource: 'fleet',
      stockPopulation: 'current-spec-work-items',
      flowPopulation: 'current-spec-work-items',
      workItemUnit: 'work-items',
      fleetLifetime: {
        kind: 'fleet-lifetime',
        startAt: '2026-08-21T00:00:00.000Z',
        startSource: 'fleet-created-at',
      },
      lifecycle: {
        schemaVersion: 'fleet-population-lifecycle-v1',
        startAt: '2026-08-21T00:00:00.000Z',
        startSource: 'fleet-created-at',
      },
    });
    expect(result.axes.metrics).toMatchObject({
      availability: 'measured',
      flow: { opened: 0, terminalLifecycle: 0, terminalCounted: 0, netLifecycle: 0, netCounted: 0 },
      remaining: { total: 0, buckets: { claimable: 0, otherUnclaimable: 0 } },
      specRevision: 7,
    });
    expect(result.axes.populationLifecycle).toMatchObject({
      availability: 'measured',
      target: { target: 2, current: 2, shortfall: 0 },
      claimFlow: { population: 'current-relevant-roster', claimable: 0 },
    });
    expect(result.axes.gates).toEqual(['fleet:spec-fleet:release-ready']);
    expect(result.axes.promotion).toEqual({ availability: 'measured', gate: 'green', deploy: 'current' });
    expect(result.axes.cost).toEqual({
      availability: 'absent',
      reason: 'canonical-cost-writer-unavailable',
    });
  });

  it('keeps an unavailable canonical measurement distinct from a measured zero', () => {
    const measured = fp([]);
    const unavailable = fp([], {
      ...canonicalContext(),
      leaderBrief: { fleetMetrics: { ok: false, reason: 'scope resolver timed out' } },
    });
    expect(measured.axes.metrics).toMatchObject({ availability: 'measured', flow: { opened: 0 } });
    expect(unavailable.axes.metrics).toEqual({ availability: 'unavailable', reason: 'scope resolver timed out' });
  });
});

describe('diffFleet', () => {
  const base = fp([
    { agentId: 'su-a', verdict: 'speaking', sessionState: 'live', doing: 'WI-1', claims: 2 },
    { agentId: 'su-b', verdict: 'joined', sessionState: 'live', claims: 0 },
  ]);

  it('emits a transition row per changed member; unchanged members are only counted', () => {
    const d = diffFleet(
      base,
      fp(
        [
          { agentId: 'su-a', verdict: 'speaking', sessionState: 'live', doing: 'WI-1', claims: 2 },
          { agentId: 'su-b', verdict: 'stalled', sessionState: 'live', claims: 0 },
        ],
        canonicalContext(),
        { stalled: [{}] },
      ),
    );
    expect(d.rows).toEqual([
      { change: 'updated', type: 'member', id: 'su-b', from: { v: 'joined', s: 'live', c: 0 }, to: { v: 'stalled', s: 'live', c: 0 } },
    ]);
    expect(d.unchanged).toBe(1);
    expect(d.stalled).toEqual({ from: 0, to: 1 });
    expect(d.orphaned).toBeUndefined();
  });

  it('emits added/removed rows for joins and departures', () => {
    const d = diffFleet(
      base,
      fp([
        { agentId: 'su-a', verdict: 'speaking', sessionState: 'live', doing: 'WI-1', claims: 2 },
        { agentId: 'su-c', verdict: 'booted' },
      ]),
    );
    expect(d.rows).toEqual([
      { change: 'added', type: 'member', id: 'su-c', to: { v: 'booted' } },
      { change: 'removed', type: 'member', id: 'su-b', from: { v: 'joined', s: 'live', c: 0 } },
    ]);
  });

  it('a quiet fleet diffs to zero rows (the whole point: a quiet wake costs ~nothing)', () => {
    const d = diffFleet(base, base);
    expect(d.rows).toEqual([]);
    expect(d.unchanged).toBe(2);
  });

  it('P-007: a context-pressure-only crossing (ok→high) is itself a transition row', () => {
    const withOk = fp([
      { agentId: 'su-a', verdict: 'speaking', sessionState: 'live', claims: 0, contextPressure: 'ok' },
    ]);
    const d = diffFleet(
      withOk,
      fp([{ agentId: 'su-a', verdict: 'speaking', sessionState: 'live', claims: 0, contextPressure: 'high' }]),
    );
    expect(d.rows).toEqual([
      {
        change: 'updated',
        type: 'member',
        id: 'su-a',
        from: { v: 'speaking', s: 'live', c: 0, p: 'ok' },
        to: { v: 'speaking', s: 'live', c: 0, p: 'high' },
      },
    ]);
    expect(d.unchanged).toBe(0);
  });

  it('emits only changed canonical axes while retaining measured zero transitions', () => {
    const changed = fp(
      [],
      withSnapshot((snapshot) => ({
        ...snapshot,
        flow: { ...(snapshot.flow as Record<string, unknown>), opened: 1, netLifecycle: 1 },
        remaining: {
          ...(snapshot.remaining as Record<string, unknown>),
          total: 1,
          buckets: {
            ...((snapshot.remaining as Record<string, unknown>).buckets as Record<string, unknown>),
            claimable: 1,
          },
        },
      })),
    );
    const delta = diffFleet(fp([]), changed);
    expect(delta.axes).toEqual({
      metrics: {
        flow: {
          netLifecycle: { from: 0, to: 1 },
          opened: { from: 0, to: 1 },
        },
        remaining: {
          total: { from: 0, to: 1 },
          buckets: { claimable: { from: 0, to: 1 } },
        },
      },
    });
    expect(delta.rows).toEqual([]);
  });

  it('schema mismatch resets to a full replacement instead of comparing cursor generations', () => {
    expect(diffFleet({ schemaVersion: 'fleet-delta-v1' }, base)).toMatchObject({
      reset: { reason: 'schema-mismatch' },
      fullReplacement: true,
      rows: [],
    });
  });

  it.each([
    {
      name: 'scope',
      reason: 'scope-mismatch',
      context: withSnapshot((snapshot) => ({
        ...snapshot,
        scope: { ...(snapshot.scope as Record<string, unknown>), harness: 'other-harness' },
      })),
    },
    {
      name: 'population',
      reason: 'population-mismatch',
      context: withSnapshot((snapshot) => {
        const scope = snapshot.scope as Record<string, unknown>;
        return {
          ...snapshot,
          scope: {
            ...scope,
            population: { ...(scope.population as Record<string, unknown>), flow: 'at-event-spec-work-item-events' },
          },
        };
      }),
    },
    {
      name: 'window',
      reason: 'window-mismatch',
      context: withSnapshot((snapshot) => {
        const scope = snapshot.scope as Record<string, unknown>;
        return {
          ...snapshot,
          scope: {
            ...scope,
            window: { ...(scope.window as Record<string, unknown>), startAt: '2026-08-22T00:00:00.000Z' },
          },
        };
      }),
    },
  ])('$name mismatch resets before comparing unlike populations', ({ reason, context }) => {
    expect(diffFleet(base, fp([], context))).toMatchObject({
      reset: { reason },
      fullReplacement: true,
      rows: [],
    });
  });
});

describe('slimAssignmentsForDelta', () => {
  it('keeps only the self row + a peer-elision count; everything else passes through', () => {
    const me = roster([
      { agentId: 'su-a', isSelf: true, verdict: 'speaking' },
      { agentId: 'su-b' },
      { agentId: 'su-c' },
    ]);
    const slim = slimAssignmentsForDelta(me) as {
      agents: unknown[];
      peerRowsElidedFromScope: number;
      elidedIsScopeRelative: boolean;
      summary: unknown;
    };
    expect(slim.agents).toEqual([{ agentId: 'su-a', isSelf: true, verdict: 'speaking' }]);
    expect(slim.peerRowsElidedFromScope).toBe(2);
    // WI-6762: the count is relative to the (already scope-filtered) input array, and
    // must say so — a bare 0 here read as "the whole fleet is one agent" twice on
    // 2026-08-01. Never emit the elision count without this qualifier.
    expect(slim.elidedIsScopeRelative).toBe(true);
    expect(slim.summary).toEqual({ agents: 3 });
  });

  it('passes a non-roster shape through untouched (fail-open)', () => {
    expect(slimAssignmentsForDelta('toon')).toBe('toon');
    expect(slimAssignmentsForDelta(null)).toBeNull();
  });
});
