import { describe, expect, it } from 'vitest';
import {
  assertWorkspaceHostSecretIsolation,
  parseWorkspaceHostCredentialReference,
  planWorkspaceHostInitialization,
  type WorkspaceHostDesiredSpec,
} from '@papercusp/deployment-driver';
import {
  hostedBringUpInitialization,
  PAPERCUSP_HOSTED_BRING_UP_AGENTS,
  workspaceHostBringUpOperationIds,
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
    });
    // The initialize/desktop-pack admission guard for operation ids.
    for (const id of Object.values(ids)) expect(id).toMatch(/^[a-z0-9][a-z0-9._:-]{0,159}$/i);
  });
});
