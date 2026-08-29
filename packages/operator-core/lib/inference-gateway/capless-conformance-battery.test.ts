/**
 * P-014 — the capless gateway conformance, saturation, chaos, restart, and failure battery.
 *
 * Each case drives PRODUCTION modules and records the matrix cells it actually
 * exercised into a shared ledger. The final case asserts that the recorded set
 * equals the declared set exactly, in both directions: a deleted or skipped case
 * leaves a cell `missing`, and a case that records a cell the matrix never declared
 * shows up as `undeclared`. That is the whole point of the ledger — a coverage
 * claim nobody can quietly weaken by editing a comment.
 *
 * See `capless-conformance-battery.ts` for why the matrix is declared as data and
 * why the packaged/container deployment cells are re-measured rather than cited.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdmissionPersistenceError, Governor } from '../resource-governor/admission';
import type { HealthResource, HealthSeverity, HealthVerdict } from '../resource-governor/health-analysis';
import { HEALTH_ANALYSIS_SCHEMA_VERSION } from '../resource-governor/health-analysis';
import { MemoryAdmissionQueueStore } from '../resource-governor/memory-admission-queue-store';
import {
  CaplessGatewayAdmissionAdapter,
  InMemoryCaplessGatewayStateStore,
} from './capless-adapter';
import { gatewayAdmissionClassFor, type GatewayAdmissionKind } from './admission-context';
import {
  describeGatewayLiveAdmissionState,
  projectFleetCapacity,
  projectGatewayStatus,
  projectHealthPanel,
  projectAlerts,
  type GatewayMeasure,
} from './admission-state-model';
import { DurableGatewayAdmissionDriver } from './durable-admission';
import { memoryGatewayPayloadSpool, PayloadTooLargeError } from './payload-spool';
import {
  adaptLocalBackendTelemetry,
  adaptProviderOutcome,
  canContractFromPhysicalConstraint,
  BACKEND_CONSTRAINT_FRESH_FOR_MS,
} from './physical-constraints';
import {
  CONFORMANCE_ACCOUNT_SHAPES,
  CONFORMANCE_ADMISSION_CLASSES,
  CONFORMANCE_ADMISSION_KINDS,
  CONFORMANCE_BODY_SHAPES,
  CONFORMANCE_LANES,
  CONFORMANCE_PIN_MODES,
  CONFORMANCE_PLATFORMS,
  CONFORMANCE_PROPERTIES,
  CONFORMANCE_SATURATION_LEVELS,
  ConformanceLedger,
  RETIRED_LEGACY_CEILING,
  conformanceCellId,
  measureAdmissionPlatformBranching,
  measureGatewayDeploymentSurfaces,
  type ConformanceLane,
} from './capless-conformance-battery';

const START = 1_700_000_000_000;

/** One shared ledger for the whole file; the last case audits it. */
const ledger = new ConformanceLedger();

function verdict(
  input: { state?: HealthVerdict['state']; severity?: HealthSeverity; resource?: HealthResource; atMs?: number } = {},
): HealthVerdict {
  const state = input.state ?? 'healthy';
  const severity = input.severity ?? 'none';
  const resource = input.resource;
  const actionable = state === 'degraded' && resource !== undefined;
  return {
    schemaVersion: HEALTH_ANALYSIS_SCHEMA_VERSION,
    scopeId: 'gateway-conformance',
    evaluatedAtMs: input.atMs ?? START,
    state,
    severity,
    actionable,
    evidence: [],
    attributions: [],
    actionableResources: resource ? [resource] : [],
    ignoredCapacitySignals: [],
    reasons: ['conformance-battery'],
  };
}

/** The gateway request kind that carries each provider lane onto the admission path. */
function kindFor(lane: ConformanceLane): GatewayAdmissionKind {
  return lane === 'local' ? 'local' : lane;
}

// ── Property 1: stable health expands past every former ceiling ───────────────

describe('P-014 · stable health expands past every former ceiling', () => {
  for (const lane of CONFORMANCE_LANES) {
    it(`grows the ${lane} lane through the whole saturation ladder without stalling at ${RETIRED_LEGACY_CEILING}`, async () => {
      const adapter = new CaplessGatewayAdmissionAdapter({
        healthySamplesPerIncrease: 1,
        now: () => START,
      });
      const kind = kindFor(lane);
      const reached = new Map<number, number>();
      let window = 0;
      let steps = 0;
      const ceiling = CONFORMANCE_SATURATION_LEVELS[CONFORMANCE_SATURATION_LEVELS.length - 1]!;

      // Sustained demand under a healthy verdict. Nothing here asks for a window;
      // the controller is left to discover one, which is the point: a surviving
      // clamp shows up as a level the ladder simply cannot reach.
      while (window < ceiling && steps < 4_000) {
        const decision = await adapter.step({
          verdict: verdict({ atMs: START + steps }),
          requests: [{ kind, idempotencyKey: `${lane}:${steps}` }],
        });
        window = decision.classes.find((item) => item.admissionClass === 'inference')?.desiredWindow ?? 0;
        for (const level of CONFORMANCE_SATURATION_LEVELS) {
          if (window >= level && !reached.has(level)) reached.set(level, steps);
        }
        steps += 1;
      }

      // Every rung, including the three past the deleted 24-wide default.
      for (const level of CONFORMANCE_SATURATION_LEVELS) {
        expect(reached.has(level), `${lane} never reached concurrency ${level}`).toBe(true);
        ledger.record(
          CONFORMANCE_PROPERTIES.ceilingExpansion,
          'saturation',
          String(level),
          `${lane} lane reached a ${level}-wide admission window under sustained healthy demand`,
        );
      }

      // The specific regression this plan exists to prevent: a window that grows
      // to exactly the retired default and stops. Reaching 24 is not enough —
      // it must keep going, which is what the strict comparison asserts.
      expect(window).toBeGreaterThan(RETIRED_LEGACY_CEILING);
      expect(window).toBeGreaterThanOrEqual(ceiling);
      ledger.record(
        CONFORMANCE_PROPERTIES.ceilingExpansion,
        'lane',
        lane,
        `${lane} window grew to ${window} (> retired ceiling ${RETIRED_LEGACY_CEILING}) in ${steps} healthy ticks`,
      );
    });
  }
});

// ── Property 2: causal faults contract only responsible classes, and expire ───

describe('P-014 · causal faults contract only the responsible lane and then expire', () => {
  for (const lane of CONFORMANCE_LANES) {
    it(`scopes a ${lane} fault to its own subject and lets it expire`, () => {
      const now = START;
      const freshForMs = lane === 'local' ? BACKEND_CONSTRAINT_FRESH_FOR_MS : 30_000;

      const observations =
        lane === 'local'
          ? adaptLocalBackendTelemetry({
              backend: { id: 'backend-a', kind: 'llama-server', enabled: true, maxConcurrent: 8 },
              // freeSlots:0 is an ENGINE-reported contract, which is the only local
              // signal permitted to contract admission (D-008).
              engine: { reported: true, authoritative: true, totalSlots: 4, freeSlots: 0, observedAtMs: now },
              inFlight: 4,
              nowMs: now,
              observedAtMs: now,
              freshForMs,
            })
          : adaptProviderOutcome({
              provider: lane === 'claude' ? 'anthropic' : 'codex',
              accountId: 'acct-a',
              status: 429,
              outcome: 'rate-limit',
              nowMs: now,
              observedAtMs: now,
              freshForMs,
            }).observations;

      expect(observations.length).toBeGreaterThan(0);

      // SCOPE: nothing this fault produced may name a different subject. An
      // observation scoped to another account or backend is precisely how a
      // single lane's 429 used to contract the whole gate.
      const subject = lane === 'local' ? 'backend-a' : 'acct-a';
      for (const observation of observations) {
        const named = observation.scope.backendId ?? observation.scope.accountId ?? null;
        if (named !== null) expect(named).toBe(subject);
      }

      // EXPIRY: at least one row may actually drive a contraction now, and no row
      // may still drive one after its freshness window closes. A fault that never
      // expires is a permanent cap wearing a different hat.
      const contracting = observations.filter((observation) => canContractFromPhysicalConstraint(observation, now));
      expect(contracting.length).toBeGreaterThan(0);
      const afterExpiry = now + freshForMs + 1;
      for (const observation of observations) {
        expect(canContractFromPhysicalConstraint(observation, afterExpiry)).toBe(false);
      }

      ledger.record(
        CONFORMANCE_PROPERTIES.causalContraction,
        'lane',
        lane,
        `${contracting.length} row(s) scoped to ${subject} could contract at T and none could at T+${freshForMs}ms`,
      );
    });
  }

  it('never lets configured local policy masquerade as a physical contract', () => {
    // D-008 in one assertion: maxConcurrent is local policy, so it may be shown
    // for diagnostics but may never contract admission the way an engine-reported
    // slot contract does. This is the local lane's version of "only the
    // responsible class contracts".
    const observations = adaptLocalBackendTelemetry({
      backend: { id: 'backend-a', kind: 'llama-server', enabled: true, maxConcurrent: 8 },
      engine: null,
      nowMs: START,
      observedAtMs: START,
    });
    const policy = observations.find((observation) => observation.key === 'backend.policySlots');
    expect(policy).toBeDefined();
    expect(policy?.binding).toBe('local-policy');
    expect(canContractFromPhysicalConstraint(policy!, START)).toBe(false);
  });

  for (const shape of CONFORMANCE_ACCOUNT_SHAPES) {
    it(`contracts only the faulting account in the ${shape} case`, () => {
      const now = START;
      const faulting = adaptProviderOutcome({
        provider: 'anthropic',
        accountId: 'acct-a',
        status: 429,
        outcome: 'rate-limit',
        nowMs: now,
        observedAtMs: now,
        freshForMs: 30_000,
      });

      // Single-account: the fault is the whole pool's fault, but it must still be
      // ATTRIBUTED to the account rather than to the gateway, or recovery cannot
      // route around it. Multi-account: a healthy sibling must be untouched, which
      // is the owner-visible "API errors despite headroom" failure.
      expect(faulting.attribution.subjectId).toBe('acct-a');
      for (const observation of faulting.observations) {
        if (observation.scope.accountId) expect(observation.scope.accountId).toBe('acct-a');
      }

      if (shape === 'multi-account') {
        const healthy = adaptProviderOutcome({
          provider: 'anthropic',
          accountId: 'acct-b',
          status: 200,
          outcome: 'success',
          nowMs: now,
          observedAtMs: now,
        });
        const contracting = healthy.observations.filter((observation) =>
          canContractFromPhysicalConstraint(observation, now),
        );
        expect(contracting).toHaveLength(0);
      }

      ledger.record(
        CONFORMANCE_PROPERTIES.causalContraction,
        'account-shape',
        shape,
        `429 on acct-a attributed to acct-a${shape === 'multi-account' ? '; acct-b produced no contracting row' : ''}`,
      );
    });
  }
});

// ── Property 3: capacity queues with bounded resident memory ─────────────────

describe('P-014 · capacity queues with bounded resident memory', () => {
  it('keeps a queued request O(ref) resident regardless of body size, on both body shapes', async () => {
    const spool = memoryGatewayPayloadSpool({ maxBytes: 8 * 1024 * 1024 });
    const oneMib = Buffer.alloc(1024 * 1024, 7);

    // Non-streaming: the body arrives as one buffer.
    const buffered = await spool.spool(oneMib);
    expect(buffered.payloadRef).not.toBeNull();
    ledger.record(
      CONFORMANCE_PROPERTIES.boundedMemory,
      'body-shape',
      'non-streaming',
      `a ${oneMib.byteLength}-byte buffered body reduced to a ${buffered.payloadRef!.length}-char ref`,
    );

    // Streaming: the same bytes arrive as chunks and are assembled before
    // acceptance. Content addressing must make the two paths converge on ONE
    // resident blob — otherwise every streamed retry doubles resident memory.
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < oneMib.byteLength; offset += 64 * 1024) {
      chunks.push(oneMib.subarray(offset, Math.min(offset + 64 * 1024, oneMib.byteLength)));
    }
    const streamed = await spool.spool(Buffer.concat(chunks));
    expect(streamed.payloadRef).toBe(buffered.payloadRef);
    expect(streamed.deduped).toBe(true);
    expect(spool.data.size).toBe(1);
    ledger.record(
      CONFORMANCE_PROPERTIES.boundedMemory,
      'body-shape',
      'streaming',
      `${chunks.length} chunks assembled to the same ref as the buffered body; 1 resident blob, not 2`,
    );

    // The size-independence claim itself: a 4x larger body yields a ref of the
    // same length, so queue depth scales ref bytes, never body bytes.
    const fourMib = Buffer.alloc(4 * 1024 * 1024, 9);
    const large = await spool.spool(fourMib);
    expect(large.payloadRef).not.toBeNull();
    expect(large.payloadRef!.length).toBe(buffered.payloadRef!.length);
    expect(large.payloadRef!.length).toBeLessThan(256);
  });

  it('refuses a body larger than the spool cap instead of admitting it resident', async () => {
    const spool = memoryGatewayPayloadSpool({ maxBytes: 1024 });
    await expect(spool.spool(Buffer.alloc(4096, 1))).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(spool.data.size).toBe(0);
  });

  it('reclaims a released payload so depth does not grow without bound', async () => {
    const spool = memoryGatewayPayloadSpool({ maxBytes: 1024 * 1024 });
    const { payloadRef } = await spool.spool(Buffer.alloc(2048, 3));
    expect(payloadRef).not.toBeNull();
    await spool.retain(payloadRef!);
    expect(await spool.sweep()).toBe(0); // pinned by a live receipt
    await spool.release(payloadRef!);
    expect(await spool.sweep()).toBe(1);
    expect(spool.data.size).toBe(0);
  });
});

// ── Property 4: restart/failover loses or duplicates no accepted work ────────

describe('P-014 · restart and failover lose no accepted work and duplicate none', () => {
  for (const lane of CONFORMANCE_LANES) {
    it(`survives a ${lane} gateway restart without losing or re-executing the receipt`, async () => {
      const store = new MemoryAdmissionQueueStore();
      const namespace = `gateway-conformance-${lane}`;
      const request = {
        idempotencyKey: `gateway:${lane}:1`,
        admissionClass: 'inference',
        demand: { providerRequests: 1 },
        metadata: { 'gateway.ownerId': `owner-${lane}` },
      } as const;

      const before = new Governor(
        new DurableGatewayAdmissionDriver({
          store,
          namespace,
          now: () => START,
          leaseIdFactory: () => `${lane}-lease-1`,
        }),
        { now: () => START, idFactory: () => `${lane}-request-1` },
      );
      const admitted = await before.admit(request);
      expect(admitted.kind).toBe('admitted');
      expect(store.state(namespace, request.idempotencyKey)).toBe('running');

      // RESTART: a brand-new driver and governor, new lease-id factory, same
      // durable store — exactly what a process restart or a failover to a second
      // gateway looks like from the queue's side.
      const after = new Governor(
        new DurableGatewayAdmissionDriver({
          store,
          namespace,
          now: () => START + 5_000,
          leaseIdFactory: () => `${lane}-lease-2`,
        }),
        { now: () => START + 5_000, idFactory: () => `${lane}-request-2` },
      );

      // LOSES NOTHING: the accepted work is still there, still running, still
      // traceable by its receipt after the restart.
      const surviving = await store.find(namespace, request.idempotencyKey);
      expect(surviving).not.toBeNull();
      expect(surviving?.record.state).toBe('running');

      // DUPLICATES NOTHING: the same idempotency key cannot be admitted a second
      // time into a second upstream execution. The unique receipt refuses it.
      await expect(after.admit(request)).rejects.toBeInstanceOf(AdmissionPersistenceError);
      expect(store.size).toBe(1);

      ledger.record(
        CONFORMANCE_PROPERTIES.restartIntegrity,
        'lane',
        lane,
        `receipt ${surviving?.receiptId} survived the restart as running; re-admit refused, queue still holds exactly 1 receipt`,
      );
    });
  }
});

// ── Property 5: priority is work-conserving ─────────────────────────────────

describe('P-014 · priority is work-conserving', () => {
  for (const admissionClass of CONFORMANCE_ADMISSION_CLASSES) {
    it(`lets ${admissionClass} use the whole machine when it is the only demander`, async () => {
      // D-007: priority governs ORDERING, not capacity. If a tier cap or a fixed
      // reserve survived, the sole demanding class would plateau at its share
      // instead of growing — so the falsifier is simply "does it keep growing".
      const adapter = new CaplessGatewayAdmissionAdapter({
        healthySamplesPerIncrease: 1,
        now: () => START,
      });
      let decision = await adapter.step({
        verdict: verdict(),
        classes: [{ admissionClass, inFlight: 1, demand: { providerRequests: 1 } }],
      });
      for (let step = 1; step <= 200; step += 1) {
        decision = await adapter.step({
          verdict: verdict({ atMs: START + step }),
          classes: [{ admissionClass, inFlight: 1, demand: { providerRequests: 1 } }],
        });
      }

      const solo = decision.classes.find((item) => item.admissionClass === admissionClass);
      expect(solo, `${admissionClass} produced no decision`).toBeDefined();
      expect(solo!.desiredWindow).toBeGreaterThan(RETIRED_LEGACY_CEILING);

      // Nothing is held back from the only class that wants work: a healthy lane's
      // effective window is its desired window, and its available starts are the
      // whole window minus what is genuinely in flight.
      expect(solo!.effectiveWindow).toBe(solo!.desiredWindow);
      expect(solo!.availableStarts).toBe(Math.max(0, solo!.effectiveWindow - solo!.inFlight));

      ledger.record(
        CONFORMANCE_PROPERTIES.workConserving,
        'admission-class',
        admissionClass,
        `sole-demander ${admissionClass} reached window ${solo!.desiredWindow} with no reserved-idle starts`,
      );
    });
  }
});

describe('P-014 · maintenance and control are both first-class, not just the class they share', () => {
  for (const kind of CONFORMANCE_ADMISSION_KINDS) {
    it(`admits ${kind} through the control class without starving it`, async () => {
      // Both kinds resolve to 'control'. Asserting the MAP as well as the behaviour
      // is what makes this a per-kind check: if a future change reroutes
      // maintenance to its own class, this fails here rather than silently
      // changing what the behavioural half was measuring.
      const admissionClass = gatewayAdmissionClassFor(kind);
      expect(admissionClass).toBe('control');

      const adapter = new CaplessGatewayAdmissionAdapter({
        healthySamplesPerIncrease: 1,
        now: () => START,
      });
      let decision = await adapter.step({
        verdict: verdict(),
        requests: [{ kind, idempotencyKey: `${kind}:0` }],
      });
      for (let step = 1; step <= 200; step += 1) {
        decision = await adapter.step({
          verdict: verdict({ atMs: START + step }),
          requests: [{ kind, idempotencyKey: `${kind}:${step}` }],
        });
      }
      const lane = decision.classes.find((item) => item.admissionClass === admissionClass);
      expect(lane).toBeDefined();
      expect(lane!.desiredWindow).toBeGreaterThan(RETIRED_LEGACY_CEILING);

      ledger.record(
        CONFORMANCE_PROPERTIES.workConserving,
        'admission-kind',
        kind,
        `${kind} → ${admissionClass} class reached window ${lane!.desiredWindow} under sustained demand`,
      );
    });
  }
});

describe('P-014 · supported platforms', () => {
  it('has nothing platform-specific on the admission path, and can prove the scan works', () => {
    const probe = measureAdmissionPlatformBranching();

    // Positive control first: if the scan cannot find platform branching in a file
    // that definitely has it, then finding none on the admission path means nothing.
    expect(probe.scanned.length).toBe(8);
    expect(
      probe.control.hits,
      `the platform scan found no branch token in ${probe.control.file} — the scan itself is broken, so its "no branching" result is not evidence`,
    ).toBeGreaterThan(0);

    expect(
      probe.branching,
      `admission now branches on platform in ${probe.branching.join(', ')} — the platform cells can no longer be vacated and need real per-platform coverage`,
    ).toEqual([]);

    for (const platform of CONFORMANCE_PLATFORMS) {
      ledger.vacate(
        CONFORMANCE_PROPERTIES.ceilingExpansion,
        'platform',
        platform,
        'D-015',
        `no platform branch across ${probe.scanned.length} admission modules; control ${probe.control.file} hit ${probe.control.hits} token(s), so the absence is measured`,
      );
    }
  });
});

// ── Property 6: state and alerts match canonical writers ────────────────────

describe('P-014 · every surface agrees with the canonical writers', () => {
  function snapshotFor(pinMode: (typeof CONFORMANCE_PIN_MODES)[number]) {
    const pinned = pinMode === 'pinned';
    return describeGatewayLiveAdmissionState({
      lanes: CONFORMANCE_LANES.map((lane, index) => ({
        lane,
        admissionClass: 'inference',
        window: 64 + index * 8,
        observedPeak: 40 + index,
        minimumWindow: 1,
        inFlight: 12 + index,
        queued: index, // lane 0 has an empty queue; later lanes are non-empty
        accountId: pinned ? `acct-${lane}` : null,
      })),
      generation: 7,
      evaluatedAtMs: START,
      healthState: 'healthy',
      nowMs: START,
    });
  }

  for (const pinMode of CONFORMANCE_PIN_MODES) {
    it(`renders one consistent lane identity across all four surfaces (${pinMode})`, () => {
      const snapshot = snapshotFor(pinMode);
      const status = projectGatewayStatus(snapshot);
      const capacity = projectFleetCapacity(snapshot);
      const panel = projectHealthPanel(snapshot);

      const laneIds = snapshot.lanes.map((lane) => lane.laneId);
      expect(status.lanes.map((lane) => lane.laneId)).toEqual(laneIds);
      expect(capacity.lanes.map((lane) => lane.laneId)).toEqual(laneIds);
      expect(panel.lanes.map((lane) => lane.laneId)).toEqual(laneIds);

      // The pin mode must be visible IN the identity, not inferred from a field
      // name: an unpinned lane is 'any', a pinned lane names its account. Two
      // surfaces disagreeing here is how a pinned lane's numbers get read as a
      // pool-wide reading.
      for (const laneId of laneIds) {
        expect(laneId.endsWith(pinMode === 'pinned' ? laneId.split('/')[2]! : 'any')).toBe(true);
        if (pinMode === 'unpinned') expect(laneId.endsWith('/any')).toBe(true);
        else expect(laneId).toMatch(/\/acct-/);
      }

      // Shared fields may not disagree. gateway:status and fleet:capacity both
      // publish inFlight and queued; they are views of ONE snapshot, so equality
      // here is a structural guarantee that must never quietly become a copy.
      for (let index = 0; index < laneIds.length; index += 1) {
        expect(capacity.lanes[index]!.inFlight).toEqual(status.lanes[index]!.inFlight);
        expect(capacity.lanes[index]!.queued).toEqual(status.lanes[index]!.queued);
        expect(capacity.lanes[index]!.generation).toBe(status.lanes[index]!.generation);
      }

      ledger.record(
        CONFORMANCE_PROPERTIES.writerConsistency,
        'pin-mode',
        pinMode,
        `${laneIds.length} lanes rendered identically across gateway:status, fleet:capacity and health-panel`,
      );
    });
  }

  it('never publishes a bare number — every measure names its writer, unit and disposition', () => {
    const snapshot = snapshotFor('pinned');
    const measures: Array<readonly [string, GatewayMeasure]> = [];
    for (const lane of snapshot.lanes) {
      measures.push(
        [`${lane.laneId}.desiredWindow`, lane.desiredWindow],
        [`${lane.laneId}.effectiveWindow`, lane.effectiveWindow],
        [`${lane.laneId}.inFlight`, lane.inFlight],
        [`${lane.laneId}.availableStarts`, lane.availableStarts],
        [`${lane.laneId}.queue.depth`, lane.queue.depth],
      );
    }
    expect(measures.length).toBeGreaterThan(0);
    for (const [label, measure] of measures) {
      expect(measure.writer.writer, `${label} has no writer`).toBeTruthy();
      expect(measure.writer.unit, `${label} has no unit`).toBeTruthy();
      expect(measure.writer.disposition, `${label} has no disposition`).toBeTruthy();
    }

    for (const lane of snapshot.lanes) {
      ledger.record(
        CONFORMANCE_PROPERTIES.writerConsistency,
        'lane',
        lane.lane.provider!,
        `${lane.laneId}: 5 measures each carrying writer, unit and disposition`,
      );
    }
  });

  it('fires an alert only where the snapshot itself says a lane is stalled', () => {
    // The alert surface is the one most likely to drift into its own arithmetic.
    // Recompute its condition straight from the snapshot and require agreement.
    const snapshot = snapshotFor('unpinned');
    const alerts = projectAlerts(snapshot);
    const expected = snapshot.lanes.filter(
      (lane) => (lane.queue.depth.value ?? 0) > 0 && (lane.availableStarts.value ?? 0) > 0 && !lane.paused,
    );
    expect(alerts.alerts.map((alert) => alert.laneId)).toEqual(expected.map((lane) => lane.laneId));
    expect(alerts.generation).toBe(snapshot.generation);
  });
});

// ── The deployment dimension, re-measured rather than cited ──────────────────

describe('P-014 · deployment paths', () => {
  it('re-measures which deployment paths actually run a gateway, with positive controls', () => {
    const surfaces = measureGatewayDeploymentSurfaces();
    expect(surfaces).toHaveLength(4);

    for (const surface of surfaces) {
      // A probe that scanned nothing would report a comfortable, meaningless
      // absence. The positive control is what makes `spawnsGateway:false`
      // evidence rather than silence.
      expect(surface.scanned.length, `${surface.deployment} probe scanned no files`).toBeGreaterThan(0);
      expect(
        surface.control.hits,
        `${surface.deployment} probe found no '${surface.control.token}' — the corpus moved, so its result means nothing`,
      ).toBeGreaterThan(0);
    }

    const byName = new Map(surfaces.map((surface) => [surface.deployment, surface]));

    // Exercised: these two really do start a gateway, and there is exactly ONE
    // process entry between them (D-014), which is why they share the state model
    // rather than needing two independent conformance runs.
    for (const deployment of ['development', 'systemd'] as const) {
      const surface = byName.get(deployment)!;
      expect(surface.spawnsGateway, `${deployment} no longer starts a gateway`).toBe(true);
      ledger.record(
        CONFORMANCE_PROPERTIES.writerConsistency,
        'deployment',
        deployment,
        `${deployment} starts a gateway via ${surface.hits.join(', ')}; same process entry, so the same canonical writers`,
      );
    }

    // Vacuous under D-014 — but only for as long as the measurement holds. The
    // moment a gateway spawn appears in the Tauri sidecar set or a container
    // image, this flips and the battery fails instead of citing a stale decision.
    for (const deployment of ['packaged', 'container'] as const) {
      const surface = byName.get(deployment)!;
      expect(
        surface.spawnsGateway,
        `${deployment} now spawns a gateway (${surface.hits.join(', ')}) — D-014's vacuity no longer holds and this cell needs real coverage`,
      ).toBe(false);
      ledger.vacate(
        CONFORMANCE_PROPERTIES.writerConsistency,
        'deployment',
        deployment,
        'D-014',
        `re-measured at run time: 0 gateway entry points across ${surface.scanned.length} scanned file(s), positive control '${surface.control.token}' hit ${surface.control.hits}x`,
      );
    }
  });
});

// ── Self-controls: prove the battery's own instruments can fail ─────────────

describe('P-014 · battery self-controls', () => {
  // A coverage ledger that cannot report a gap is worse than no ledger: it makes
  // every run look complete. These controls are permanent rather than a one-off
  // mutation probe, because the instrument they guard is the one thing in this
  // file that nothing else checks. They use their own throwaway ledgers and
  // requirement sets, so they never touch the shared ledger the audit reads.

  it('reports a MISSING cell when a case does not record one', () => {
    const control = new ConformanceLedger([
      {
        property: CONFORMANCE_PROPERTIES.ceilingExpansion,
        dimension: 'control',
        values: ['recorded', 'forgotten'],
        rationale: 'self-control',
      },
    ]);
    control.record(CONFORMANCE_PROPERTIES.ceilingExpansion, 'control', 'recorded', 'present');
    const report = control.report();
    expect(report.missing).toEqual([`${CONFORMANCE_PROPERTIES.ceilingExpansion}|control=forgotten`]);
    expect(report.exercised).toBe(1);
  });

  it('reports an UNDECLARED cell when a case invents one', () => {
    const control = new ConformanceLedger([
      {
        property: CONFORMANCE_PROPERTIES.ceilingExpansion,
        dimension: 'control',
        values: ['declared'],
        rationale: 'self-control',
      },
    ]);
    control.record(CONFORMANCE_PROPERTIES.ceilingExpansion, 'control', 'declared', 'present');
    control.record(CONFORMANCE_PROPERTIES.ceilingExpansion, 'control', 'invented', 'not in the matrix');
    expect(control.report().undeclared).toEqual([`${CONFORMANCE_PROPERTIES.ceilingExpansion}|control=invented`]);
  });

  it('refuses to let a cell be exercised and vacated at once', () => {
    const control = new ConformanceLedger([
      {
        property: CONFORMANCE_PROPERTIES.ceilingExpansion,
        dimension: 'control',
        values: ['contested'],
        rationale: 'self-control',
      },
    ]);
    control.record(CONFORMANCE_PROPERTIES.ceilingExpansion, 'control', 'contested', 'ran');
    expect(() =>
      control.vacate(CONFORMANCE_PROPERTIES.ceilingExpansion, 'control', 'contested', 'D-014', 'also vacuous'),
    ).toThrow(/already dispositioned/);
  });

  it('DETECTS a gateway spawn in a packaged tree, so the D-014 vacuity is a finding and not a default', () => {
    // The deployment probe's whole value rests on it being able to say "yes".
    // Point it at a synthetic tree whose Tauri sources DO name a gateway entry
    // and require it to notice. Built in a temp dir: the shared checkout is
    // swept by git-sync, so a probe must never mutate it to prove a point.
    const root = mkdtempSync(join(tmpdir(), 'capless-deployment-probe-'));
    try {
      const tauriSrc = join(root, 'papercusp-desktop', 'src-tauri', 'src');
      mkdirSync(tauriSrc, { recursive: true });
      writeFileSync(
        join(root, 'papercusp-desktop', 'src-tauri', 'tauri.conf.json'),
        JSON.stringify({ productName: 'papercusp' }),
      );
      writeFileSync(join(root, 'papercusp-desktop', 'src-tauri', 'Cargo.toml'), '[package]\nname = "papercusp"\n');
      writeFileSync(
        join(tauriSrc, 'sidecar.rs'),
        '// papercusp\nfn spawn() { Command::new("node").arg("inference-gateway/bin.ts"); }\n',
      );

      const packaged = measureGatewayDeploymentSurfaces({ repoRoot: root }).find(
        (surface) => surface.deployment === 'packaged',
      );
      expect(packaged?.control.hits).toBeGreaterThan(0);
      expect(packaged?.spawnsGateway).toBe(true);
      expect(packaged?.hits.some((hit) => hit.endsWith('sidecar.rs'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a probe with no positive control, rather than a comfortable absence', () => {
    // An empty tree must NOT read as "packaged runs no gateway" — it must read as
    // "this probe measured nothing", which the audit above rejects via control.hits.
    const root = mkdtempSync(join(tmpdir(), 'capless-empty-probe-'));
    try {
      const packaged = measureGatewayDeploymentSurfaces({ repoRoot: root }).find(
        (surface) => surface.deployment === 'packaged',
      );
      expect(packaged?.spawnsGateway).toBe(false);
      expect(packaged?.control.hits).toBe(0); // ⇐ what makes the false absence detectable
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── The audit ───────────────────────────────────────────────────────────────

describe('P-014 · matrix coverage audit', () => {
  it('dispositions every declared cell and invents none', () => {
    const report = ledger.report();

    // `missing` catches a case that was deleted, skipped, or silently stopped
    // covering what it claims. `undeclared` stops the ledger being padded with
    // cells the matrix never asked for. Both directions matter.
    expect(report.missing, `uncovered conformance cells: ${report.missing.join(', ')}`).toEqual([]);
    expect(report.undeclared, `ledger recorded undeclared cells: ${report.undeclared.join(', ')}`).toEqual([]);
    expect(report.exercised + report.vacuous).toBe(report.declared);

    // Vacuity is pinned to an exact SET, not a count. A count would let a newly
    // inconvenient cell be vacated as long as some other cell stopped being — the
    // quiet way a battery decays into a list of the things that were easy.
    const allowedVacuous = [
      conformanceCellId(CONFORMANCE_PROPERTIES.writerConsistency, 'deployment', 'packaged'),
      conformanceCellId(CONFORMANCE_PROPERTIES.writerConsistency, 'deployment', 'container'),
      ...CONFORMANCE_PLATFORMS.map((platform) =>
        conformanceCellId(CONFORMANCE_PROPERTIES.ceilingExpansion, 'platform', platform),
      ),
    ].sort();
    expect(report.vacuousCells).toEqual(allowedVacuous);
    expect(report.declared).toBeGreaterThan(0);
  });
});
