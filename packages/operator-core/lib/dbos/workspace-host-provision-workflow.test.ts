import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { WorkspaceHostDesiredSpec, WorkspaceHostProviderConnection } from '@papercusp/deployment-driver';

const control = vi.hoisted(() => ({
  dedupConflict: false,
  startOptions: null as null | Record<string, unknown>,
  stepOptions: null as null | Record<string, unknown>,
  sleep: vi.fn(async (_ms: number) => {}),
  provider: { target: 'gcp' },
  createProvider: vi.fn(),
  runProvisioning: vi.fn(),
}));

vi.mock('../workspace-host/gcp-provider', () => ({
  createConfiguredGcpWorkspaceHostProvider: control.createProvider,
}));

vi.mock('../workspace-host/provisioning-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace-host/provisioning-runner')>();
  return { ...actual, runWorkspaceHostProvisioning: control.runProvisioning };
});

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
      runStep: (run: () => unknown, options: Record<string, unknown>) => {
        control.stepOptions = options;
        return run();
      },
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
import {
  WorkspaceHostProvisioningConnectionError,
  WorkspaceHostProvisioningRequestError,
} from '../workspace-host/provisioning-runner';

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
  control.stepOptions = null;
  control.sleep.mockClear();
  control.createProvider.mockReset();
  control.createProvider.mockReturnValue(control.provider);
  control.runProvisioning.mockReset();
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

  it('composes the production provider from the selected connection inside the DBOS workflow', async () => {
    control.runProvisioning.mockResolvedValueOnce({
      status: 'succeeded',
      operationId: 'op-1',
      hostId: 'host-1',
      plan,
      checkpoints: [],
    });

    await startWorkspaceHostProvisioningWorkflow(input);

    expect(control.createProvider).toHaveBeenCalledWith(connection);
    expect(control.runProvisioning).toHaveBeenCalledWith(expect.objectContaining({ provider: control.provider }));
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

  it('marks typed request and connection refusals non-retryable while retaining transient retries', async () => {
    const terminal = new WorkspaceHostProvisioningRequestError(['desired.zone must belong to desired.region']);
    setWorkspaceHostProvisioningExecutor(async () => {
      throw terminal;
    });

    await expect(startWorkspaceHostProvisioningWorkflow(input)).rejects.toBe(terminal);

    const shouldRetry = control.stepOptions?.shouldRetry as ((error: unknown) => boolean) | undefined;
    expect(shouldRetry).toBeTypeOf('function');
    expect(shouldRetry?.(terminal)).toBe(false);
    expect(shouldRetry?.(new WorkspaceHostProvisioningConnectionError(['connection unavailable']))).toBe(false);
    expect(shouldRetry?.(new Error('transient provider timeout'))).toBe(true);
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
