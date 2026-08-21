import { describe, expect, it } from 'vitest';
import {
  FLEET_METRIC_ADMISSION_PARITY,
  FLEET_METRIC_REMAINING_PRECEDENCE,
  FLEET_METRIC_UNITS,
  FLEET_METRIC_WRITERS,
  FLEET_METRICS_SCHEMA_VERSION,
  fleetMetricsResultSchema,
  type FleetMetricsResult,
} from './fleet-metrics-contract';

function currentSpecExample(): FleetMetricsResult {
  return {
    ok: true,
    snapshot: {
      schemaVersion: FLEET_METRICS_SCHEMA_VERSION,
      generatedAt: '2026-08-21T14:00:00.000Z',
      scope: {
        fleet: 'nonp2p-bug-drain',
        harness: 'papercusp',
        window: {
          kind: 'fleet-lifetime',
          startAt: '2026-08-20T12:00:00.000Z',
          endAt: '2026-08-21T14:00:00.000Z',
          startInclusive: true,
          endExclusive: true,
          startSource: 'fleet-created-at',
          endSource: 'snapshot-generated-at',
        },
        stock: {
          mode: 'current-spec',
          specId: 'nonp2p-bugs',
          revision: 25,
          source: 'fleet',
          appliedTo: 'all-counted-items',
        },
        flow: {
          mode: 'current-spec',
          specId: 'nonp2p-bugs',
          revision: 25,
          source: 'fleet',
          appliedTo: 'all-counted-items',
        },
        attribution: {
          membership: 'ever-members',
          writer: FLEET_METRIC_WRITERS.membership,
          memberCount: 31,
          rule: 'actor owner id is in the fleet append-only ever-member cohort',
        },
      },
      quality: {
        exactness: { status: 'exact', sourceCap: null },
        freshness: {
          status: 'fresh',
          measuredAt: '2026-08-21T14:00:00.000Z',
          staleAfterMs: 60_000,
        },
      },
      flow: {
        opened: 12,
        terminalLifecycle: 10,
        terminalCounted: 8,
        netLifecycle: 2,
        netCounted: 4,
        unit: FLEET_METRIC_UNITS.workItems,
        openedBy: {
          fleet: 7,
          otherAgents: 2,
          system: 2,
          unattributed: 1,
          partitions: true,
          membershipBasis: 'ever-members',
        },
        terminalBy: {
          fleet: 6,
          otherAgents: 2,
          system: 1,
          unattributed: 1,
          partitions: true,
          membershipBasis: 'ever-members',
        },
      },
      remaining: {
        total: 15,
        unit: FLEET_METRIC_UNITS.workItems,
        buckets: {
          needsHuman: 1,
          blocked: 2,
          claimHeld: 1,
          inFlight: 4,
          claimable: 5,
          otherUnclaimable: 2,
        },
        mutuallyExclusive: true,
        precedence: [...FLEET_METRIC_REMAINING_PRECEDENCE],
      },
      authority: {
        lifecycleTerminal: 10,
        counted: 8,
        committed: 5,
        validated: 1,
        proposed: 1,
        pendingHuman: 1,
        invalid: 0,
        legacy: 2,
        partitionsLifecycleTerminal: true,
        countedRule: 'committed + validated + legacy',
      },
      issueUnits: {
        canonicalBugs: 9,
        observations: 22,
        occurrences: 30,
        duplicateOccurrences: 21,
        separateUnits: true,
        units: {
          canonicalBugs: FLEET_METRIC_UNITS.canonicalBugs,
          observations: FLEET_METRIC_UNITS.observations,
          occurrences: FLEET_METRIC_UNITS.occurrences,
          duplicateOccurrences: FLEET_METRIC_UNITS.duplicateOccurrences,
        },
        writers: {
          canonicalBugs: FLEET_METRIC_WRITERS.workItems,
          observations: FLEET_METRIC_WRITERS.workItems,
          occurrences: FLEET_METRIC_WRITERS.occurrences,
        },
      },
      admissionParity: FLEET_METRIC_ADMISSION_PARITY,
    },
  };
}

describe('fleet metrics v1 contract', () => {
  it('accepts a current-spec fleet-lifetime snapshot with explicit units and provenance', () => {
    const parsed = fleetMetricsResultSchema.parse(currentSpecExample());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.snapshot.scope.stock.mode).toBe('current-spec');
    expect(parsed.snapshot.scope.flow.mode).toBe('current-spec');
    expect(parsed.snapshot.scope.attribution.membership).toBe('ever-members');
    expect(parsed.snapshot.issueUnits.separateUnits).toBe(true);
    expect(parsed.snapshot.admissionParity.oracle).toBe('scheduler:get_next');
    expect(parsed.snapshot.admissionParity.rankAffectsPopulation).toBe(false);
  });

  it('represents at-event history without pretending one current revision governed the past', () => {
    const example = currentSpecExample();
    if (!example.ok) throw new Error('fixture must be available');
    example.snapshot.scope.flow = {
      mode: 'at-event-spec',
      specId: 'nonp2p-bugs',
      currentRevision: 25,
      revision: 'effective-at-event',
      historyWriter: FLEET_METRIC_WRITERS.claimSpecHistory,
      appliedTo: 'each-event-at-its-event-time',
      missingRevision: 'unavailable-never-current-fallback',
    };

    const parsed = fleetMetricsResultSchema.parse(example);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.snapshot.scope.stock.mode).toBe('current-spec');
    expect(parsed.snapshot.scope.flow).toMatchObject({
      mode: 'at-event-spec',
      revision: 'effective-at-event',
      missingRevision: 'unavailable-never-current-fallback',
    });
  });

  it('rejects overlapping/omitted remaining dispositions disguised as a partition', () => {
    const example = currentSpecExample();
    if (!example.ok) throw new Error('fixture must be available');
    example.snapshot.remaining.buckets.blocked += 1;
    expect(fleetMetricsResultSchema.safeParse(example).success).toBe(false);
  });

  it('keeps lifecycle terminality separate from completion authority', () => {
    const example = currentSpecExample();
    if (!example.ok) throw new Error('fixture must be available');
    example.snapshot.authority.counted += 1;
    example.snapshot.flow.terminalCounted += 1;
    example.snapshot.flow.netCounted -= 1;
    expect(fleetMetricsResultSchema.safeParse(example).success).toBe(false);
  });

  it('requires opened/terminal attribution and net flow to reconcile', () => {
    const badAttribution = currentSpecExample();
    if (!badAttribution.ok) throw new Error('fixture must be available');
    badAttribution.snapshot.flow.openedBy.fleet += 1;
    expect(fleetMetricsResultSchema.safeParse(badAttribution).success).toBe(false);

    const badNet = currentSpecExample();
    if (!badNet.ok) throw new Error('fixture must be available');
    badNet.snapshot.flow.netLifecycle = 99;
    expect(fleetMetricsResultSchema.safeParse(badNet).success).toBe(false);
  });

  it('marks truncation and staleness explicitly, including the recovery read', () => {
    const example = currentSpecExample();
    if (!example.ok) throw new Error('fixture must be available');
    example.snapshot.quality = {
      exactness: {
        status: 'truncated',
        sourceCap: 2_000,
        fetched: 2_000,
        reason: 'source cap exhausted before post-filter aggregation',
        recoverVia: 'fleet:leader-brief { payloadTier: "full" }',
      },
      freshness: {
        status: 'stale',
        measuredAt: '2026-08-21T13:00:00.000Z',
        staleAfterMs: 60_000,
        reason: 'snapshot older than the declared freshness bound',
        recoverVia: 'fleet:leader-brief',
      },
    };
    expect(fleetMetricsResultSchema.parse(example)).toEqual(example);
  });

  it('uses an unavailable envelope instead of manufacturing a zero on a missing history revision', () => {
    const unavailable: FleetMetricsResult = {
      ok: false,
      schemaVersion: FLEET_METRICS_SCHEMA_VERSION,
      error: 'fleet_metrics_unavailable',
      reason: 'claim-spec revision effective at an event could not be resolved',
      recoverVia: 'scheduler:get_claim_spec { fleet, history: 20 }',
      requested: {
        fleet: 'nonp2p-bug-drain',
        harness: 'papercusp',
        flowMode: 'at-event-spec',
        window: 'fleet-lifetime',
      },
    };
    expect(fleetMetricsResultSchema.parse(unavailable)).toEqual(unavailable);
  });

  it('never adds canonical bugs, observations, and occurrences as though they shared a unit', () => {
    const example = currentSpecExample();
    if (!example.ok) throw new Error('fixture must be available');
    const units = example.snapshot.issueUnits;
    expect(new Set(Object.values(units.units)).size).toBe(4);
    expect(units.canonicalBugs).toBe(9);
    expect(units.observations).toBe(22);
    expect(units.occurrences).toBe(30);
    expect(units).not.toHaveProperty('total');
  });

  it('CONTROL: a current-spec flow revision cannot masquerade as at-event history', () => {
    const example = currentSpecExample() as unknown as Record<string, unknown>;
    const snapshot = example.snapshot as Record<string, unknown>;
    const scope = snapshot.scope as Record<string, unknown>;
    scope.flow = {
      mode: 'at-event-spec',
      specId: 'nonp2p-bugs',
      revision: 25,
      source: 'fleet',
      appliedTo: 'all-counted-items',
    };
    expect(fleetMetricsResultSchema.safeParse(example).success).toBe(false);
  });
});
