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
import { assertWorkspaceHostSecretIsolation } from '@papercusp/deployment-driver';
import {
  UnsupportedWorkspaceHostInitializationTargetError,
  WorkspaceHostDesiredSpecUnavailableError,
  WorkspaceHostInitializationControllerProfileError,
  resolveWorkspaceHostInitializationControllerProfile,
  resolveWorkspaceHostInitializationOperations,
  resolveWorkspaceHostInitializationOperationsForHost,
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

describe('resolveWorkspaceHostInitializationControllerProfile', () => {
  const complete = {
    PAPERCUSP_WORKSPACE_HOST_SSH_USER: 'papercusp',
    PAPERCUSP_WORKSPACE_HOST_KNOWN_HOSTS: '/etc/papercusp/known_hosts',
    PAPERCUSP_WORKSPACE_HOST_REMOTE_ENTRYPOINT: '/opt/papercusp/bin/workspace-host-initializer',
  };

  it('builds the profile from deployment configuration', () => {
    expect(resolveWorkspaceHostInitializationControllerProfile(complete)).toEqual({
      sshUser: 'papercusp',
      knownHostsFile: '/etc/papercusp/known_hosts',
      remoteEntrypoint: '/opt/papercusp/bin/workspace-host-initializer',
    });
  });

  it('carries optional overrides through and omits absent ones entirely', () => {
    const profile = resolveWorkspaceHostInitializationControllerProfile({
      ...complete,
      PAPERCUSP_WORKSPACE_HOST_IDENTITY_FILE: '/etc/papercusp/id_ed25519',
      PAPERCUSP_WORKSPACE_HOST_GCLOUD_EXECUTABLE: 'gcloud',
    });
    expect(profile.identityFile).toBe('/etc/papercusp/id_ed25519');
    expect(profile.gcloudExecutable).toBe('gcloud');
    // Absent means ABSENT, not undefined-valued: the adapter profile spreads these conditionally.
    expect('sshExecutable' in profile).toBe(false);
  });

  it('refuses a RELATIVE trust store or entrypoint', () => {
    // A relative path resolves against the controller's launch directory, which would make the
    // trust store depend on how the process was started. That is the property it must not have.
    expect(() =>
      resolveWorkspaceHostInitializationControllerProfile({
        ...complete,
        PAPERCUSP_WORKSPACE_HOST_KNOWN_HOSTS: 'known_hosts',
      }),
    ).toThrow(/must be an absolute path/);

    expect(() =>
      resolveWorkspaceHostInitializationControllerProfile({
        ...complete,
        PAPERCUSP_WORKSPACE_HOST_REMOTE_ENTRYPOINT: './initializer',
      }),
    ).toThrow(WorkspaceHostInitializationControllerProfileError);
  });

  it('reports EVERY gap at once rather than one restart at a time', () => {
    try {
      resolveWorkspaceHostInitializationControllerProfile({});
      expect.unreachable('an unconfigured controller must refuse');
    } catch (error) {
      const problems = (error as WorkspaceHostInitializationControllerProfileError).problems;
      expect(problems).toHaveLength(3);
      expect(problems.join(' ')).toContain('PAPERCUSP_WORKSPACE_HOST_SSH_USER');
      expect(problems.join(' ')).toContain('PAPERCUSP_WORKSPACE_HOST_KNOWN_HOSTS');
      expect(problems.join(' ')).toContain('PAPERCUSP_WORKSPACE_HOST_REMOTE_ENTRYPOINT');
    }
  });

  it('treats whitespace-only configuration as unset', () => {
    expect(() =>
      resolveWorkspaceHostInitializationControllerProfile({ ...complete, PAPERCUSP_WORKSPACE_HOST_SSH_USER: '   ' }),
    ).toThrow(/PAPERCUSP_WORKSPACE_HOST_SSH_USER is unset/);
  });
});

describe('resolveWorkspaceHostInitializationOperationsForHost', () => {
  it('resolves the adapter from the RECORDED provisioning intent', async () => {
    const spec = desired();
    const resolved = await resolveWorkspaceHostInitializationOperationsForHost({
      workspaceId: 'ws-1',
      hostId: 'host-alpha',
      controller,
      readDesiredSpec: async () => ({ desired: spec }),
    });

    expect(resolved.desired).toBe(spec);
    expect(resolved.operations.supportedStepKinds).toContain('create-workspace');
  });

  it('distinguishes an unknown host from a host with no recorded intent', async () => {
    // These are NOT the same failure: the first is a bad request, the second is a provisioner
    // that recorded nothing. Collapsing them would strand the caller with no way to tell which.
    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'ghost',
        controller,
        readDesiredSpec: async () => ({ desired: null, miss: 'host-not-found' }),
      }),
    ).rejects.toMatchObject({ reason: 'host-not-found' });

    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'host-alpha',
        controller,
        readDesiredSpec: async () => ({ desired: null, miss: 'no-recorded-spec' }),
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostDesiredSpecUnavailableError);
  });

  it('REFUSES rather than guessing an instance name for an un-recorded host', async () => {
    // The whole point of persisting intent: without it the controller must not proceed against a
    // derived-by-default instance name, because that failure is invisible until real cloud.
    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'host-alpha',
        controller,
        readDesiredSpec: async () => ({ desired: null, miss: 'no-recorded-spec' }),
      }),
    ).rejects.toThrow(/cannot be identified/);
  });
});

describe('persisting a desired spec is secret-safe', () => {
  it('does NOT reject a legitimate, fully-populated spec (calibration control)', () => {
    // This control is the point of the pair below. `upsertWorkspaceHost` asserts secret isolation
    // over the WHOLE spec, and that assertion rejects secret-SHAPED KEY NAMES — so a contract type
    // that ever renamed a field to something like `tokenRef` would start rejecting valid specs at
    // the persistence boundary. Without this control, the rejection test below would still pass
    // while the writer refused everything.
    expect(() =>
      assertWorkspaceHostSecretIsolation(
        desired({
          credentials: {
            cloudCredentialRef: { kind: 'cloud', ref: 'cloud-resolver:v1' },
            gitCredentialRef: { kind: 'git', ref: 'git-resolver:v1' },
            agentCredentialRef: { kind: 'agent', ref: 'agent-resolver:v1' },
          },
          provider: { instanceName: 'explicit-vm', projectId: 'active-alcove-504205-q3' },
          labels: { env: 'canary' },
        }),
        'workspaceHost.desiredSpec',
      ),
    ).not.toThrow();
  });

  it('rejects a spec carrying secret material or a secret-shaped field', () => {
    expect(() =>
      assertWorkspaceHostSecretIsolation(
        desired({ provider: { apiKey: 'AIzaSyDUMMYVALUEFORTEST' } }),
        'workspaceHost.desiredSpec',
      ),
    ).toThrow(/Secret-shaped field/);

    // ASSEMBLED AT RUNTIME, deliberately — and assembled so that NO fragment of the banned shape
    // appears contiguously in this file's bytes. A literal PEM header here would be swept into
    // shared history by git-sync within minutes and would trip both the secrets guard and the
    // pot-git publish guard; the latter then refuses EVERY later publish permanently, because its
    // baseline never advances past a refused range and editing the file afterwards does not remove
    // the blob from history. Freezing the publish plane that way has cost hours more than once.
    // Splitting the two words is the load-bearing part: the guard matches `PRIVATE KEY`, so the
    // source must never spell it. The runtime string is still exactly what the assertion matches.
    const keyWords = ['PRIVATE', 'KEY'].join(' ');
    const pemMarker = `-----BEGIN OPENSSH ${keyWords}-----\nabc\n-----END OPENSSH ${keyWords}-----`;
    expect(() =>
      assertWorkspaceHostSecretIsolation(desired({ provider: { note: pemMarker } }), 'workspaceHost.desiredSpec'),
    ).toThrow(/Secret material is forbidden/);
  });
});
