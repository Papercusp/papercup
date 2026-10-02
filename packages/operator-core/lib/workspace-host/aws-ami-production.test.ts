import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WORKSPACE_HOST_BOOTC_BUILDER_KIND, type WorkspaceHostProviderConnection } from '@papercusp/deployment-driver';
import { canonicalize } from '@papercusp/publish-auth/jcs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  awsAmiReleaseDescription,
  buildAwsAmiVersionManifest,
  parseAwsAmiReleaseDescription,
  type AwsAmiReleaseRequest,
} from './aws-ami-release';
import {
  SdkAwsAmiReleaseAdapter,
  executeConfiguredAwsAmiRelease,
  probeAwsAmiCredential,
  type AwsAmiCommandRunner,
} from './aws-ami-production';

const KMS = 'arn:aws:kms:us-east-1:111111111111:key/abc';
const SHA = 'a'.repeat(64);
const TOOLS = ['amazon-ssm-agent', 'openssh-server'];

type Call = { name: string; input: Record<string, unknown> };

function fakeSender(responses: Record<string, (input: Record<string, unknown>) => unknown>, calls: Call[]) {
  return {
    send: async (command: unknown) => {
      const { constructor, input } = command as { constructor: { name: string }; input: Record<string, unknown> };
      calls.push({ name: constructor.name, input });
      const respond = responses[constructor.name];
      if (!respond) throw new Error(`unexpected command ${constructor.name}`);
      return respond(input);
    },
  };
}

function fakeCommands(stdout: string, runs: unknown[]): AwsAmiCommandRunner {
  return { run: async (command) => (runs.push(command), { exitCode: 0, stdout, stderr: '' }) };
}

let dir: string;
let diskPath: string;
let diskSha: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aws-ami-production-'));
  diskPath = join(dir, 'disk.raw');
  await writeFile(diskPath, 'bootc-ami-disk');
  diskSha = createHash('sha256').update('bootc-ami-disk').digest('hex');
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

function buildInput(overrides: Record<string, unknown> = {}) {
  return {
    sourceRegion: 'us-east-1',
    imageName: 'papercusp-workspace-host-2026.10.1',
    description: awsAmiReleaseDescription('2026.10.1', SHA),
    kmsKeyArn: KMS,
    builderKind: WORKSPACE_HOST_BOOTC_BUILDER_KIND,
    templatePath: 'infra/images/bootc/workspace-host.Containerfile',
    bootcArtifact: { cloud: 'aws' as const, type: 'ami' as const, artifact: diskPath, sha256: diskSha, sizeBytes: 14 },
    buildManifestIdentity: `sha256:${'c'.repeat(64)}`,
    releaseVersion: '2026.10.1',
    releaseSha256: SHA,
    architecture: 'x86_64',
    requiredGuestTools: TOOLS,
    tags: { 'papercusp:managed': 'true' },
    ...overrides,
  } as Parameters<SdkAwsAmiReleaseAdapter['buildCandidate']>[0];
}

function adapterWith(ec2Calls: Call[], runs: unknown[], ec2Responses: Record<string, (input: Record<string, unknown>) => unknown> = {}) {
  return new SdkAwsAmiReleaseAdapter(
    {
      ec2: () => fakeSender(ec2Responses, ec2Calls),
      ssm: () => fakeSender({}, ec2Calls),
      childCredentials: async () => ({ AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'secret' }),
      commands: fakeCommands('Uploaded snapshot snap-0abc123\n', runs),
      sleep: async () => {},
    },
    { guestToolVersions: { 'amazon-ssm-agent': '3.3.1', 'openssh-server': '9.6' } },
  );
}

describe('AWS AMI release description (cross-account provenance)', () => {
  it('round-trips version and digest, and rejects anything else', () => {
    expect(parseAwsAmiReleaseDescription(awsAmiReleaseDescription('2026.10.1', SHA))).toEqual({
      releaseVersion: '2026.10.1',
      releaseSha256: SHA,
    });
    expect(parseAwsAmiReleaseDescription('Canonical, Ubuntu, 24.04')).toBeUndefined();
    expect(() => awsAmiReleaseDescription('has space', SHA)).toThrow(/version token/);
  });
});

describe('SdkAwsAmiReleaseAdapter.buildCandidate', () => {
  it('refuses a Packer-kind build before any upload or AWS call', async () => {
    const calls: Call[] = [];
    const runs: unknown[] = [];
    await expect(
      adapterWith(calls, runs).buildCandidate(buildInput({ builderKind: 'packer', bootcArtifact: undefined })),
    ).rejects.toThrow(/bootc bake/);
    expect(calls).toEqual([]);
    expect(runs).toEqual([]);
  });

  it('refuses a disk whose digest differs from the bake manifest before uploading it', async () => {
    const calls: Call[] = [];
    const runs: unknown[] = [];
    const input = buildInput();
    await expect(
      adapterWith(calls, runs).buildCandidate({ ...input, bootcArtifact: { ...input.bootcArtifact!, sha256: 'f'.repeat(64) } }),
    ).rejects.toThrow(/digest does not match/);
    expect(runs).toEqual([]);
  });

  it('uploads, registers, re-encrypts with the source key, and removes the unencrypted staging image', async () => {
    const calls: Call[] = [];
    const runs: unknown[] = [];
    const adapter = adapterWith(calls, runs, {
      RegisterImageCommand: () => ({ ImageId: 'ami-0aaa' }),
      DescribeImagesCommand: () => ({ Images: [{ State: 'available' }] }),
      CopyImageCommand: () => ({ ImageId: 'ami-0bbb' }),
      DeregisterImageCommand: () => ({}),
      DeleteSnapshotCommand: () => ({}),
    });
    await expect(adapter.buildCandidate(buildInput())).resolves.toEqual({ imageId: 'ami-0bbb' });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ command: 'coldsnap', args: ['upload', '--wait', diskPath] });
    expect((runs[0] as { env: Record<string, string> }).env).toMatchObject({ AWS_REGION: 'us-east-1' });
    const register = calls.find((call) => call.name === 'RegisterImageCommand')!;
    expect(register.input).toMatchObject({ BlockDeviceMappings: [{ Ebs: { SnapshotId: 'snap-0abc123' } }], ImdsSupport: 'v2.0' });
    const copy = calls.find((call) => call.name === 'CopyImageCommand')!;
    expect(copy.input).toMatchObject({
      SourceImageId: 'ami-0aaa',
      Encrypted: true,
      KmsKeyId: KMS,
      Name: 'papercusp-workspace-host-2026.10.1',
      Description: awsAmiReleaseDescription('2026.10.1', SHA),
    });
    expect(calls.filter((call) => /Deregister|DeleteSnapshot/.test(call.name)).map((call) => call.input)).toEqual([
      { ImageId: 'ami-0aaa' },
      { SnapshotId: 'snap-0abc123' },
    ]);
  });

  it('refuses when a required guest tool version is not pinned', async () => {
    const adapter = new SdkAwsAmiReleaseAdapter(
      { ec2: () => fakeSender({}, []), ssm: () => fakeSender({}, []), childCredentials: async () => ({}) },
      { guestToolVersions: { 'amazon-ssm-agent': '3.3.1' } },
    );
    await expect(adapter.buildCandidate(buildInput())).rejects.toThrow(/not pinned for: openssh-server/);
  });
});

describe('SdkAwsAmiReleaseAdapter.scanImage', () => {
  it('hands the scan child the same coldsnap the upload uses (WI-10005642)', async () => {
    const runs: unknown[] = [];
    const scanInput = { region: 'us-east-1', imageId: 'ami-0bbb', buildManifestIdentity: `sha256:${'c'.repeat(64)}`, releaseSha256: SHA };
    const pinned = new SdkAwsAmiReleaseAdapter(
      { ec2: () => fakeSender({}, []), ssm: () => fakeSender({}, []), childCredentials: async () => ({}), commands: fakeCommands('{}', runs) },
      { coldsnapExecutable: '/home/u/.papercusp/tools/coldsnap/0.12.0/bin/coldsnap' },
    );
    await pinned.scanImage(scanInput as Parameters<SdkAwsAmiReleaseAdapter['scanImage']>[0]);
    expect(runs[0]).toMatchObject({
      command: 'papercusp-aws-ami-scan',
      env: { AWS_REGION: 'us-east-1', PAPERCUSP_AWS_AMI_SCAN_COLDSNAP: '/home/u/.papercusp/tools/coldsnap/0.12.0/bin/coldsnap' },
    });

    // Positive control: with no override the scan child still gets the adapter's default, not nothing.
    await adapterWith([], runs).scanImage(scanInput as Parameters<SdkAwsAmiReleaseAdapter['scanImage']>[0]).catch(() => undefined);
    expect((runs[1] as { env: Record<string, string> }).env.PAPERCUSP_AWS_AMI_SCAN_COLDSNAP).toBe('coldsnap');
  });
});

describe('SdkAwsAmiReleaseAdapter.inspectImage', () => {
  it('reads launch permissions, snapshot encryption/sharing and guest tools from the image itself', async () => {
    const calls: Call[] = [];
    const adapter = adapterWith(calls, [], {
      DescribeImagesCommand: () => ({
        Images: [
          {
            OwnerId: '111111111111',
            State: 'available',
            Architecture: 'x86_64',
            Tags: [{ Key: 'papercusp:guest-tool:amazon-ssm-agent', Value: '3.3.1' }, { Key: 'papercusp:managed', Value: 'true' }],
            BlockDeviceMappings: [{ Ebs: { SnapshotId: 'snap-0abc' } }],
          },
        ],
      }),
      DescribeImageAttributeCommand: () => ({ LaunchPermissions: [{ UserId: '333333333333' }, { UserId: '222222222222' }] }),
      DescribeSnapshotsCommand: () => ({ Snapshots: [{ Encrypted: true, KmsKeyId: KMS }] }),
      DescribeSnapshotAttributeCommand: () => ({ CreateVolumePermissions: [{ UserId: '222222222222' }] }),
    });
    await expect(adapter.inspectImage('us-east-1', 'ami-0bbb')).resolves.toMatchObject({
      ownerAccountId: '111111111111',
      state: 'available',
      guestTools: [{ name: 'amazon-ssm-agent', version: '3.3.1' }],
      launchAccountIds: ['222222222222', '333333333333'],
      snapshots: [{ snapshotId: 'snap-0abc', encrypted: true, kmsKeyArn: KMS, createVolumeAccountIds: ['222222222222'] }],
    });
  });
});

describe('SdkAwsAmiReleaseAdapter.publishVersionManifest', () => {
  const manifestFor = (publishedAt: string) =>
    buildAwsAmiVersionManifest({
      releaseVersion: '2026.10.1',
      releaseSha256: SHA,
      buildManifestIdentity: `sha256:${'c'.repeat(64)}`,
      architecture: 'x86_64',
      sourceRegion: 'us-east-1',
      publishedAt,
      requiredGuestTools: TOOLS,
      regions: [{ region: 'us-east-1', imageId: 'ami-0bbb', snapshotIds: ['snap-0abc'], kmsKeyArn: KMS, launchAccountIds: ['222222222222'] }],
      rollbackPins: [],
      cleanAccountProof: {} as never,
    });

  function adapterStoring(stored: string) {
    return new SdkAwsAmiReleaseAdapter({
      ec2: () => fakeSender({}, []),
      ssm: () =>
        fakeSender(
          {
            PutParameterCommand: () => {
              throw Object.assign(new Error('exists'), { name: 'ParameterAlreadyExists' });
            },
            GetParameterCommand: () => ({ Parameter: { Value: stored } }),
          },
          [],
        ),
      childCredentials: async () => ({}),
    });
  }

  it('returns a receipt whose identity is re-derived from the STORED manifest', async () => {
    const manifest = manifestFor('2026-10-01T00:00:00.000Z');
    await expect(adapterStoring(canonicalize(manifest)).publishVersionManifest(manifest)).resolves.toEqual({
      uri: 'ssm://us-east-1/papercusp/workspace-host/ami/manifests/2026.10.1',
      manifestIdentity: manifest.manifestIdentity,
    });
  });

  it('refuses when a different manifest already holds the release version', async () => {
    const manifest = manifestFor('2026-10-01T00:00:00.000Z');
    const other = manifestFor('2026-10-02T00:00:00.000Z');
    await expect(adapterStoring(canonicalize(other)).publishVersionManifest(manifest)).rejects.toThrow(/does not match this release/);
  });
});

describe('connection binding', () => {
  const connection = {
    target: 'aws',
    scope: { kind: 'account', id: '111111111111' },
    provider: { region: 'us-east-1' },
  } as unknown as WorkspaceHostProviderConnection;

  it('refuses a release whose publisher account is not the connection account', async () => {
    await expect(
      executeConfiguredAwsAmiRelease({ publisherAccountId: '222222222222' } as AwsAmiReleaseRequest, connection),
    ).rejects.toThrow(/not the connection's account/);
  });

  it('credential probe fails when the credential resolves to a different account', async () => {
    const sts = { send: async () => ({ Account: '999999999999', Arn: 'arn:aws:sts::999999999999:assumed-role/x/y' }) };
    await expect(probeAwsAmiCredential(connection, { sts })).resolves.toMatchObject({
      ok: false,
      resolvedAccountId: '999999999999',
      error: expect.stringMatching(/not '111111111111'/),
    });
    const ok = { send: async () => ({ Account: '111111111111' }) };
    await expect(probeAwsAmiCredential(connection, { sts: ok })).resolves.toMatchObject({ ok: true });
  });
});
