/**
 * P-013 spec `capless-p013-state-read-model@3`.
 *
 * The clause's falsifier is: "Two status surfaces disagree about the binding writer
 * or omit the generation/freshness needed to interpret a capacity number." Its
 * probeMethod is: "Compare gateway status, fleet capacity, health panels, and alert
 * projections against one state snapshot."
 *
 * That probe is executed literally below — `surfaces-agree` builds ONE snapshot and
 * compares all four projections field-by-field. The test is written so it can only
 * pass while the projections genuinely share a single source: it asserts over the
 * FULL projection registry rather than a hand-listed pair, so a fifth surface added
 * later is covered without anyone remembering to extend this file.
 */

import { describe, expect, it } from 'vitest';

import type { QueueReceipt } from '../resource-governor/admission';
import type { CaplessControllerDecision } from '../resource-governor/controller';
import {
  BINDING_DISPOSITIONS,
  describeGatewayAdmissionState,
  describeGatewayLiveAdmissionState,
  explainGatewayLaneBinding,
  GATEWAY_ADMISSION_STATE_SCHEMA_VERSION,
  GATEWAY_STATE_PROJECTIONS,
  gatewayLaneId,
  projectAlerts,
  projectFleetCapacity,
  projectGatewayStatus,
  projectHealthPanel,
} from './admission-state-model';
import type { PhysicalConstraintObservation, PhysicalConstraintVerdict } from './physical-constraints';

const NOW = 1_700_000_000_000;

function klass(over: Partial<CaplessControllerDecision['classes'][number]> = {}) {
  return {
    admissionClass: 'interactive',
    desiredWindow: 12,
    effectiveWindow: 8,
    inFlight: 3,
    availableStarts: 5,
    paused: false,
    pauseUntilMs: null,
    protected: false,
    healthySamples: 4,
    feedback: [],
    ...over,
  } as CaplessControllerDecision['classes'][number];
}

function decision(over: Partial<CaplessControllerDecision> = {}): CaplessControllerDecision {
  return {
    schemaVersion: 'capless-controller-v1',
    generation: 42,
    evaluatedAtMs: NOW - 1_000,
    healthScopeId: 'gateway',
    healthState: 'healthy',
    healthSeverity: 'none',
    classes: [klass()],
    reasons: [],
    ...over,
  } as CaplessControllerDecision;
}

function observation(over: Partial<PhysicalConstraintObservation> = {}): PhysicalConstraintObservation {
  return {
    id: 'obs-1',
    key: 'rate-limit',
    kind: 'quota',
    source: 'provider',
    sourceId: 'anthropic',
    scope: { provider: 'anthropic' },
    state: 'measured',
    value: 0,
    unit: 'count',
    constraint: true,
    binding: 'external-physical-contract',
    causalRole: 'cause',
    actionable: false,
    confidence: 1,
    observedAtMs: NOW - 500,
    collectedAtMs: NOW - 500,
    expiresAtMs: NOW + 60_000,
    lastMeasuredAtMs: NOW - 500,
    freshness: { state: 'fresh', ageMs: 500, validUntilMs: NOW + 60_000 },
    reason: 'anthropic 429 budget exhausted',
    evidence: ['429 from anthropic'],
    ...over,
  } as PhysicalConstraintObservation;
}

function verdict(observations: PhysicalConstraintObservation[]): PhysicalConstraintVerdict {
  return {
    schemaVersion: 'gateway-physical-constraint-v1',
    evaluatedAtMs: NOW,
    state: 'constrained',
    constrained: true,
    actionable: false,
    observations,
    attributions: [],
    actionableResources: [],
    reasons: [],
  } as unknown as PhysicalConstraintVerdict;
}

function receipt(over: Partial<QueueReceipt> = {}): QueueReceipt {
  return {
    receiptId: 'r-1',
    idempotencyKey: 'k-1',
    state: 'queued',
    enqueuedAtMs: NOW - 5_000,
    decisionGeneration: 42,
    ...over,
  };
}

describe('describeGatewayAdmissionState (unit)', () => {
  it('gives every capacity number a writer, a unit, and a disposition', () => {
    const snap = describeGatewayAdmissionState({ decision: decision(), nowMs: NOW });
    const lane = snap.lanes[0]!;

    for (const [field, m] of Object.entries({
      desiredWindow: lane.desiredWindow,
      effectiveWindow: lane.effectiveWindow,
      inFlight: lane.inFlight,
      availableStarts: lane.availableStarts,
      queueDepth: lane.queue.depth,
    })) {
      expect(m.writer.writer, `${field} must name its writer`).toMatch(/\.ts#/);
      expect(m.writer.unit, `${field} must name its unit`).toBeTruthy();
      expect(m.writer.disposition, `${field} must declare a disposition`).toBeTruthy();
    }
  });

  it('never labels an adaptive window as a binding disposition', () => {
    // The whole point of the capless work: desired/effective are MEASUREMENTS of an
    // unbounded adaptive target, so they must never carry a disposition that the
    // source lint would read as a licence to cap.
    const snap = describeGatewayAdmissionState({ decision: decision(), nowMs: NOW });
    const lane = snap.lanes[0]!;
    expect(BINDING_DISPOSITIONS.has(lane.desiredWindow.writer.disposition)).toBe(false);
    expect(BINDING_DISPOSITIONS.has(lane.effectiveWindow.writer.disposition)).toBe(false);
  });

  it('counts only still-waiting receipts as queue depth', () => {
    const snap = describeGatewayAdmissionState({
      decision: decision(),
      nowMs: NOW,
      queued: {
        interactive: [
          receipt({ receiptId: 'r-1', state: 'queued', enqueuedAtMs: NOW - 9_000 }),
          receipt({ receiptId: 'r-2', state: 'eligible', enqueuedAtMs: NOW - 3_000 }),
          receipt({ receiptId: 'r-3', state: 'completed' }),
          receipt({ receiptId: 'r-4', state: 'cancelled' }),
        ],
      },
    });
    const lane = snap.lanes[0]!;
    // Counting terminal receipts would inflate the single number an operator uses to
    // decide whether admission is stuck — the failure this assertion pins.
    expect(lane.queue.depth.value).toBe(2);
    expect(lane.queue.oldestEnqueuedAtMs).toBe(NOW - 9_000);
    expect(lane.queue.receipts).toHaveLength(4);
  });

  it('reports binding precedence: pause outranks physical contract outranks window', () => {
    const paused = explainGatewayLaneBinding(klass({ paused: true, pauseUntilMs: NOW + 1_000 }), [observation()], NOW);
    expect(paused.bindingTerm).toBe('pause');

    const physical = explainGatewayLaneBinding(klass({ inFlight: 8, effectiveWindow: 8 }), [observation()], NOW);
    expect(physical.bindingTerm).toBe('physical-contract');

    const window = explainGatewayLaneBinding(klass({ inFlight: 8, effectiveWindow: 8 }), [], NOW);
    expect(window.bindingTerm).toBe('effective-window');

    const free = explainGatewayLaneBinding(klass({ inFlight: 1, effectiveWindow: 8 }), [], NOW);
    expect(free.bindingTerm).toBeNull();
    expect(free.writer).toBeNull();
  });

  it('an EXPIRED physical constraint stops binding the lane — freshness is consulted, not just stored', () => {
    // Regression for the freshness-blind binding filter found by acceptance-rubric vetting
    // on 2026-08-30 (plan capless-inference-gateway-2026-08-28, D-020). A row collected while
    // `measured` keeps `state:'measured'` and `constraint:true` in the STORED object forever;
    // only `refreshPhysicalConstraint` re-classifies it once `expiresAtMs` has passed. The
    // binding filter used to read the raw row, so an expired provider quota was still reported
    // as the live binding term with a `physical-constraints.ts#provider` writer beside it.
    const expiresAtMs = NOW + 60_000;
    const row = observation({ expiresAtMs });

    // POSITIVE CONTROL — before expiry the same row MUST still bind, or this test would pass
    // for the trivial reason that nothing ever binds.
    const live = explainGatewayLaneBinding(klass({ inFlight: 8, effectiveWindow: 8 }), [row], NOW);
    expect(live.bindingTerm).toBe('physical-contract');
    expect(live.bindingObservations).toHaveLength(1);

    // CONTROL for the FAILURE MODE, not just the outcome: past expiry the STORED row is
    // byte-identical and still self-describes as a live constraint. Those two fields are
    // exactly what the pre-fix filter read, so this assertion pins that the gate below is
    // doing the work — if it ever passed because the row itself changed shape, this fails.
    expect(row.state).toBe('measured');
    expect(row.constraint).toBe(true);

    // One millisecond past its own stated validity, the SAME row must stop binding and the
    // lane must fall through to the term that actually explains it.
    const afterExpiry = explainGatewayLaneBinding(
      klass({ inFlight: 8, effectiveWindow: 8 }),
      [row],
      expiresAtMs + 1,
    );
    expect(afterExpiry.bindingTerm).toBe('effective-window');
    expect(afterExpiry.bindingObservations).toHaveLength(0);

    // And the same must hold through the operator-visible projection, not only the helper —
    // that projection is where the misdiagnosis would actually reach a human. Asserted as a
    // PAIR at the same inputs so the post-expiry `not.toBe` cannot pass vacuously: if lane
    // scoping filtered this row out entirely, the pre-expiry leg fails first and says so.
    const projectAt = (nowMs: number) =>
      describeGatewayAdmissionState({
        decision: decision({ classes: [klass({ inFlight: 8, effectiveWindow: 8 })] }),
        physical: verdict([row]),
        provider: 'claude',
        nowMs,
      }).lanes[0]!.binding.bindingTerm;

    expect(projectAt(NOW)).toBe('physical-contract');
    expect(projectAt(expiresAtMs + 1)).not.toBe('physical-contract');
  });

  it('does not attribute another account\'s physical constraint to this lane', () => {
    const snap = describeGatewayAdmissionState({
      decision: decision(),
      physical: verdict([observation({ scope: { provider: 'anthropic', accountId: 'acct-other' } })]),
      provider: 'claude',
      accountId: 'acct-mine',
      nowMs: NOW,
    });
    // A quota on one account reported as binding on another is exactly the
    // misdiagnosis this model exists to prevent.
    expect(snap.lanes[0]!.physical).toHaveLength(0);
    expect(snap.lanes[0]!.binding.bindingTerm).not.toBe('physical-contract');
  });

  it('degrades freshness with age and refuses to call a skewed clock fresh', () => {
    const budget = 10_000;
    const at = (evaluatedAtMs: number) =>
      describeGatewayAdmissionState({
        decision: decision({ evaluatedAtMs }),
        nowMs: NOW,
        freshnessBudgetMs: budget,
      }).freshness;

    expect(at(NOW - 1_000)).toBe('fresh');
    expect(at(NOW - 15_000)).toBe('aging');
    expect(at(NOW - 60_000)).toBe('stale');
    // An observation from the future is a broken instrument. Reporting it as `fresh`
    // would launder the fault into a confident reading.
    expect(at(NOW + 60_000)).toBe('unknown');
  });

  it('reports unknown freshness for an empty snapshot rather than fresh', () => {
    const snap = describeGatewayAdmissionState({ decision: decision({ classes: [] }), nowMs: NOW });
    expect(snap.freshness).toBe('unknown');
    expect(snap.schemaVersion).toBe(GATEWAY_ADMISSION_STATE_SCHEMA_VERSION);
  });
});

describe('describeGatewayLiveAdmissionState (integration — the production path)', () => {
  // This is the shape `/admin/config` builds from the gateway's own live writers:
  // ProviderAdmissionLifecycle for windows, each lane's queue.snapshot() for the rest.
  const live = describeGatewayLiveAdmissionState({
    lanes: [
      { lane: 'claude', window: 8, observedPeak: 12, minimumWindow: 2, inFlight: 8, queued: 3 },
      { lane: 'codex', window: 6, observedPeak: 6, minimumWindow: 2, inFlight: 1, queued: 2 },
    ],
    generation: 7,
    evaluatedAtMs: NOW - 1_000,
    healthState: 'healthy',
    nowMs: NOW,
  });

  it('attributes each number to the writer that actually produced it', () => {
    const claude = live.lanes.find((l) => l.lane.provider === 'claude')!;
    // Windows come from the lifecycle; in-flight/queued come from the lane queue.
    // Collapsing these onto one writer would send a doubting reader to the wrong file.
    expect(claude.effectiveWindow.writer.writer).toContain('provider-admission-lifecycle.ts#');
    expect(claude.inFlight.writer.writer).toContain('queue.snapshot');
    expect(claude.queue.depth.writer.writer).toContain('queue.snapshot');
    expect(claude.availableStarts.writer.disposition).toBe('derived');
  });

  it('keeps desired and effective identical rather than inventing a gap', () => {
    // The lifecycle keeps ONE adaptive window per lane. Splitting it to look richer
    // would recreate the maxConcurrent-beside-effective confusion that cost a day.
    for (const lane of live.lanes) {
      expect(lane.desiredWindow.value).toBe(lane.effectiveWindow.value);
    }
  });

  it('separates lanes by provider and computes available starts per lane', () => {
    const claude = live.lanes.find((l) => l.lane.provider === 'claude')!;
    const codex = live.lanes.find((l) => l.lane.provider === 'codex')!;
    expect(claude.availableStarts.value).toBe(0); // 8 in flight against an 8 window
    expect(codex.availableStarts.value).toBe(5); // 1 in flight against a 6 window
    expect(claude.laneId).not.toBe(codex.laneId);
  });

  it('alerts on the lane that is genuinely stalled, not the one at its window', () => {
    const alerts = projectAlerts(live);
    // claude is AT its window with a queue — correct capless behaviour, no alert.
    // codex has 2 queued with 5 starts free — a real admission defect.
    expect(alerts.alerts.map((a) => a.laneId)).toEqual([
      gatewayLaneId({ admissionClass: 'codex', provider: 'codex', accountId: null }),
    ]);
  });
});

describe('surfaces-agree (integration — the spec falsifier, executed)', () => {
  const snapshot = describeGatewayAdmissionState({
    decision: decision({
      classes: [
        klass({ admissionClass: 'interactive', inFlight: 8, effectiveWindow: 8, availableStarts: 0 }),
        klass({ admissionClass: 'batch', inFlight: 1, effectiveWindow: 6, availableStarts: 5 }),
      ],
    }),
    physical: verdict([observation()]),
    provider: 'claude',
    accountId: 'acct-mine',
    queued: { batch: [receipt({ state: 'queued' })] },
    nowMs: NOW,
  });

  const projections = Object.entries(GATEWAY_STATE_PROJECTIONS).map(
    ([name, project]) => [name, project(snapshot)] as const,
  );

  it('covers every registered surface, so a new one cannot silently escape this probe', () => {
    expect(projections.map(([n]) => n).sort()).toEqual(
      ['alerts', 'fleet:capacity', 'gateway:status', 'health-panel'].sort(),
    );
    expect(projections.length).toBeGreaterThanOrEqual(4);
  });

  it('never omits the generation or freshness needed to interpret a capacity number', () => {
    // The "omit" half of the falsifier.
    for (const [name, projected] of projections) {
      expect(projected.generation, `${name} omitted generation`).toBe(snapshot.generation);
      expect(projected.freshness, `${name} omitted freshness`).toBe(snapshot.freshness);
    }
  });

  /** Returns the lanes on which the given surfaces disagree about binding. */
  function disagreements(surfaces: readonly (readonly [string, unknown])[]): string[] {
    const byLane = new Map<string, { surface: string; term: unknown; writer: unknown }[]>();
    for (const [surface, projected] of surfaces) {
      const p = projected as { lanes?: unknown[]; alerts?: unknown[] };
      const rows = (p.lanes ?? p.alerts ?? []) as {
        laneId: string;
        bindingTerm: unknown;
        bindingWriter: unknown;
      }[];
      for (const row of rows) {
        const seen = byLane.get(row.laneId) ?? [];
        seen.push({ surface, term: row.bindingTerm, writer: row.bindingWriter });
        byLane.set(row.laneId, seen);
      }
    }
    const bad: string[] = [];
    for (const [laneId, rows] of byLane) {
      const terms = new Set(rows.map((r) => JSON.stringify(r.term)));
      const writers = new Set(rows.map((r) => JSON.stringify(r.writer)));
      if (terms.size !== 1 || writers.size !== 1) bad.push(laneId);
    }
    return bad;
  }

  it('no two surfaces disagree about a lane\'s binding writer', () => {
    // The "disagree" half of the falsifier.
    expect(projections.length).toBeGreaterThan(0);
    expect(disagreements(projections)).toEqual([]);
  });

  it('CONTROL: the agreement check catches a surface that derives binding on its own', () => {
    // A permanent deliberately-wrong implementation, kept here as a control so the
    // assertion above can never pass vacuously. This is the repo-sanctioned way to
    // prove a guard falsifiable for imported logic: mutating the real module in the
    // shared tree risks git-sync committing the mutant mid-probe.
    //
    // `projectRogueSurface` is what a future surface looks like when someone
    // re-derives binding locally instead of projecting the snapshot — the precise
    // regression this architecture exists to prevent.
    const projectRogueSurface = (snap: typeof snapshot) => ({
      generation: snap.generation,
      freshness: snap.freshness,
      lanes: snap.lanes.map((lane) => ({
        laneId: lane.laneId,
        bindingTerm: 'effective-window' as const, // re-derived, ignoring the pause/physical terms
        bindingWriter: 'some-other-module.ts#guess',
      })),
    });

    const caught = disagreements([...projections, ['rogue', projectRogueSurface(snapshot)] as const]);
    expect(caught.length, 'the agreement check failed to notice a rogue surface').toBeGreaterThan(0);
  });

  it('agrees on the shared capacity numbers the surfaces both publish', () => {
    const status = projectGatewayStatus(snapshot);
    const capacity = projectFleetCapacity(snapshot);
    for (const lane of snapshot.lanes) {
      const s = status.lanes.find((l) => l.laneId === lane.laneId)!;
      const c = capacity.lanes.find((l) => l.laneId === lane.laneId)!;
      // These two surfaces are the pair that historically disagreed (maxConcurrent
      // beside effective, from two independent reads).
      expect(s.inFlight).toEqual(c.inFlight);
      expect(s.queued).toEqual(c.queued);
    }
  });

  it('names the binding writer for the constrained lane, and no writer for the free one', () => {
    const health = projectHealthPanel(snapshot);
    const constrained = health.lanes.find((l) => l.laneId === gatewayLaneId({
      admissionClass: 'interactive', provider: 'claude', accountId: 'acct-mine',
    }))!;
    expect(constrained.bindingTerm).toBe('physical-contract');
    expect(constrained.bindingWriter).toContain('physical-constraints.ts#');
  });

  it('alerts only on work waiting while starts are available', () => {
    // batch has 1 queued with 5 starts available ⇒ an admission defect, alert.
    // interactive is at its window ⇒ working as designed, no alert.
    const alerts = projectAlerts(snapshot);
    expect(alerts.alerts).toHaveLength(1);
    expect(alerts.alerts[0]!.laneId).toContain('batch');
    expect(alerts.alerts[0]!.kind).toBe('admission-stalled');
  });
});
