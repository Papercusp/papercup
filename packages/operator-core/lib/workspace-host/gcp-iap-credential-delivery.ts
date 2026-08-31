/**
 * The controller side of credential-material delivery over GCP IAP (P-046 / WI-40474, D-215).
 *
 * WHY THIS IS A SEPARATE FILE FROM `gcp-iap-initialization-operations`. That module's contract is
 * that no resolved credential bytes cross its boundary, and it asserts that on every step and
 * every encoded request. This module's contract is the exact opposite: it exists to carry those
 * bytes. Putting both in one file would make that header claim conditional — a reader could no
 * longer take "credential bytes never cross this boundary" at face value, and the assertion would
 * have to grow an exception. Two files, two unambiguous contracts, one shared TRANSPORT
 * (`buildGcpIapSshInvocation`) so the security-critical SSH options cannot drift between them.
 *
 * MATERIAL TRAVELS ON STDIN, NEVER IN ARGV. `/proc/<pid>/cmdline` is world-readable on Linux, so
 * an argument is visible to every local process for the lifetime of the command — and to `ps`, the
 * audit log, and any transport that echoes what it ran. The remote argv here is a fixed three
 * tokens with no caller input in it at all; the bytes go down the pipe.
 */
import {
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV,
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
  encodeWorkspaceHostCredentialDeliveryRequest,
  type WorkspaceHostCredentialMaterial,
} from '@papercusp/deployment-driver';
import type { WorkspaceHostCredentialChannel } from '@papercusp/deployment-driver';

import {
  buildGcpIapSshInvocation,
  type GcpIapWorkspaceHostInitializationCommand,
  type GcpIapWorkspaceHostInitializationCommandRunner,
  type GcpIapWorkspaceHostTransportProfile,
} from './gcp-iap-initialization-operations';

/**
 * The delivery profile: the shared transport plus the delivery binary.
 *
 * `deliveryEntrypoint` is deliberately its own field rather than reusing `remoteEntrypoint`. They
 * are two different programs in the signed release, and a profile that carried one path for both
 * would silently send delivery requests to the initializer — which would refuse them as a protocol
 * version mismatch, reported as a broken step rather than as a misconfigured profile.
 */
export interface GcpIapWorkspaceHostCredentialDeliveryProfile
  extends GcpIapWorkspaceHostTransportProfile {
  /** Absolute path to `bin/papercusp-deliver-material` in the extracted release. */
  deliveryEntrypoint: string;
}

export interface GcpIapWorkspaceHostCredentialDeliveryInput {
  readonly channel: WorkspaceHostCredentialChannel;
  readonly credentialRef: string;
  readonly generation: number;
  readonly material: WorkspaceHostCredentialMaterial;
}

/**
 * The receipt a successful delivery returns. Structurally the host's receipt; re-declared here as
 * what the controller is willing to PERSIST, so a host that grew an extra field cannot smuggle it
 * into a durable record just because the parser was permissive.
 */
export interface GcpIapWorkspaceHostCredentialDeliveryReceipt {
  readonly protocolVersion: typeof WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION;
  readonly family: string;
  readonly generation: number;
  readonly present: true;
  readonly observedAt: string;
}

export class GcpIapWorkspaceHostCredentialDeliveryError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'GcpIapWorkspaceHostCredentialDeliveryError';
    this.exitCode = exitCode;
  }
}

/**
 * Build the delivery invocation.
 *
 * NOTE THE ABSENT ASSERTION. `assertWorkspaceHostSecretIsolation` is not called on the request, and
 * that is the whole point of the operation rather than an omission — see D-215's inbound/outbound
 * asymmetry. It IS called on the receipt, in `parse...Receipt` below, because that is the value
 * that gets persisted.
 */
export function buildGcpIapWorkspaceHostCredentialDeliveryCommand(
  profile: GcpIapWorkspaceHostCredentialDeliveryProfile,
  input: GcpIapWorkspaceHostCredentialDeliveryInput,
): GcpIapWorkspaceHostInitializationCommand {
  const request = encodeWorkspaceHostCredentialDeliveryRequest({
    channel: input.channel,
    credentialRef: input.credentialRef,
    generation: input.generation,
    material: input.material,
  });

  return buildGcpIapSshInvocation(profile, {
    entrypoint: profile.deliveryEntrypoint,
    entrypointLabel: 'Credential delivery entrypoint',
    // A fixed argv with no caller input spliced into it. Everything variable is in stdin.
    args: [...WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV],
    stdin: `${JSON.stringify(request)}\n`,
  });
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GcpIapWorkspaceHostCredentialDeliveryError(
      `credential delivery receipt ${label} must be a non-empty string`,
      1,
    );
  }
  return value;
}

/**
 * Parse the host's receipt.
 *
 * Fields are read INDIVIDUALLY rather than the object being passed through, so a host that
 * returned extra fields — a size, a digest, an echo of the material — cannot have them land in a
 * durable record. D-215 point 3 forbids anything derived from the bytes, and the cheapest way to
 * enforce that at the controller is to construct the persisted value from named fields only.
 */
export function parseGcpIapWorkspaceHostCredentialDeliveryReceipt(
  stdout: string,
): GcpIapWorkspaceHostCredentialDeliveryReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new GcpIapWorkspaceHostCredentialDeliveryError(
      'credential delivery returned a malformed response',
      1,
    );
  }
  const body = parsed as Record<string, unknown>;
  if (body?.protocolVersion !== WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION) {
    throw new GcpIapWorkspaceHostCredentialDeliveryError(
      `credential delivery answered protocol '${String(body?.protocolVersion)}'; the controller ` +
        `speaks '${WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION}'`,
      1,
    );
  }
  if (body.present !== true) {
    throw new GcpIapWorkspaceHostCredentialDeliveryError(
      'credential delivery did not report the material as present',
      1,
    );
  }
  const generation = body.generation;
  if (!Number.isSafeInteger(generation) || (generation as number) < 1) {
    throw new GcpIapWorkspaceHostCredentialDeliveryError(
      'credential delivery receipt generation must be a positive safe integer',
      1,
    );
  }
  return {
    protocolVersion: WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
    family: requireString(body.family, 'family'),
    generation: generation as number,
    present: true,
    observedAt: requireString(body.observedAt, 'observedAt'),
  };
}

/**
 * Deliver one generation's material to the host and return its receipt.
 *
 * Reuses the initialization runner interface: the transport, timeout and output bounds are the
 * same problem, and a second runner would be a second place to get the bounded-stderr handling
 * wrong. A non-zero exit carries the host's stderr tail, which the delivery CLI writes as
 * `name: message` and never as the request.
 */
export async function deliverGcpIapWorkspaceHostCredentialMaterial(
  profile: GcpIapWorkspaceHostCredentialDeliveryProfile,
  input: GcpIapWorkspaceHostCredentialDeliveryInput,
  runner: GcpIapWorkspaceHostInitializationCommandRunner,
): Promise<GcpIapWorkspaceHostCredentialDeliveryReceipt> {
  const command = buildGcpIapWorkspaceHostCredentialDeliveryCommand(profile, input);
  const result = await runner.run(command);
  if (result.exitCode !== 0) {
    throw new GcpIapWorkspaceHostCredentialDeliveryError(
      `credential delivery failed with exit ${result.exitCode}: ${result.stderr.trim() || '(no diagnostic output)'}`,
      result.exitCode,
    );
  }
  return parseGcpIapWorkspaceHostCredentialDeliveryReceipt(result.stdout);
}
