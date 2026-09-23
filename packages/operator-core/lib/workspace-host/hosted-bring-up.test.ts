import { describe, expect, it } from 'vitest';
import {
  assertWorkspaceHostSecretIsolation,
  parseWorkspaceHostCredentialReference,
  planWorkspaceHostInitialization,
  type WorkspaceHostDesiredSpec,
} from '@papercusp/deployment-driver';
import {
  enrollHostedWorkspaceConnector,
  hostedBringUpInitialization,
  hostedConnectorRouteLabel,
  PAPERCUSP_HOSTED_BRING_UP_AGENTS,
  workspaceHostBringUpOperationIds,
  type HostedConnectorEnrollmentDependencies,
} from './hosted-bring-up';
import { resolveWorkspaceHostDeliveryCapabilities } from './initialization-operations-resolver';

/** The spec shape `gcpFirstWorkspaceDesiredSpec` produces for a Papercusp-hosted host. */
const HOSTED: WorkspaceHostDesiredSpec = {
  hostId: 'host-3b44551202aa97c3c3048660',
  target: 'gcp',
  scope: { kind: 'project', id: 'papercusp-hosted-workspaces' },
  region: 'us-central1',
  zone: 'us-central1-c',
  size: 'e2-standard-4',
  image: { id: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20260918' },
  data: { encrypted: true, volumeGiB: 100 },
  credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'delegation://ws-3b44/conn-3b44' } },
  provider: { projectId: 'papercusp-hosted-workspaces', network: { mode: 'managed' } },
} as WorkspaceHostDesiredSpec;

function request(desired: WorkspaceHostDesiredSpec = HOSTED) {
  return hostedBringUpInitialization({
    workspaceId: 'papercusp-workspace',
    operationId: 'prov-3b44.initialize',
    requestedAt: '2026-09-23T10:15:19.000Z',
    desired,
    requestedAgents: PAPERCUSP_HOSTED_BRING_UP_AGENTS,
  });
}

describe('hosted bring-up (D-401)', () => {
  it('builds the request that initialized a real hosted machine (op d401-probe-init-4)', () => {
    expect(request()).toMatchObject({
      hostId: HOSTED.hostId,
      source: { kind: 'empty' },
      requestedAgents: ['omp'],
      credentialRefs: {
        cloudCredentialRef: {
          kind: 'cloud',
          ref: 'pc-cloud-workload://gcp/papercusp-hosted-workspaces/host-3b44551202aa97c3c3048660',
        },
      },
      credentialDelivery: {
        cloud: {
          kind: 'provider-identity',
          generation: 1,
          audience: HOSTED.hostId,
          revocationRef: 'pc-cloud-workload-revocation://gcp/papercusp-hosted-workspaces/host-3b44551202aa97c3c3048660/g1',
        },
      },
    });
    // The machine's own identity, never the controller's connection selector or the delegation.
    expect(() =>
      parseWorkspaceHostCredentialReference(request().credentialRefs.cloudCredentialRef.ref, 'cloud'),
    ).not.toThrow();
  });

  it('is accepted by the real planner and secret-isolation check, not just shaped like it', () => {
    const admitted = {
      ...request(),
      deliveryCapabilities: resolveWorkspaceHostDeliveryCapabilities(HOSTED),
    };
    const plan = planWorkspaceHostInitialization(admitted);
    expect(plan.steps.map((step) => step.kind)).toContain('bind-credential');
    expect(() => assertWorkspaceHostSecretIsolation(admitted, 'hosted-bring-up.test')).not.toThrow();
  });

  it('never asks for agents the customer has not connected yet', () => {
    // claude/codex need the customer's own accounts (D-250); requesting them fails readiness.
    expect(PAPERCUSP_HOSTED_BRING_UP_AGENTS).toEqual(['omp']);
  });

  it('refuses a host that is not a GCP project host', () => {
    expect(() => request({ ...HOSTED, scope: { kind: 'organization', id: 'org-1' } } as never)).toThrow(
      /GCP project hosts only/,
    );
  });

  it('derives one stable, routable operation per stage from the provision', () => {
    const ids = workspaceHostBringUpOperationIds('prov-3b44551202aa97c3c3048660');
    expect(ids).toEqual({
      initialize: 'prov-3b44551202aa97c3c3048660.initialize',
      desktopPack: 'prov-3b44551202aa97c3c3048660.desktop-pack',
      connector: 'prov-3b44551202aa97c3c3048660.connector',
    });
    // The initialize/desktop-pack admission guard for operation ids.
    for (const id of Object.values(ids)) expect(id).toMatch(/^[a-z0-9][a-z0-9._:-]{0,159}$/i);
  });
});

describe('hosted desktop connector enrollment (D-403)', () => {
  const TICKET = `ht_${'T'.repeat(43)}`;
  const INPUT = {
    controlPlaneWorkspaceId: 'papercusp-workspace',
    customerWorkspaceId: 'ws-2f6a4b0c6dc222d8d20766ae',
    hostId: 'host-2f6a4b0c6dc222d8d20766ae',
    operationId: 'prov-2f6a.connector',
  };

  function dependencies(overrides: Partial<HostedConnectorEnrollmentDependencies> = {}) {
    const calls = {
      enroll: [] as unknown[],
      delivered: [] as unknown[],
      updates: [] as Array<Record<string, unknown>>,
      events: [] as Array<Record<string, unknown>>,
      signals: [] as Array<Record<string, unknown>>,
    };
    const deps: HostedConnectorEnrollmentDependencies = {
      readOrganizationId: async () => 'org-1',
      gateway: {
        enroll: async (binding) => {
          calls.enroll.push(binding);
          return {
            ticket: TICKET,
            binding: { ...binding, generation: 4, state: 'pending', kind: 'enrollment', audience: 'connector-register', expiresAt: new Date() },
          };
        },
      },
      deliverTicket: async (input) => {
        calls.delivered.push(input);
        return { generation: 4 };
      },
      beginOperation: async () => {},
      updateOperation: async (update) => {
        calls.updates.push({ ...update });
      },
      appendEvent: async (event) => {
        calls.events.push({ ...event });
        return 'event-1';
      },
      recordSignals: async (signals) => {
        calls.signals.push({ ...signals });
      },
      ...overrides,
    };
    return { deps, calls };
  }

  it('enrolls the bound organization + workspace + host and hands only the ticket to the host', async () => {
    const { deps, calls } = dependencies();
    await expect(enrollHostedWorkspaceConnector(INPUT, deps)).resolves.toEqual({
      generation: 4,
      routeLabel: 'host-2f6a4b0c6dc222d8d20766ae',
    });
    expect(calls.enroll).toEqual([{
      controlPlaneWorkspaceId: 'papercusp-workspace',
      organizationId: 'org-1',
      customerWorkspaceId: 'ws-2f6a4b0c6dc222d8d20766ae',
      hostId: 'host-2f6a4b0c6dc222d8d20766ae',
      routeLabel: 'host-2f6a4b0c6dc222d8d20766ae',
      transport: 'websocket',
    }]);
    expect(calls.delivered).toEqual([{ workspaceId: 'papercusp-workspace', hostId: INPUT.hostId, ticket: TICKET }]);
    expect(calls.updates.at(-1)).toMatchObject({ operationId: INPUT.operationId, status: 'succeeded' });
    // Published in the shape the desktop surface's readHostedWorkspaceConnector reads
    // (apps/operator/app/cloud-workspaces/hosted-workspace-session-protocol.ts).
    expect(calls.signals).toEqual([{
      workspaceId: 'papercusp-workspace',
      hostId: INPUT.hostId,
      tunnelStatus: { hostedConnector: { routeLabel: INPUT.hostId, transport: 'websocket', generation: 4 } },
    }]);
    // Nothing persisted by this stage carries the ticket.
    expect(JSON.stringify([calls.updates, calls.events, calls.signals])).not.toContain(TICKET);
  });

  it('publishes nothing when the host did not register', async () => {
    const { deps, calls } = dependencies({ deliverTicket: async () => { throw new Error('exit 69'); } });
    await expect(enrollHostedWorkspaceConnector(INPUT, deps)).rejects.toThrow('exit 69');
    expect(calls.signals).toEqual([]);
  });

  it('fails the stage when the host registered a different generation than was enrolled', async () => {
    const { deps, calls } = dependencies({ deliverTicket: async () => ({ generation: 3 }) });
    await expect(enrollHostedWorkspaceConnector(INPUT, deps)).rejects.toThrow(/registered connector generation 3/);
    expect(calls.updates.at(-1)).toMatchObject({ operationId: INPUT.operationId, status: 'failed' });
  });

  it('records the host-side refusal on the stage operation and rethrows it', async () => {
    const refusal = new Error('connector enrollment failed with exit 77: refused the ticket (HTTP 401)');
    const { deps, calls } = dependencies({ deliverTicket: async () => { throw refusal; } });
    await expect(enrollHostedWorkspaceConnector(INPUT, deps)).rejects.toBe(refusal);
    expect(calls.updates.at(-1)).toMatchObject({ status: 'failed', error: refusal.message });
    expect(JSON.stringify(calls.updates)).not.toContain(TICKET);
  });

  it('uses the host id as the route label and refuses one that is not a DNS label', () => {
    expect(hostedConnectorRouteLabel('Host-ABC')).toBe('host-abc');
    expect(() => hostedConnectorRouteLabel('host_1')).toThrow(/route label/);
    expect(() => hostedConnectorRouteLabel(`h${'x'.repeat(63)}`)).toThrow(/route label/);
  });
});
