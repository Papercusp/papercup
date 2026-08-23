import { describe, expect, it, vi } from 'vitest';

import {
  WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
  WORKSPACE_HOST_INITIALIZATION_STEP_KINDS,
  planWorkspaceHostInitialization,
  type WorkspaceHostCredentialRefs,
} from '@papercusp/deployment-driver';
import {
  GCP_IAP_INITIALIZATION_PROTOCOL_VERSION,
  GcpIapWorkspaceHostInitializationOperations,
  buildGcpIapWorkspaceHostInitializationCommand,
  type GcpIapWorkspaceHostInitializationCommandRunner,
  type GcpIapWorkspaceHostInitializationProfile,
} from './gcp-iap-initialization-operations';

const PROFILE: GcpIapWorkspaceHostInitializationProfile = {
  projectId: 'active-alcove-504205-q3',
  zone: 'us-central1-a',
  instanceName: 'pc-workspace-1',
  sshUser: 'papercusp-workspace',
  knownHostsFile: '/var/lib/papercusp/controller/known_hosts',
  identityFile: '/var/lib/papercusp/controller/os-login',
  remoteEntrypoint: '/opt/papercusp/current/bin/papercusp-workspace-initialize',
};

const REFS: WorkspaceHostCredentialRefs = {
  cloudCredentialRef: { kind: 'cloud', ref: 'cloud-resolver:v1' },
  gitCredentialRef: { kind: 'git', ref: 'git-resolver:v1' },
  agentCredentialRef: { kind: 'agent', ref: 'agent-resolver:v1' },
};

function step() {
  return planWorkspaceHostInitialization({
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    operationId: 'init-1',
    workspaceId: 'workspace-1',
    hostId: 'host-1',
    requestedAt: '2026-08-23T06:00:00Z',
    source: { kind: 'empty' },
    credentialRefs: REFS,
    credentialDelivery: {
      cloud: {
        kind: 'provider-identity',
        generation: 1,
        audience: 'host-1',
        revocationRef: 'revoke-cloud-v1',
      },
      git: {
        kind: 'forwarded-agent',
        generation: 1,
        audience: 'host-1',
        revocationRef: 'revoke-git-v1',
      },
      agent: {
        kind: 'short-lived-delegation',
        generation: 1,
        audience: 'host-1',
        revocationRef: 'revoke-agent-v1',
        expiresAt: '2026-08-23T07:00:00Z',
      },
    },
  }).steps[0]!;
}

describe('GCP IAP workspace-host initialization operations', () => {
  it('plans one strict non-interactive OpenSSH/IAP request without bash, scp, or credential bytes', () => {
    const command = buildGcpIapWorkspaceHostInitializationCommand(PROFILE, step());

    expect(command.command).toBe('ssh');
    expect(command.args).toEqual(
      expect.arrayContaining([
        '-T',
        'BatchMode=yes',
        'ClearAllForwardings=yes',
        'StrictHostKeyChecking=yes',
        `UserKnownHostsFile=${PROFILE.knownHostsFile}`,
        `ProxyCommand=gcloud compute start-iap-tunnel %h %p --listen-on-stdin --project=${PROFILE.projectId} --zone=${PROFILE.zone} --verbosity=error`,
        `${PROFILE.sshUser}@${PROFILE.instanceName}`,
      ]),
    );
    expect(command.args.at(-1)).toContain("'/opt/papercusp/current/bin/papercusp-workspace-initialize'");
    expect(command.args.join(' ')).not.toMatch(/\b(?:bash|scp)\b/);
    expect(JSON.parse(command.stdin)).toMatchObject({
      protocolVersion: GCP_IAP_INITIALIZATION_PROTOCOL_VERSION,
      step: { id: 'workspace', kind: 'create-workspace' },
    });
    expect(command.stdin).not.toMatch(/PRIVATE KEY|access.?token|api.?key/i);
  });

  it('declares every typed step capability and performs no I/O until execute', async () => {
    const run = vi.fn<GcpIapWorkspaceHostInitializationCommandRunner['run']>().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        protocolVersion: GCP_IAP_INITIALIZATION_PROTOCOL_VERSION,
        stepId: 'workspace',
        status: 'succeeded',
        observedAt: '2026-08-23T06:01:00Z',
        publicEvidence: { workspaceCreated: true },
      }),
    });
    const operations = new GcpIapWorkspaceHostInitializationOperations(PROFILE, { run });

    expect(operations.supportedStepKinds).toEqual(WORKSPACE_HOST_INITIALIZATION_STEP_KINDS);
    expect(run).not.toHaveBeenCalled();
    await expect(operations.execute(step())).resolves.toEqual({
      observedAt: '2026-08-23T06:01:00Z',
      publicEvidence: { workspaceCreated: true },
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it('fails closed on routing injection before invoking the transport', async () => {
    const run = vi.fn<GcpIapWorkspaceHostInitializationCommandRunner['run']>();
    const operations = new GcpIapWorkspaceHostInitializationOperations(
      { ...PROFILE, zone: 'us-central1-a; touch /tmp/pwned' },
      { run },
    );

    await expect(operations.execute(step())).rejects.toThrow('GCP zone has an invalid value');
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects secret-shaped remote evidence and never reflects transport output in an exit error', async () => {
    const secretResponse = new GcpIapWorkspaceHostInitializationOperations(PROFILE, {
      async run() {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            protocolVersion: GCP_IAP_INITIALIZATION_PROTOCOL_VERSION,
            stepId: 'workspace',
            status: 'succeeded',
            observedAt: '2026-08-23T06:01:00Z',
            publicEvidence: { accessToken: 'must-never-persist' },
          }),
        };
      },
    });
    await expect(secretResponse.execute(step())).rejects.toThrow(/Secret-shaped field/);

    const failed = new GcpIapWorkspaceHostInitializationOperations(PROFILE, {
      async run() {
        return { exitCode: 23, stdout: 'private diagnostic must not escape' };
      },
    });
    await expect(failed.execute(step())).rejects.toThrow('failed with exit code 23');
    await expect(failed.execute(step())).rejects.not.toThrow(/private diagnostic/);
  });
});
