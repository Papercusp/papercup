/**
 * Production composition for the AWS workspace-host AMI release — the AWS counterpart of
 * `gcp-image-family-production.ts` (plan aws-byoc-gcp-parity-2026-10-01, P-006).
 *
 * `aws-ami-release.ts` owns the release CONTRACT (gate, scan policy, sharing and encryption
 * invariants, clean-account proof, version manifest). This module supplies the concrete
 * adapter that contract drives:
 *
 *   - build:    the bootc bake renders one AWS `ami` disk per release; the adapter verifies its
 *               digest, uploads it as an EBS snapshot with `coldsnap` (EBS direct APIs — no S3
 *               bucket and no `vmimport` service role), registers it, then copies it inside the
 *               source region so the candidate is encrypted with the source target's KMS key.
 *               The unencrypted staging image and snapshot are removed before returning.
 *   - scan / clean-account canary: external executables with a JSON stdin/stdout contract,
 *               exactly like the GCP scan and clean-room runners.
 *   - copy / share / inspect / deprecate: EC2 SDK v3.
 *   - manifest + pins: SSM Parameter Store in the publisher account. The customer catalog does
 *               NOT read these (it resolves shared AMIs by owner + name + Description); they are
 *               the publisher's own rollback record.
 *
 * Credentials are always reconstructed from the persisted connection's credential source via
 * the same `planAwsSdkCredentialProvider` → `createAwsSdkCredentialProvider` path the
 * workspace-host SDK client uses; the CLI never accepts a raw key.
 *
 * There is no Packer `amazon-ebs` source in `infra/images/workspace-host.pkr.hcl`, so AWS AMIs
 * are produced from the bootc bake only; a Packer-kind build is refused before any spend.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';

import {
  CopyImageCommand,
  DeleteSnapshotCommand,
  DeregisterImageCommand,
  DescribeImageAttributeCommand,
  DescribeImagesCommand,
  DescribeSnapshotAttributeCommand,
  DescribeSnapshotsCommand,
  EC2Client,
  EnableImageDeprecationCommand,
  ModifyImageAttributeCommand,
  ModifySnapshotAttributeCommand,
  RegisterImageCommand,
  type CopyImageResult,
  type DescribeImagesResult,
  type ImageAttribute,
  type DescribeSnapshotAttributeResult,
  type DescribeSnapshotsResult,
  type RegisterImageResult,
} from '@aws-sdk/client-ec2';
import { GetParameterCommand, PutParameterCommand, SSMClient, type GetParameterResult } from '@aws-sdk/client-ssm';
import { GetCallerIdentityCommand, STSClient, type GetCallerIdentityResponse } from '@aws-sdk/client-sts';
import { WORKSPACE_HOST_BOOTC_BUILDER_KIND, type WorkspaceHostProviderConnection } from '@papercusp/deployment-driver';
import { canonicalize } from '@papercusp/publish-auth/jcs';

import {
  AwsAmiReleaseError,
  buildAwsAmiVersionManifest,
  executeAwsAmiRelease,
  type AwsAmiCleanAccountLaunchProof,
  type AwsAmiInspection,
  type AwsAmiReleaseAdapter,
  type AwsAmiReleaseRequest,
  type AwsAmiReleaseResult,
  type AwsAmiScanEvidence,
  type AwsAmiVersionManifest,
} from './aws-ami-release';
import { planAwsSdkCredentialProvider, type AwsWorkspaceHostCredentialSource } from './aws-connection';
import {
  createAwsSdkCredentialProvider,
  type AwsSdkCredentialIdentityProvider,
  type AwsSdkCredentialResolvers,
} from './aws-sdk-client';
import type { WorkspaceHostBootcCloudArtifact } from './bootc-bake-manifest';
// The argv/shell:false process boundary is cloud-neutral; reuse it rather than fork a second one.
import {
  NodeGcpImageFamilyCommandRunner,
  type GcpImageFamilyCommandResult as AwsAmiCommandResult,
  type GcpImageFamilyCommandRunner as AwsAmiCommandRunner,
} from './gcp-image-family-adapter';

export type { AwsAmiCommandRunner };

export const AWS_AMI_RELEASE_EXECUTABLES = {
  coldsnap: 'coldsnap',
  scan: 'papercusp-aws-ami-scan',
  canary: 'papercusp-aws-ami-clean-account-canary',
} as const;

export const AWS_AMI_DEFAULT_PARAMETER_PREFIX = '/papercusp/workspace-host/ami';

const GUEST_TOOL_TAG_PREFIX = 'papercusp:guest-tool:';
const SNAPSHOT_ID = /^snap-[a-f0-9]+$/;
const AMI_ID = /^ami-[a-f0-9]+$/;
/** coldsnap uploads a multi-GiB disk; an hour bounds a stalled upload without cutting a slow one. */
const UPLOAD_TIMEOUT_MS = 60 * 60 * 1000;
const RUNNER_TIMEOUT_MS = 45 * 60 * 1000;
const IMAGE_WAIT_TIMEOUT_MS = 60 * 60 * 1000;
const IMAGE_POLL_MS = 15_000;
/** SSM Standard parameters hold 4 KB; Advanced holds 8 KB. */
const SSM_STANDARD_LIMIT = 4096;
const SSM_ADVANCED_LIMIT = 8192;

/** The one SDK capability the adapter needs: send a v3 command. Tests inject a fake. */
export interface AwsAmiSdkSender {
  send(command: unknown): Promise<unknown>;
}

export interface AwsAmiReleaseCompositionOptions {
  repositoryRoot?: string;
  /** Operator-pinned versions of the guest tools baked into the image (`--guest-tool-versions-file`). */
  guestToolVersions?: Readonly<Record<string, string>>;
  coldsnapExecutable?: string;
  scanExecutable?: string;
  canaryExecutable?: string;
  parameterPrefix?: string;
  resolvers?: AwsSdkCredentialResolvers;
}

export interface AwsAmiReleaseAdapterDeps {
  ec2: (region: string) => AwsAmiSdkSender;
  ssm: (region: string) => AwsAmiSdkSender;
  /** Resolved credentials for child processes (coldsnap / scanner / canary). */
  childCredentials: () => Promise<Readonly<Record<string, string>>>;
  commands?: AwsAmiCommandRunner;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function fail(message: string): never {
  throw new AwsAmiReleaseError(message);
}

function tagList(tags: Readonly<Record<string, string>>) {
  return Object.entries(tags)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([Key, Value]) => ({ Key, Value }));
}

function tagMap(tags: readonly { Key?: string; Value?: string }[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of tags ?? []) if (tag.Key) out[tag.Key] = tag.Value ?? '';
  return out;
}

function clientToken(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex').slice(0, 64);
}

async function sha256File(path: string): Promise<string> {
  return await new Promise<string>((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolveHash(hash.digest('hex')));
  });
}

/** Verify the bake-manifest AWS disk byte-for-byte before anything is uploaded or billed. */
export async function verifyBootcAmiArtifact(
  artifact: WorkspaceHostBootcCloudArtifact,
  repositoryRoot: string,
): Promise<string> {
  if (artifact.cloud !== 'aws' || artifact.type !== 'ami') {
    fail('bootcArtifact must be the AWS/ami row from the canonical bake manifest');
  }
  const path = isAbsolute(artifact.artifact) ? resolve(artifact.artifact) : resolve(repositoryRoot, artifact.artifact);
  if (!isAbsolute(artifact.artifact) && relative(repositoryRoot, path).startsWith('..')) {
    fail('bootcArtifact.artifact escapes repositoryRoot');
  }
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(path);
  } catch {
    fail(`bootc AMI disk does not exist: ${path}`);
  }
  if (!metadata.isFile() || metadata.size !== artifact.sizeBytes) {
    fail(`bootc AMI disk size does not match the bake manifest: ${path}`);
  }
  if ((await sha256File(path)) !== artifact.sha256) {
    fail(`bootc AMI disk digest does not match the bake manifest: ${path}`);
  }
  return path;
}

function assertSuccess(result: AwsAmiCommandResult, operation: string): string {
  if (result.exitCode !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(-2000);
    fail(`${operation} exited ${result.exitCode}${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function parseJsonStdout(stdout: string, operation: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    fail(`${operation} did not print a JSON document on stdout`);
  }
}

/** Concrete AWS adapter of the shared image-release contract. */
export class SdkAwsAmiReleaseAdapter implements AwsAmiReleaseAdapter {
  private readonly commands: AwsAmiCommandRunner;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly guestToolVersions: Readonly<Record<string, string>>;
  private readonly repositoryRoot: string;
  private readonly parameterPrefix: string;
  private readonly executables: { coldsnap: string; scan: string; canary: string };

  constructor(
    private readonly deps: AwsAmiReleaseAdapterDeps,
    options: AwsAmiReleaseCompositionOptions = {},
  ) {
    this.commands = deps.commands ?? new NodeGcpImageFamilyCommandRunner();
    this.sleep = deps.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.now = deps.now ?? (() => Date.now());
    this.guestToolVersions = options.guestToolVersions ?? {};
    this.repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
    this.parameterPrefix = (options.parameterPrefix ?? AWS_AMI_DEFAULT_PARAMETER_PREFIX).replace(/\/+$/, '');
    this.executables = {
      coldsnap: options.coldsnapExecutable ?? AWS_AMI_RELEASE_EXECUTABLES.coldsnap,
      scan: options.scanExecutable ?? AWS_AMI_RELEASE_EXECUTABLES.scan,
      canary: options.canaryExecutable ?? AWS_AMI_RELEASE_EXECUTABLES.canary,
    };
  }

  /** Guest-tool versions are written as per-tool tags so `inspectImage` reads them back from the image. */
  private imageTags(tags: Readonly<Record<string, string>>): Record<string, string> {
    const out: Record<string, string> = { ...tags };
    for (const [name, version] of Object.entries(this.guestToolVersions)) out[`${GUEST_TOOL_TAG_PREFIX}${name}`] = version;
    return out;
  }

  private async childEnv(region: string): Promise<Record<string, string>> {
    return { ...(await this.deps.childCredentials()), AWS_REGION: region, AWS_DEFAULT_REGION: region };
  }

  private async runJson(executable: string, input: unknown, region: string, operation: string): Promise<unknown> {
    const result = await this.commands.run({
      command: executable,
      args: [],
      stdin: JSON.stringify(input),
      env: await this.childEnv(region),
      timeoutMs: RUNNER_TIMEOUT_MS,
    });
    return parseJsonStdout(assertSuccess(result, operation), operation);
  }

  private async waitForImageAvailable(region: string, imageId: string): Promise<void> {
    const deadline = this.now() + IMAGE_WAIT_TIMEOUT_MS;
    for (;;) {
      const result = (await this.deps.ec2(region).send(new DescribeImagesCommand({ ImageIds: [imageId] }))) as DescribeImagesResult;
      const state = result.Images?.[0]?.State;
      if (state === 'available') return;
      if (state === 'failed' || state === 'error' || state === 'invalid' || state === 'deregistered') {
        fail(`AMI ${region}/${imageId} entered state '${state}': ${result.Images?.[0]?.StateReason?.Message ?? 'no reason'}`);
      }
      if (this.now() >= deadline) fail(`AMI ${region}/${imageId} did not become available within the wait bound`);
      await this.sleep(IMAGE_POLL_MS);
    }
  }

  async buildCandidate(input: Parameters<AwsAmiReleaseAdapter['buildCandidate']>[0]): Promise<{ imageId: string }> {
    if (input.builderKind !== WORKSPACE_HOST_BOOTC_BUILDER_KIND || !input.bootcArtifact) {
      fail('AWS AMIs are produced from the bootc bake; workspace-host.pkr.hcl has no amazon-ebs source');
    }
    const missing = input.requiredGuestTools.filter((tool) => !this.guestToolVersions[tool]?.trim());
    if (missing.length > 0) fail(`guest tool versions are not pinned for: ${missing.join(', ')}`);
    const diskPath = await verifyBootcAmiArtifact(input.bootcArtifact, this.repositoryRoot);

    const upload = await this.commands.run({
      command: this.executables.coldsnap,
      args: ['upload', '--wait', diskPath],
      env: await this.childEnv(input.sourceRegion),
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    const snapshotId = assertSuccess(upload, 'coldsnap upload').trim().split(/\s+/).find((token) => SNAPSHOT_ID.test(token));
    if (!snapshotId) fail('coldsnap upload did not report a snapshot id');

    const ec2 = this.deps.ec2(input.sourceRegion);
    const stagingTags = { ...this.imageTags(input.tags), 'papercusp:release-stage': 'unencrypted-staging' };
    const registered = (await ec2.send(
      new RegisterImageCommand({
        Name: `${input.imageName}-staging`,
        Description: input.description,
        Architecture: input.architecture as never,
        RootDeviceName: '/dev/xvda',
        BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { SnapshotId: snapshotId, VolumeType: 'gp3', DeleteOnTermination: true } }],
        VirtualizationType: 'hvm',
        EnaSupport: true,
        BootMode: 'uefi-preferred',
        ImdsSupport: 'v2.0',
        TagSpecifications: [{ ResourceType: 'image', Tags: tagList(stagingTags) }],
      }),
    )) as RegisterImageResult;
    const stagingImageId = registered.ImageId;
    if (!stagingImageId || !AMI_ID.test(stagingImageId)) fail('RegisterImage did not return an AMI id');
    await this.waitForImageAvailable(input.sourceRegion, stagingImageId);

    const copied = (await ec2.send(
      new CopyImageCommand({
        SourceRegion: input.sourceRegion,
        SourceImageId: stagingImageId,
        Name: input.imageName,
        Description: input.description,
        Encrypted: true,
        KmsKeyId: input.kmsKeyArn,
        ClientToken: clientToken('build', stagingImageId, input.imageName, input.kmsKeyArn),
        TagSpecifications: [
          { ResourceType: 'image', Tags: tagList(this.imageTags(input.tags)) },
          { ResourceType: 'snapshot', Tags: tagList(input.tags) },
        ],
      }),
    )) as CopyImageResult;
    const imageId = copied.ImageId;
    if (!imageId || !AMI_ID.test(imageId)) fail('encrypting CopyImage did not return an AMI id');
    await this.waitForImageAvailable(input.sourceRegion, imageId);

    // The staging image is unencrypted and must not outlive the build: no residue is the contract.
    await ec2.send(new DeregisterImageCommand({ ImageId: stagingImageId }));
    await ec2.send(new DeleteSnapshotCommand({ SnapshotId: snapshotId }));
    return { imageId };
  }

  async scanImage(input: Parameters<AwsAmiReleaseAdapter['scanImage']>[0]): Promise<AwsAmiScanEvidence> {
    // The release contract validates every field; this layer only enforces the JSON boundary.
    return (await this.runJson(this.executables.scan, input, input.region, 'AMI scan')) as AwsAmiScanEvidence;
  }

  async copyImage(input: Parameters<AwsAmiReleaseAdapter['copyImage']>[0]): Promise<{ imageId: string }> {
    const copied = (await this.deps.ec2(input.targetRegion).send(
      new CopyImageCommand({
        SourceRegion: input.sourceRegion,
        SourceImageId: input.sourceImageId,
        Name: input.imageName,
        Description: input.description,
        Encrypted: true,
        KmsKeyId: input.kmsKeyArn,
        ClientToken: clientToken('copy', input.sourceImageId, input.targetRegion, input.kmsKeyArn),
        TagSpecifications: [
          { ResourceType: 'image', Tags: tagList(this.imageTags(input.tags)) },
          { ResourceType: 'snapshot', Tags: tagList(input.tags) },
        ],
      }),
    )) as CopyImageResult;
    const imageId = copied.ImageId;
    if (!imageId || !AMI_ID.test(imageId)) fail(`CopyImage to ${input.targetRegion} did not return an AMI id`);
    await this.waitForImageAvailable(input.targetRegion, imageId);
    return { imageId };
  }

  private async snapshotIdsOf(region: string, imageId: string): Promise<string[]> {
    const result = (await this.deps.ec2(region).send(new DescribeImagesCommand({ ImageIds: [imageId] }))) as DescribeImagesResult;
    const image = result.Images?.[0];
    if (!image) fail(`AMI ${region}/${imageId} does not exist`);
    return (image.BlockDeviceMappings ?? [])
      .map((mapping) => mapping.Ebs?.SnapshotId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .sort();
  }

  async publishPermissions(input: Parameters<AwsAmiReleaseAdapter['publishPermissions']>[0]): Promise<void> {
    const ec2 = this.deps.ec2(input.region);
    await ec2.send(
      new ModifyImageAttributeCommand({
        ImageId: input.imageId,
        LaunchPermission: { Add: input.launchAccountIds.map((UserId) => ({ UserId })) },
      }),
    );
    for (const snapshotId of await this.snapshotIdsOf(input.region, input.imageId)) {
      await ec2.send(
        new ModifySnapshotAttributeCommand({
          SnapshotId: snapshotId,
          Attribute: 'createVolumePermission',
          OperationType: 'add',
          UserIds: [...input.snapshotCreateVolumeAccountIds],
        }),
      );
    }
  }

  async inspectImage(region: string, imageId: string): Promise<AwsAmiInspection> {
    const ec2 = this.deps.ec2(region);
    const described = (await ec2.send(new DescribeImagesCommand({ ImageIds: [imageId] }))) as DescribeImagesResult;
    const image = described.Images?.[0];
    if (!image) fail(`AMI ${region}/${imageId} does not exist`);
    const tags = tagMap(image.Tags);
    const launch = (await ec2.send(
      new DescribeImageAttributeCommand({ ImageId: imageId, Attribute: 'launchPermission' }),
    )) as ImageAttribute;
    const snapshotIds = (image.BlockDeviceMappings ?? [])
      .map((mapping) => mapping.Ebs?.SnapshotId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .sort();
    const snapshots = [];
    for (const snapshotId of snapshotIds) {
      const detail = (await ec2.send(new DescribeSnapshotsCommand({ SnapshotIds: [snapshotId] }))) as DescribeSnapshotsResult;
      const permissions = (await ec2.send(
        new DescribeSnapshotAttributeCommand({ SnapshotId: snapshotId, Attribute: 'createVolumePermission' }),
      )) as DescribeSnapshotAttributeResult;
      const snapshot = detail.Snapshots?.[0];
      snapshots.push({
        snapshotId,
        encrypted: snapshot?.Encrypted === true,
        kmsKeyArn: snapshot?.KmsKeyId ?? '',
        createVolumeAccountIds: (permissions.CreateVolumePermissions ?? [])
          .map((entry) => entry.UserId)
          .filter((id): id is string => Boolean(id))
          .sort(),
      });
    }
    const state = image.State;
    return {
      imageId,
      region,
      ownerAccountId: image.OwnerId ?? '',
      state: state === 'available' || state === 'pending' || state === 'deregistered' ? state : 'failed',
      architecture: image.Architecture ?? '',
      tags,
      guestTools: Object.entries(tags)
        .filter(([key]) => key.startsWith(GUEST_TOOL_TAG_PREFIX))
        .map(([key, version]) => ({ name: key.slice(GUEST_TOOL_TAG_PREFIX.length), version }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      launchAccountIds: (launch.LaunchPermissions ?? [])
        .map((entry) => entry.UserId)
        .filter((id): id is string => Boolean(id))
        .sort(),
      snapshots,
    };
  }

  async launchCleanAccountCanary(
    input: Parameters<AwsAmiReleaseAdapter['launchCleanAccountCanary']>[0],
  ): Promise<AwsAmiCleanAccountLaunchProof> {
    return (await this.runJson(this.executables.canary, input, input.region, 'clean-account canary')) as AwsAmiCleanAccountLaunchProof;
  }

  private manifestParameterName(releaseVersion: string): string {
    return `${this.parameterPrefix}/manifests/${releaseVersion}`;
  }

  async publishVersionManifest(manifest: AwsAmiVersionManifest): Promise<{ uri: string; manifestIdentity: string }> {
    const ssm = this.deps.ssm(manifest.sourceRegion);
    const name = this.manifestParameterName(manifest.releaseVersion);
    const value = canonicalize(manifest);
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > SSM_ADVANCED_LIMIT) fail(`version manifest is ${bytes} bytes; SSM parameters hold at most ${SSM_ADVANCED_LIMIT}`);
    try {
      await ssm.send(
        new PutParameterCommand({
          Name: name,
          Value: value,
          Type: 'String',
          Tier: bytes > SSM_STANDARD_LIMIT ? 'Advanced' : 'Standard',
          // Immutable: a release version's manifest is written once.
          Overwrite: false,
        }),
      );
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'ParameterAlreadyExists') throw error;
    }
    // Read back and re-derive the identity: the receipt must prove what is STORED, not what was sent.
    const stored = (await ssm.send(new GetParameterCommand({ Name: name }))) as GetParameterResult;
    let parsed: AwsAmiVersionManifest;
    try {
      parsed = JSON.parse(stored.Parameter?.Value ?? '') as AwsAmiVersionManifest;
    } catch {
      fail(`stored version manifest ${name} is not JSON`);
    }
    const { manifestIdentity: _claimed, schemaVersion: _schema, contractVersion: _contract, ...payload } = parsed;
    const recomputed = buildAwsAmiVersionManifest(payload);
    if (recomputed.manifestIdentity !== manifest.manifestIdentity) {
      fail(`stored version manifest ${name} does not match this release (a different manifest already holds the version)`);
    }
    return { uri: `ssm://${manifest.sourceRegion}${name}`, manifestIdentity: recomputed.manifestIdentity };
  }

  async activatePins(input: Parameters<AwsAmiReleaseAdapter['activatePins']>[0]): Promise<void> {
    const put = async (region: string, name: string, value: string, dataType?: 'aws:ec2:image') =>
      await this.deps.ssm(region).send(
        new PutParameterCommand({ Name: name, Value: value, Type: 'String', Overwrite: true, ...(dataType ? { DataType: dataType } : {}) }),
      );
    for (const pin of input.rollbackPins) {
      await put(pin.region, `${this.parameterPrefix}/rollback`, pin.imageId, 'aws:ec2:image');
    }
    for (const pin of input.pins) {
      await put(pin.region, `${this.parameterPrefix}/active`, pin.imageId, 'aws:ec2:image');
      await put(pin.region, `${this.parameterPrefix}/active-manifest`, `${input.manifestIdentity} ${input.manifestUri}`);
    }
  }

  async enableImageDeprecation(input: Parameters<AwsAmiReleaseAdapter['enableImageDeprecation']>[0]): Promise<void> {
    await this.deps.ec2(input.region).send(
      new EnableImageDeprecationCommand({ ImageId: input.imageId, DeprecateAt: new Date(input.deprecateAt) }),
    );
  }
}

function connectionCredentialProvider(
  connection: WorkspaceHostProviderConnection,
  region: string,
  resolvers: AwsSdkCredentialResolvers = {},
): AwsSdkCredentialIdentityProvider {
  if (connection.target !== 'aws') fail(`AWS AMI release cannot use a '${connection.target}' connection`);
  const source = connection.provider?.credentialSource;
  if (!source || typeof source !== 'object') fail('AWS AMI release connection has no credential source');
  return createAwsSdkCredentialProvider(
    planAwsSdkCredentialProvider(source as unknown as AwsWorkspaceHostCredentialSource),
    region,
    resolvers,
  );
}

function connectionRegion(connection: WorkspaceHostProviderConnection): string {
  const region = connection.provider?.region;
  if (typeof region !== 'string' || !region.trim()) fail('AWS AMI release connection has no region');
  return region.trim();
}

/** Compose the SDK-backed adapter for one persisted publisher connection. */
export function composeAwsAmiReleaseAdapter(
  connection: WorkspaceHostProviderConnection,
  options: AwsAmiReleaseCompositionOptions = {},
  overrides: Partial<AwsAmiReleaseAdapterDeps> = {},
): SdkAwsAmiReleaseAdapter {
  const homeRegion = connectionRegion(connection);
  const credentials = connectionCredentialProvider(connection, homeRegion, options.resolvers);
  const ec2Clients = new Map<string, EC2Client>();
  const ssmClients = new Map<string, SSMClient>();
  const sender = <C extends { send(command: never): Promise<unknown> }>(client: C): AwsAmiSdkSender => ({
    send: (command) => client.send(command as never),
  });
  return new SdkAwsAmiReleaseAdapter(
    {
      ec2: (region) => {
        if (!ec2Clients.has(region)) ec2Clients.set(region, new EC2Client({ region, credentials }));
        return sender(ec2Clients.get(region)!);
      },
      ssm: (region) => {
        if (!ssmClients.has(region)) ssmClients.set(region, new SSMClient({ region, credentials }));
        return sender(ssmClients.get(region)!);
      },
      childCredentials: async () => {
        const resolved = await credentials();
        return {
          AWS_ACCESS_KEY_ID: resolved.accessKeyId,
          AWS_SECRET_ACCESS_KEY: resolved.secretAccessKey,
          ...(resolved.sessionToken ? { AWS_SESSION_TOKEN: resolved.sessionToken } : {}),
        };
      },
      ...overrides,
    },
    options,
  );
}

export interface AwsAmiCredentialProbe {
  ok: boolean;
  accountId: string;
  identityArn?: string;
  resolvedAccountId?: string;
  error?: string;
}

/** Read-only: prove the persisted connection resolves to the publisher account before any spend. */
export async function probeAwsAmiCredential(
  connection: WorkspaceHostProviderConnection,
  options: { resolvers?: AwsSdkCredentialResolvers; sts?: AwsAmiSdkSender } = {},
): Promise<AwsAmiCredentialProbe> {
  const accountId = connection.scope?.id ?? '';
  try {
    const region = connectionRegion(connection);
    const sts =
      options.sts ??
      (() => {
        const client = new STSClient({ region, credentials: connectionCredentialProvider(connection, region, options.resolvers) });
        return { send: (command: unknown) => client.send(command as never) };
      })();
    const identity = (await sts.send(new GetCallerIdentityCommand({}))) as GetCallerIdentityResponse;
    const resolvedAccountId = identity.Account ?? '';
    return {
      ok: Boolean(accountId) && resolvedAccountId === accountId,
      accountId,
      ...(identity.Arn ? { identityArn: identity.Arn } : {}),
      resolvedAccountId,
      ...(resolvedAccountId === accountId ? {} : { error: `credential resolves to account '${resolvedAccountId}', not '${accountId}'` }),
    };
  } catch (error) {
    return { ok: false, accountId, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface AwsAmiExecutableProbe {
  ok: boolean;
  executables: readonly { role: keyof typeof AWS_AMI_RELEASE_EXECUTABLES; executable: string; ok: boolean; path?: string }[];
}

async function resolveExecutable(executable: string, pathEnv: string): Promise<string | undefined> {
  const candidates = executable.includes('/') ? [executable] : pathEnv.split(delimiter).filter(Boolean).map((dir) => join(dir, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** Read-only: every external executable the release will invoke is present and executable. */
export async function probeAwsAmiExecutables(
  options: AwsAmiReleaseCompositionOptions = {},
  pathEnv: string = process.env.PATH ?? '',
): Promise<AwsAmiExecutableProbe> {
  const wanted = {
    coldsnap: options.coldsnapExecutable ?? AWS_AMI_RELEASE_EXECUTABLES.coldsnap,
    scan: options.scanExecutable ?? AWS_AMI_RELEASE_EXECUTABLES.scan,
    canary: options.canaryExecutable ?? AWS_AMI_RELEASE_EXECUTABLES.canary,
  };
  const executables = await Promise.all(
    (Object.keys(wanted) as (keyof typeof wanted)[]).map(async (role) => {
      const path = await resolveExecutable(wanted[role], pathEnv);
      return { role, executable: wanted[role], ok: Boolean(path), ...(path ? { path } : {}) };
    }),
  );
  return { ok: executables.every((entry) => entry.ok), executables };
}

/** Run the release contract through the connection-bound production adapter. */
export async function executeConfiguredAwsAmiRelease(
  request: AwsAmiReleaseRequest,
  connection: WorkspaceHostProviderConnection,
  options: AwsAmiReleaseCompositionOptions = {},
  overrides: Partial<AwsAmiReleaseAdapterDeps> = {},
): Promise<AwsAmiReleaseResult> {
  if (connection.scope?.id !== request.publisherAccountId) {
    fail(`publisherAccountId '${request.publisherAccountId}' is not the connection's account '${connection.scope?.id ?? ''}'`);
  }
  return await executeAwsAmiRelease(request, composeAwsAmiReleaseAdapter(connection, options, overrides));
}
