import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
  WorkspaceHostDestroyEvidenceError,
  workspaceHostCanaryIdentityLabels,
  type WorkspaceHostInitializationCanaryEvidence,
  type WorkspaceHostInitializationHostOperations,
} from '@papercusp/deployment-driver';
import type { RouteContext } from '../../define-route';
import type { WorkspaceHostCanaryRunResult } from '../../../workspace-host/canary-runner';
import { createWorkspaceHostCanaryRoute, type WorkspaceHostCanaryRouteDependencies } from './canary';

/**
 * What the provision route persists for this run. Built by the PRODUCTION synthesizer rather than
 * hand-written, so a change to the identity contract cannot leave this stub agreeing with a
 * contract that no longer exists (WI-2144027).
 */
const STORED_IDENTITY = workspaceHostCanaryIdentityLabels({ runId: 'run-1', workspaceId: 'workspace-1' });

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: { hostId: 'host-1' },
  log: () => {},
  signal: new AbortController().signal,
};

const operations = {
  supportedStepKinds: [],
  execute: vi.fn(),
} satisfies WorkspaceHostInitializationHostOperations;

function resultFixture(adapted = false): WorkspaceHostCanaryRunResult {
  const evidence: WorkspaceHostInitializationCanaryEvidence = {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    kind: 'live' as const,
    runId: 'run-1',
    workspaceId: 'workspace-1',
    hostId: 'host-1',
    observedAt: '2026-08-26T21:00:00.000Z',
    repository: { visibility: 'private' as const, cloned: true as const },
    channels: {
      cloud: {
        bound: true as const,
        rotated: true as const,
        previousBindingRevoked: true as const,
        reconnected: true as const,
      },
      git: {
        bound: true as const,
        rotated: true as const,
        previousBindingRevoked: true as const,
        reconnected: true as const,
      },
      agent: {
        bound: true as const,
        rotated: true as const,
        previousBindingRevoked: true as const,
        reconnected: true as const,
      },
    },
    agents: {
      claude: { ready: true as const, verificationKind: 'authenticated-account' as const },
      codex: { ready: true as const, verificationKind: 'authenticated-account' as const },
      omp: { ready: true as const, verificationKind: 'local-inference' as const },
    },
    backupRestore: {
      authorizationMaterial: 'excluded' as const,
      credentialReferences: 'excluded' as const,
      reboundChannels: ['cloud', 'git', 'agent'] as const,
    },
  };
  const lifecycle = (['rotate', 'revoke', 'reconnect', 'restore-rebind'] as const).map((phase) => ({
    phase,
    result: {
      operationId: `canary:run-1:${phase}`,
      plan: {
        contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
        operationId: `canary:run-1:${phase}`,
        workspaceId: 'workspace-1',
        hostId: 'host-1',
        action: phase,
        requestedAt: '2026-08-26T20:00:00.000Z',
        steps: [
          {
            id: `${phase}-cloud`,
            kind: phase === 'revoke' ? 'verify-revoked' : 'verify-bound',
            channel: 'cloud',
            dependsOn: [],
            idempotencyKey: `${phase}-cloud`,
            credentialRef: { kind: 'cloud', ref: 'cloud-resolver:g2' },
            delivery: {
              kind: 'provider-identity',
              generation: 2,
              audience: 'host-1',
              revocationRef: 'revoke-cloud-2',
            },
          },
        ],
      },
      receipts: [
        {
          stepId: `${phase}-cloud`,
          evidence: {
            namespaceVersion: 'papercusp-workspace-host-credential-namespace-v1',
            channel: 'cloud',
            family: 'cloud-workload-identity',
            operation: phase === 'revoke' ? 'verify-revoked' : 'verify-bound',
            deliveryKind: 'provider-identity',
            generation: 2,
            audience: 'host-1',
            revocationRef: 'revoke-cloud-2',
            referenceDigest: 'digest-cloud-2',
            detail: {},
          },
        },
      ],
    },
  }));
  return {
    runId: 'run-1',
    workspaceId: 'workspace-1',
    hostId: 'host-1',
    requestedAt: '2026-08-26T20:00:00.000Z',
    operationIds: {
      initialize: 'canary:run-1:initialize',
      rotate: 'canary:run-1:rotate',
      revoke: 'canary:run-1:revoke',
      reconnect: 'canary:run-1:reconnect',
      'restore-rebind': 'canary:run-1:restore-rebind',
    },
    initialization: {
      operationId: 'canary:run-1:initialize',
      plan: {
        contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
        operationId: 'canary:run-1:initialize',
        workspaceId: 'workspace-1',
        hostId: 'host-1',
        requestedAt: '2026-08-26T20:00:00.000Z',
        steps: [
          {
            id: 'verify',
            kind: 'verify-initialization',
            dependsOn: [],
            idempotencyKey: 'verify',
            input: {},
          },
        ],
      },
      receipts: [
        {
          stepId: 'verify',
          status: 'succeeded',
          observedAt: '2026-08-26T21:00:00.000Z',
        },
      ],
    },
    lifecycle: lifecycle as WorkspaceHostCanaryRunResult['lifecycle'],
    backupManifest: {
      contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
      workspaceId: 'workspace-1',
      capturedAt: '2026-08-26T20:00:00.000Z',
      authorizationMaterial: 'excluded',
      credentialReferences: 'excluded',
      rebindRequired: ['cloud', 'git', 'agent'],
      bindingState: [],
    },
    restoreRebindRequest: {} as WorkspaceHostCanaryRunResult['restoreRebindRequest'],
    assembly: {
      evidence,
      validation: { ok: true, errors: [] },
      channelObservations: evidence.channels,
    },
    ...(adapted
      ? {
          adaptedDestroyEvidence: {
            runId: 'run-1',
            workspaceId: 'workspace-1',
            contractApproval: {} as never,
            teardownDeadlineAt: '2026-08-26T22:00:00.000Z',
            budgetEvidenceRef: 'budget-1',
            preRunZeroBaseline: {
              cents: 0,
              observedAt: '2026-08-26T20:00:00.000Z',
              providerEvidenceRef: 'billing-0',
            },
            costEvidence: [],
          },
        }
      : {}),
  };
}

function requestBody() {
  const generation = {
    credentialRefs: { cloudCredentialRef: { kind: 'cloud', ref: 'cloud-resolver:g1' } },
    delivery: {
      cloud: {
        kind: 'provider-identity',
        generation: 1,
        audience: 'host-1',
        revocationRef: 'revoke-cloud-1',
      },
    },
  };
  return {
    runId: 'run-1',
    requestedAt: '2026-08-26T20:00:00.000Z',
    source: {
      kind: 'git',
      repositoryUrl: 'https://github.com/papercusp/private-canary.git',
      visibility: 'private',
      destination: 'repositories/private-canary',
    },
    credentials: {
      initial: generation,
      rotated: generation,
      restored: generation,
    },
  };
}

// `null` — not `undefined` — is how a caller asks for a host with NO stored labels: passing
// `undefined` re-triggers the default parameter, which would silently hand the identity guard a
// correctly-labelled host and make its test vacuous.
function harness(adapted = false, storedLabels: Readonly<Record<string, string>> | null = STORED_IDENTITY) {
  const runCanary = vi.fn<WorkspaceHostCanaryRouteDependencies['runCanary']>(async () => resultFixture(adapted));
  const resolveOperationsForHost = vi.fn<WorkspaceHostCanaryRouteDependencies['resolveOperationsForHost']>(
    async () => ({
      desired: (storedLabels ? { labels: storedLabels } : {}) as never,
      operations,
      deliveryCapabilities: { fileTransfer: true },
    }),
  );
  const dependencies: WorkspaceHostCanaryRouteDependencies = {
    activeWorkspaceId: () => 'workspace-1',
    resolveControllerProfile: () => ({
      sshUser: 'papercusp',
      knownHostsFile: '/etc/papercusp/known_hosts',
      remoteEntrypoint: '/usr/local/bin/papercusp-workspace-host-initializer',
      deliveryEntrypoint: '/usr/local/bin/papercusp-deliver-material',
    }),
    resolveOperationsForHost,
    runCanary,
  };
  return { dependencies, runCanary, resolveOperationsForHost };
}

async function post(dependencies: WorkspaceHostCanaryRouteDependencies, body: unknown): Promise<Response> {
  const route = createWorkspaceHostCanaryRoute(dependencies);
  return route.handler(
    new Request('http://operator.test/api/workspace-hosts/host-1/canary', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    CTX,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('POST /workspace-hosts/:hostId/canary', () => {
  it('invokes the controller and returns ordered, credential-free phase summaries', async () => {
    const { dependencies, runCanary } = harness();
    const response = await post(dependencies, requestBody());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      status: 'ready-for-destroy',
      runId: 'run-1',
      hostId: 'host-1',
      validation: { ok: true, errors: [] },
    });
    expect(body.phases.map((phase: { phase: string }) => phase.phase)).toEqual([
      'initialize',
      'rotate',
      'revoke',
      'reconnect',
      'restore-rebind',
    ]);
    expect(JSON.stringify(body)).not.toContain('cloud-resolver:');
    expect(runCanary).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        workspaceId: 'workspace-1',
        hostId: 'host-1',
        operations,
        onPhaseStart: expect.any(Function),
      }),
    );
  });

  it('rejects malformed generation shapes before controller or host resolution', async () => {
    const { dependencies, resolveOperationsForHost } = harness();
    const response = await post(dependencies, {
      ...requestBody(),
      credentials: { initial: {}, rotated: {}, restored: {} },
    });

    expect(response.status).toBe(400);
    expect(resolveOperationsForHost).not.toHaveBeenCalled();
  });

  it('distinguishes preflight rejection from a failure after a durable phase starts', async () => {
    const preflight = harness();
    preflight.runCanary.mockRejectedValueOnce(new Error('secret preflight detail'));
    const rejected = await post(preflight.dependencies, requestBody());
    expect(rejected.status).toBe(422);
    expect(JSON.stringify(await rejected.json())).not.toContain('secret preflight detail');

    const runtime = harness();
    runtime.runCanary.mockImplementationOnce(async (run) => {
      run.onPhaseStart?.('initialize', 'canary:run-1:initialize');
      throw new Error('remote output must not leak');
    });
    const failed = await post(runtime.dependencies, requestBody());
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain('remote output must not leak');
  });

  it('maps the lane-I fail-closed adapter error to a safe 422 response', async () => {
    const { dependencies, runCanary } = harness();
    runCanary.mockRejectedValueOnce(
      new WorkspaceHostDestroyEvidenceError(['provider teardown orphan census is not clean']),
    );
    const response = await post(dependencies, requestBody());

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'destroy evidence rejected',
      problems: ['provider teardown orphan census is not clean'],
    });
  });

  // WI-2144027. A host with no identity labels can be driven all the way through a canary run and
  // then be undestroyable through the product route — which is how four real GCP canaries had to
  // be retired out of band. Refuse at bind, before a VM does any work.
  it('refuses to bind a run to a host the provision route never marked as its canary', async () => {
    const { dependencies, runCanary } = harness(false, null);
    const response = await post(dependencies, requestBody());

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'workspace host is not provisioned as a canary for this run',
      problems: [
        `stored desired.labels must contain 'papercusp_canary=true'`,
        `stored desired.labels must contain 'papercusp_run_id=run-1'`,
        `stored desired.labels must contain 'papercusp_workspace_id=workspace-1'`,
      ],
    });
    expect(runCanary).not.toHaveBeenCalled();
  });

  it('refuses to bind a run to a host provisioned for a different canary run', async () => {
    const { dependencies, runCanary } = harness(
      false,
      workspaceHostCanaryIdentityLabels({ runId: 'run-2', workspaceId: 'workspace-1' }),
    );
    const response = await post(dependencies, requestBody());

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      problems: [`stored desired.labels must contain 'papercusp_run_id=run-1'`],
    });
    expect(runCanary).not.toHaveBeenCalled();
  });
});
