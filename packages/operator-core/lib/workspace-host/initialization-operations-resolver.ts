/**
 * Target -> concrete initialization host adapter (P-046 / WI-40474).
 *
 * `runWorkspaceHostInitialization` takes an injected `operations` seam so it stays testable and
 * provider-agnostic. This is the production resolver that decides which real adapter fills that
 * seam for a given host, and it is deliberately the ONLY place that mapping exists.
 *
 * Two properties matter here:
 *
 * 1. THE INSTANCE IDENTITY IS NOT DERIVED HERE. It comes from
 *    `resolveGcpWorkspaceHostInstanceIdentity`, the same exported function the GCP provider's own
 *    `readSettings` uses when it PROVISIONS the instance. Deriving the instance name here
 *    independently would be a silent bug: initialization would open an IAP tunnel to a name that
 *    was never created, failing only at runtime and only against real cloud. Sharing the
 *    derivation makes that class of divergence impossible rather than merely unlikely.
 *
 * 2. AN UNSUPPORTED TARGET REFUSES LOUDLY. AWS and Azure initialization adapters are separate
 *    plan items (P-030 / P-035) and do not exist yet. A transport kind never implies command,
 *    transfer, pairing or credential-delivery parity — the contract says so explicitly — so
 *    falling back to "some other adapter" would be actively wrong. Refusing names the gap.
 */
import { createHash, createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS,
  DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
  WORKSPACE_HOST_RUNTIME_ROOT,
  type WorkspaceHostDesiredSpec,
  type WorkspaceHostInitializationHostOperations,
} from '@papercusp/deployment-driver';
import { createGcpWorkspaceHostAcquireAuth } from '../cloud-workspaces/gcp-preflight';
import { createGcpWorkspaceHostApiClient } from './gcp-api-client';
import {
  GcpIapWorkspaceHostInitializationOperations,
  type GcpIapWorkspaceHostInitializationProfile,
} from './gcp-iap-initialization-operations';
import {
  GCP_WORKSPACE_HOST_TARGET,
  resolveGcpWorkspaceHostInstanceIdentity,
  type GcpInstanceGuestAttribute,
  type GcpWorkspaceHostApiClient,
} from './gcp-provider';
import { readWorkspaceHostDesiredSpec } from './observability-store';

/**
 * Controller-owned, host-independent settings. These are NOT per-host database columns: the
 * known-hosts file is a controller-managed trust store and the remote entrypoint is a fixed
 * binary shipped in the signed workspace-host release. Keeping them out of the host record is
 * what stops a per-host row from being able to redirect the controller at an arbitrary binary.
 */
export interface WorkspaceHostInitializationControllerProfile {
  sshUser: string;
  /** Absolute path to a controller-owned, pre-enrolled known_hosts file. */
  knownHostsFile: string;
  /** Absolute path to the fixed initializer binary in the signed release. */
  remoteEntrypoint: string;
  identityFile?: string;
  sshExecutable?: string;
  gcloudExecutable?: string;
}

export class WorkspaceHostInitializationHostKeyError extends Error {
  constructor(message: string) {
    super(`Workspace-host SSH trust refused: ${message}`);
    this.name = 'WorkspaceHostInitializationHostKeyError';
  }
}

export interface GcpIapHostKeyEnrollmentInput {
  identity: { projectId: string; zone: string; instanceName: string };
  knownHostsFile: string;
  attributes: readonly GcpInstanceGuestAttribute[];
}

const HOST_KEY_ALGORITHMS = ['ecdsa-sha2-nistp256', 'ssh-ed25519', 'ssh-rsa'] as const;
type HostKeyAlgorithm = (typeof HOST_KEY_ALGORITHMS)[number];
const HOST_KEY_BY_ATTRIBUTE = new Map<string, (typeof HOST_KEY_ALGORITHMS)[number]>([
  ['ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp256'],
  ['ssh-ed25519', 'ssh-ed25519'],
  ['ssh-rsa', 'ssh-rsa'],
]);

const hostKeyEnrollmentQueues = new Map<string, Promise<void>>();

function gcpIapHostKeyAlias(identity: GcpIapHostKeyEnrollmentInput['identity']): string {
  return `gcp-iap-${createHash('sha256')
    .update(`${identity.projectId}\0${identity.zone}\0${identity.instanceName}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function hostKeyFailure(message: string): never {
  throw new WorkspaceHostInitializationHostKeyError(message);
}

function readSshString(
  blob: Buffer,
  offset: number,
  label: string,
): { value: Buffer; nextOffset: number } {
  if (offset + 4 > blob.length) hostKeyFailure(`${label} is truncated`);
  const length = blob.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > blob.length) hostKeyFailure(`${label} is truncated`);
  return { value: blob.subarray(start, end), nextOffset: end };
}

function requireNoTrailingKeyData(blob: Buffer, offset: number): void {
  if (offset !== blob.length) hostKeyFailure('host key contains trailing encoded data');
}

function positiveMpint(value: Buffer, label: string): Buffer {
  if (value.length === 0 || (value[0]! & 0x80) !== 0) {
    return hostKeyFailure(`${label} is not a positive SSH mpint`);
  }
  if (value.length > 1 && value[0] === 0 && (value[1]! & 0x80) === 0) {
    return hostKeyFailure(`${label} is not canonically encoded`);
  }
  return value[0] === 0 ? value.subarray(1) : value;
}

function validatePublicKeyObject(makeKey: () => KeyObject): KeyObject {
  try {
    return makeKey();
  } catch {
    return hostKeyFailure('host key contains invalid cryptographic material');
  }
}

function validatePublicKeyBlob(algorithm: HostKeyAlgorithm, blob: Buffer): void {
  if (blob.length > 16 * 1024) hostKeyFailure('host key material is unreasonably large');
  const encodedAlgorithm = readSshString(blob, 0, 'host key algorithm');
  if (encodedAlgorithm.value.toString('utf8') !== algorithm) {
    hostKeyFailure('host key algorithm does not match its encoded key');
  }

  if (algorithm === 'ssh-ed25519') {
    const publicBytes = readSshString(blob, encodedAlgorithm.nextOffset, 'Ed25519 public key');
    if (publicBytes.value.length !== 32) hostKeyFailure('Ed25519 public key must be 32 bytes');
    requireNoTrailingKeyData(blob, publicBytes.nextOffset);
    validatePublicKeyObject(() =>
      createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: publicBytes.value.toString('base64url') },
        format: 'jwk',
      }),
    );
    return;
  }

  if (algorithm === 'ecdsa-sha2-nistp256') {
    const curve = readSshString(blob, encodedAlgorithm.nextOffset, 'ECDSA curve');
    const point = readSshString(blob, curve.nextOffset, 'ECDSA public point');
    if (curve.value.toString('utf8') !== 'nistp256') hostKeyFailure('ECDSA host key must use nistp256');
    if (point.value.length !== 65 || point.value[0] !== 0x04) {
      hostKeyFailure('ECDSA nistp256 public point is malformed');
    }
    requireNoTrailingKeyData(blob, point.nextOffset);
    validatePublicKeyObject(() =>
      createPublicKey({
        key: {
          kty: 'EC',
          crv: 'P-256',
          x: point.value.subarray(1, 33).toString('base64url'),
          y: point.value.subarray(33).toString('base64url'),
        },
        format: 'jwk',
      }),
    );
    return;
  }

  const exponent = readSshString(blob, encodedAlgorithm.nextOffset, 'RSA exponent');
  const modulus = readSshString(blob, exponent.nextOffset, 'RSA modulus');
  requireNoTrailingKeyData(blob, modulus.nextOffset);
  validatePublicKeyObject(() =>
    createPublicKey({
      key: {
        kty: 'RSA',
        e: positiveMpint(exponent.value, 'RSA exponent').toString('base64url'),
        n: positiveMpint(modulus.value, 'RSA modulus').toString('base64url'),
      },
      format: 'jwk',
    }),
  );
}

function parsePublicKeyLine(value: string): { algorithm: HostKeyAlgorithm; key: string } {
  const match = /^(ecdsa-sha2-nistp256|ssh-ed25519|ssh-rsa) ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/.exec(value);
  if (!match) throw new WorkspaceHostInitializationHostKeyError('host key material is malformed');
  const algorithm = match[1] as HostKeyAlgorithm;
  const key = match[2]!;
  const blob = Buffer.from(key, 'base64');
  const canonical = blob.toString('base64');
  if (blob.length < 4 || (key !== canonical && key !== canonical.replace(/=+$/, ''))) {
    throw new WorkspaceHostInitializationHostKeyError('host key material is malformed');
  }
  validatePublicKeyBlob(algorithm, blob);
  return { algorithm, key };
}

function guestHostKeys(attributes: readonly GcpInstanceGuestAttribute[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const attribute of attributes) {
    if (attribute.namespace !== 'hostkeys') {
      throw new WorkspaceHostInitializationHostKeyError(`unexpected guest-attribute namespace '${attribute.namespace}'`);
    }
    const expected = HOST_KEY_BY_ATTRIBUTE.get(attribute.key);
    if (!expected) throw new WorkspaceHostInitializationHostKeyError(`unsupported host-key attribute '${attribute.key}'`);
    const parsed = parsePublicKeyLine(attribute.value);
    if (parsed.algorithm !== expected) {
      throw new WorkspaceHostInitializationHostKeyError(
        `host-key attribute '${attribute.key}' contains '${parsed.algorithm}'`,
      );
    }
    if (keys.has(parsed.algorithm)) {
      throw new WorkspaceHostInitializationHostKeyError(`duplicate '${parsed.algorithm}' host-key attribute`);
    }
    keys.set(parsed.algorithm, parsed.key);
  }
  // Images may intentionally configure a subset of the guest agent's supported host-key types;
  // an empty namespace is the missing-material failure, while any non-empty supported subset is
  // sufficient for OpenSSH negotiation.
  if (keys.size === 0) throw new WorkspaceHostInitializationHostKeyError('hostkeys/ returned no usable host keys');
  return keys;
}

async function enrollGcpIapHostKeysUnlocked(input: GcpIapHostKeyEnrollmentInput): Promise<void> {
  const alias = gcpIapHostKeyAlias(input.identity);
  const received = guestHostKeys(input.attributes);
  const directory = dirname(input.knownHostsFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  let current = '';
  try {
    const metadata = await lstat(input.knownHostsFile);
    if (!metadata.isFile()) {
      throw new WorkspaceHostInitializationHostKeyError('known_hosts path is not a regular file');
    }
    current = await readFile(input.knownHostsFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const kept: string[] = [];
  const trusted = new Map<string, string>();
  for (const line of current.replace(/\n$/, '').split('\n')) {
    if (!line && current === '') continue;
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#')) {
      kept.push(line);
      continue;
    }
    const fields = trimmed.split(/\s+/);
    const marked = fields[0]?.startsWith('@') === true;
    const hostField = fields[marked ? 1 : 0] ?? '';
    if (hostField === alias) {
      if (marked) {
        throw new WorkspaceHostInitializationHostKeyError('known_hosts contains a marked controller-alias entry');
      }
      const parsed = parsePublicKeyLine(trimmed.slice(hostField.length).trimStart());
      if (trusted.has(parsed.algorithm)) {
        throw new WorkspaceHostInitializationHostKeyError(`known_hosts contains duplicate '${parsed.algorithm}' keys`);
      }
      trusted.set(parsed.algorithm, parsed.key);
      continue;
    }
    if (hostField.split(',').includes(alias)) {
      throw new WorkspaceHostInitializationHostKeyError('known_hosts embeds the controller alias in a multi-host entry');
    }
    kept.push(line);
  }
  for (const [algorithm, key] of trusted) {
    if (received.get(algorithm) !== key) {
      throw new WorkspaceHostInitializationHostKeyError(`'${algorithm}' host key changed or disappeared`);
    }
  }

  const enrolled = HOST_KEY_ALGORITHMS.flatMap((algorithm) => {
    const key = received.get(algorithm);
    return key ? [`${alias} ${algorithm} ${key}`] : [];
  });
  const next = [...kept, ...enrolled].join('\n') + '\n';
  if (next === current) {
    await chmod(input.knownHostsFile, 0o600);
    return;
  }

  const temporary = `${input.knownHostsFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, next, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, input.knownHostsFile);
    await chmod(input.knownHostsFile, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * The packaged controller is one systemd service process, but routes within that process may
 * resolve different hosts concurrently. Serialize by normalized trust-file path so two atomic
 * renames cannot each preserve a stale snapshot and lose the other host's alias.
 */
export function enrollGcpIapHostKeys(input: GcpIapHostKeyEnrollmentInput): Promise<void> {
  if (!isAbsolute(input.knownHostsFile)) {
    return Promise.reject(new WorkspaceHostInitializationHostKeyError('known_hosts path must be absolute'));
  }
  const knownHostsFile = resolve(input.knownHostsFile);
  const prior = hostKeyEnrollmentQueues.get(knownHostsFile) ?? Promise.resolve();
  const run = prior
    .catch(() => undefined)
    .then(() => enrollGcpIapHostKeysUnlocked({ ...input, knownHostsFile }));
  hostKeyEnrollmentQueues.set(knownHostsFile, run);
  return run.finally(() => {
    if (hostKeyEnrollmentQueues.get(knownHostsFile) === run) hostKeyEnrollmentQueues.delete(knownHostsFile);
  });
}

/** Raised when no initialization adapter exists for a host's provider target. */
export class UnsupportedWorkspaceHostInitializationTargetError extends Error {
  readonly target: string;

  constructor(target: string) {
    super(
      `No workspace-host initialization adapter for target '${target}'. ` +
        `Only '${GCP_WORKSPACE_HOST_TARGET}' is implemented; AWS and Azure adapters are separate plan items.`,
    );
    this.name = 'UnsupportedWorkspaceHostInitializationTargetError';
    this.target = target;
  }
}

/**
 * Build the concrete host adapter for a desired spec.
 *
 * Throws `UnsupportedWorkspaceHostInitializationTargetError` for a target with no adapter, and
 * propagates the provider's own validation errors (bad zone/region pairing, scope mismatch,
 * secret material in the provider record) unchanged — those are the provider's rules and this
 * resolver deliberately does not soften them.
 */
export function resolveWorkspaceHostInitializationOperations(
  desired: WorkspaceHostDesiredSpec,
  controller: WorkspaceHostInitializationControllerProfile,
): WorkspaceHostInitializationHostOperations {
  if (desired.target !== GCP_WORKSPACE_HOST_TARGET) {
    throw new UnsupportedWorkspaceHostInitializationTargetError(String(desired.target));
  }

  const identity = resolveGcpWorkspaceHostInstanceIdentity(desired);
  const profile: GcpIapWorkspaceHostInitializationProfile = {
    projectId: identity.projectId,
    zone: identity.zone,
    instanceName: identity.instanceName,
    sshUser: controller.sshUser,
    knownHostsFile: controller.knownHostsFile,
    remoteEntrypoint: controller.remoteEntrypoint,
    ...(controller.identityFile ? { identityFile: controller.identityFile } : {}),
    ...(controller.sshExecutable ? { sshExecutable: controller.sshExecutable } : {}),
    ...(controller.gcloudExecutable ? { gcloudExecutable: controller.gcloudExecutable } : {}),
  };

  return new GcpIapWorkspaceHostInitializationOperations(profile);
}

/** Raised when the controller's own initialization settings are missing or unusable. */
export class WorkspaceHostInitializationControllerProfileError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Workspace-host initialization controller profile is not configured: ${problems.join('; ')}`);
    this.name = 'WorkspaceHostInitializationControllerProfileError';
    this.problems = problems;
  }
}

const CONTROLLER_ENV = {
  sshUser: 'PAPERCUSP_WORKSPACE_HOST_SSH_USER',
  knownHostsFile: 'PAPERCUSP_WORKSPACE_HOST_KNOWN_HOSTS',
  remoteEntrypoint: 'PAPERCUSP_WORKSPACE_HOST_REMOTE_ENTRYPOINT',
  identityFile: 'PAPERCUSP_WORKSPACE_HOST_IDENTITY_FILE',
  sshExecutable: 'PAPERCUSP_WORKSPACE_HOST_SSH_EXECUTABLE',
  gcloudExecutable: 'PAPERCUSP_WORKSPACE_HOST_GCLOUD_EXECUTABLE',
} as const;

const DEFAULT_CONTROLLER_REMOTE_ENTRYPOINT = join(
  WORKSPACE_HOST_RUNTIME_ROOT,
  'current',
  DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS.remoteInitializer,
);
const SYSTEMD_STATE_DIRECTORY_ENV = 'STATE_DIRECTORY';

/**
 * Build the controller's own initialization profile from deployment configuration.
 *
 * These are controller-owned and host-INDEPENDENT on purpose: the known-hosts file is the
 * controller's trust store and the remote entrypoint is a fixed binary in the signed
 * workspace-host release. The SSH user and entrypoint come from the deployment-driver contract;
 * explicit environment values remain supported for development/test overrides. The packaged
 * systemd user service supplies one private StateDirectory, whose absolute runtime value becomes
 * the default trust-store parent. No per-host row can redirect any of these values.
 *
 * Both paths must be ABSOLUTE. A relative path would resolve against whatever working directory
 * the controller happened to start in, which turns the trust store and the entrypoint into
 * values that depend on how the process was launched — the exact property a trust store must not
 * have. Every problem is collected and reported together: a half-configured controller should
 * name all of its gaps once, not surface them one restart at a time.
 */
export function resolveWorkspaceHostInitializationControllerProfile(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkspaceHostInitializationControllerProfile {
  const problems: string[] = [];

  const configured = (key: keyof typeof CONTROLLER_ENV, requireAbsolute: boolean): string | undefined => {
    const name = CONTROLLER_ENV[key];
    const raw = env[name];
    if (raw === undefined) return undefined;
    const value = raw.trim();
    if (!value) {
      problems.push(`${name} must not be empty when set`);
      return undefined;
    }
    if (requireAbsolute && !isAbsolute(value)) {
      problems.push(`${name} must be an absolute path (got '${value}')`);
      return undefined;
    }
    return value;
  };

  const sshUser = configured('sshUser', false) ?? DEFAULT_WORKSPACE_HOST_WORKSPACE_USER;
  const remoteEntrypoint = configured('remoteEntrypoint', true) ?? DEFAULT_CONTROLLER_REMOTE_ENTRYPOINT;
  const configuredKnownHostsFile = configured('knownHostsFile', true);
  let knownHostsFile = configuredKnownHostsFile ?? '';
  if (!configuredKnownHostsFile && env[CONTROLLER_ENV.knownHostsFile] === undefined) {
    const stateDirectory = (env[SYSTEMD_STATE_DIRECTORY_ENV] ?? '').trim();
    if (!stateDirectory) {
      problems.push(
        `${CONTROLLER_ENV.knownHostsFile} is unset and ${SYSTEMD_STATE_DIRECTORY_ENV} is unavailable`,
      );
    } else if (!isAbsolute(stateDirectory) || stateDirectory.includes(':')) {
      problems.push(`${SYSTEMD_STATE_DIRECTORY_ENV} must name one absolute directory`);
    } else {
      knownHostsFile = join(stateDirectory, 'known_hosts');
    }
  }

  const optional = (key: keyof typeof CONTROLLER_ENV, requireAbsolute: boolean): string | undefined => {
    const name = CONTROLLER_ENV[key];
    const value = (env[name] ?? '').trim();
    if (!value) return undefined;
    if (requireAbsolute && !isAbsolute(value)) {
      problems.push(`${name} must be an absolute path (got '${value}')`);
      return undefined;
    }
    return value;
  };

  const identityFile = optional('identityFile', true);
  const sshExecutable = optional('sshExecutable', false);
  const gcloudExecutable = optional('gcloudExecutable', false);

  if (problems.length > 0) throw new WorkspaceHostInitializationControllerProfileError(problems);

  return {
    sshUser,
    knownHostsFile,
    remoteEntrypoint,
    ...(identityFile ? { identityFile } : {}),
    ...(sshExecutable ? { sshExecutable } : {}),
    ...(gcloudExecutable ? { gcloudExecutable } : {}),
  };
}

/** Raised when a host cannot be initialized because its provisioning intent is unavailable. */
export class WorkspaceHostDesiredSpecUnavailableError extends Error {
  readonly hostId: string;
  readonly reason: 'host-not-found' | 'no-recorded-spec';

  constructor(hostId: string, reason: 'host-not-found' | 'no-recorded-spec') {
    super(
      reason === 'host-not-found'
        ? `No workspace host '${hostId}' in this workspace`
        : `Workspace host '${hostId}' has no recorded provisioning intent, so the cloud instance ` +
          `to initialize cannot be identified. It was provisioned before the intent was persisted ` +
          `(migration 956), or by a provisioner that did not record it.`,
    );
    this.name = 'WorkspaceHostDesiredSpecUnavailableError';
    this.hostId = hostId;
    this.reason = reason;
  }
}

export interface ResolveOperationsForHostInput {
  workspaceId: string;
  hostId: string;
  controller: WorkspaceHostInitializationControllerProfile;
  /** Test seam; defaults to the durable host record. */
  readDesiredSpec?: typeof readWorkspaceHostDesiredSpec;
  /** Test seam; production uses the persisted cloud credential reference. */
  gcpClient?: Pick<GcpWorkspaceHostApiClient, 'getInstanceGuestAttributes'>;
  /** Test seam; production atomically updates the controller-owned trust store. */
  enrollHostKeys?: (input: GcpIapHostKeyEnrollmentInput) => Promise<void>;
}

/**
 * Resolve the concrete host adapter for an ALREADY-PROVISIONED host, by id.
 *
 * This is the production entry point: initialization is handed a hostId, and the instance it must
 * reach is recovered from the intent the provisioner recorded — never re-derived from the host's
 * observed columns, which do not carry the zone, the project, or an explicit instance name.
 * A host whose intent was never recorded REFUSES here rather than proceeding against a guessed
 * instance name, because the failure mode of guessing is a tunnel to an instance that does not
 * exist, visible only against real cloud.
 */
export async function resolveWorkspaceHostInitializationOperationsForHost(
  input: ResolveOperationsForHostInput,
): Promise<{ desired: WorkspaceHostDesiredSpec; operations: WorkspaceHostInitializationHostOperations }> {
  const read = input.readDesiredSpec ?? readWorkspaceHostDesiredSpec;
  const lookup = await read(input.workspaceId, input.hostId);
  if (!lookup.desired) {
    throw new WorkspaceHostDesiredSpecUnavailableError(input.hostId, lookup.miss ?? 'no-recorded-spec');
  }

  // Keep the provider boundary ahead of the GCP-only trust enrollment. Unsupported targets must
  // refuse without making a cloud call (or attempting to interpret an AWS/Azure spec as GCP).
  const operations = resolveWorkspaceHostInitializationOperations(lookup.desired, input.controller);
  const identity = resolveGcpWorkspaceHostInstanceIdentity(lookup.desired);
  const client =
    input.gcpClient ??
    createGcpWorkspaceHostApiClient({
      acquireAuth: createGcpWorkspaceHostAcquireAuth(lookup.desired.credentials.cloudCredentialRef.ref),
    });
  const attributes = await client.getInstanceGuestAttributes(
    identity.projectId,
    identity.zone,
    identity.instanceName,
    'hostkeys/',
  );
  await (input.enrollHostKeys ?? enrollGcpIapHostKeys)({
    identity,
    knownHostsFile: input.controller.knownHostsFile,
    attributes,
  });

  return {
    desired: lookup.desired,
    operations,
  };
}
