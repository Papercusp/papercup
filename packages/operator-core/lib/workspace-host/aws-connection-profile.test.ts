import { describe, expect, it } from 'vitest';

import type { RemoteWorkspaceConsoleLaunchOptions } from '../console-launch-bridge';
import {
  buildOpenSshControlMasterCommand,
  buildOpenSshPtySessionCommand,
} from './local-connection-manager';
import {
  buildAwsWorkspaceHostTransportProfile,
  normalizeAwsWorkspaceHostConnectionProfile,
} from './aws-connection-profile';

const SSM_INPUT = {
  kind: 'aws-ssm-ssh' as const,
  profileName: 'aws-production',
  instanceId: 'i-0123456789abcdef0',
  region: 'us-east-1',
  sshUser: 'ubuntu',
  awsProfile: 'papercusp-production',
};

describe('AWS workspace-host connection-profile adapter', () => {
  it('defaults the managed-node path to the AWS-StartSSHSession ProxyCommand contract', () => {
    const profile = normalizeAwsWorkspaceHostConnectionProfile(SSM_INPUT);

    expect(profile).toMatchObject({
      profileName: 'aws-production',
      kind: 'aws-ssm-ssh',
      target: 'ubuntu@i-0123456789abcdef0',
      remoteOperatorPort: 3070,
    });
    expect(profile.extraArgs).toEqual([
      '-o',
      'ProxyCommand=aws ssm start-session --target %h --document-name AWS-StartSSHSession ' +
        '--parameters portNumber=%p --region us-east-1 --profile papercusp-production',
    ]);
    expect(profile.transportProfile).toMatchObject({
      kind: 'aws-ssm-ssh',
      audited: true,
      features: { command: true, pty: true, tcpForward: true, fileTransfer: true },
      compatibility: {
        traffic: { interactive: 'recommended', 'bulk-transfer': 'discouraged' },
        audit: { controlPlaneEvents: true, sessionContent: false, fileTransferEvents: false },
      },
    });
    expect(profile.transportProfile.compatibility.fallbacks).toContainEqual(
      expect.objectContaining({
        feature: 'fileTransfer',
        trafficClass: 'bulk-transfer',
        strategy: 'provider-object-storage',
      }),
    );

    const launchOptions = {
      targetClientId: 'desktop-aws',
      profileName: profile.profileName,
    } satisfies RemoteWorkspaceConsoleLaunchOptions;
    expect(launchOptions).toEqual({ targetClientId: 'desktop-aws', profileName: 'aws-production' });
    expect(profile).not.toHaveProperty('ticket');
  });

  it('feeds the existing local-forward and remote-command builders without reimplementing either', () => {
    const profile = normalizeAwsWorkspaceHostConnectionProfile(SSM_INPUT);
    const master = buildOpenSshControlMasterCommand({
      target: profile.target,
      extraArgs: profile.extraArgs,
      remoteOperatorPort: profile.remoteOperatorPort,
      controlPath: '/tmp/aws-control.sock',
      localPort: 43170,
    });
    expect(master.command).toBe('ssh');
    expect(master.args).toEqual(
      expect.arrayContaining([
        '-L',
        '127.0.0.1:43170:127.0.0.1:3070',
        profile.extraArgs[1],
        profile.target,
      ]),
    );
    expect(master.args.at(-1)).toBe(profile.target);

    const remote = buildOpenSshPtySessionCommand({
      target: profile.target,
      controlPath: '/tmp/aws-control.sock',
      remoteArgv: ['psu', '--no-picker', '--account', 'default'],
    });
    expect(remote.args).toEqual([
      '-tt',
      '-o',
      'BatchMode=yes',
      '-o',
      'ControlMaster=no',
      '-S',
      '/tmp/aws-control.sock',
      '--',
      profile.target,
      "'psu' '--no-picker' '--account' 'default'",
    ]);
  });

  it('supports direct SSH only with an explicit address and non-/0 source allowlist', () => {
    const profile = normalizeAwsWorkspaceHostConnectionProfile({
      kind: 'aws-direct-ssh',
      profileName: 'aws-direct-breakglass',
      instanceId: 'i-0123456789abcdef0',
      region: 'us-east-1',
      sshUser: 'ubuntu',
      directAddress: '203.0.113.17',
      directSshSourceRanges: ['198.51.100.42/32', '2001:db8:1::/64'],
    });

    expect(profile).toMatchObject({
      kind: 'aws-direct-ssh',
      target: 'ubuntu@203.0.113.17',
      extraArgs: [],
      transportProfile: { audited: false },
    });
    expect(profile.transportProfile.constraints).toContain('Only tcp/22 from 198.51.100.42/32, 2001:db8:1::/64 may be exposed');

    expect(() =>
      buildAwsWorkspaceHostTransportProfile({
        kind: 'aws-direct-ssh',
        instanceId: 'i-0123456789abcdef0',
        region: 'us-east-1',
        directAddress: '203.0.113.17',
      }),
    ).toThrow('explicit restricted source CIDR allowlist');
    expect(() =>
      buildAwsWorkspaceHostTransportProfile({
        kind: 'aws-direct-ssh',
        instanceId: 'i-0123456789abcdef0',
        region: 'us-east-1',
        directAddress: '203.0.113.17',
        directSshSourceRanges: ['0.0.0.0/0'],
      }),
    ).toThrow("source CIDR '0.0.0.0/0'");
  });

  it('rejects routing injection and settings that leak across transport kinds', () => {
    expect(() =>
      normalizeAwsWorkspaceHostConnectionProfile({ ...SSM_INPUT, profileName: 'bad profile' }),
    ).toThrow('Connection profile name');
    expect(() =>
      normalizeAwsWorkspaceHostConnectionProfile({ ...SSM_INPUT, awsProfile: 'prod; touch /tmp/pwned' }),
    ).toThrow('AWS shared profile name');
    expect(() =>
      buildAwsWorkspaceHostTransportProfile({
        kind: 'aws-ssm-ssh',
        instanceId: SSM_INPUT.instanceId,
        region: SSM_INPUT.region,
        directAddress: '203.0.113.17',
      }),
    ).toThrow('valid only for aws-direct-ssh');
  });
});
