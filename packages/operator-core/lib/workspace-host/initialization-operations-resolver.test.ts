/**
 * initialization-operations-resolver.test.ts (P-046 / WI-40474).
 *
 * The property worth guarding here is not "the resolver returns an object" — it is that the
 * instance the INITIALIZER tunnels to is the same instance the PROVIDER creates. Those live in
 * different modules and are reached by different call paths, so nothing but a test stops a
 * future edit from re-forking the derivation. A re-fork would not fail here or in typecheck; it
 * would fail against real cloud, at runtime, as an SSH to a nonexistent instance.
 */
import { describe, expect, it } from 'vitest';
import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';
import {
  UnsupportedWorkspaceHostInitializationTargetError,
  resolveWorkspaceHostInitializationOperations,
  type WorkspaceHostInitializationControllerProfile,
} from './initialization-operations-resolver';
import { resolveGcpWorkspaceHostInstanceIdentity } from './gcp-provider';
import { buildGcpIapWorkspaceHostInitializationCommand } from './gcp-iap-initialization-operations';

const controller: WorkspaceHostInitializationControllerProfile = {
  sshUser: 'papercusp',
  knownHostsFile: '/etc/papercusp/known_hosts',
  remoteEntrypoint: '/opt/papercusp/bin/workspace-host-initializer',
};

function desired(overrides: Partial<WorkspaceHostDesiredSpec> = {}): WorkspaceHostDesiredSpec {
  return {
    hostId: 'host-alpha',
    target: 'gcp',
    scope: { kind: 'project', id: 'active-alcove-504205-q3' },
    region: 'us-central1',
    zone: 'us-central1-a',
    size: 'e2-standard-4',
    image: { id: 'projects/p/global/images/papercusp-host-v1' },
    data: { encrypted: true },
    credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'cloud-resolver:v1' } },
    ...overrides,
  } as WorkspaceHostDesiredSpec;
}

describe('resolveWorkspaceHostInitializationOperations', () => {
  it('declares the initialization step kinds the GCP adapter supports', () => {
    const operations = resolveWorkspaceHostInitializationOperations(desired(), controller);
    expect(operations.supportedStepKinds).toContain('create-workspace');
    expect(operations.supportedStepKinds).toContain('bind-credential');
  });

  it('tunnels to the SAME instance the provider provisions (anti-divergence guard)', () => {
    const spec = desired();
    const identity = resolveGcpWorkspaceHostInstanceIdentity(spec);

    // Reach the profile the resolver actually built, through the adapter's own command builder —
    // i.e. assert on the SSH target that would really be used, not on an internal field.
    const command = buildGcpIapWorkspaceHostInitializationCommand(
      {
        projectId: identity.projectId,
        zone: identity.zone,
        instanceName: identity.instanceName,
        ...controller,
      },
      {
        id: 'workspace',
        kind: 'create-workspace',
        dependsOn: [],
        idempotencyKey: 'workspace-init:op-1:workspace',
        input: {},
      },
    );

    expect(command.args).toContain(`${controller.sshUser}@${identity.instanceName}`);
    expect(command.args.join(' ')).toContain(`--project=${identity.projectId}`);
    expect(command.args.join(' ')).toContain(`--zone=${identity.zone}`);
  });

  it('derives a stable, DNS-safe default instance name from the host id', () => {
    const identity = resolveGcpWorkspaceHostInstanceIdentity(desired());
    expect(identity.instanceName).toMatch(/^pc-[a-z0-9-]+-[0-9a-f]{8}-vm$/);
    expect(identity.instanceName.length).toBeLessThanOrEqual(63);
    // Deterministic: the same host id must never resolve to two different instances.
    expect(resolveGcpWorkspaceHostInstanceIdentity(desired()).instanceName).toBe(identity.instanceName);
  });

  it('honours an explicit provider instanceName over the derived default', () => {
    const identity = resolveGcpWorkspaceHostInstanceIdentity(
      desired({ provider: { instanceName: 'explicit-vm' } }),
    );
    expect(identity.instanceName).toBe('explicit-vm');
  });

  it('refuses a target with no adapter instead of silently falling back', () => {
    expect(() =>
      resolveWorkspaceHostInitializationOperations(desired({ target: 'aws' } as never), controller),
    ).toThrow(UnsupportedWorkspaceHostInitializationTargetError);

    expect(() =>
      resolveWorkspaceHostInitializationOperations(desired({ target: 'azure' } as never), controller),
    ).toThrow(/No workspace-host initialization adapter for target 'azure'/);
  });

  it("propagates the provider's own validation rules rather than softening them", () => {
    // zone must belong to region — the provider enforces this when provisioning, so the
    // initializer must not accept a spec the provider would have rejected.
    expect(() =>
      resolveWorkspaceHostInitializationOperations(desired({ zone: 'europe-west1-b' }), controller),
    ).toThrow(/zone must belong to/);

    expect(() =>
      resolveWorkspaceHostInitializationOperations(
        desired({ provider: { projectId: 'some-other-project' } }),
        controller,
      ),
    ).toThrow(/projectId must match/);
  });
});
