import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { CaplessControllerDecision } from './controller';
import type { HealthVerdict } from './health-analysis';
import { HEALTH_ANALYSIS_SCHEMA_VERSION } from './health-analysis';
import {
  GOVERNOR_STATE_MAX_CLASSES,
  GOVERNOR_STATE_SNAPSHOT_VERSION,
  GovernorStateSnapshotWriter,
  buildGovernorOrientSummary,
  buildGovernorStateSnapshot,
  evaluateGovernorTransitions,
} from './state-snapshot';

function health(state: HealthVerdict['state'] = 'healthy'): HealthVerdict {
  return {
    schemaVersion: HEALTH_ANALYSIS_SCHEMA_VERSION,
    scopeId: 'test',
    evaluatedAtMs: 1_000,
    state,
    severity: state === 'healthy' ? 'none' : 'warning',
    actionable: state !== 'healthy',
    evidence: [],
    attributions: [],
    actionableResources: [],
    ignoredCapacitySignals: [],
    reasons: ['test'],
  };
}

function admission(): CaplessControllerDecision {
  return {
    schemaVersion: 'resource-governor-controller-v1',
    generation: 7,
    evaluatedAtMs: 1_000,
    healthScopeId: 'test',
    healthState: 'degraded',
    healthSeverity: 'warning',
    reasons: ['causal-class-contraction'],
    classes: [
      {
        admissionClass: 'build',
        desiredWindow: 4,
        effectiveWindow: 2,
        inFlight: 2,
        availableStarts: 0,
        paused: false,
        pauseUntilMs: null,
        protected: false,
        healthySamples: 0,
        feedback: [
          {
            admissionClass: 'build',
            resource: 'memory',
            severity: 'warning',
            confidence: 0.8,
            attributableShare: 1,
            reductionFraction: 0.5,
            desiredWindowBefore: 4,
            desiredWindowAfter: 2,
            observedAtMs: 1_000,
            expiresAtMs: 2_000,
            reason: 'test',
          },
        ],
      },
    ],
  };
}

describe('governor state snapshot', () => {
  it('keeps the canonical admission/queue/state lint on a blocking real-tree test path', () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    expect(
      execFileSync(process.execPath, ['scripts/check-resource-governor-enforcement.mjs'], {
        cwd: root,
        encoding: 'utf8',
      }),
    ).toContain('[resource-governor-enforcement] OK');
  });

  it('computes totals from the complete population before bounding class detail', () => {
    const queueByClass = Array.from({ length: GOVERNOR_STATE_MAX_CLASSES + 6 }, (_, index) => ({
      admissionClass: `class-${index.toString().padStart(2, '0')}`,
      depth: index + 1,
      oldestAgeMs: index * 100,
      arrivals: 2,
      drained: 1,
      observedWindowMs: 1_000,
    }));
    const snapshot = buildGovernorStateSnapshot({
      observedAtMs: 1_000,
      validUntilMs: 2_000,
      evidenceRef: 'health:snapshot:1',
      health: health('degraded'),
      admission: admission(),
      queueByClass,
      recovery: { state: 'recovering', completed: 3, total: 10, nextProbeAtMs: 1_500, confidence: 0.7 },
    });
    expect(snapshot.queue.depth).toBe(queueByClass.reduce((sum, item) => sum + item.depth, 0));
    expect(snapshot.queue.populationClasses).toBe(queueByClass.length);
    expect(snapshot.queue.byClass).toHaveLength(GOVERNOR_STATE_MAX_CLASSES);
    expect(snapshot.queue.truncated).toBe(true);
    expect(snapshot.queue).toMatchObject({ arrivalRatePerSec: 60, drainRatePerSec: 30, trend: 'rising' });
    expect(snapshot.admission).toMatchObject({ state: 'constrained', generation: 7, constrainedClasses: ['build'] });
    expect(snapshot.resources).toMatchObject({ constrained: ['memory'], truncated: false });
    expect(snapshot.recovery).toMatchObject({ progress: 0.3, confidence: 0.7 });
    expect(snapshot.assessments).toMatchObject({
      health: 'degraded',
      admission: 'constrained',
      queue: 'growing',
      resources: 'constrained',
      recovery: 'recovering',
    });
  });

  it('preserves unmeasured values as null/unknown instead of coercing them to zero', () => {
    const snapshot = buildGovernorStateSnapshot({ observedAtMs: 1_000, validUntilMs: 2_000 });
    expect(snapshot.unknown).toEqual(['admission', 'health', 'queue', 'recovery']);
    expect(snapshot.queue).toMatchObject({
      depth: null,
      oldestAgeMs: null,
      arrivalRatePerSec: null,
      drainRatePerSec: null,
      trend: 'unknown',
      populationClasses: null,
    });
    expect(snapshot.health.state).toBeNull();
    expect(snapshot.admission.generation).toBeNull();
    expect(snapshot.recovery.progress).toBeNull();
  });

  it('does not turn an invalid or partial population leg into a zero total/rate', () => {
    const snapshot = buildGovernorStateSnapshot({
      observedAtMs: 1_000,
      validUntilMs: 2_000,
      queueByClass: [
        { admissionClass: 'agent', depth: 4, arrivals: 2, drained: 1, observedWindowMs: 1_000 },
        { admissionClass: 'build', depth: -1, drained: 1, observedWindowMs: 1_000 },
      ],
    });
    expect(snapshot.queue).toMatchObject({
      depth: null,
      arrivalRatePerSec: null,
      drainRatePerSec: 2,
      trend: 'unknown',
    });
    expect(snapshot.queue.byClass).toEqual(
      expect.arrayContaining([expect.objectContaining({ admissionClass: 'build', depth: null })]),
    );
    expect(snapshot.unknown).toEqual(expect.arrayContaining(['queue.depth', 'queue.arrivalRatePerSec']));
  });

  it('publishes exactly one atomic snapshot through the reused shared substrate', async () => {
    const writes: unknown[][] = [];
    const writer = new GovernorStateSnapshotWriter(
      'workspace-test',
      async (...args) => void writes.push(args),
      async () => null,
      async () => ({ ok: true }),
    );
    const snapshot = await writer.publish({
      observedAtMs: 1_000,
      validUntilMs: 2_000,
      health: health(),
      admission: admission(),
      queueByClass: [],
      recovery: { state: 'stable', completed: 0, total: 0, confidence: 1 },
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject([
      'resource-governor.state',
      'workspace-test',
      snapshot,
      GOVERNOR_STATE_SNAPSHOT_VERSION,
    ]);
  });

  it('requires age, adverse trend, and sustained samples before firing backlog unhealthy once', () => {
    const observed = {
      observedAtMs: 1_000,
      validUntilMs: 2_000,
      queueByClass: [
        { admissionClass: 'agent', depth: 4, oldestAgeMs: 70_000, arrivals: 4, drained: 1, observedWindowMs: 1_000 },
      ],
    };
    const first = buildGovernorStateSnapshot(observed);
    const firstEval = evaluateGovernorTransitions(first, null, 60_000);
    expect(firstEval.fired).not.toContain('backlog-unhealthy');
    const persistedFirst = buildGovernorStateSnapshot(observed, firstEval.state);
    const secondEval = evaluateGovernorTransitions(buildGovernorStateSnapshot(observed), persistedFirst, 60_000);
    expect(secondEval.fired).toContain('backlog-unhealthy');
    const persistedSecond = buildGovernorStateSnapshot(observed, secondEval.state);
    expect(
      evaluateGovernorTransitions(buildGovernorStateSnapshot(observed), persistedSecond, 60_000).fired,
    ).not.toContain('backlog-unhealthy');
  });

  it('builds a bounded orient summary without per-class queue rows', () => {
    const snapshot = buildGovernorStateSnapshot({
      observedAtMs: 1_000,
      validUntilMs: 2_000,
      health: health(),
      admission: admission(),
      queueByClass: [{ admissionClass: 'agent', depth: 2, oldestAgeMs: 3_000 }],
    });
    const summary = buildGovernorOrientSummary(snapshot, 1_500);
    expect(summary).toMatchObject({ generation: 7, stale: false, queue: { depth: 2, oldestAgeMs: 3_000 } });
    expect(summary).not.toHaveProperty('queue.byClass');
  });

  it('latches stale telemetry and emits the transition only once', async () => {
    const writes: unknown[][] = [];
    const emits: unknown[] = [];
    let current = buildGovernorStateSnapshot({ observedAtMs: 1_000, validUntilMs: 2_000 });
    const writer = new GovernorStateSnapshotWriter(
      'workspace-test',
      async (_key, _workspace, payload) => {
        current = payload as typeof current;
        writes.push([payload]);
      },
      async () => ({ payload: current, computedAt: 1_000, ageMs: 2_000 }),
      async (event) => {
        emits.push(event);
        return { ok: true };
      },
    );
    expect(await writer.checkStaleness(3_000)).toBe(true);
    expect(await writer.checkStaleness(4_000)).toBe(false);
    expect(writes).toHaveLength(1);
    expect(emits).toEqual([expect.objectContaining({ key: 'governor:transition:telemetry-stale' })]);
  });

  it('emits a bounded backlog transition payload only on the hysteretic edge', async () => {
    const emits: Array<{ key: string; payload?: unknown }> = [];
    const observed = {
      observedAtMs: 1_000,
      validUntilMs: 5_000,
      evidenceRef: 'governor:evidence:7',
      queueServiceObjectiveMs: 60_000,
      queueByClass: [
        {
          admissionClass: 'agent',
          depth: 4,
          oldestAgeMs: 70_000,
          arrivals: 4,
          drained: 1,
          observedWindowMs: 1_000,
        },
      ],
    };
    let current: ReturnType<typeof buildGovernorStateSnapshot> | null = null;
    const writer = new GovernorStateSnapshotWriter(
      'workspace-test',
      async (_key, _workspace, payload) => {
        current = payload as typeof current;
      },
      async () => (current ? { payload: current, computedAt: 1_000, ageMs: 0 } : null),
      async (event) => {
        emits.push(event);
        return { ok: true };
      },
    );
    await writer.publish(observed);
    await writer.publish({ ...observed, observedAtMs: 2_000, validUntilMs: 6_000 });
    await writer.publish({ ...observed, observedAtMs: 3_000, validUntilMs: 7_000 });
    const backlog = emits.filter((event) => event.key === 'governor:transition:backlog-unhealthy');
    expect(backlog).toHaveLength(1);
    expect(backlog[0]?.payload).toMatchObject({
      kind: 'backlog-unhealthy',
      evidenceRef: 'governor:evidence:7',
      trend: 'rising',
      action: expect.stringContaining('oldest service-objective breach'),
    });
    expect(backlog[0]?.payload).not.toHaveProperty('queueByClass');
  });
});
