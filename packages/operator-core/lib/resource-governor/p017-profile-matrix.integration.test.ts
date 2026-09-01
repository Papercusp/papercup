/**
 * P-017 — cross-machine saturation, queue, chaos and failure validation for the
 * capless adaptive resource governor.
 *
 * Executed as RESOURCE-PROFILE EMULATION on the canonical staging substrate per
 * plan decision D-024 (`capless-adaptive-resource-governor-2026-08-26`): the
 * enumerated machine matrix (laptop / workstation / high-core+memory server /
 * constrained container / Linux+macOS+Windows / embedded vs dedicated DB /
 * single vs multi-worker, at 1/10/30/100/300 and beyond the former ceilings) is
 * satisfied by named resource profiles driven through the real stack, not by
 * procuring separate physical machines. Every profile still owes evidence for
 * every P-017 acceptance property, which is what each `it` below asserts.
 *
 * The stack under test is real, not mocked: `PgAdmissionLedgerQueueStore` (the
 * dedicated admission ledger, P-006 of
 * `resource-governor-admission-ledger-2026-09-01`) on a real Postgres,
 * `WorkItemAdmissionQueueDriver`, `Governor`, `RollingHealthAnalyzer`,
 * `CaplessAdaptiveController` and `PacedDurableQueueDrainer`. Only the *host
 * measurements* are emulated — that is the axis D-024 rules is emulable. The
 * fixture carries no work-item allocator, so every load level here also proves
 * that admission never allocates a work-item.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  allSessionsLiveResolver,
  applyAdmissionLedgerFixture,
  truncateAdmissionLedgerFixture,
  workItemRowCount,
} from '../../test/_admission-ledger-fixture';
import { Governor } from './admission';
import { PgAdmissionLedgerQueueStore } from './admission-ledger-store';
import { WorkItemAdmissionQueueDriver } from './queue';
import {
  LIVE_HEALTH_SCHEMA_VERSION,
  LIVE_HEALTH_SIGNAL_SPECS,
  emptyLiveHealthObservations,
  emptyLiveHealthSignals,
  liveHealthWindow,
  measuredLiveHealthReading,
  type LiveHealthPlatformProfile,
  type LiveHealthReading,
  type LiveHealthSignalKey,
  type LiveHealthSnapshot,
  type LiveHealthWriter,
} from './live-health';
import {
  RollingHealthAnalyzer,
  liveHealthFrameFromSnapshot,
  type HealthAnalysisFrame,
  type HealthResource,
} from './health-analysis';
import { CaplessAdaptiveController, CAPLESS_CONTROLLER_STATE_SCHEMA_VERSION } from './controller';
import { PacedDurableQueueDrainer, type QueueDrainLeaseSource } from './queue-drainer';

const START = 1_700_000_000_000;
const STEP = 5_000;
const WORKSPACE_ID = 'ws-p017';

/**
 * The former hard ceilings this plan deleted. P-017 requires load "beyond former
 * ceilings", so the ladder deliberately runs past the largest of them and the
 * upward-probe assertions require the controller to climb past it too.
 */
const FORMER_CEILINGS = Object.freeze({
  deepMaxConcurrent: 2,
  fleetMaxMembers: 30,
  testWorkers: 100,
  highest: 300,
});

const LOAD_LADDER = Object.freeze([1, 10, 30, 100, 300, 600]);

interface ResourceProfile {
  readonly id: string;
  /** The machine class this profile emulates, in P-017's own vocabulary. */
  readonly machineClass: 'laptop' | 'workstation' | 'high-core-server' | 'constrained-container';
  readonly profile: LiveHealthPlatformProfile;
}

function platform(
  input: Omit<LiveHealthPlatformProfile, 'source'>,
): LiveHealthPlatformProfile {
  return Object.freeze({ ...input, source: '@papercusp/resource-profile' as const });
}

/**
 * The emulated matrix. Cores/memory are the container/cgroup limit each run is
 * recorded with; `embeddedPg` is the DB-mode axis; `platform` is the OS axis.
 */
const PROFILES: readonly ResourceProfile[] = Object.freeze([
  {
    id: 'laptop-4c-8g-darwin-embedded',
    machineClass: 'laptop',
    profile: platform({
      platform: 'darwin',
      arch: 'arm64',
      release: 'p017-emulated-laptop',
      effectiveCores: 4,
      physicalCores: 4,
      totalMemoryBytes: 8 * 1024 ** 3,
      embeddedPg: true,
      hostRole: 'laptop',
    }),
  },
  {
    id: 'workstation-8c-32g-win32-embedded',
    machineClass: 'workstation',
    profile: platform({
      platform: 'win32',
      arch: 'x64',
      release: 'p017-emulated-workstation',
      effectiveCores: 8,
      physicalCores: 8,
      totalMemoryBytes: 32 * 1024 ** 3,
      embeddedPg: true,
      hostRole: 'workstation',
    }),
  },
  {
    id: 'workstation-16c-64g-linux-dedicated',
    machineClass: 'workstation',
    profile: platform({
      platform: 'linux',
      arch: 'x64',
      release: 'p017-emulated-workstation-linux',
      effectiveCores: 16,
      physicalCores: 16,
      totalMemoryBytes: 64 * 1024 ** 3,
      embeddedPg: false,
      hostRole: 'workstation',
    }),
  },
  {
    id: 'server-128c-252g-linux-dedicated',
    machineClass: 'high-core-server',
    profile: platform({
      platform: 'linux',
      arch: 'x64',
      release: 'p017-emulated-high-core-server',
      effectiveCores: 128,
      physicalCores: 64,
      totalMemoryBytes: 252 * 1024 ** 3,
      embeddedPg: false,
      hostRole: 'server',
    }),
  },
  {
    id: 'container-2c-2g-linux-embedded',
    machineClass: 'constrained-container',
    profile: platform({
      platform: 'linux',
      arch: 'x64',
      release: 'p017-emulated-constrained-container',
      effectiveCores: 2,
      physicalCores: 2,
      totalMemoryBytes: 2 * 1024 ** 3,
      embeddedPg: true,
      hostRole: 'container',
    }),
  },
]);

const HEALTHY_VALUES: Readonly<Partial<Record<LiveHealthSignalKey, number | boolean>>> = Object.freeze({
  'progress.heartbeatLagMs': 5,
  'cpu.hostUtilizationPct': 35,
  'cpu.processUtilizationPct': 20,
  'cpu.psiSomePct': 0.1,
  'latency.eventLoopP95Ms': 8,
  'memory.hostUsedBytes': 4 * 1024 ** 3,
  'memory.workingSetBytes': 512 * 1024 ** 2,
  'memory.workingSetGrowthBytesPerSec': 0,
  'memory.psiSomePct': 0.1,
  'memory.psiFullPct': 0,
  'memory.gcPauseP95Ms': 2,
  'memory.majorFaultsPerSec': 0,
  'memory.swapUsedBytes': 0,
  'memory.swapInBytesPerSec': 0,
  'memory.swapOutBytesPerSec': 0,
  'database.waitP95Ms': 5,
  'database.activeConnections': 4,
  'service.waitP95Ms': 5,
  'provider.waitP95Ms': 20,
  'provider.rateLimited': false,
  'queue.writerLatencyP95Ms': 5,
  'queue.writerFailureRate': 0,
  'queue.oldestAgeMs': 0,
  'queue.arrivalRate': 1,
  'governor.admissionLatencyP95Ms': 3,
  'governor.decisionLatencyP95Ms': 2,
  'governor.persistLatencyP95Ms': 3,
});

/**
 * CPU saturation with no service degradation. D-013: utilization alone is never
 * a throttle reason, so these values must not contract anything.
 */
const SATURATED_CPU_VALUES: Readonly<Partial<Record<LiveHealthSignalKey, number | boolean>>> = Object.freeze({
  'cpu.hostUtilizationPct': 99,
  'cpu.processUtilizationPct': 98,
  'scheduler.runnableCount': 512,
});

/**
 * One entry per degradation family P-017 enumerates. Each names the signal the
 * evidence contract must cite and the resource the contraction must attribute to.
 */
interface DegradationCase {
  readonly family: string;
  readonly resource: HealthResource;
  /**
   * The signal the causal attribution must name. Note this is deliberately the
   * CAUSE, not an objective: several families (CPU stall, working-set growth)
   * have no service objective of their own by design — a raw capacity number is
   * never a throttle reason (D-013), so they must reach the controller through a
   * breached *outcome* objective plus a causal attribution back to the cause.
   */
  readonly causeSignal: LiveHealthSignalKey;
  readonly values: Readonly<Partial<Record<LiveHealthSignalKey, number | boolean>>>;
}

const DEGRADATION_CASES: readonly DegradationCase[] = Object.freeze([
  {
    family: 'slowness (event-loop + heartbeat progress loss under CPU stall)',
    resource: 'cpu',
    causeSignal: 'cpu.psiSomePct',
    values: { 'cpu.psiSomePct': 40, 'latency.eventLoopP95Ms': 260, 'progress.heartbeatLagMs': 900 },
  },
  {
    family: 'RAM (working-set growth)',
    resource: 'memory',
    causeSignal: 'memory.workingSetGrowthBytesPerSec',
    values: {
      'memory.workingSetGrowthBytesPerSec': 96 * 1024 ** 2,
      'memory.workingSetBytes': 6 * 1024 ** 3,
      'latency.eventLoopP95Ms': 240,
      'progress.heartbeatLagMs': 850,
    },
  },
  {
    family: 'PSI (memory full stall)',
    resource: 'memory',
    causeSignal: 'memory.psiFullPct',
    values: { 'memory.psiFullPct': 42, 'latency.eventLoopP95Ms': 250, 'progress.heartbeatLagMs': 800 },
  },
  {
    family: 'GC (pause inflation)',
    resource: 'memory',
    causeSignal: 'memory.gcPauseP95Ms',
    values: { 'memory.gcPauseP95Ms': 320, 'latency.eventLoopP95Ms': 260, 'progress.heartbeatLagMs': 820 },
  },
  {
    family: 'fault (major fault thrash)',
    resource: 'memory',
    causeSignal: 'memory.majorFaultsPerSec',
    values: { 'memory.majorFaultsPerSec': 900, 'latency.eventLoopP95Ms': 245, 'progress.heartbeatLagMs': 810 },
  },
  {
    family: 'swap (swap-in thrash)',
    resource: 'memory',
    causeSignal: 'memory.swapInBytesPerSec',
    values: {
      'memory.swapInBytesPerSec': 64 * 1024 ** 2,
      'memory.swapUsedBytes': 3 * 1024 ** 3,
      'memory.psiFullPct': 30,
      'memory.majorFaultsPerSec': 400,
      'latency.eventLoopP95Ms': 250,
      'progress.heartbeatLagMs': 830,
    },
  },
  {
    family: 'service (dependency wait inflation)',
    resource: 'service',
    causeSignal: 'service.waitP95Ms',
    values: { 'service.waitP95Ms': 900, 'latency.eventLoopP95Ms': 240, 'progress.heartbeatLagMs': 840 },
  },
  {
    family: 'database (pool wait inflation)',
    resource: 'database',
    causeSignal: 'database.waitP95Ms',
    values: { 'database.waitP95Ms': 700, 'database.activeConnections': 96, 'progress.heartbeatLagMs': 860 },
  },
]);

const WRITER_ID = 'operator:p017';

function writerFor(profileId: string, atMs: number): LiveHealthWriter {
  return {
    id: WRITER_ID,
    kind: 'operator',
    instanceId: `${WRITER_ID}:${profileId}`,
    pid: null,
    platform: 'linux',
    startedAtMs: atMs - STEP,
  };
}

function reading(key: LiveHealthSignalKey, value: number | boolean, atMs: number): LiveHealthReading {
  const spec = LIVE_HEALTH_SIGNAL_SPECS[key];
  return measuredLiveHealthReading({
    key,
    value,
    writerId: WRITER_ID,
    observedAtMs: atMs,
    window: liveHealthWindow(spec.windowKind, atMs - (spec.windowKind === 'instant' ? 0 : STEP), atMs),
    confidence: 1,
  });
}

/**
 * Build a real `LiveHealthSnapshot` carrying the emulated machine profile, then
 * select the analysis frame the way production does — writer-scoped, never
 * borrowing a sibling writer's reading.
 */
function snapshotFrame(
  entry: ResourceProfile,
  index: number,
  overrides: Readonly<Partial<Record<LiveHealthSignalKey, number | boolean>>> = {},
  extraWriters: Readonly<Record<string, { writer: LiveHealthWriter; signals: Partial<Record<LiveHealthSignalKey, LiveHealthReading>> }>> = {},
): HealthAnalysisFrame {
  const atMs = START + index * STEP;
  const values = { ...HEALTHY_VALUES, ...overrides };
  const observations = emptyLiveHealthObservations();
  const signals = emptyLiveHealthSignals(atMs);
  for (const [rawKey, value] of Object.entries(values)) {
    const key = rawKey as LiveHealthSignalKey;
    const item = reading(key, value as number | boolean, atMs);
    observations[key][WRITER_ID] = item;
    signals[key] = item;
  }
  const writers: Record<string, LiveHealthWriter> = { [WRITER_ID]: writerFor(entry.id, atMs) };
  for (const extra of Object.values(extraWriters)) {
    writers[extra.writer.id] = extra.writer;
    for (const [rawKey, item] of Object.entries(extra.signals)) {
      const key = rawKey as LiveHealthSignalKey;
      if (item) observations[key][extra.writer.id] = item;
    }
  }
  const snapshot: LiveHealthSnapshot = {
    schemaVersion: LIVE_HEALTH_SCHEMA_VERSION,
    sequence: index + 1,
    sampledAtMs: atMs,
    monitorStartedAtMs: START - STEP,
    cadenceMs: STEP,
    profile: entry.profile,
    writers,
    observations,
    signals,
  };
  return liveHealthFrameFromSnapshot(snapshot, {
    scopeId: `operator:${entry.id}`,
    writerIds: new Set([WRITER_ID]),
  });
}

function primedAnalyzer(entry: ResourceProfile): RollingHealthAnalyzer {
  const analyzer = new RollingHealthAnalyzer();
  for (let index = 0; index < 6; index++) analyzer.primeHealthy(snapshotFrame(entry, index));
  return analyzer;
}

/** Named evidence rows printed at the end of the run for the P-017 record. */
interface EvidenceRow {
  readonly profileId: string;
  readonly machineClass: string;
  readonly property: string;
  readonly detail: Readonly<Record<string, unknown>>;
}
const EVIDENCE: EvidenceRow[] = [];
function record(entry: ResourceProfile, property: string, detail: Readonly<Record<string, unknown>>): void {
  EVIDENCE.push({ profileId: entry.id, machineClass: entry.machineClass, property, detail });
}

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('p017-profile-matrix');
  await applyAdmissionLedgerFixture(db.sql);
}, 120_000);

afterAll(async () => {
  // The run's own machine-readable evidence, keyed by profile and property.
  // eslint-disable-next-line no-console
  console.log(`[P-017 evidence] ${JSON.stringify({ profiles: PROFILES.map((p) => p.id), loadLadder: LOAD_LADDER, formerCeilings: FORMER_CEILINGS, rows: EVIDENCE })}`);
  await db?.cleanup();
});

beforeEach(async () => {
  await truncateAdmissionLedgerFixture(db.sql);
});

interface Stack {
  readonly store: PgAdmissionLedgerQueueStore;
  readonly driver: WorkItemAdmissionQueueDriver;
  readonly governor: Governor;
}

function stack(namespace: string, label: string, now: () => number = () => START): Stack {
  let requestNo = 0;
  let leaseNo = 0;
  const store = new PgAdmissionLedgerQueueStore({
    sql: db.sql,
    workspaceId: WORKSPACE_ID,
    resolveSessionStatesFn: allSessionsLiveResolver,
  });
  const driver = new WorkItemAdmissionQueueDriver(store, {
    namespace,
    now,
    leaseIdFactory: () => `${label}-lease-${++leaseNo}`,
  });
  return { store, driver, governor: new Governor(driver, { now, idFactory: () => `${label}-req-${++requestNo}` }) };
}

async function queuedRowCount(): Promise<number> {
  const rows = await db.sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM harness_shared.resource_governor_admissions
     WHERE workspace_id = ${WORKSPACE_ID}
       AND state = 'queued'`;
  return Number(rows[0]?.count ?? '0');
}

describe.each(PROFILES)('P-017 profile $id', (entry) => {
  it('keeps admission open and probes upward while CPU is saturated but healthy', () => {
    const analyzer = primedAnalyzer(entry);
    const controller = new CaplessAdaptiveController({ healthySamplesPerIncrease: 1, increaseStep: 8 });
    let decision = controller.step({
      verdict: analyzer.evaluate(snapshotFrame(entry, 6, SATURATED_CPU_VALUES)),
      classes: [{ admissionClass: 'agent', inFlight: 0 }],
      atMs: START + 6 * STEP,
    });
    expect(decision.healthState).toBe('healthy');
    expect(decision.reasons).toContain('stable-health-upward-probe');

    const windows: number[] = [decision.classes[0]!.desiredWindow];
    for (let index = 7; index < 90; index++) {
      decision = controller.step({
        verdict: analyzer.evaluate(snapshotFrame(entry, index, SATURATED_CPU_VALUES)),
        classes: [{ admissionClass: 'agent', inFlight: 0 }],
        atMs: START + index * STEP,
      });
      windows.push(decision.classes[0]!.desiredWindow);
    }

    const agent = decision.classes[0]!;
    expect(agent.paused).toBe(false);
    expect(agent.effectiveWindow).toBe(agent.desiredWindow);
    // Utilization alone never throttles, and the probe has no maximum (D-002/D-013).
    expect(agent.desiredWindow).toBeGreaterThan(FORMER_CEILINGS.highest);
    expect(windows.every((value, i) => i === 0 || value >= windows[i - 1]!)).toBe(true);
    // Raw capacity signals are declared non-causal and must be reported as ignored.
    const verdict = analyzer.evaluate(snapshotFrame(entry, 90, SATURATED_CPU_VALUES));
    expect(verdict.ignoredCapacitySignals).toContain('cpu.hostUtilizationPct');
    record(entry, 'healthy-cpu-saturation-remains-open', {
      finalDesiredWindow: agent.desiredWindow,
      formerHighestCeiling: FORMER_CEILINGS.highest,
      paused: agent.paused,
      ignoredCapacitySignals: verdict.ignoredCapacitySignals,
    });
  });

  it.each(DEGRADATION_CASES)(
    'contracts on measured degradation before crash — $family',
    ({ family, resource, causeSignal, values }) => {
      const analyzer = primedAnalyzer(entry);
      const controller = new CaplessAdaptiveController({ healthySamplesPerIncrease: 1, increaseStep: 8 });
      // Climb first so a contraction is observable rather than floored.
      let decision = controller.step({
        verdict: analyzer.evaluate(snapshotFrame(entry, 6)),
        classes: [{ admissionClass: 'agent', inFlight: 0 }],
        atMs: START + 6 * STEP,
      });
      for (let index = 7; index < 20; index++) {
        decision = controller.step({
          verdict: analyzer.evaluate(snapshotFrame(entry, index)),
          classes: [{ admissionClass: 'agent', inFlight: 0 }],
          atMs: START + index * STEP,
        });
      }
      const before = decision.classes[0]!.desiredWindow;
      expect(before).toBeGreaterThan(1);

      const degradedAtMs = START + 20 * STEP;
      const verdict = analyzer.evaluate(snapshotFrame(entry, 20, values));
      expect(verdict.state).toBe('degraded');
      expect(verdict.actionable).toBe(true);
      expect(verdict.actionableResources).toContain(resource);
      // The evidence contract exists BEFORE any crash boundary: a breached
      // outcome objective with a named signal, a baseline and a measured
      // reading, PLUS a causal attribution naming the cause signal. Both halves
      // are required — a breach with no attribution is a symptom nobody owns,
      // and an attribution with no breach is a raw capacity number (D-013).
      const breach = verdict.evidence.find((item) => item.breached && item.quality === 'actionable');
      expect(breach).toBeDefined();
      expect(breach?.readingState).toBe('measured');
      expect(breach?.baseline).not.toBeNull();
      const attribution = verdict.attributions.find(
        (item) => item.actionable && item.resource === resource && item.causeSignal === causeSignal,
      );
      expect(attribution).toBeDefined();
      expect(attribution?.confidence).toBeGreaterThan(0);

      const contracted = controller.step({
        verdict,
        classes: [{ admissionClass: 'agent', inFlight: before, resourceWeights: { [resource]: 1 } }],
        atMs: degradedAtMs,
      });
      const agent = contracted.classes[0]!;
      expect(contracted.reasons).toContain('causal-class-contraction');
      expect(agent.desiredWindow).toBeLessThan(before);
      expect(agent.desiredWindow).toBeGreaterThanOrEqual(controller.minimumWindow);
      expect(agent.feedback.some((item) => item.resource === resource)).toBe(true);
      // A contraction is transient by construction: it expires.
      expect(agent.feedback.every((item) => item.expiresAtMs > degradedAtMs)).toBe(true);
      record(entry, 'degradation-evidence-contracts-before-crash', {
        family,
        resource,
        windowBefore: before,
        windowAfter: agent.desiredWindow,
        breachedObjective: breach?.objectiveId,
        breachedSignal: breach?.signal,
        attributedCauseSignal: attribution?.causeSignal,
        attributionConfidence: attribution?.confidence,
      });
    },
  );

  it('queues every request durably at each load level, and never rejects', async () => {
    const { governor } = stack(`p017-load-${entry.id}`, entry.id);
    const perLevel: Record<string, { queued: number; unique: number }> = {};
    for (const level of LOAD_LADDER) {
      await db.sql`TRUNCATE harness_shared.resource_governor_admissions`;
      const outcomes = await Promise.all(
        Array.from({ length: level }, (_, i) =>
          governor.admit({
            idempotencyKey: `${entry.id}-l${level}-${i}`,
            admissionClass: 'agent',
            priority: 4,
            demand: { cpuWeight: 10, memoryBytes: 64 * 1024 ** 2 },
            payloadRef: `work-item:P-017:${entry.id}:${level}:${i}`,
          }),
        ),
      );
      expect(outcomes.every((outcome) => outcome.kind === 'queued')).toBe(true);
      const receipts = outcomes.map((outcome) => (outcome.kind === 'queued' ? outcome.receipt.receiptId : ''));
      expect(new Set(receipts).size).toBe(level);
      expect(await queuedRowCount()).toBe(level);
      perLevel[String(level)] = { queued: outcomes.length, unique: new Set(receipts).size };
    }
    // The ladder deliberately runs past every ceiling this plan deleted.
    expect(LOAD_LADDER[LOAD_LADDER.length - 1]!).toBeGreaterThan(FORMER_CEILINGS.highest);
    // And at no level did a queued admission become a work-item (P-006).
    expect(await workItemRowCount(db.sql, WORKSPACE_ID)).toBe(0);
    record(entry, 'capacity-pressure-always-queues', { perLevel, rejections: 0, workItemsAllocated: 0 });
  }, 180_000);

  it('loses and duplicates no work across a restart, and a restored window is not a ceiling', async () => {
    const namespace = `p017-restart-${entry.id}`;
    const first = stack(namespace, `${entry.id}-a`);
    const load = 30;
    const before = await Promise.all(
      Array.from({ length: load }, (_, i) =>
        first.governor.admit({
          idempotencyKey: `${entry.id}-restart-${i}`,
          admissionClass: 'agent',
          priority: 4,
          demand: { cpuWeight: 10 },
          payloadRef: `work-item:P-017:${entry.id}:restart:${i}`,
        }),
      ),
    );
    const beforeIds = before.map((o) => (o.kind === 'queued' ? o.receipt.receiptId : '')).sort();

    // Failover: every in-process instance is discarded and rebuilt on the same
    // durable store, then the identical requests replay.
    const second = stack(namespace, `${entry.id}-b`);
    const after = await Promise.all(
      Array.from({ length: load }, (_, i) =>
        second.governor.admit({
          idempotencyKey: `${entry.id}-restart-${i}`,
          admissionClass: 'agent',
          priority: 4,
          demand: { cpuWeight: 10 },
          payloadRef: `work-item:P-017:${entry.id}:restart:${i}`,
        }),
      ),
    );
    const afterIds = after.map((o) => (o.kind === 'queued' ? o.receipt.receiptId : '')).sort();

    expect(afterIds).toEqual(beforeIds); // nothing lost
    expect(await queuedRowCount()).toBe(load); // nothing duplicated

    // Controller state also survives, and cannot come back as a ceiling.
    const analyzer = primedAnalyzer(entry);
    const controller = new CaplessAdaptiveController({ healthySamplesPerIncrease: 1, increaseStep: 8 });
    let decision = controller.step({
      verdict: analyzer.evaluate(snapshotFrame(entry, 6)),
      classes: [{ admissionClass: 'agent', inFlight: 0 }],
      atMs: START + 6 * STEP,
    });
    for (let index = 7; index < 16; index++) {
      decision = controller.step({
        verdict: analyzer.evaluate(snapshotFrame(entry, index)),
        classes: [{ admissionClass: 'agent', inFlight: 0 }],
        atMs: START + index * STEP,
      });
    }
    const snapshot = controller.snapshot(START + 16 * STEP);
    expect(snapshot.schemaVersion).toBe(CAPLESS_CONTROLLER_STATE_SCHEMA_VERSION);
    const restored = new CaplessAdaptiveController({
      healthySamplesPerIncrease: 1,
      increaseStep: 8,
      state: snapshot,
    });
    const restoredWindows: number[] = [];
    let restoredDecision = restored.step({
      verdict: analyzer.evaluate(snapshotFrame(entry, 17)),
      classes: [{ admissionClass: 'agent', inFlight: 0 }],
      atMs: START + 17 * STEP,
    });
    for (let index = 18; index < 40; index++) {
      restoredDecision = restored.step({
        verdict: analyzer.evaluate(snapshotFrame(entry, index)),
        classes: [{ admissionClass: 'agent', inFlight: 0 }],
        atMs: START + index * STEP,
      });
      restoredWindows.push(restoredDecision.classes[0]!.desiredWindow);
    }
    const resumedFrom = decision.classes[0]!.desiredWindow;
    expect(restoredWindows[0]).toBeGreaterThanOrEqual(resumedFrom);
    expect(restoredDecision.classes[0]!.desiredWindow).toBeGreaterThan(resumedFrom);
    record(entry, 'restart-failover-no-loss-no-duplication', {
      load,
      receiptsBefore: beforeIds.length,
      receiptsAfter: afterIds.length,
      rowsAfterReplay: load,
      windowBeforeRestart: resumedFrom,
      windowAfterRecovery: restoredDecision.classes[0]!.desiredWindow,
    });
  }, 120_000);

  it('drains paced and herd-free, and the backlog is never released at once', async () => {
    const namespace = `p017-drain-${entry.id}`;
    const { driver, governor } = stack(namespace, `${entry.id}-drain`, () => START);
    const load = 100;
    await Promise.all(
      Array.from({ length: load }, (_, i) =>
        governor.admit({
          idempotencyKey: `${entry.id}-drain-${i}`,
          admissionClass: 'agent',
          priority: 4,
          demand: { cpuWeight: 10 },
          payloadRef: `work-item:P-017:${entry.id}:drain:${i}`,
        }),
      ),
    );
    expect(await queuedRowCount()).toBe(load);

    const dispatched: string[] = [];
    const source: QueueDrainLeaseSource = {
      leaseNext: (input) => driver.leaseNext(input),
      releaseLease: (receiptId, leaseId) => driver.releaseLease(receiptId, leaseId),
    };
    const drainer = new PacedDurableQueueDrainer({
      source,
      owner: `p017-${entry.id}`,
      leaseTtlMs: 60_000,
      dispatch: ({ claim }) => void dispatched.push(claim.receiptId),
    });

    const window = 8;
    const firstWake = await drainer.wake({
      trigger: { kind: 'enqueued', atMs: START + 1_000 },
      decision: {
        schemaVersion: 'resource-governor-controller-v1',
        generation: 1,
        evaluatedAtMs: START + 1_000,
        healthScopeId: `operator:${entry.id}`,
        healthState: 'healthy',
        healthSeverity: 'none',
        classes: [{
          admissionClass: 'agent',
          desiredWindow: window,
          effectiveWindow: window,
          inFlight: 0,
          availableStarts: window,
          paused: false,
          pauseUntilMs: null,
          protected: false,
          healthySamples: 3,
          feedback: [],
        }],
        reasons: ['test'],
      },
    });
    // A herd would start the whole backlog; pacing starts at most the window.
    expect(firstWake.started).toBeLessThanOrEqual(window);
    expect(firstWake.started).toBeGreaterThan(0);
    expect(dispatched.length).toBe(firstWake.started);
    expect(new Set(dispatched).size).toBe(dispatched.length);
    const remaining = await queuedRowCount();
    expect(remaining).toBe(load - firstWake.started);

    const secondWake = await drainer.wake({
      trigger: { kind: 'completed', atMs: START + 2_000 },
      decision: {
        schemaVersion: 'resource-governor-controller-v1',
        generation: 2,
        evaluatedAtMs: START + 2_000,
        healthScopeId: `operator:${entry.id}`,
        healthState: 'healthy',
        healthSeverity: 'none',
        classes: [{
          admissionClass: 'agent',
          desiredWindow: window,
          effectiveWindow: window,
          inFlight: 0,
          availableStarts: window,
          paused: false,
          pauseUntilMs: null,
          protected: false,
          healthySamples: 3,
          feedback: [],
        }],
        reasons: ['test'],
      },
    });
    expect(secondWake.started).toBeLessThanOrEqual(window);
    expect(new Set(dispatched).size).toBe(dispatched.length);
    record(entry, 'drain-has-no-herd', {
      backlog: load,
      window,
      firstWakeStarted: firstWake.started,
      secondWakeStarted: secondWake.started,
      remainingAfterFirstWake: remaining,
      duplicateDispatches: dispatched.length - new Set(dispatched).size,
    });
  }, 120_000);

  it('attributes state and alerts to the canonical writer and never borrows a sibling', () => {
    const analyzer = primedAnalyzer(entry);
    const atMs = START + 21 * STEP;
    const foreign: LiveHealthWriter = {
      id: 'provider:unrelated',
      kind: 'provider',
      instanceId: 'provider:unrelated:1',
      pid: null,
      platform: 'linux',
      startedAtMs: atMs - STEP,
    };
    const frame = snapshotFrame(
      entry,
      21,
      { 'memory.psiFullPct': 42, 'latency.eventLoopP95Ms': 250, 'progress.heartbeatLagMs': 800 },
      {
        foreign: {
          writer: foreign,
          signals: {
            'provider.waitP95Ms': measuredLiveHealthReading({
              key: 'provider.waitP95Ms',
              value: 9_000,
              writerId: foreign.id,
              observedAtMs: atMs,
              window: liveHealthWindow('rolling', atMs - STEP, atMs),
            }),
          },
        },
      },
    );
    // The frame is writer-scoped, so the unrelated provider lane is not present.
    expect(frame.signals['provider.waitP95Ms']?.writerId).not.toBe(foreign.id);
    const verdict = analyzer.evaluate(frame);
    expect(verdict.scopeId).toBe(`operator:${entry.id}`);
    expect(verdict.state).toBe('degraded');
    for (const item of verdict.evidence) {
      if (item.readingState === 'measured') {
        expect(frame.signals[item.signal]?.writerId).toBe(WRITER_ID);
      }
    }
    expect(verdict.actionableResources).not.toContain('provider');
    record(entry, 'state-and-alerts-match-canonical-writers', {
      scopeId: verdict.scopeId,
      canonicalWriter: WRITER_ID,
      foreignWriterAdmitted: false,
      actionableResources: verdict.actionableResources,
    });
  });

  it('recovers past the pre-contraction window once degradation clears', () => {
    const analyzer = primedAnalyzer(entry);
    const controller = new CaplessAdaptiveController({
      healthySamplesPerIncrease: 1,
      increaseStep: 8,
      contractionTtlMs: 15_000,
      contractionCooldownMs: 0,
    });
    let decision = controller.step({
      verdict: analyzer.evaluate(snapshotFrame(entry, 6)),
      classes: [{ admissionClass: 'agent', inFlight: 0 }],
      atMs: START + 6 * STEP,
    });
    for (let index = 7; index < 24; index++) {
      decision = controller.step({
        verdict: analyzer.evaluate(snapshotFrame(entry, index)),
        classes: [{ admissionClass: 'agent', inFlight: 0 }],
        atMs: START + index * STEP,
      });
    }
    const peak = decision.classes[0]!.desiredWindow;

    const degraded = controller.step({
      verdict: analyzer.evaluate(
        snapshotFrame(entry, 24, { 'memory.psiFullPct': 45, 'latency.eventLoopP95Ms': 260, 'progress.heartbeatLagMs': 900 }),
      ),
      classes: [{ admissionClass: 'agent', inFlight: peak, resourceWeights: { memory: 1 } }],
      atMs: START + 24 * STEP,
    });
    const trough = degraded.classes[0]!.desiredWindow;
    expect(trough).toBeLessThan(peak);

    let recovered = degraded;
    for (let index = 25; index < 120; index++) {
      recovered = controller.step({
        verdict: analyzer.evaluate(snapshotFrame(entry, index)),
        classes: [{ admissionClass: 'agent', inFlight: 0 }],
        atMs: START + index * STEP,
      });
    }
    const agent = recovered.classes[0]!;
    expect(agent.paused).toBe(false);
    expect(agent.feedback).toHaveLength(0); // the contraction expired, it did not persist as a limit
    expect(agent.desiredWindow).toBeGreaterThan(peak);
    expect(agent.desiredWindow).toBeGreaterThan(FORMER_CEILINGS.highest);
    record(entry, 'no-artificial-ceiling-stops-recovery', {
      peakBeforeContraction: peak,
      troughAfterContraction: trough,
      windowAfterRecovery: agent.desiredWindow,
      formerHighestCeiling: FORMER_CEILINGS.highest,
      residualFeedback: agent.feedback.length,
    });
  });
});

describe('P-017 worker topologies', () => {
  it.each([
    { topology: 'single-worker', workers: 1 },
    { topology: 'multi-worker', workers: 4 },
  ])('$topology shares one durable queue authority without loss or duplication', async ({ topology, workers }) => {
    const namespace = `p017-topology-${workers}`;
    const load = 100;
    const stacks = Array.from({ length: workers }, (_, w) => stack(namespace, `w${w}`));
    const outcomes = await Promise.all(
      Array.from({ length: load }, (_, i) =>
        stacks[i % workers]!.governor.admit({
          idempotencyKey: `topology-${workers}-${i}`,
          admissionClass: 'agent',
          priority: 4,
          demand: { cpuWeight: 10 },
          payloadRef: `work-item:P-017:topology:${workers}:${i}`,
        }),
      ),
    );
    expect(outcomes.every((outcome) => outcome.kind === 'queued')).toBe(true);
    const receipts = outcomes.map((o) => (o.kind === 'queued' ? o.receipt.receiptId : ''));
    expect(new Set(receipts).size).toBe(load);
    expect(await queuedRowCount()).toBe(load);

    // Concurrent identical replay from every worker converges on one receipt.
    const replay = await Promise.all(
      stacks.map((s) =>
        s.governor.admit({
          idempotencyKey: `topology-${workers}-0`,
          admissionClass: 'agent',
          priority: 4,
          demand: { cpuWeight: 10 },
          payloadRef: `work-item:P-017:topology:${workers}:0`,
        }),
      ),
    );
    const replayIds = new Set(replay.map((o) => (o.kind === 'queued' ? o.receipt.receiptId : '')));
    expect(replayIds.size).toBe(1);
    expect(await queuedRowCount()).toBe(load);
    EVIDENCE.push({
      profileId: `topology:${topology}`,
      machineClass: 'topology',
      property: 'single-and-multi-worker-share-one-authority',
      detail: { workers, load, uniqueReceipts: new Set(receipts).size, convergedReplayReceipts: replayIds.size },
    });
  }, 180_000);
});
