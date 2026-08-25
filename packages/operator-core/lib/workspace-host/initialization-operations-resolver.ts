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
