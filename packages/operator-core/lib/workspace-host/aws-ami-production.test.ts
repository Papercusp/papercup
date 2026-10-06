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
  AWS_AMI_COMMAND_ERROR_DETAIL_CHARS,
  SdkAwsAmiReleaseAdapter,
  executeConfiguredAwsAmiRelease,
  probeAwsAmiCredential,
  resolveAwsAmiGuestToolVersions,
  type AwsAmiCommandRunner,
} from './aws-ami-production';
import { CANARY_BUDGETS, SSM_CHUNK_CHARS } from '../../bin/aws-ami-canary-measure.mjs';

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
    expect(runs[0]).toMatchObject({ command: 'coldsnap' });
    // Zero blocks skipped (WI-10006192); each run tag is a `--tag Key=K,Value=V` pair; the disk is last.
    const uploadArgs = (runs[0] as { args: string[] }).args;
    // 16 workers, not coldsnap's 64: on an uplink-bound upload 64 put each block near the 12 s read timeout.
    expect(uploadArgs.slice(0, 5)).toEqual(['upload', '--wait', '--omit-zero-blocks', '--workers', '16']);
    expect(uploadArgs.at(-1)).toBe(diskPath);
    const tagArgs = uploadArgs.slice(5, -1);
    expect(tagArgs.filter((_, index) => index % 2 === 0).every((flag) => flag === '--tag')).toBe(true);
    expect(tagArgs).toEqual(expect.arrayContaining(['Key=papercusp:managed,Value=true']));
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

  describe('coldsnap upload failure (WI-10006192)', () => {
    const TRANSPORT = "[WARN ] block 24145: attempt 5/5 failed after 3.1s: Failed to put block 24145 for snapshot 'snap-0dead1': dispatch failure";
    const OK = { exitCode: 0, stdout: 'Uploaded snapshot snap-0abc123\n', stderr: '' };

    function sequencedAdapter(
      results: { exitCode: number; stdout: string; stderr: string }[],
      calls: Call[],
      runs: unknown[],
      deleteSnapshot: (input: Record<string, unknown>) => unknown = () => ({}),
    ) {
      return new SdkAwsAmiReleaseAdapter(
        {
          ec2: () =>
            fakeSender(
              {
                RegisterImageCommand: () => ({ ImageId: 'ami-0aaa' }),
                DescribeImagesCommand: () => ({ Images: [{ State: 'available' }] }),
                CopyImageCommand: () => ({ ImageId: 'ami-0bbb' }),
                DeregisterImageCommand: () => ({}),
                DeleteSnapshotCommand: deleteSnapshot,
              },
              calls,
            ),
          ssm: () => fakeSender({}, calls),
          childCredentials: async () => ({ AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'secret' }),
          commands: { run: async (command) => (runs.push(command), results.shift() ?? OK) },
          sleep: async () => {},
        },
        { guestToolVersions: { 'amazon-ssm-agent': '3.3.1', 'openssh-server': '9.6' } },
      );
    }
    const deletedSnapshots = (calls: Call[]) => calls.filter((call) => call.name === 'DeleteSnapshotCommand').map((call) => call.input.SnapshotId);

    it('deletes the partial snapshot of a transport failure, then retries the upload once', async () => {
      const calls: Call[] = [];
      const runs: unknown[] = [];
      const adapter = sequencedAdapter([{ exitCode: 1, stdout: '', stderr: TRANSPORT }], calls, runs);
      await expect(adapter.buildCandidate(buildInput())).resolves.toEqual({ imageId: 'ami-0bbb' });
      expect(runs).toHaveLength(2);
      // The partial goes first; the staging snapshot of the successful retry is removed after the copy.
      expect(deletedSnapshots(calls)).toEqual(['snap-0dead1', 'snap-0abc123']);
    });

    it('gives up after the second transport failure and deletes both partial snapshots', async () => {
      const calls: Call[] = [];
      const runs: unknown[] = [];
      const second = { exitCode: 1, stdout: '', stderr: TRANSPORT.replaceAll('snap-0dead1', 'snap-0dead2') };
      const adapter = sequencedAdapter([{ exitCode: 1, stdout: '', stderr: TRANSPORT }, second], calls, runs);
      await expect(adapter.buildCandidate(buildInput())).rejects.toThrow(/coldsnap upload \(attempt 2\/2\) exited 1: .*dispatch failure/);
      expect(runs).toHaveLength(2);
      expect(deletedSnapshots(calls)).toEqual(['snap-0dead1', 'snap-0dead2']);
      expect(calls.some((call) => call.name === 'RegisterImageCommand')).toBe(false);
    });

    it('does not retry a non-transport failure, but still deletes its partial snapshot', async () => {
      const calls: Call[] = [];
      const runs: unknown[] = [];
      const denied = { exitCode: 1, stdout: '', stderr: "Failed to start snapshot 'snap-0dead3': AccessDeniedException" };
      const adapter = sequencedAdapter([denied], calls, runs);
      await expect(adapter.buildCandidate(buildInput())).rejects.toThrow(/coldsnap upload \(attempt 1\/2\) exited 1: .*AccessDenied/);
      expect(runs).toHaveLength(1);
      expect(deletedSnapshots(calls)).toEqual(['snap-0dead3']);
    });

    it('stops coldsnap at the first block that has used its last retry, not at an intermediate retry', async () => {
      const calls: Call[] = [];
      const runs: unknown[] = [];
      await sequencedAdapter([], calls, runs).buildCandidate(buildInput());
      const pattern = (runs[0] as { abortOnStderr?: RegExp }).abortOnStderr;
      expect(pattern).toBeInstanceOf(RegExp);
      expect(pattern!.test(TRANSPORT)).toBe(true);
      // The chain14 try2 lines: 5/5 lost the upload; 2/5 was coldsnap recovering on its own.
      expect(pattern!.test("[WARN ] block 11633: attempt 5/5 failed after 12.0s: Failed to put block 11633 for snapshot 'snap-017b90e05278d7710': dispatch failure")).toBe(true);
      expect(pattern!.test("[WARN ] block 11776: attempt 2/5 failed after 12.0s: Failed to put block 11776 for snapshot 'snap-017b90e05278d7710': dispatch failure")).toBe(false);
    });

    it('names a partial snapshot that would not delete, and does not retry over it', async () => {
      const calls: Call[] = [];
      const runs: unknown[] = [];
      const adapter = sequencedAdapter([{ exitCode: 1, stdout: '', stderr: TRANSPORT }], calls, runs, () => {
        throw Object.assign(new Error('throttled'), { name: 'RequestLimitExceeded' });
      });
      await expect(adapter.buildCandidate(buildInput())).rejects.toThrow(/partial snapshot NOT deleted: snap-0dead1/);
      expect(runs).toHaveLength(1);
    });
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

describe('SdkAwsAmiReleaseAdapter.launchCleanAccountCanary failure output', () => {
  it('keeps the trailing bootstrap diagnostics of a long canary error payload (P-012 chain5)', async () => {
    // The canary serializes { error, details } with bootstrapDiagnostics LAST; the old 2,000-char
    // tail dropped the journal that explained why the service would not start.
    const journal = 'journal: Error: EACCES: permission denied, open /var/lib/papercusp/state.db';
    const payload = JSON.stringify({
      tool: 'papercusp-aws-ami-clean-account-canary',
      error: 'SSM bootstrap ended Failed',
      details: { stdoutTail: 'x'.repeat(2_000), runId: 'r1', bootstrapDiagnostics: `${'status-line\n'.repeat(400)}${journal}` },
    });
    expect(payload.length).toBeGreaterThan(5_000);
    const adapter = new SdkAwsAmiReleaseAdapter({
      ec2: () => fakeSender({}, []),
      ssm: () => fakeSender({}, []),
      childCredentials: async () => ({}),
      commands: { run: async () => ({ exitCode: 1, stdout: '', stderr: payload }) },
    });
    const error = await adapter
      .launchCleanAccountCanary({ region: 'us-east-1' } as Parameters<SdkAwsAmiReleaseAdapter['launchCleanAccountCanary']>[0])
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('clean-account canary exited 1');
    expect((error as Error).message).toContain(journal);
    expect(AWS_AMI_COMMAND_ERROR_DETAIL_CHARS).toBeGreaterThanOrEqual(24_000);
  });

  it('budgets the child runner for every canary phase, fixture upload, and teardown', async () => {
    const runs: unknown[] = [];
    const adapter = new SdkAwsAmiReleaseAdapter({
      ec2: () => fakeSender({}, []),
      ssm: () => fakeSender({}, []),
      childCredentials: async () => ({}),
      commands: {
        run: async (command) => {
          runs.push(command);
          return { exitCode: 0, stdout: '{}', stderr: '' };
        },
      },
    });
    const bootstrapScript = 'x'.repeat(24_001);
    const uploadCount = Math.ceil((Math.ceil(Buffer.byteLength(bootstrapScript, 'utf8') / 3) * 4) / SSM_CHUNK_CHARS);
    expect(uploadCount).toBe(2);

    await adapter.launchCleanAccountCanary({
      region: 'us-east-1',
      fixture: { bootstrapScript },
    } as Parameters<SdkAwsAmiReleaseAdapter['launchCleanAccountCanary']>[0]);

    const expectedTimeoutMs =
      CANARY_BUDGETS.runningMs +
      CANARY_BUDGETS.ssmOnlineMs +
      CANARY_BUDGETS.bootstrapMs +
      CANARY_BUDGETS.terminateMs +
      (uploadCount + 2) * CANARY_BUDGETS.shortCommandMs +
      (uploadCount + 6) * 3 * CANARY_BUDGETS.pollMs +
      5 * 60_000;
    expect(runs[0]).toMatchObject({
      command: 'papercusp-aws-ami-clean-account-canary',
      timeoutMs: expectedTimeoutMs,
    });
    expect(expectedTimeoutMs).toBeGreaterThan(45 * 60_000);
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

  it('refuses an operator guest-tool override that contradicts the request SBOM versions (WI-10006386)', async () => {
    await expect(
      executeConfiguredAwsAmiRelease(
        { publisherAccountId: '111111111111', guestToolVersions: { curl: '8.12.1-6.el10' } } as unknown as AwsAmiReleaseRequest,
        connection,
        { guestToolVersions: { curl: '8.0-1' } },
      ),
    ).rejects.toThrow(/disagrees with the bake SBOM: curl \(override 8\.0-1; SBOM 8\.12\.1-6\.el10\)/);
  });

  it('resolves guest-tool versions: SBOM-derived wins, an override may restate but not contradict or add (WI-10006386)', () => {
    const derived = { curl: '8.12.1-6.el10', nftables: '1:1.1.5-6.el10' };
    expect(resolveAwsAmiGuestToolVersions(derived, undefined)).toEqual(derived);
    // A request composed without derived versions still uses the operator file.
    expect(resolveAwsAmiGuestToolVersions(undefined, { curl: '1' })).toEqual({ curl: '1' });
    expect(resolveAwsAmiGuestToolVersions(undefined, undefined)).toBeUndefined();
    expect(resolveAwsAmiGuestToolVersions(derived, { curl: ' 8.12.1-6.el10 ' })).toEqual(derived);
    expect(() => resolveAwsAmiGuestToolVersions(derived, { nftables: '1.1.5-6.el10' })).toThrow(
      /nftables \(override 1\.1\.5-6\.el10; SBOM 1:1\.1\.5-6\.el10\)/,
    );
    expect(() => resolveAwsAmiGuestToolVersions(derived, { jq: '1.7' })).toThrow(/jq \(override 1\.7; the SBOM records no version\)/);
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
