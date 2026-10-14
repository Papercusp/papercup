import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceHostDesiredSpec, WorkspaceHostProviderConnection } from '@papercusp/deployment-driver';
import {
  createWorkspaceHostProvisioningClient,
  type WorkspaceHostProvisioningDbosClient,
} from './workspace-host-provision-client';
import { hostedCustomerDeletionEnqueueRequest, HOSTED_CUSTOMER_DELETION_WORKFLOW_NAME } from './hosted-customer-deletion-workflow';
import type { HostedCustomerDeletionRequest } from '../data-governance/hosted-customer-deletion';
import {
  WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME,
  workspaceHostDestroyEnqueueRequest,
  workspaceHostLifecycleEnqueueRequest,
  workspaceHostProvisioningEnqueueRequest,
  type StartWorkspaceHostDestroyInput,
  type StartWorkspaceHostLifecycleInput,
  type StartWorkspaceHostProvisioningInput,
} from './workspace-host-provision-workflow';

const input: StartWorkspaceHostProvisioningInput = {
  workspaceId: 'control-plane',
  connectionId: 'conn-1',
  name: 'My workspace',
  desired: { hostId: 'host-1' } as unknown as WorkspaceHostDesiredSpec,
  connection: { id: 'conn-1' } as unknown as WorkspaceHostProviderConnection,
  operationId: 'op-1',
  actorId: 'user-1',
  bootstrapReleaseOverride: {
    manifestPath: '/var/lib/papercusp/releases/aws-canary.json',
    migrationId: '1101',
  },
};

function fakeClient() {
  const enqueue = vi.fn<WorkspaceHostProvisioningDbosClient['enqueue']>(async (options) => ({
    workflowID: options.workflowID,
  }));
  const createClient = vi.fn(async () => ({ enqueue }));
  return { enqueue, createClient };
}

describe('workspace-host provisioning DBOS client', () => {
  it('shares its pinned pool and queue with customer deletion and preserves replay identity', async () => {
    const { enqueue, createClient } = fakeClient();
    const client = createWorkspaceHostProvisioningClient({ systemDatabaseUrl: 'postgres://example/papercusp',
      appVersion: 'bg-host-v1', createClient });
    const deletion: HostedCustomerDeletionRequest = { operationId: 'delete-1', organizationId: 'org-1', requestedBy: 'user-1',
      target: { kind: 'organization' }, policy: { approvalRef: 'plan#D-policy', stripe: 'retain', consent: 'retain' } };
    const expected = hostedCustomerDeletionEnqueueRequest(deletion);
    const accepted = await client.enqueueCustomerDeletion(deletion);
    expect(await client.enqueueCustomerDeletion(deletion)).toEqual(accepted);
    await client.enqueue(input);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenNthCalledWith(1, { queueName: WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME,
      workflowName: HOSTED_CUSTOMER_DELETION_WORKFLOW_NAME, workflowID: expected.workflowId,
      deduplicationID: expected.deduplicationId, appVersion: 'bg-host-v1' }, deletion);
    expect(enqueue.mock.calls[1]).toEqual(enqueue.mock.calls[0]);
    expect(enqueue.mock.calls[2]?.[0].queueName).toBe(WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME);
    expect(enqueue.mock.calls[0]?.[0].queueName).toBe(enqueue.mock.calls[2]?.[0].queueName);
    expect(accepted).toEqual({ workflowId: expected.workflowId, operationId: 'delete-1' });
    expect(hostedCustomerDeletionEnqueueRequest({ ...deletion, organizationId: 'org-2' }).workflowId).not.toBe(expected.workflowId);
  });

  it('rejects malformed deletion scope or pending retention before connecting', async () => {
    const { enqueue, createClient } = fakeClient();
    const client = createWorkspaceHostProvisioningClient({ systemDatabaseUrl: 'postgres://example/papercusp',
      appVersion: 'bg-host-v1', createClient });
    const deletion: HostedCustomerDeletionRequest = { operationId: 'delete-1', organizationId: 'org-1', requestedBy: 'user-1',
      target: { kind: 'user', userId: 'other-user' }, policy: { approvalRef: 'plan#D-policy', stripe: 'retain', consent: 'retain' } };
    await expect(client.enqueueCustomerDeletion(deletion)).rejects.toThrow('customer_deletion_enqueue_invalid');
    await expect(client.enqueueCustomerDeletion({ ...deletion, target: { kind: 'organization' },
      policy: { ...deletion.policy, approvalRef: '' } })).rejects.toThrow('customer_deletion_enqueue_invalid');
    expect(createClient).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueues the SAME workflow id, dedup key and input the in-process start would use', async () => {
    const { enqueue, createClient } = fakeClient();
    const client = createWorkspaceHostProvisioningClient({
      systemDatabaseUrl: 'postgres://example/papercusp',
      appVersion: 'bg-host-v1',
      createClient,
    });

    const result = await client.enqueue(input);

    const expected = workspaceHostProvisioningEnqueueRequest(input);
    expect(enqueue).toHaveBeenCalledWith(
      {
        queueName: WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME,
        workflowName: WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME,
        workflowID: expected.workflowId,
        deduplicationID: expected.deduplicationId,
        appVersion: 'bg-host-v1',
      },
      expected.workflowInput,
    );
    expect(expected.workflowInput).toMatchObject({ action: 'provision', operationId: 'op-1' });
    expect(expected.workflowInput.bootstrapReleaseOverride).toEqual(input.bootstrapReleaseOverride);
    expect(result).toEqual({ workflowId: expected.workflowId });
  });

  it('enqueues lifecycle and destroy actions with the in-process keys and the caller actorId (WI-10005363)', async () => {
    const { enqueue, createClient } = fakeClient();
    const client = createWorkspaceHostProvisioningClient({
      systemDatabaseUrl: 'postgres://example/papercusp',
      appVersion: 'bg-host-v1',
      createClient,
    });
    const lifecycle: StartWorkspaceHostLifecycleInput = {
      workspaceId: 'control-plane',
      hostId: 'host-1',
      connection: { id: 'conn-1' } as unknown as WorkspaceHostProviderConnection,
      action: 'stop',
      operationId: 'stop-1',
      actorId: 'user-1',
    };
    const destroy: StartWorkspaceHostDestroyInput = {
      workspaceId: 'control-plane',
      hostId: 'host-1',
      connectionId: 'conn-1',
      connection: { id: 'conn-1' } as unknown as WorkspaceHostProviderConnection,
      disposition: 'discard',
      confirmation: { expectedHostId: 'host-1', confirmedBy: 'user-1', confirmedAt: '2026-10-02T00:00:00.000Z' },
      operationId: 'destroy-1',
      actorId: 'user-1',
    };

    const stopped = await client.enqueueLifecycle(lifecycle);
    const destroyed = await client.enqueueDestroy(destroy);

    const expectedStop = workspaceHostLifecycleEnqueueRequest(lifecycle);
    const expectedDestroy = workspaceHostDestroyEnqueueRequest(destroy);
    const common = {
      queueName: WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME,
      workflowName: WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME,
      appVersion: 'bg-host-v1',
    };
    expect(enqueue).toHaveBeenNthCalledWith(
      1,
      { ...common, workflowID: expectedStop.workflowId, deduplicationID: expectedStop.deduplicationId },
      expectedStop.workflowInput,
    );
    expect(enqueue).toHaveBeenNthCalledWith(
      2,
      { ...common, workflowID: expectedDestroy.workflowId, deduplicationID: expectedDestroy.deduplicationId },
      expectedDestroy.workflowInput,
    );
    // The attribution the raw-forward path dropped: the workflow input carries the actor.
    expect(expectedStop.workflowInput).toMatchObject({ action: 'stop', operationId: 'stop-1', actorId: 'user-1' });
    expect(expectedDestroy.workflowInput).toMatchObject({ action: 'destroy', operationId: 'destroy-1', actorId: 'user-1' });
    expect(stopped).toEqual({ workflowId: expectedStop.workflowId, operationId: 'stop-1' });
    expect(destroyed).toEqual({ workflowId: expectedDestroy.workflowId, operationId: 'destroy-1' });
    // One pool serves every action.
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed lifecycle request before anything is enqueued', async () => {
    const { enqueue, createClient } = fakeClient();
    const client = createWorkspaceHostProvisioningClient({
      systemDatabaseUrl: 'postgres://example/papercusp',
      appVersion: 'bg-host-v1',
      createClient,
    });
    await expect(
      client.enqueueLifecycle({
        workspaceId: 'control-plane',
        hostId: 'host-1',
        connection: { id: 'conn-1' } as unknown as WorkspaceHostProviderConnection,
        action: 'upgrade',
      }),
    ).rejects.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('pins an explicit app version — a NULL version is claimable by any DBOS host', () => {
    expect(() =>
      createWorkspaceHostProvisioningClient({ systemDatabaseUrl: 'postgres://example/papercusp', appVersion: '  ' }),
    ).toThrow('workspace_host_provisioning_client_app_version_required');
  });

  it('opens one client lazily and retries the open after a failure', async () => {
    const { enqueue } = fakeClient();
    const createClient = vi
      .fn<(url: string) => Promise<WorkspaceHostProvisioningDbosClient>>()
      .mockRejectedValueOnce(new Error('connect refused'))
      .mockResolvedValue({ enqueue });
    const client = createWorkspaceHostProvisioningClient({
      systemDatabaseUrl: 'postgres://example/papercusp',
      appVersion: 'bg-host-v1',
      createClient,
    });
    expect(createClient).not.toHaveBeenCalled();

    await expect(client.enqueue(input)).rejects.toThrow('connect refused');
    await client.enqueue(input);
    await client.enqueue(input);

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});
