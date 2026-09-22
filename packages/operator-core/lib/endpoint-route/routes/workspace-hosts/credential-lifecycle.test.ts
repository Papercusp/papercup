import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWorkspaceHostRemoteInitializerRequest } from '@papercusp/deployment-driver';
import type { RouteContext } from '../../define-route';
import { routeRegistrationOrder } from '../../register';
import {
  UnsupportedWorkspaceHostInitializationTargetError,
  WorkspaceHostDesiredSpecUnavailableError,
  WorkspaceHostInitializationControllerProfileError,
} from '../../../workspace-host/initialization-operations-resolver';
import {
  GCP_IAP_INITIALIZATION_PROTOCOL_VERSION,
  GcpIapWorkspaceHostBootstrapNotReadyError,
  GcpIapWorkspaceHostInitializationOperations,
} from '../../../workspace-host/gcp-iap-initialization-operations';
import {
  CREDENTIAL_LIFECYCLE_BOOTSTRAP_READINESS_TIMEOUT_MS,
  CREDENTIAL_LIFECYCLE_ROUTE_TIMEOUT_SEC,
  createWorkspaceHostCredentialLifecycleRoute,
  type WorkspaceHostCredentialLifecycleRouteDependencies,
} from './credential-lifecycle';

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: { hostId: 'host-1' },
  log: () => {},
  signal: new AbortController().signal,
};

const step = {
  id: 'bind-cloud',
  kind: 'bind' as const,
  channel: 'cloud' as const,
  dependsOn: [],
  idempotencyKey: 'workspace-credential:op-1:bind-cloud',
  credentialRef: { kind: 'cloud' as const, ref: 'cloud://ref' },
  delivery: {
    kind: 'provider-identity' as const,
    generation: 2,
    audience: 'host-1',
    revocationRef: 'cloud-revoke://ref/g2',
  },
};

function harness() {
  const execute = vi.fn(async () => ({
    observedAt: '2026-08-26T10:01:00.000Z', publicEvidence: {},
  }));
  const runLifecycle = vi.fn<WorkspaceHostCredentialLifecycleRouteDependencies['runLifecycle']>(
    async (input) => {
      input.onPlanned?.({ action: input.action } as never);
      await input.operations.execute(step);
      return {
        operationId: input.operationId ?? 'op-1',
        plan: { action: input.action, steps: [step] } as never,
        receipts: [{
          stepId: step.id,
          evidence: {
            channel: 'cloud', operation: 'bind', generation: 2, referenceDigest: 'digest-1',
          },
        }] as never,
      };
    },
  );
  const dependencies: WorkspaceHostCredentialLifecycleRouteDependencies = {
    activeWorkspaceId: () => 'workspace-1',
    resolveControllerProfile: () => ({
      sshUser: 'papercusp',
      knownHostsFile: '/known-hosts',
      remoteEntrypoint: '/initializer',
      deliveryEntrypoint: '/deliver-material',
    }),
    resolveOperationsForHost: vi.fn(async () => ({
      desired: {} as never,
      operations: { execute } as never,
      deliveryCapabilities: { fileTransfer: true },
    })),
    runLifecycle,
  };
  return { dependencies, execute, runLifecycle };
}

async function post(dependencies: WorkspaceHostCredentialLifecycleRouteDependencies, body: unknown) {
  const route = createWorkspaceHostCredentialLifecycleRoute(dependencies);
  return route.handler(new Request('http://operator.test/workspace-hosts/host-1/credential-lifecycle', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), CTX);
}

const bodies = {
  rotate: {
    action: 'rotate', currentCredentialRefs: {}, currentDelivery: {},
    nextCredentialRefs: {}, nextDelivery: {},
  },
  revoke: { action: 'revoke', currentCredentialRefs: {}, currentDelivery: {}, channels: ['cloud'] },
  reconnect: { action: 'reconnect', currentCredentialRefs: {}, currentDelivery: {} },
  'restore-rebind': { action: 'restore-rebind', backup: {}, nextCredentialRefs: {}, nextDelivery: {} },
} as const;

beforeEach(() => vi.clearAllMocks());

describe('POST /workspace-hosts/:hostId/credential-lifecycle', () => {
  it('is reachable through the production route registry', () => {
    expect(routeRegistrationOrder()).toContainEqual({
      method: 'POST',
      path: '/workspace-hosts/:hostId/credential-lifecycle',
    });
  });

  // The route-stack's 30s default watchdog discards a handler's response once it fires, so a
  // reconnect that waited out a post-upgrade bootstrap and then succeeded came back 408 (live,
  // 2026-09-22 22:37Z). The route's watchdog must outlast the gate it holds the request open for.
  it('declares a watchdog longer than its bootstrap gate plus the lifecycle steps', () => {
    const route = createWorkspaceHostCredentialLifecycleRoute(harness().dependencies);
    expect(route.timeoutSec).toBe(CREDENTIAL_LIFECYCLE_ROUTE_TIMEOUT_SEC);
    expect(CREDENTIAL_LIFECYCLE_ROUTE_TIMEOUT_SEC * 1000)
      .toBeGreaterThan(CREDENTIAL_LIFECYCLE_BOOTSTRAP_READINESS_TIMEOUT_MS + 60_000);
  });

  it.each(Object.entries(bodies))('accepts and forwards the %s action', async (action, body) => {
    const { dependencies, execute, runLifecycle } = harness();
    const response = await post(dependencies, body);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, action, receipts: [{ operation: 'bind' }] });
    expect(runLifecycle).toHaveBeenCalledWith(expect.objectContaining({ action }));
    expect(execute).toHaveBeenCalledWith(step);
  });

  it('carries a planner lifecycle step through the route and GCP transport exactly once', async () => {
    const transport = vi.fn(async (command: { stdin: string }) => {
      const request = parseWorkspaceHostRemoteInitializerRequest(JSON.parse(command.stdin));
      expect(request.step).toMatchObject({
        id: 'bind-cloud',
        kind: 'bind',
        input: {
          channel: 'cloud',
          credentialRef: step.credentialRef,
          delivery: step.delivery,
        },
      });
      expect(request.step).not.toHaveProperty('channel');
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          protocolVersion: GCP_IAP_INITIALIZATION_PROTOCOL_VERSION,
          stepId: step.id,
          status: 'succeeded',
          observedAt: '2026-08-26T10:01:00.000Z',
          publicEvidence: {},
        }),
      };
    });
    const operations = new GcpIapWorkspaceHostInitializationOperations(
      {
        projectId: 'active-alcove-504205-q3',
        zone: 'us-central1-a',
        instanceName: 'pc-workspace-1',
        instanceId: '4715512353118305137',
        sshUser: 'papercusp-workspace',
        knownHostsFile: '/var/lib/papercusp/controller/known_hosts',
        // buildGcpIapSshInvocation refuses a controller with no identity (b7aefde3), which this
        // fixture predated — every POST here answered 500 before reaching the transport.
        identityFile: '/var/lib/papercusp/controller/os-login',
        remoteEntrypoint: '/opt/papercusp/current/bin/papercusp-workspace-initialize',
      },
      { run: transport },
    );
    const dependencies = harness().dependencies;
    dependencies.resolveOperationsForHost = vi.fn(async () => ({
      desired: {} as never,
      operations,
      deliveryCapabilities: { fileTransfer: true },
    }));

    const response = await post(dependencies, bodies.rotate);

    expect(response.status).toBe(200);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('returns 400 for malformed bodies before resolving controller state', async () => {
    const { dependencies } = harness();
    const controller = vi.spyOn(dependencies, 'resolveControllerProfile');
    expect((await post(dependencies, { action: 'rotate' })).status).toBe(400);
    expect((await post(dependencies, { action: 'revoke', currentCredentialRefs: {}, currentDelivery: {}, channels: 1 })).status).toBe(400);
    expect(controller).not.toHaveBeenCalled();
  });

  it('maps missing intent, unsupported targets, and controller configuration without echoing thrown text', async () => {
    const first = harness().dependencies;
    first.resolveOperationsForHost = vi.fn(async () => {
      throw new WorkspaceHostDesiredSpecUnavailableError('host-1', 'host-not-found');
    });
    expect((await post(first, bodies.reconnect)).status).toBe(404);

    const second = harness().dependencies;
    second.resolveOperationsForHost = vi.fn(async () => {
      throw new WorkspaceHostDesiredSpecUnavailableError('host-1', 'no-recorded-spec');
    });
    expect((await post(second, bodies.reconnect)).status).toBe(409);

    const third = harness().dependencies;
    third.resolveOperationsForHost = vi.fn(async () => {
      throw new UnsupportedWorkspaceHostInitializationTargetError('aws-secret-diagnostic');
    });
    const unsupported = await post(third, bodies.reconnect);
    expect(unsupported.status).toBe(501);
    expect(JSON.stringify(await unsupported.json())).not.toContain('Only');

    const fourth = harness().dependencies;
    fourth.resolveControllerProfile = () => {
      throw new WorkspaceHostInitializationControllerProfileError(['internal secret path']);
    };
    expect((await post(fourth, bodies.reconnect)).status).toBe(503);
  });

  it('uses the onPlanned seam to separate contract rejection from execution failure', async () => {
    const rejected = harness().dependencies;
    rejected.runLifecycle = vi.fn(async () => { throw new Error('bad generation'); });
    const rejectedResponse = await post(rejected, bodies.rotate);
    expect(rejectedResponse.status).toBe(422);
    expect(JSON.stringify(await rejectedResponse.json())).not.toContain('bad generation');

    const failed = harness().dependencies;
    failed.runLifecycle = vi.fn(async (input) => {
      input.onPlanned?.({} as never);
      throw new Error('host output secret-must-not-echo');
    });
    const failedResponse = await post(failed, bodies.reconnect);
    expect(failedResponse.status).toBe(500);
    expect(JSON.stringify(await failedResponse.json())).not.toContain('secret-must-not-echo');
  });

  // WI-10002499: the wrapper around the host operations exposed `execute` alone, so the
  // adapter's bootstrap gate never reached the runner and a post-upgrade reconnect raced the
  // recreated VM's bootstrap.
  it('forwards the host bootstrap gate, bound to the real GCP adapter, with the sync budget', async () => {
    // ssh carries the remote command as ONE quoted argv element (the last), so the probe is
    // recognised by that element's head, not by argv membership.
    const remoteCommands: string[] = [];
    const isProbe = (remote: string) => remote.startsWith(`'/bin/test' '-x'`);
    const transport = vi.fn(async (command: { args: readonly string[] }) => {
      const remote = command.args.at(-1) ?? '';
      remoteCommands.push(remote);
      if (isProbe(remote)) return { exitCode: 0, stderr: '', stdout: '' };
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          protocolVersion: GCP_IAP_INITIALIZATION_PROTOCOL_VERSION,
          stepId: step.id,
          status: 'succeeded',
          observedAt: '2026-08-26T10:01:00.000Z',
          publicEvidence: {},
        }),
      };
    });
    const operations = new GcpIapWorkspaceHostInitializationOperations(
      {
        projectId: 'active-alcove-504205-q3',
        zone: 'us-central1-a',
        instanceName: 'pc-workspace-1',
        instanceId: '4715512353118305137',
        sshUser: 'papercusp-workspace',
        knownHostsFile: '/var/lib/papercusp/controller/known_hosts',
        identityFile: '/var/lib/papercusp/controller/os-login',
        remoteEntrypoint: '/opt/papercusp/current/bin/papercusp-workspace-initialize',
      },
      { run: transport },
    );
    const { dependencies, runLifecycle } = harness();
    dependencies.resolveOperationsForHost = vi.fn(async () => ({
      desired: {} as never,
      operations,
      deliveryCapabilities: { fileTransfer: true },
    }));
    runLifecycle.mockImplementationOnce(async (input) => {
      input.onPlanned?.({ action: input.action, operationId: 'op-gated' } as never);
      await input.operations.awaitBootstrapReady?.();
      await input.operations.execute(step);
      return {
        operationId: 'op-gated',
        plan: { action: input.action, steps: [step] } as never,
        receipts: [] as never,
      };
    });

    const response = await post(dependencies, bodies.reconnect);

    expect(response.status).toBe(200);
    expect(runLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      bootstrapReadinessTimeoutMs: CREDENTIAL_LIFECYCLE_BOOTSTRAP_READINESS_TIMEOUT_MS,
    }));
    expect(remoteCommands).toHaveLength(2);
    expect(isProbe(remoteCommands[0] ?? '')).toBe(true);
    expect(remoteCommands[1]).toContain('papercusp-workspace-initialize');
    expect(isProbe(remoteCommands[1] ?? '')).toBe(false);
  });

  it('adds no gate for an adapter that declares none (calibration)', async () => {
    const { dependencies, runLifecycle } = harness();
    await post(dependencies, bodies.reconnect);
    expect(runLifecycle.mock.calls[0]?.[0].operations.awaitBootstrapReady).toBeUndefined();
  });

  it('answers an unfinished bootstrap with a retryable 503 naming the operation', async () => {
    const { dependencies } = harness();
    dependencies.runLifecycle = vi.fn(async (input) => {
      input.onPlanned?.({ operationId: 'op-waited' } as never);
      throw new GcpIapWorkspaceHostBootstrapNotReadyError({
        conduitPath: '/usr/local/bin/papercusp-workspace-host-initialize',
        probes: 40, waitedMs: 600_000, answered: true, lastExitCode: 1,
        lastStderr: 'secret-must-not-echo',
      });
    });

    const response = await post(dependencies, bodies.reconnect);

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: false, reason: 'host-bootstrap-unfinished', hostId: 'host-1', operationId: 'op-waited',
      waitedMs: 600_000, probes: 40,
    });
    expect(JSON.stringify(payload)).not.toContain('secret-must-not-echo');
  });

  it('answers a host that never gave a clean probe answer with a 502, not a retry hint', async () => {
    const { dependencies } = harness();
    dependencies.runLifecycle = vi.fn(async (input) => {
      input.onPlanned?.({ operationId: 'op-unreachable' } as never);
      throw new GcpIapWorkspaceHostBootstrapNotReadyError({
        conduitPath: '/usr/local/bin/papercusp-workspace-host-initialize',
        probes: 40, waitedMs: 600_000, answered: false, lastExitCode: 255,
        lastStderr: 'Permission denied (publickey) secret-must-not-echo',
      });
    });

    const response = await post(dependencies, bodies.reconnect);

    expect(response.status).toBe(502);
    expect(response.headers.get('retry-after')).toBeNull();
    const payload = await response.json();
    expect(payload).toMatchObject({ ok: false, reason: 'host-unreachable', operationId: 'op-unreachable' });
    expect(JSON.stringify(payload)).not.toContain('secret-must-not-echo');
  });
});
