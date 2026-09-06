import { describe, expect, it } from 'vitest';
import type { WorkspaceHostPlanStep } from './workspace-host-types';
import {
  nextWorkspaceHostControllerAction,
  validateWorkspaceHostWorkflow,
  workspaceHostCompensationOrder,
  workspaceHostDestroyIsConfirmed,
  workspaceHostRecoveryAction,
  workspaceHostWorkflowKeys,
  type WorkspaceHostDurableResourcePlan,
  type WorkspaceHostDurableWorkflowSpec,
  type WorkspaceHostResourceCheckpoint,
} from './workspace-host-workflow';

function step(id: string, dependsOn: readonly string[] = []): WorkspaceHostPlanStep {
  return {
    id,
    action: 'provision',
    resourceKind: id,
    dependsOn,
    idempotencyKey: `apply:op-1:${id}`,
    destructive: false,
    input: {},
  };
}

function resource(
  id: string,
  dependsOn: readonly string[] = [],
  overrides: Partial<WorkspaceHostDurableResourcePlan> = {},
): WorkspaceHostDurableResourcePlan {
  return {
    logicalKey: id,
    step: step(id, dependsOn),
    createdByOperation: true,
    deleteOnDestroy: true,
    compensation: { action: 'destroy', idempotencyKey: `compensate:op-1:${id}` },
    ...overrides,
  };
}

function spec(
  action: WorkspaceHostDurableWorkflowSpec['action'] = 'provision',
): WorkspaceHostDurableWorkflowSpec {
  return {
    identity: {
      workspaceId: 'ws-1',
      hostId: 'host-1',
      operationId: 'op-1',
      planId: 'plan-1',
      target: 'gcp',
      desiredRevision: 3,
    },
    action,
    resources: [resource('network'), resource('disk', ['network']), resource('vm', ['network', 'disk'])],
    maxApplyAttempts: 3,
  };
}

function checkpoint(
  logicalKey: string,
  state: WorkspaceHostResourceCheckpoint['state'],
  overrides: Partial<WorkspaceHostResourceCheckpoint> = {},
): WorkspaceHostResourceCheckpoint {
  return { logicalKey, state, attempts: state === 'planned' ? 0 : 1, ...overrides };
}

describe('workspaceHostWorkflowKeys', () => {
  it('resumes a stable operation while serializing all desired mutations for one host', () => {
    const a = workspaceHostWorkflowKeys({ workspaceId: 'ws:1', hostId: 'host/1', operationId: 'op-1' });
    const replay = workspaceHostWorkflowKeys({ workspaceId: 'ws:1', hostId: 'host/1', operationId: 'op-1' });
    const next = workspaceHostWorkflowKeys({ workspaceId: 'ws:1', hostId: 'host/1', operationId: 'op-2' });
    expect(a).toEqual(replay);
    expect(a.workflowId).not.toBe(next.workflowId);
    expect(a.deduplicationId).toBe(next.deduplicationId);
    expect(a.workflowId).toContain('ws%3A1');
  });
});

describe('validateWorkspaceHostWorkflow', () => {
  it('requires topological order, unique provider keys, and explicit cancellation disposition', () => {
    const invalid: WorkspaceHostDurableWorkflowSpec = {
      ...spec(),
      resources: [
        resource('vm', ['disk'], { compensation: undefined, retainOnCancel: false }),
        resource('disk', [], { step: { ...step('disk'), idempotencyKey: 'apply:op-1:vm' } }),
      ],
    };
    const result = validateWorkspaceHostWorkflow(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "step 'vm' must appear after dependency 'disk'",
      "resource 'vm' needs compensation or retainOnCancel",
      "duplicate provider idempotency key 'apply:op-1:vm'",
    ]));
  });
});

describe('workspace-host controller recovery', () => {
  it('records every resource plan before the first provider call, then respects dependencies', () => {
    const workflow = spec();
    const first = nextWorkspaceHostControllerAction(workflow, []);
    expect(first.kind).toBe('record-plan');
    expect(first.kind === 'record-plan' && first.resources.map((entry) => entry.logicalKey)).toEqual([
      'network', 'disk', 'vm',
    ]);

    const planned = ['network', 'disk', 'vm'].map((id) => checkpoint(id, 'planned'));
    expect(nextWorkspaceHostControllerAction(workflow, planned)).toMatchObject({
      kind: 'apply', resource: { logicalKey: 'network' },
    });
    planned[0] = checkpoint('network', 'applied');
    expect(nextWorkspaceHostControllerAction(workflow, planned)).toMatchObject({
      kind: 'apply', resource: { logicalKey: 'disk' },
    });
  });

  it('reconciles an interrupted apply or ambiguous response instead of issuing a blind retry', () => {
    expect(workspaceHostRecoveryAction(checkpoint('vm', 'applying'), 3)).toBe('reconcile');
    expect(workspaceHostRecoveryAction(checkpoint('vm', 'failed', { retryClass: 'ambiguous' }), 3)).toBe('reconcile');
    expect(workspaceHostRecoveryAction(checkpoint('vm', 'retry-wait', {
      attempts: 1, retryClass: 'transient',
    }), 3)).toBe('retry');
    expect(workspaceHostRecoveryAction(checkpoint('vm', 'retry-wait', {
      attempts: 3, retryClass: 'throttled', retryAfterMs: 10_000,
    }), 3)).toBe('halt');
  });

  it('reconciles an in-flight resource before honoring cancellation', () => {
    const action = nextWorkspaceHostControllerAction(spec(), [
      checkpoint('network', 'applied'),
      checkpoint('disk', 'applying'),
      checkpoint('vm', 'planned'),
    ], { cancellationRequested: true });
    expect(action).toMatchObject({ kind: 'reconcile', resource: { logicalKey: 'disk' } });
  });

  it('compensates operation-created resources in reverse dependency order and retains explicit data', () => {
    const workflow: WorkspaceHostDurableWorkflowSpec = {
      ...spec(),
      resources: [
        resource('network'),
        resource('disk', ['network'], { compensation: undefined, retainOnCancel: true }),
        resource('vm', ['network', 'disk']),
        resource('existing-firewall', [], { createdByOperation: false, compensation: undefined }),
      ],
    };
    const checkpoints = workflow.resources.map((entry) => checkpoint(entry.logicalKey, 'applied'));
    expect(workspaceHostCompensationOrder(workflow, checkpoints).map((entry) => entry.logicalKey)).toEqual([
      'vm', 'network',
    ]);
    expect(nextWorkspaceHostControllerAction(workflow, checkpoints, { cancellationRequested: true })).toMatchObject({
      kind: 'compensate', resource: { logicalKey: 'vm' },
    });
  });

  it('keeps destroy blocked until every delete target has a matching provider-read absence receipt', () => {
    const workflow = spec('destroy');
    const records = workflow.resources.map((entry) => checkpoint(entry.logicalKey, 'absent', {
      providerResource: { target: 'gcp', kind: entry.logicalKey, providerId: `provider-${entry.logicalKey}` },
      deletionConfirmation: {
        hostId: 'host-1',
        providerResourceId: `provider-${entry.logicalKey}`,
        confirmedAbsentAt: '2026-08-22T00:00:00Z',
        source: 'provider-read',
      },
    }));
    records[2] = checkpoint('vm', 'applied');
    expect(workspaceHostDestroyIsConfirmed(workflow, records)).toBe(false);
    expect(nextWorkspaceHostControllerAction(workflow, records)).toEqual({
      kind: 'blocked', reason: 'destroy-unconfirmed',
    });

    records[2] = checkpoint('vm', 'absent', {
      providerResource: { target: 'gcp', kind: 'vm', providerId: 'provider-vm' },
      deletionConfirmation: {
        hostId: 'host-1', providerResourceId: 'provider-vm',
        confirmedAbsentAt: '2026-08-22T00:00:01Z', source: 'provider-read',
      },
    });
    expect(workspaceHostDestroyIsConfirmed(workflow, records)).toBe(true);
    expect(nextWorkspaceHostControllerAction(workflow, records)).toEqual({ kind: 'complete', status: 'succeeded' });
  });
});
