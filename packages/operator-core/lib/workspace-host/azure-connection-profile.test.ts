import { describe, expect, it } from 'vitest';

import type { RemoteWorkspaceConsoleLaunchOptions } from '../console-launch-bridge';
import {
  buildOpenSshControlMasterCommand,
  buildOpenSshPtySessionCommand,
} from './local-connection-manager';
import {
  buildAzureWorkspaceHostTransportProfile,
  normalizeAzureWorkspaceHostConnectionProfile,
  planAzureWorkspaceHostConnection,
} from './azure-connection-profile';

const SUBSCRIPTION_ID = '00000000-1111-2222-3333-444444444444';
const VM_RESOURCE_ID =
  `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg-workspace/` +
  'providers/Microsoft.Compute/virtualMachines/vm-workspace-1';

const ENTRA_INPUT = {
  kind: 'azure-bastion-entra-ssh' as const,
  profileName: 'azure-production',
  vmResourceId: VM_RESOURCE_ID,
  sshUser: 'alice_example_com',
  bastionName: 'bastion-production',
  bastionResourceGroup: 'rg-network',
  identityFile: '/home/alice/.papercusp/ssh/azure-id_rsa',
  publicKeyFile: '/home/alice/.papercusp/ssh/azure-id_rsa.pub',
  certificateFile: '/home/alice/.papercusp/ssh/azure-id_rsa-aadcert.pub',
};

describe('Azure workspace-host connection-profile adapter', () => {
  it('uses Bastion tunnel plus a short-lived Entra certificate without weakening known_hosts', () => {
    const profile = normalizeAzureWorkspaceHostConnectionProfile(ENTRA_INPUT);
    const plan = planAzureWorkspaceHostConnection(profile, {
      controlPath: '/tmp/azure-control.sock',
      localOperatorPort: 43170,
      bastionLocalPort: 45222,
    });

    expect(profile).toMatchObject({
      profileName: 'azure-production',
      kind: 'azure-bastion-entra-ssh',
      target: 'alice_example_com@127.0.0.1',
      remoteOperatorPort: 3070,
    });
    expect(plan.prepare).toEqual([
      {
        command: 'az',
        args: [
          'ssh',
          'cert',
          '--public-key-file',
          ENTRA_INPUT.publicKeyFile,
          '--file',
          ENTRA_INPUT.certificateFile,
          '--subscription',
          SUBSCRIPTION_ID,
          '--only-show-errors',
          '--output',
          'none',
        ],
      },
    ]);
    expect(plan.providerTunnel).toEqual({
      command: 'az',
      args: [
        'network',
        'bastion',
        'tunnel',
        '--name',
        'bastion-production',
        '--resource-group',
        'rg-network',
        '--target-resource-id',
        VM_RESOURCE_ID,
        '--resource-port',
        '22',
        '--port',
        '45222',
        '--subscription',
        SUBSCRIPTION_ID,
        '--only-show-errors',
      ],
    });

    const master = buildOpenSshControlMasterCommand(plan.openSsh);
    expect(master.args).toEqual(
      expect.arrayContaining([
        '-p',
        '45222',
        `HostKeyAlias=${profile.hostKeyAlias}`,
        ENTRA_INPUT.identityFile,
        `CertificateFile=${ENTRA_INPUT.certificateFile}`,
        '127.0.0.1:43170:127.0.0.1:3070',
      ]),
    );
    expect(master.args.at(-1)).toBe(profile.target);
    expect(master.args.join(' ')).not.toMatch(/StrictHostKeyChecking=no|UserKnownHostsFile=/);
    expect(plan.providerTunnel.args).not.toContain('ssh');
  });

  it('maps exact remote argv into the shared PTY path and remains ticket-free', () => {
    const profile = normalizeAzureWorkspaceHostConnectionProfile(ENTRA_INPUT);
    const remote = buildOpenSshPtySessionCommand({
      target: profile.target,
      controlPath: '/tmp/azure-control.sock',
      remoteArgv: ['psu', '--no-picker', '--account', 'default', '--', '--backend=value with spaces'],
    });
    expect(remote.args).toEqual([
      '-tt',
      '-o',
      'BatchMode=yes',
      '-o',
      'ControlMaster=no',
      '-S',
      '/tmp/azure-control.sock',
      '--',
      profile.target,
      "'psu' '--no-picker' '--account' 'default' '--' '--backend=value with spaces'",
    ]);

    const launchOptions = {
      targetClientId: 'desktop-azure',
      profileName: profile.profileName,
    } satisfies RemoteWorkspaceConsoleLaunchOptions;
    expect(launchOptions).toEqual({ targetClientId: 'desktop-azure', profileName: 'azure-production' });
    expect(profile).not.toHaveProperty('ticket');
  });

  it('supports key-backed Bastion file transfer without requiring the Entra extension', () => {
    const profile = normalizeAzureWorkspaceHostConnectionProfile({
      ...ENTRA_INPUT,
      kind: 'azure-bastion-ssh',
      profileName: 'azure-key-backed',
      publicKeyFile: undefined,
      certificateFile: undefined,
    });
    const requirementIds = profile.transportProfile.compatibility.requirements.map(({ id }) => id);

    expect(profile.transportProfile.features.fileTransfer).toBe(true);
    expect(profile.transportProfile.compatibility.traffic['bulk-transfer']).toBe('discouraged');
    expect(profile.transportProfile.compatibility.fallbacks).toContainEqual(
      expect.objectContaining({
        feature: 'fileTransfer',
        trafficClass: 'bulk-transfer',
        strategy: 'provider-object-storage',
      }),
    );
    expect(requirementIds).toContain('azure-local-ssh-key');
    expect(requirementIds).not.toContain('azure-ssh-extension');
    expect(planAzureWorkspaceHostConnection(profile, {
      controlPath: '/tmp/azure-key-control.sock',
      localOperatorPort: 43171,
      bastionLocalPort: 45223,
    }).prepare).toEqual([]);
  });

  it('supports direct SSH only with an explicit address and non-/0 source allowlist', () => {
    const profile = normalizeAzureWorkspaceHostConnectionProfile({
      kind: 'azure-direct-ssh',
      profileName: 'azure-direct-breakglass',
      vmResourceId: VM_RESOURCE_ID,
      sshUser: 'azureuser',
      identityFile: '/home/alice/.ssh/azure-direct',
      directAddress: '203.0.113.18',
      directSshSourceRanges: ['198.51.100.42/32', '2001:db8:1::/64'],
    });
    const plan = planAzureWorkspaceHostConnection(profile, {
      controlPath: '/tmp/azure-direct-control.sock',
      localOperatorPort: 43172,
    });

    expect(profile).toMatchObject({
      kind: 'azure-direct-ssh',
      target: 'azureuser@203.0.113.18',
      transportProfile: { audited: false },
    });
    expect(profile.transportProfile.constraints).toContain(
      'Only tcp/22 from 198.51.100.42/32, 2001:db8:1::/64 may be exposed',
    );
    expect(plan).not.toHaveProperty('providerTunnel');
    expect(plan.openSsh).not.toHaveProperty('port');

    expect(() =>
      buildAzureWorkspaceHostTransportProfile({
        kind: 'azure-direct-ssh',
        vmResourceId: VM_RESOURCE_ID,
        directAddress: '203.0.113.18',
      }),
    ).toThrow('explicit restricted source CIDR allowlist');
    expect(() =>
      buildAzureWorkspaceHostTransportProfile({
        kind: 'azure-direct-ssh',
        vmResourceId: VM_RESOURCE_ID,
        directAddress: '203.0.113.18',
        directSshSourceRanges: ['0.0.0.0/0'],
      }),
    ).toThrow("source CIDR '0.0.0.0/0'");
  });

  it('rejects routing injection and settings that leak across transport kinds', () => {
    expect(() =>
      normalizeAzureWorkspaceHostConnectionProfile({ ...ENTRA_INPUT, bastionName: 'bad/name' }),
    ).toThrow('resource name');
    expect(() =>
      normalizeAzureWorkspaceHostConnectionProfile({
        ...ENTRA_INPUT,
        kind: 'azure-bastion-ssh',
      }),
    ).toThrow('valid only for azure-bastion-entra-ssh');
    expect(() =>
      buildAzureWorkspaceHostTransportProfile({
        kind: 'azure-bastion-entra-ssh',
        vmResourceId: VM_RESOURCE_ID,
        directAddress: '203.0.113.18',
      }),
    ).toThrow('valid only for azure-direct-ssh');
  });
});
