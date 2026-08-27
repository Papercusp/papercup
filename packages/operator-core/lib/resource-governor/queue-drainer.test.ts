import { describe, expect, it } from 'vitest';
import type { CaplessControllerDecision, ClassAdmissionDecision } from './controller';
import type { DurableAdmissionRecord, QueueLeaseSelection } from './queue';
import { PacedDurableQueueDrainer, estimateQueueWait, type QueueDrainLeaseSource } from './queue-drainer';

function controllerClass(
  admissionClass: string,
  availableStarts: number,
  options: Partial<ClassAdmissionDecision> = {},
): ClassAdmissionDecision {
  return {
    admissionClass,
    desiredWindow: availableStarts,
    effectiveWindow: availableStarts,
    inFlight: 0,
    availableStarts,
    paused: false,
    pauseUntilMs: null,
    protected: false,
    healthySamples: 0,
    feedback: [],
    ...options,
  };
}

function decision(generation: number, classes: readonly ClassAdmissionDecision[]): CaplessControllerDecision {
  return {
    schemaVersion: 'resource-governor-controller-v1',
    generation,
    evaluatedAtMs: generation * 1_000,
    healthScopeId: 'test',
    healthState: 'healthy',
    healthSeverity: 'none',
    classes,
    reasons: ['test'],
  };
}

function record(receiptId: string, admissionClass: string): { receiptId: string; record: DurableAdmissionRecord } {
  const atMs = 1_000;
  return {
    receiptId,
    record: {
      schemaVersion: 1,
      namespace: 'test',
      idempotencyKey: receiptId,
      requestFingerprint: receiptId,
      admissionClass,
      priority: 0,
      deadlineAtMs: null,
      demand: {},
      payloadRef: null,
      coalesceKey: null,
      metadata: {},
      context: {
        contractVersion: 1,
        requestId: receiptId,
        rootRequestId: receiptId,
        parentRequestId: null,
        idempotencyKey: receiptId,
        admissionClass,
        priority: 0,
        demand: {},
        depth: 0,
        createdAtMs: atMs,
        decisionGeneration: 0,
      },
      state: 'queued',
      enqueuedAtMs: atMs,
      updatedAtMs: atMs,
      decision: { generation: 0, atMs, reason: 'test', evidence: {} },
    },
  };
}

class SelectionAwareSource implements QueueDrainLeaseSource {
  readonly rows: Array<{ receiptId: string; record: DurableAdmissionRecord }>;
  readonly selections: QueueLeaseSelection[] = [];
  private lease = 0;

  constructor(rows: Array<{ receiptId: string; record: DurableAdmissionRecord }>) {
    this.rows = rows;
  }

  async leaseNext(input: { owner: string; ttlMs: number; selection: QueueLeaseSelection }) {
    this.selections.push(input.selection);
    const policy = new Map(input.selection.classes.map((item) => [item.admissionClass, item]));
    this.rows.sort((a, b) => {
      const left = policy.get(a.record.admissionClass)?.virtualTime ?? Number.POSITIVE_INFINITY;
      const right = policy.get(b.record.admissionClass)?.virtualTime ?? Number.POSITIVE_INFINITY;
      return left - right || a.receiptId.localeCompare(b.receiptId);
    });
    const index = this.rows.findIndex((item) => policy.has(item.record.admissionClass));
    if (index < 0) return null;
    const stored = this.rows.splice(index, 1)[0]!;
    const leaseId = `lease-${++this.lease}`;
    return {
      ...stored,
      context: { ...stored.record.context, decisionGeneration: 1, leaseId },
      lease: {
        leaseId,
        owner: input.owner,
        generation: 1,
        admissionClass: stored.record.admissionClass,
        expiresAtMs: input.ttlMs,
      },
    };
  }

  async releaseLease() {}
}

describe('PacedDurableQueueDrainer', () => {
  it('spends only controller credit, then progressively expands without a fixed drain maximum', async () => {
    const source = new SelectionAwareSource(Array.from({ length: 50 }, (_, index) => record(`WI-${index}`, 'build')));
    const dispatched: string[] = [];
    const drainer = new PacedDurableQueueDrainer({
      source,
      owner: 'worker',
      leaseTtlMs: 1_000,
      dispatch: ({ claim }) => void dispatched.push(claim.receiptId),
    });

    await expect(drainer.wake({
      trigger: { kind: 'health-transition', atMs: 1_000 },
      decision: decision(1, [controllerClass('build', 1)]),
    })).resolves.toMatchObject({ started: 1 });
    await expect(drainer.wake({
      trigger: { kind: 'health-transition', atMs: 2_000 },
      decision: decision(2, [controllerClass('build', 3)]),
    })).resolves.toMatchObject({ started: 3 });
    await expect(drainer.wake({
      trigger: { kind: 'released', atMs: 3_000 },
      decision: decision(3, [controllerClass('build', 37)]),
    })).resolves.toMatchObject({ started: 37 });
    expect(dispatched).toHaveLength(41);
  });

  it('borrows idle healthy credit but never lends it to a class under live contraction', async () => {
    const source = new SelectionAwareSource([
      record('WI-b1', 'build'),
      record('WI-b2', 'build'),
      record('WI-b3', 'build'),
      record('WI-b4', 'build'),
    ]);
    const drainer = new PacedDurableQueueDrainer({
      source,
      owner: 'worker',
      leaseTtlMs: 1_000,
      dispatch: () => undefined,
    });
    const healthy = await drainer.wake({
      trigger: { kind: 'completed', atMs: 1_000 },
      decision: decision(1, [controllerClass('agent', 2), controllerClass('build', 1)]),
    });
    expect(healthy).toMatchObject({ started: 3, borrowed: 2, startedByClass: { build: 3 } });

    const constrainedBuild = controllerClass('build', 1, {
      feedback: [{
        admissionClass: 'build',
        resource: 'memory',
        severity: 'warning',
        confidence: 1,
        attributableShare: 1,
        reductionFraction: 0.5,
        desiredWindowBefore: 2,
        desiredWindowAfter: 1,
        observedAtMs: 2_000,
        expiresAtMs: 10_000,
        reason: 'test',
      }],
    });
    const constrained = await drainer.wake({
      trigger: { kind: 'health-transition', atMs: 2_000 },
      decision: decision(2, [controllerClass('agent', 2), constrainedBuild]),
    });
    expect(constrained).toMatchObject({ started: 1, borrowed: 0, startedByClass: { build: 1 } });
  });

  it('does not borrow credit while its funded class still has queued work', async () => {
    const source = new SelectionAwareSource([
      record('WI-0-borrower', 'build'),
      record('WI-1-funded', 'agent'),
    ]);
    const started: string[] = [];
    const drainer = new PacedDurableQueueDrainer({
      source,
      owner: 'worker',
      leaseTtlMs: 1_000,
      dispatch: ({ claim }) => void started.push(claim.record.admissionClass),
    });

    const result = await drainer.wake({
      trigger: { kind: 'completed', atMs: 1_000 },
      decision: decision(1, [controllerClass('agent', 1), controllerClass('build', 0)]),
    });

    expect(result).toMatchObject({ started: 1, borrowed: 0, startedByClass: { agent: 1 } });
    expect(started).toEqual(['agent']);
  });

  it('uses weighted virtual time across event wakes instead of fixed class quotas', async () => {
    const rows = Array.from({ length: 20 }, (_, index) => [
      record(`WI-a-${index}`, 'agent'),
      record(`WI-b-${index}`, 'build'),
    ]).flat();
    const source = new SelectionAwareSource(rows);
    const started: string[] = [];
    const drainer = new PacedDurableQueueDrainer({
      source,
      owner: 'worker',
      leaseTtlMs: 1_000,
      dispatch: ({ claim }) => void started.push(claim.record.admissionClass),
    });
    for (let generation = 1; generation <= 6; generation += 1) {
      await drainer.wake({
        trigger: { kind: 'completed', atMs: generation * 1_000 },
        decision: decision(generation, [
          controllerClass('idle-donor', 1),
          controllerClass('agent', 0),
          controllerClass('build', 0),
        ]),
        classWeights: { agent: 2, build: 1 },
      });
    }
    expect(started.filter((item) => item === 'agent')).toHaveLength(4);
    expect(started.filter((item) => item === 'build')).toHaveLength(2);
  });

  it('coalesces concurrent push wakes into bounded latest-state cycles', async () => {
    const source = new SelectionAwareSource([record('WI-1', 'build'), record('WI-2', 'build')]);
    let releaseFirst!: () => void;
    const firstDispatch = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let dispatches = 0;
    const drainer = new PacedDurableQueueDrainer({
      source,
      owner: 'worker',
      leaseTtlMs: 1_000,
      dispatch: async () => {
        dispatches += 1;
        if (dispatches === 1) await firstDispatch;
      },
    });
    const first = drainer.wake({
      trigger: { kind: 'completed', atMs: 1_000 },
      decision: decision(1, [controllerClass('build', 1)]),
    });
    await Promise.resolve();
    const second = drainer.wake({
      trigger: { kind: 'released', atMs: 2_000, releasedResources: ['database'] },
      decision: decision(2, [controllerClass('build', 1)]),
    });
    const third = drainer.wake({
      trigger: { kind: 'health-transition', atMs: 3_000 },
      decision: decision(3, [controllerClass('build', 1)]),
    });
    releaseFirst();
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toMatchObject({ wakeCount: 3, cycleCount: 2, started: 2, controllerGeneration: 3 });
  });

  it('emits wait estimates only from fresh observed service evidence with explicit confidence', () => {
    const evidence = {
      admissionClass: 'build',
      completedCount: 4,
      observedWindowMs: 2_000,
      observedAtMs: 10_000,
      validUntilMs: 20_000,
      confidence: 0.75,
    } as const;
    expect(estimateQueueWait({ queueDepth: 6, evidence, nowMs: 12_000 })).toEqual({
      admissionClass: 'build',
      expectedWaitMs: 3_000,
      confidence: 0.75,
      asOfMs: 10_000,
      validUntilMs: 20_000,
      stale: false,
      evidence: { completedCount: 4, observedWindowMs: 2_000, queueDepth: 6 },
    });
    expect(estimateQueueWait({ queueDepth: 6, evidence: { ...evidence, completedCount: 0 }, nowMs: 12_000 })).toBeNull();
    expect(estimateQueueWait({ queueDepth: 6, evidence: { ...evidence, completedCount: Infinity }, nowMs: 12_000 })).toBeNull();
    expect(estimateQueueWait({ queueDepth: -1, evidence, nowMs: 12_000 })).toBeNull();
    expect(estimateQueueWait({ queueDepth: 6, evidence: { ...evidence, observedAtMs: Number.NaN }, nowMs: 12_000 })).toBeNull();
    expect(estimateQueueWait({ queueDepth: 6, evidence, nowMs: 20_001 })).toBeNull();
  });
});
