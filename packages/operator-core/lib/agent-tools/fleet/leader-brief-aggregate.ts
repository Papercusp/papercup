import {
  interpretFleetClaimability,
  type FleetClaimabilityInterpretation,
  type FleetLaneHealth,
} from '../../fleet/lane-health';

export interface ClaimableNowPopulation {
  kind: 'fleet-claim-spec';
  /** The fleet whose durable claim spec was requested. */
  fleet: string;
  /** Resolved spec harness, or the requested harness when the read failed. */
  harness: string | null;
  spec: {
    ref: string;
    revision: number | null;
    matchedBy: string;
    /** null is load-bearing: this is a fleet population, not one reader's lane. */
    assigneeScoped: string | null;
    /** Distinguishes an empty plan lane from a non-plan spec matching zero rows. */
    planScoped?: boolean;
  } | null;
  basis: FleetLaneHealth['effective']['basis'] | null;
  matchedByFilter: number | null;
  /** Full-tier family evidence; the payload shaper retains the bounded decision core. */
  families?: {
    issue: FleetLaneHealth['issueFamily'];
    feature: FleetLaneHealth['featureFamily'];
    effective: FleetLaneHealth['effective'];
  };
  note: string;
}

export interface ClaimableNowAggregate {
  value: number | null;
  population: ClaimableNowPopulation;
  interpretation: FleetClaimabilityInterpretation;
  /** Present exactly when `value` is unknown. A null without a reason is forbidden. */
  unknown?: {
    code: 'not-measured';
    detail: string;
  };
}

/**
 * P-002 / D-004: bind the claimable count to the population that gives it
 * meaning. The previous `claimable_now` + `claimable_now_spec` siblings let a
 * caller keep the numeral while silently dropping its scope; this aggregate has
 * no such representable state.
 */
export function buildClaimableNowAggregate(input: {
  fleet: string;
  requestedHarness?: string | null;
  laneHealth: FleetLaneHealth | null;
  /** null means the control-state read was unavailable; false is a measured active state. */
  fleetPaused?: boolean | null;
}): ClaimableNowAggregate {
  const { fleet, laneHealth } = input;
  const population: ClaimableNowPopulation = laneHealth
    ? {
        kind: 'fleet-claim-spec',
        fleet,
        harness: laneHealth.spec.harness,
        spec: {
          ref: laneHealth.spec.ref,
          revision: laneHealth.spec.revision,
          matchedBy: laneHealth.spec.matchedBy,
          assigneeScoped: laneHealth.spec.assigneeScoped,
          ...(laneHealth.spec.planScoped !== undefined ? { planScoped: laneHealth.spec.planScoped } : {}),
        },
        basis: laneHealth.effective.basis,
        matchedByFilter: laneHealth.effective.matchedByFilter,
        families: {
          issue: laneHealth.issueFamily,
          feature: laneHealth.featureFamily,
          effective: laneHealth.effective,
        },
        note:
          `claimable_now (${laneHealth.effective.claimable ?? 'unknown'}) uses the ` +
          `${laneHealth.effective.basis} verdict for rows admitted by ${laneHealth.spec.ref} ` +
          `within harness '${laneHealth.spec.harness}'. This is a caller-neutral FLEET population ` +
          '(assigneeScoped:null): it intentionally omits the reading leader, so caller-specific ' +
          'release-cooldown and reserved-plan-lane floors do not apply. work_items:claimable is ' +
          'caller-scoped and may therefore return a different count even when passed this exact ' +
          'spec+harness; without a spec it also asks the different default-spec, harness-wide question.',
      }
    : {
        kind: 'fleet-claim-spec',
        fleet,
        harness: input.requestedHarness ?? null,
        spec: null,
        basis: null,
        matchedByFilter: null,
        note:
          'claimable_now was not measured on this brief; the requested fleet+harness is ' +
          'preserved, but no claim-spec population was resolved.',
      };

  const value = laneHealth?.effective.claimable ?? null;
  const interpretation = interpretFleetClaimability({
    claimable: value,
    matchedByFilter: laneHealth?.effective.matchedByFilter ?? null,
    excluded: laneHealth?.effective.excluded ?? null,
    fleetPaused: input.fleetPaused ?? null,
    planScoped: laneHealth?.spec.planScoped ?? null,
  });
  if (value == null) {
    return {
      value: null,
      population,
      interpretation,
      unknown: {
        code: 'not-measured',
        detail:
          'Fleet lane health did not produce a family-complete claimable count for this brief; ' +
          'do not read the lane as drained.',
      },
    };
  }
  return { value, population, interpretation };
}
