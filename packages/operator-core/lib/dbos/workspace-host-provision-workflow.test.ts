import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { WorkspaceHostDesiredSpec, WorkspaceHostProviderConnection } from '@papercusp/deployment-driver';

const control = vi.hoisted(() => ({
  dedupConflict: false,
  startOptions: null as null | Record<string, unknown>,
  sleep: vi.fn(async (_ms: number) => {}),
}));

vi.mock('@dbos-inc/dbos-sdk', () => {
  class WorkflowQueue {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
  }
  return {
    WorkflowQueue,
    DBOS: {
      runStep: (run: () => unknown) => run(),
      sleep: control.sleep,
      registerWorkflow: (implementation: unknown) => implementation,
      startWorkflow:
        (workflow: (input: unknown) => Promise<unknown>, options: Record<string, unknown>) => (input: unknown) => {
          control.startOptions = options;
          if (control.dedupConflict) {
            return Promise.reject(Object.assign(new Error('duplicate'), { dbosErrorCode: 28 }));
          }
          return Promise.resolve({ getResult: () => workflow(input) });
        },
    },
  };
});

import {
  setWorkspaceHostProvisioningExecutor,
  startWorkspaceHostProvisioningWorkflow,
  WorkspaceHostProvisioningConflictError,
} from './workspace-host-provision-workflow';

const desired: WorkspaceHostDesiredSpec = {
  hostId: 'host-1',
  target: 'gcp',
  scope: { kind: 'project', id: 'project-1' },
  region: 'us-central1',
  zone: 'us-central1-a',
  size: 'e2-small',
  image: { id: 'projects/images/global/images/papercusp-v1' },
  data: { volumeGiB: 20, encrypted: true },
  credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' } },
};
const connection: WorkspaceHostProviderConnection = {
  target: 'gcp',
  cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' },
  scope: desired.scope,
};
const input = {
  workspaceId: 'ws-1',
  connectionId: 'connection-1',
  name: 'Host',
  desired,
  connection,
  operationId: 'op-1',
};
const plan = {
  planId: 'plan-1',
  operationId: 'op-1',
  target: 'gcp',
  hostId: 'host-1',
  generatedAt: '2026-08-25T00:00:00Z',
  steps: [],
  warnings: [],
};

beforeEach(() => {
  control.dedupConflict = false;
  control.startOptions = null;
  control.sleep.mockClear();
});

afterEach(() => {
  setWorkspaceHostProvisioningExecutor(null);
});

describe('workspace-host provisioning DBOS admission', () => {
  it('is registered by bootstrap before DBOS.launch so crash recovery can bind it', () => {
    const source = readFileSync(new URL('./bootstrap.ts', import.meta.url), 'utf8');
    const registration = source.indexOf("await import('./workspace-host-provision-workflow')");
    const launch = source.indexOf('await DBOS.launch()');
    expect(registration).toBeGreaterThan(0);
    expect(launch).toBeGreaterThan(registration);
  });

  it('uses an operation-scoped workflow id and a host-scoped deduplication id', async () => {
    setWorkspaceHostProvisioningExecutor(async () => ({
      status: 'succeeded',
      operationId: 'op-1',
      hostId: 'host-1',
      plan,
      checkpoints: [],
    }));

    await startWorkspaceHostProvisioningWorkflow(input);

    expect(control.startOptions).toMatchObject({
      workflowID: 'workspace-host:ws-1:host-1:operation:op-1',
      queueName: 'workspace-host-provision',
      enqueueOptions: { deduplicationID: 'workspace-host:ws-1:host-1' },
    });
  });

  it('keeps the workflow active across an in-progress runner receipt', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'in-progress',
        operationId: 'op-1',
        hostId: 'host-1',
        plan,
        checkpoints: [],
        retryAfterMs: 7_500,
      })
      .mockResolvedValueOnce({
        status: 'succeeded',
        operationId: 'op-1',
        hostId: 'host-1',
        plan,
        checkpoints: [],
      });
    setWorkspaceHostProvisioningExecutor(execute);

    await expect(startWorkspaceHostProvisioningWorkflow(input)).resolves.toMatchObject({ status: 'succeeded' });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(control.sleep).toHaveBeenCalledWith(7_500);
  });

  it('maps a concurrent host-scoped dedup refusal to a typed conflict', async () => {
    control.dedupConflict = true;
    setWorkspaceHostProvisioningExecutor(async () => {
      throw new Error('must not run');
    });

    await expect(startWorkspaceHostProvisioningWorkflow(input)).rejects.toBeInstanceOf(
      WorkspaceHostProvisioningConflictError,
    );
  });
});
