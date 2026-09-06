import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  _resetWorkspaceHostProvidersForTests,
  registerWorkspaceHostProvider,
  WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
  type WorkspaceHostDesiredSpec,
  type WorkspaceHostProviderConnection,
} from '@papercusp/deployment-driver';

const control = vi.hoisted(() => ({
  dedupConflict: false,
  resultError: null as unknown,
  startOptions: null as null | Record<string, unknown>,
  stepOptions: null as null | Record<string, unknown>,
  sleep: vi.fn(async (_ms: number) => {}),
  provider: { target: 'gcp' },
  runDestroy: vi.fn(),
  runProvisioning: vi.fn(),
}));

vi.mock('../workspace-host/provisioning-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace-host/provisioning-runner')>();
  return {
    ...actual,
    runWorkspaceHostDestroy: control.runDestroy,
    runWorkspaceHostProvisioning: control.runProvisioning,
  };
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
          return Promise.resolve({
            getResult: () => (control.resultError === null ? workflow(input) : Promise.reject(control.resultError)),
          });
        },
    },
  };
});

import {
  setWorkspaceHostProvisioningExecutor,
  startWorkspaceHostDestroyWorkflow,
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
  control.resultError = null;
  control.startOptions = null;
  control.stepOptions = null;
  control.sleep.mockClear();
  _resetWorkspaceHostProvidersForTests();
  registerWorkspaceHostProvider(control.provider as never);
  control.runProvisioning.mockReset();
  control.runDestroy.mockReset();
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

  it('resolves the production provider from the injected registry inside the DBOS workflow', async () => {
    control.runProvisioning.mockResolvedValueOnce({
      status: 'succeeded',
      operationId: 'op-1',
      hostId: 'host-1',
      plan,
      checkpoints: [],
    });

    await startWorkspaceHostProvisioningWorkflow(input);

    expect(control.runProvisioning).toHaveBeenCalledWith(expect.objectContaining({ provider: control.provider }));
  });

  it('routes discard destroy through the same host-scoped DBOS admission and composes the provider inside', async () => {
    control.runDestroy.mockResolvedValueOnce({
      status: 'succeeded',
      operationId: 'destroy-1',
      hostId: 'host-1',
      plan: { ...plan, operationId: 'destroy-1' },
      checkpoints: [],
    });

    await startWorkspaceHostDestroyWorkflow({
      workspaceId: 'ws-1',
      hostId: 'host-1',
      connectionId: 'connection-1',
      connection,
      disposition: 'discard',
      confirmation: {
        expectedHostId: 'host-1',
        confirmedBy: 'operator:test',
        confirmedAt: '2026-08-25T00:00:00Z',
      },
      canary: {
        runId: 'canary_1',
        workspaceId: 'ws-1',
        contractApproval: {
          status: 'approved',
          suiteVersion: WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
          reportRef: 'report://gcp/fake-contract',
          approvedBy: 'operator:test',
          approvedAt: '2026-08-25T00:00:00Z',
        },
        teardownDeadlineAt: '2099-01-01T00:00:00Z',
        budgetEvidenceRef: 'gcp://billing/budget',
        preRunZeroBaseline: {
          cents: 0,
          observedAt: '2026-08-25T00:00:00Z',
          providerEvidenceRef: 'gcp://billing/baseline',
        },
        costEvidence: [{ cents: 1, observedAt: '2026-08-25T00:10:00Z', providerEvidenceRef: 'gcp://billing/cost' }],
        lateObservedSpend: [
          { cents: 1, observedAt: '2026-08-25T01:10:00Z', providerEvidenceRef: 'gcp://billing/late' },
        ],
      },
      operationId: 'destroy-1',
    });

    expect(control.startOptions).toMatchObject({
      workflowID: 'workspace-host:ws-1:host-1:operation:destroy-1',
      queueName: 'workspace-host-provision',
      enqueueOptions: { deduplicationID: 'workspace-host:ws-1:host-1' },
    });
    expect(control.runDestroy).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'destroy', provider: control.provider }),
    );
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

  it('rehydrates validated typed errors after DBOS serialization erases their prototypes', async () => {
    const requestProblems = ['desired.zone must belong to desired.region'];
    control.resultError = Object.assign(new Error('workspace-host provisioning request rejected'), {
      name: 'WorkspaceHostProvisioningRequestError',
      problems: requestProblems,
    });

    const requestError = await startWorkspaceHostProvisioningWorkflow(input).then(
      () => null,
      (error: unknown) => error,
    );
    expect(requestError).toBeInstanceOf(WorkspaceHostProvisioningRequestError);
    expect((requestError as WorkspaceHostProvisioningRequestError).problems).toEqual(requestProblems);

    const connectionProblems = ['provider connection is not usable'];
    control.resultError = Object.assign(new Error('workspace-host provider connection is unavailable'), {
      name: 'WorkspaceHostProvisioningConnectionError',
      problems: connectionProblems,
    });

    const connectionError = await startWorkspaceHostProvisioningWorkflow(input).then(
      () => null,
      (error: unknown) => error,
    );
    expect(connectionError).toBeInstanceOf(WorkspaceHostProvisioningConnectionError);
    expect((connectionError as WorkspaceHostProvisioningConnectionError).problems).toEqual(connectionProblems);
  });

  it('does not reclassify malformed or unrelated DBOS errors', async () => {
    const malformed = Object.assign(new Error('transient provider timeout'), {
      name: 'WorkspaceHostProvisioningRequestError',
      problems: [''],
    });
    control.resultError = malformed;

    const received = await startWorkspaceHostProvisioningWorkflow(input).then(
      () => null,
      (error: unknown) => error,
    );
    expect(received).toBe(malformed);
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
