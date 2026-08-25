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
import type {
  WorkspaceHostDesiredSpec,
  WorkspaceHostInitializationHostOperations,
} from '@papercusp/deployment-driver';
import {
  GcpIapWorkspaceHostInitializationOperations,
  type GcpIapWorkspaceHostInitializationProfile,
} from './gcp-iap-initialization-operations';
import { GCP_WORKSPACE_HOST_TARGET, resolveGcpWorkspaceHostInstanceIdentity } from './gcp-provider';
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

/**
 * Build the controller's own initialization profile from deployment configuration.
 *
 * These are controller-owned and host-INDEPENDENT on purpose: the known-hosts file is the
 * controller's trust store and the remote entrypoint is a fixed binary in the signed
 * workspace-host release. Sourcing them from deployment config rather than a per-host row is
 * what stops a host record from being able to point the controller at an arbitrary binary or a
 * trust store that would accept an arbitrary key.
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

  const required = (key: keyof typeof CONTROLLER_ENV, requireAbsolute: boolean): string => {
    const name = CONTROLLER_ENV[key];
    const value = (env[name] ?? '').trim();
    if (!value) {
      problems.push(`${name} is unset`);
      return '';
    }
    if (requireAbsolute && !value.startsWith('/')) {
      problems.push(`${name} must be an absolute path (got '${value}')`);
      return '';
    }
    return value;
  };

  const sshUser = required('sshUser', false);
  const knownHostsFile = required('knownHostsFile', true);
  const remoteEntrypoint = required('remoteEntrypoint', true);

  const optional = (key: keyof typeof CONTROLLER_ENV, requireAbsolute: boolean): string | undefined => {
    const name = CONTROLLER_ENV[key];
    const value = (env[name] ?? '').trim();
    if (!value) return undefined;
    if (requireAbsolute && !value.startsWith('/')) {
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

  return {
    desired: lookup.desired,
    operations: resolveWorkspaceHostInitializationOperations(lookup.desired, input.controller),
  };
}
