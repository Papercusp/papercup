import { describe, expect, it } from 'vitest';
import {
  SPAWN_GOVERNOR_OBSERVATION_VERSION,
  buildSpawnGovernorObservation,
  type SpawnObservationInput,
} from './spawn-observation';
import { GOVERNOR_STATE_SNAPSHOT_VERSION, type GovernorStateSnapshot } from './state-snapshot';

const NOW = 1_700_000_000_000;

function snapshot(overrides: {
  admission?: Partial<GovernorStateSnapshot['admission']>;
  queueByClass?: GovernorStateSnapshot['queue']['byClass'];
  observedAtMs?: number;
  validUntilMs?: number;
}): GovernorStateSnapshot {
  return {
    schemaVersion: GOVERNOR_STATE_SNAPSHOT_VERSION,
    generation: 7,
    observedAtMs: overrides.observedAtMs ?? NOW - 1_000,
    validUntilMs: overrides.validUntilMs ?? NOW + 60_000,
    evidenceRef: null,
    confidence: 1,
    freshness: { stale: false, observedAtMs: NOW - 1_000, validUntilMs: NOW + 60_000 },
    unknown: [],
    assessments: {
      health: 'healthy',
      admission: 'open',
      queue: 'empty',
      resources: 'unconstrained',
      recovery: 'stable',
    },
    health: { state: null, severity: null, actionable: null, confidence: null, evidenceRef: null },
    admission: {
      state: 'open',
      reason: null,
      generation: 7,
      constrainedClasses: [],
      nextProbeAtMs: null,
      confidence: 1,
      ...overrides.admission,
    },
    queue: {
      depth: null,
      oldestAgeMs: null,
      arrivalRatePerSec: null,
      drainRatePerSec: null,
      trend: 'stable',
      byClass: overrides.queueByClass ?? [],
      populationClasses: null,
      truncated: false,
    },
    resources: { constrained: [], byResource: [], truncated: false },
    recovery: {
      state: null,
      completed: null,
      total: null,
      progress: null,
      nextProbeAtMs: null,
      evidenceRef: null,
      confidence: null,
    },
    transitions: {
      admissionConstrained: false,
      backlogUnhealthy: false,
      backlogUnhealthySamples: 0,
      healthy: true,
      healthySamples: 1,
      recoveryProbing: false,
      telemetryStale: false,
    },
  };
}

const baseInput: SpawnObservationInput = {
  nowMs: NOW,
  doorOutcome: 'admitted',
  doorCap: 40,
  doorRoleCap: null,
  parentRole: 'operator',
  childRole: 'su',
  fleetSlug: null,
  planSlug: null,
  snapshot: null,
};

const build = (over: Partial<SpawnObservationInput> = {}) =>
  buildSpawnGovernorObservation({ ...baseInput, ...over });

describe('buildSpawnGovernorObservation (P-003 observe-only receipt)', () => {
  it('reports unknown — never admit — when no snapshot is available', () => {
    // The consequential default. If a missing snapshot rendered as `admit`,
    // P-004 would count every no-opinion sample as "the governor agreed" and
    // conclude Phase 3 is safe on evidence that does not exist.
    const o = build({ snapshot: null });
    expect(o.governor.wouldAdmit).toBe('unknown');
    expect(o.divergedFromGovernor).toBeNull();
    expect(o.caveats).toContain('governor-snapshot-absent');
    expect(o.version).toBe(SPAWN_GOVERNOR_OBSERVATION_VERSION);
  });

  it('agrees with the door when admission is open', () => {
    const o = build({ snapshot: snapshot({}) });
    expect(o.governor.wouldAdmit).toBe('admit');
    expect(o.divergedFromGovernor).toBe(false);
  });

  it('flags divergence when the door admitted but the governor was paused', () => {
    const o = build({ snapshot: snapshot({ admission: { state: 'paused' } }) });
    expect(o.governor.wouldAdmit).toBe('paused');
    expect(o.divergedFromGovernor).toBe(true);
  });

  it('does NOT flag agent spawns when a DIFFERENT class is the constrained one', () => {
    // Over-reporting here would make Phase 3 look far more dangerous than it is
    // and could wrongly justify never migrating the recovery callers at all.
    const o = build({
      snapshot: snapshot({ admission: { state: 'constrained', constrainedClasses: ['embedding'] } }),
    });
    expect(o.governor.wouldAdmit).toBe('admit');
    expect(o.governor.classConstrained).toBe(false);
    expect(o.divergedFromGovernor).toBe(false);
  });

  it('flags divergence when the agent class itself is constrained', () => {
    const o = build({
      snapshot: snapshot({ admission: { state: 'constrained', constrainedClasses: ['agent'] } }),
    });
    expect(o.governor.wouldAdmit).toBe('constrained');
    expect(o.governor.classConstrained).toBe(true);
    expect(o.divergedFromGovernor).toBe(true);
  });

  it('does not call it divergence when the DOOR already held the spawn', () => {
    // over_cap means the door's own ceiling stopped it. The governor agreeing to
    // stop it too is not a disagreement, and counting it as one would inflate
    // the very statistic P-004 uses to judge the seam.
    const o = build({
      doorOutcome: 'over_cap',
      snapshot: snapshot({ admission: { state: 'constrained', constrainedClasses: ['agent'] } }),
    });
    expect(o.divergedFromGovernor).toBe(false);
  });

  it('records an unknown admission state as unknown, not as open', () => {
    const o = build({ snapshot: snapshot({ admission: { state: null } }) });
    expect(o.governor.wouldAdmit).toBe('unknown');
    expect(o.governor.classConstrained).toBeNull();
    expect(o.caveats).toContain('governor-admission-state-unknown');
    expect(o.divergedFromGovernor).toBeNull();
  });

  it('marks a stale snapshot but still records its verdict', () => {
    const o = build({
      snapshot: snapshot({ observedAtMs: NOW - 500_000, validUntilMs: NOW - 400_000 }),
    });
    expect(o.caveats).toContain('governor-snapshot-stale');
    expect(o.governor.snapshotAgeMs).toBe(500_000);
    expect(o.governor.wouldAdmit).toBe('admit');
  });

  it('derives the estimated wait from agent-class depth and drain rate', () => {
    const o = build({
      snapshot: snapshot({
        queueByClass: [
          { admissionClass: 'agent', depth: 8, oldestAgeMs: null, arrivalRatePerSec: null, drainRatePerSec: 2 },
        ],
      }),
    });
    expect(o.governor.classQueueDepth).toBe(8);
    expect(o.governor.estimatedWaitMs).toBe(4_000);
  });

  it('leaves the wait NULL — never 0 — when the drain rate is unknown', () => {
    // A zero here would read as "measured: no delay", which is the opposite of
    // "we could not measure it", on the single number D-003 gates Phase 3 on.
    const o = build({
      snapshot: snapshot({
        queueByClass: [
          { admissionClass: 'agent', depth: 5, oldestAgeMs: null, arrivalRatePerSec: null, drainRatePerSec: null },
        ],
      }),
    });
    expect(o.governor.estimatedWaitMs).toBeNull();
    expect(o.caveats).toContain('queue-drain-rate-unknown');
  });

  it('ignores other classes when reading queue depth', () => {
    const o = build({
      snapshot: snapshot({
        queueByClass: [
          { admissionClass: 'embedding', depth: 99, oldestAgeMs: null, arrivalRatePerSec: null, drainRatePerSec: 1 },
        ],
      }),
    });
    expect(o.governor.classQueueDepth).toBeNull();
    expect(o.governor.estimatedWaitMs).toBeNull();
  });

  it('always declares that caller attribution is not yet available', () => {
    // Until P-005..P-011 thread the real caller through, parentRole is NOT
    // caller identity. Saying so on every row stops P-004 reading it as one.
    expect(build({ snapshot: snapshot({}) }).caveats).toContain('caller-attribution-unavailable');
    expect(build({ snapshot: null }).caveats).toContain('caller-attribution-unavailable');
  });

  it('carries the door facts through unchanged', () => {
    const o = build({
      doorCap: 12,
      doorRoleCap: 3,
      parentRole: 'mug',
      childRole: 'cup',
      fleetSlug: 'f-1',
      planSlug: 'p-1',
      snapshot: snapshot({}),
    });
    expect(o.door).toEqual({
      outcome: 'admitted',
      cap: 12,
      roleCap: 3,
      parentRole: 'mug',
      childRole: 'cup',
      fleetSlug: 'f-1',
      planSlug: 'p-1',
    });
  });
});
