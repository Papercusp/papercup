/**
 * aws-byoc-gcp-parity-2026-10-01 P-005: the AWS half of the shared SSH transport seam.
 *
 * The step protocol, readiness probe, credential delivery and connector enrollment are shared with
 * GCP; only the ProxyCommand and the trust-pin alias differ. These tests pin both, and pin that the
 * GCP path through the seam is byte-for-byte what it was before AWS existed.
 */
import { describe, expect, it } from 'vitest';
import {
  awsSsmHostKeyAlias,
  buildAwsSsmSshInvocation,
  buildGcpIapSshInvocation,
  buildGcpIapWorkspaceHostBootstrapReadinessProbe,
  buildGcpIapWorkspaceHostInitializationCommand,
  buildWorkspaceHostSshInvocation,
  gcpIapHostKeyAlias,
  workspaceHostSshHostKeyAlias,
  type AwsSsmWorkspaceHostInitializationProfile,
  type GcpIapWorkspaceHostInitializationProfile,
} from './gcp-iap-initialization-operations';

const aws: AwsSsmWorkspaceHostInitializationProfile = {
  kind: 'aws-ssm-ssh',
  region: 'us-east-2',
  instanceId: 'i-0123456789abcdef0',
  sshUser: 'papercusp',
  knownHostsFile: '/var/lib/papercusp/known_hosts',
  identityFile: '/var/lib/papercusp/id_ed25519',
  remoteEntrypoint: '/opt/papercusp/bin/papercusp-init',
};

const gcp: GcpIapWorkspaceHostInitializationProfile = {
  projectId: 'papercusp-hosted',
  zone: 'us-central1-c',
  instanceName: 'pc-host-abc',
  instanceId: '1234567890123',
  sshUser: 'papercusp',
  knownHostsFile: '/var/lib/papercusp/known_hosts',
  identityFile: '/var/lib/papercusp/id_ed25519',
  remoteEntrypoint: '/opt/papercusp/bin/papercusp-init',
};

const invocation = {
  entrypoint: '/opt/papercusp/bin/papercusp-init',
  entrypointLabel: 'Remote initializer',
  args: ['--json-stdin'],
  stdin: '{"x":1}\n',
};

function option(args: readonly string[], name: string): string | undefined {
  const hit = args.find((arg, index) => args[index - 1] === '-o' && arg.startsWith(`${name}=`));
  return hit?.slice(name.length + 1);
}

describe('AWS SSM SSH transport (P-005)', () => {
  it('tunnels OpenSSH through an SSM AWS-StartSSHSession to the instance id, in the connection region', () => {
    const command = buildAwsSsmSshInvocation(aws, invocation);
    expect(command.command).toBe('ssh');
    expect(option(command.args, 'ProxyCommand')).toBe(
      'aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p --region=us-east-2',
    );
    expect(command.args.at(-2)).toBe('papercusp@i-0123456789abcdef0');
    expect(command.args.at(-1)).toBe("'/opt/papercusp/bin/papercusp-init' '--json-stdin'");
    expect(command.stdin).toBe(invocation.stdin);
  });

  it('keeps the same hardening as the IAP transport: batch, strict pin under an incarnation alias, one identity, no forwarding', () => {
    const { args } = buildAwsSsmSshInvocation(aws, invocation);
    expect(option(args, 'BatchMode')).toBe('yes');
    expect(option(args, 'StrictHostKeyChecking')).toBe('yes');
    expect(option(args, 'ClearAllForwardings')).toBe('yes');
    expect(option(args, 'IdentitiesOnly')).toBe('yes');
    expect(option(args, 'UserKnownHostsFile')).toBe(aws.knownHostsFile);
    expect(option(args, 'HostKeyAlias')).toBe('aws-ssm-us-east-2-i-0123456789abcdef0');
    expect(args[args.indexOf('-i') + 1]).toBe(aws.identityFile);
  });

  it('passes a named CLI profile through and refuses one that could inject an argument', () => {
    const named = buildAwsSsmSshInvocation({ ...aws, awsProfile: 'papercusp-byoc' }, invocation);
    expect(option(named.args, 'ProxyCommand')).toMatch(/ --profile=papercusp-byoc$/);
    expect(() => buildAwsSsmSshInvocation({ ...aws, awsProfile: 'x --debug' }, invocation)).toThrow(
      /AWS CLI profile has an invalid value/,
    );
  });

  it('binds the trust pin to the EC2 incarnation, so a replaced instance gets its own pin', () => {
    expect(awsSsmHostKeyAlias(aws)).not.toBe(awsSsmHostKeyAlias({ ...aws, instanceId: 'i-0fedcba9876543210' }));
    expect(() => awsSsmHostKeyAlias({ ...aws, instanceId: 'pc-host-abc' })).toThrow(/EC2 instance id/);
    expect(() => awsSsmHostKeyAlias({ ...aws, region: 'us east 2' })).toThrow(/AWS region/);
  });

  it('refuses to build without a controller identity file, as the IAP transport does', () => {
    expect(() => buildAwsSsmSshInvocation({ ...aws, identityFile: undefined }, invocation)).toThrow(
      /OpenSSH identity file is required/,
    );
  });
});

describe('the shared transport seam', () => {
  it('routes a GCP profile (no kind) to the unchanged IAP builder', () => {
    expect(buildWorkspaceHostSshInvocation(gcp, invocation)).toEqual(buildGcpIapSshInvocation(gcp, invocation));
    expect(workspaceHostSshHostKeyAlias(gcp)).toBe(gcpIapHostKeyAlias(gcp));
  });

  it('routes an AWS profile to the SSM builder', () => {
    expect(buildWorkspaceHostSshInvocation(aws, invocation)).toEqual(buildAwsSsmSshInvocation(aws, invocation));
    expect(workspaceHostSshHostKeyAlias(aws)).toBe(awsSsmHostKeyAlias(aws));
  });

  it('drives the shared initialization step and readiness probe over SSM for an AWS host', () => {
    const step = buildGcpIapWorkspaceHostInitializationCommand(aws, {
      id: 'verify-1',
      kind: 'verify-release',
    } as never);
    expect(option(step.args, 'ProxyCommand')).toMatch(/^aws ssm start-session /);
    expect(step.args.at(-1)).toMatch(/^'\/opt\/papercusp\/bin\/papercusp-init' '--protocol-version' /);

    const probe = buildGcpIapWorkspaceHostBootstrapReadinessProbe(aws);
    expect(option(probe.args, 'ProxyCommand')).toMatch(/^aws ssm start-session /);
    expect(probe.args.at(-1)).toBe("'/bin/test' '-x' '/opt/papercusp/bin/papercusp-init'");
  });
});
