import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWorkspaceHostCredentialReference,
  buildWorkspaceHostCredentialRevocationReference,
  describeWorkspaceHostCredentialBinding,
  workspaceHostCredentialReferenceDigest,
  type WorkspaceHostCredentialDeliverySet,
  type WorkspaceHostCredentialLifecycleStep,
  type WorkspaceHostCredentialRefs,
} from '@papercusp/deployment-driver';

const h = vi.hoisted(() => ({
  receipts: new Map<string, unknown>(),
  begin: vi.fn(),
  update: vi.fn(),
  event: vi.fn(),
}));

vi.mock('./initialization-replay-store', () => ({
  createWorkspaceHostInitializationReplayStore: () => ({
    async runOnce(identity: { idempotencyKey: string }, run: () => Promise<unknown>) {
      const prior = h.receipts.get(identity.idempotencyKey);
      if (prior) return prior;
      const receipt = await run();
      h.receipts.set(identity.idempotencyKey, receipt);
      return receipt;
    },
  }),
}));
vi.mock('./observability-store', () => ({
  beginWorkspaceHostOperation: h.begin,
  updateWorkspaceHostOperation: h.update,
  appendWorkspaceHostEvent: h.event,
}));

import { runWorkspaceHostCredentialLifecycle } from './credential-lifecycle-runner';

const REQUESTED_AT = '2026-08-26T10:00:00.000Z';

function credentials(generation: number): {
  refs: WorkspaceHostCredentialRefs;
  delivery: WorkspaceHostCredentialDeliverySet;
} {
  const cloudFields = { provider: 'gcp', scopeId: 'project-1', workloadId: 'host-1' };
  const gitFields = { forge: 'github', owner: 'papercusp', repository: 'private-repo' };
  const agentFields = { hostId: 'host-1', agentSet: 'claude-codex-omp' };
  const ref = {
    cloud: buildWorkspaceHostCredentialReference('cloud-workload-identity', cloudFields),
    git: buildWorkspaceHostCredentialReference('git-short-lived-delegation', gitFields),
    agent: buildWorkspaceHostCredentialReference('agent-forwarded-reference', agentFields),
  };
  return {
    refs: {
      cloudCredentialRef: { kind: 'cloud', ref: ref.cloud },
      gitCredentialRef: { kind: 'git', ref: ref.git },
      agentCredentialRef: { kind: 'agent', ref: ref.agent },
    },
    delivery: {
      cloud: {
        kind: 'provider-identity', generation, audience: 'host-1',
        revocationRef: buildWorkspaceHostCredentialRevocationReference(
          'cloud-workload-identity', cloudFields, generation,
        ),
      },
      git: {
        kind: 'short-lived-delegation', generation, audience: 'host-1',
        revocationRef: buildWorkspaceHostCredentialRevocationReference(
          'git-short-lived-delegation', gitFields, generation,
        ),
        expiresAt: '2026-08-26T11:00:00.000Z',
      },
      agent: {
        kind: 'forwarded-agent', generation, audience: 'host-1',
        revocationRef: buildWorkspaceHostCredentialRevocationReference(
          'agent-forwarded-reference', agentFields, generation,
        ),
      },
    },
  };
}

function recordingOperations(failOn?: string) {
  const calls: string[] = [];
  return {
    calls,
    async execute(step: WorkspaceHostCredentialLifecycleStep) {
      calls.push(step.id);
      if (step.id === failOn) throw new Error('host said bearer secret-must-not-echo');
      const binding = describeWorkspaceHostCredentialBinding({
        channel: step.channel,
        credentialRef: step.credentialRef,
        delivery: step.delivery,
        requestedAt: REQUESTED_AT,
      });
      return {
        observedAt: '2026-08-26T10:01:00.000Z',
        publicEvidence: {
          channel: step.channel,
          family: binding.family,
          operation: step.kind,
          deliveryKind: binding.deliveryKind,
          generation: binding.generation,
          audience: binding.audience,
          referenceDigest: workspaceHostCredentialReferenceDigest(step.credentialRef.ref),
          detail: { verified: true },
        },
      };
    },
  };
}

function rotationInput(operations: ReturnType<typeof recordingOperations>) {
  const current = credentials(1);
  const next = credentials(2);
  return {
    workspaceId: 'workspace-1',
    hostId: 'host-1',
    operationId: 'rotate-replay-validation',
    requestedAt: REQUESTED_AT,
    deliveryCapabilities: { fileTransfer: true },
    action: 'rotate' as const,
    currentCredentialRefs: current.refs,
    currentDelivery: current.delivery,
    nextCredentialRefs: next.refs,
    nextDelivery: next.delivery,
    operations,
  };
}

beforeEach(() => {
  h.receipts.clear();
  vi.clearAllMocks();
});

describe('runWorkspaceHostCredentialLifecycle', () => {
  it('plans, records, executes, and resumes a rotation through the shared replay store', async () => {
    const current = credentials(1);
    const next = credentials(2);
    const first = recordingOperations();
    const input = {
      workspaceId: 'workspace-1',
      hostId: 'host-1',
      operationId: 'rotate-1',
      requestedAt: REQUESTED_AT,
      deliveryCapabilities: { fileTransfer: true },
      action: 'rotate' as const,
      currentCredentialRefs: current.refs,
      currentDelivery: current.delivery,
      nextCredentialRefs: next.refs,
      nextDelivery: next.delivery,
      operations: first,
    };

    const result = await runWorkspaceHostCredentialLifecycle(input);
    expect(result.plan.steps).toHaveLength(12);
    expect(result.receipts).toHaveLength(12);
    expect(first.calls).toEqual(result.plan.steps.map((step) => step.id));
    expect(h.begin).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'rotate-1', action: 'initialize', request: expect.objectContaining({ action: 'rotate' }),
    }));
    expect(h.update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'succeeded', percent: 100 }));
    expect(h.event).toHaveBeenCalledWith(expect.objectContaining({ phase: 'credential-lifecycle:rotate:complete' }));

    const resumed = recordingOperations();
    await runWorkspaceHostCredentialLifecycle({ ...input, operations: resumed });
    expect(resumed.calls).toEqual([]);
  });

  it('rejects a replay receipt for a different lifecycle step', async () => {
    const input = rotationInput(recordingOperations());
    await runWorkspaceHostCredentialLifecycle(input);
    const firstKey = h.receipts.keys().next().value;
    if (typeof firstKey !== 'string') throw new Error('expected a replay receipt');
    const replayReceipt = h.receipts.get(firstKey) as {
      stepId: string;
      status: string;
      observedAt: string;
      publicEvidence?: Record<string, unknown>;
    };
    h.receipts.set(firstKey, {
      ...replayReceipt,
      stepId: `${replayReceipt.stepId}:wrong-step`,
    });

    await expect(runWorkspaceHostCredentialLifecycle({
      ...input,
      operations: recordingOperations(),
    })).rejects.toThrow(/invalid receipt/);
  });

  it('rejects a replay receipt that is not succeeded', async () => {
    const input = rotationInput(recordingOperations());
    await runWorkspaceHostCredentialLifecycle(input);
    const firstKey = h.receipts.keys().next().value;
    if (typeof firstKey !== 'string') throw new Error('expected a replay receipt');
    const replayReceipt = h.receipts.get(firstKey) as {
      stepId: string;
      status: string;
      observedAt: string;
      publicEvidence?: Record<string, unknown>;
    };
    h.receipts.set(firstKey, { ...replayReceipt, status: 'failed' });

    await expect(runWorkspaceHostCredentialLifecycle({
      ...input,
      operations: recordingOperations(),
    })).rejects.toThrow(/invalid receipt/);
  });

  it('calls onPlanned only after validation and leaves no operation row for rejected input', async () => {
    const same = credentials(1);
    const onPlanned = vi.fn();
    await expect(runWorkspaceHostCredentialLifecycle({
      workspaceId: 'workspace-1', hostId: 'host-1', requestedAt: REQUESTED_AT,
      deliveryCapabilities: { fileTransfer: true },
      action: 'rotate',
      currentCredentialRefs: same.refs, currentDelivery: same.delivery,
      nextCredentialRefs: same.refs, nextDelivery: same.delivery,
      operations: recordingOperations(), onPlanned,
    })).rejects.toThrow(/generation.*increase/i);
    expect(onPlanned).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
  });

  it('keeps host diagnostics out of human-facing failure messages', async () => {
    const current = credentials(1);
    await expect(runWorkspaceHostCredentialLifecycle({
      workspaceId: 'workspace-1', hostId: 'host-1', requestedAt: REQUESTED_AT,
      deliveryCapabilities: { fileTransfer: true },
      action: 'reconnect',
      currentCredentialRefs: current.refs, currentDelivery: current.delivery,
      operations: recordingOperations('bind-cloud'),
    })).rejects.toThrow(/secret-must-not-echo/);
    const failed = h.update.mock.calls.find(([value]) => value.status === 'failed')?.[0];
    expect(failed.message).not.toContain('secret-must-not-echo');
    expect(failed.percent).toBeLessThan(100);
  });

  // WI-10002499: an upgrade recreates the boot disk, so the host re-runs its bootstrap and a
  // reconnect sent right after raced it (`Permission denied (publickey)` inside harden-os).
  describe('bootstrap-readiness gate', () => {
    function gatedReconnect(
      awaitBootstrapReady: (options?: {
        timeoutMs?: number;
        onWaiting?: (progress: { elapsedMs: number; timeoutMs: number; probes: number }) => unknown;
      }) => Promise<{ waitedMs: number; probes: number; readyImmediately: boolean }>,
    ) {
      const current = credentials(1);
      const order: string[] = [];
      const recording = recordingOperations();
      const operations = {
        calls: recording.calls,
        async execute(step: WorkspaceHostCredentialLifecycleStep) {
          order.push(`execute:${step.id}`);
          return recording.execute(step);
        },
        awaitBootstrapReady: vi.fn(async (options?: Parameters<typeof awaitBootstrapReady>[0]) => {
          order.push('gate');
          return awaitBootstrapReady(options);
        }),
      };
      return {
        order,
        operations,
        input: {
          workspaceId: 'workspace-1', hostId: 'host-1', operationId: 'reconnect-gated',
          requestedAt: REQUESTED_AT,
          deliveryCapabilities: { fileTransfer: true },
          action: 'reconnect' as const,
          currentCredentialRefs: current.refs, currentDelivery: current.delivery,
          bootstrapReadinessTimeoutMs: 600_000,
          operations,
        },
      };
    }

    it('waits out an unfinished bootstrap before step 1 and records that it had to', async () => {
      const { order, operations, input } = gatedReconnect(async (options) => {
        await options?.onWaiting?.({ elapsedMs: 15_000, timeoutMs: options.timeoutMs ?? 0, probes: 1 });
        return { waitedMs: 390_000, probes: 27, readyImmediately: false };
      });

      const result = await runWorkspaceHostCredentialLifecycle(input);

      expect(operations.awaitBootstrapReady).toHaveBeenCalledTimes(1);
      expect(operations.awaitBootstrapReady.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ timeoutMs: 600_000 }),
      );
      expect(order[0]).toBe('gate');
      expect(order.slice(1)).toEqual(result.plan.steps.map((step) => `execute:${step.id}`));
      expect(h.update).toHaveBeenCalledWith(expect.objectContaining({
        status: 'running', percent: 0, message: expect.stringMatching(/Waiting for host bootstrap.*15s of 600s/),
      }));
      expect(h.event).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'credential-lifecycle:reconnect:bootstrap-ready',
        details: { waitedMs: 390_000, probes: 27 },
      }));
      expect(h.update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'succeeded', percent: 100 }));
    });

    it('adds no timeline line when the host was already ready (calibration)', async () => {
      const { operations, input } = gatedReconnect(async () => ({
        waitedMs: 0, probes: 1, readyImmediately: true,
      }));
      const result = await runWorkspaceHostCredentialLifecycle(input);
      expect(operations.awaitBootstrapReady).toHaveBeenCalledTimes(1);
      expect(operations.calls).toEqual(result.plan.steps.map((step) => step.id));
      expect(h.event).not.toHaveBeenCalledWith(expect.objectContaining({
        phase: expect.stringMatching(/bootstrap-ready$/),
      }));
    });

    it('fails durably at 0% and runs no step when the bootstrap never becomes ready', async () => {
      const notReady = new Error('bootstrap did not become ready');
      const { operations, input } = gatedReconnect(async () => {
        throw notReady;
      });

      await expect(runWorkspaceHostCredentialLifecycle(input)).rejects.toBe(notReady);

      expect(operations.calls).toEqual([]);
      expect(h.begin).toHaveBeenCalledTimes(1);
      expect(h.update).toHaveBeenLastCalledWith(expect.objectContaining({
        status: 'failed', percent: 0, message: expect.stringMatching(/after 0\/\d+ steps/),
      }));
      expect(h.event).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'credential-lifecycle:reconnect:failed',
      }));
    });
  });
});
