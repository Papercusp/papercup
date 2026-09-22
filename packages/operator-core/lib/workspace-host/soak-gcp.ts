/**
 * Production GCP seams for the workspace-host soak (D-391).
 *
 * Both readings are READ-ONLY. The instance read is one Compute `instances.get`. The reach probe
 * is the WI-10002499 bootstrap-readiness probe (`test -x <conduit>`) over the controller's own IAP
 * SSH transport, bound to the PINNED incarnation's host-key alias and — unlike initialization — it
 * enrolls nothing, so a machine recreated mid-soak fails StrictHostKeyChecking instead of being
 * quietly re-trusted. A quiesced snapshot is never used as a probe: it stops the VM for ~75s
 * (EI-24005526609432424).
 */
import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';
import {
  GcpIapWorkspaceHostBootstrapNotReadyError,
  GcpIapWorkspaceHostInitializationOperations,
  NodeGcpIapWorkspaceHostInitializationCommandRunner,
  type GcpIapWorkspaceHostInitializationCommandRunner,
} from './gcp-iap-initialization-operations';
import { resolveGcpWorkspaceHostInstanceIdentity, type GcpWorkspaceHostApiClient } from './gcp-provider';
import {
  WorkspaceHostDesiredSpecUnavailableError,
  createGcpWorkspaceHostApiClientForDesired,
  resolveGcpIapWorkspaceHostInitializationProfile,
  resolveWorkspaceHostInitializationControllerProfile,
  type WorkspaceHostInitializationControllerProfile,
} from './initialization-operations-resolver';
import { readWorkspaceHostDesiredSpec } from './observability-store';
import type {
  WorkspaceHostSoakInstanceReading,
  WorkspaceHostSoakProbe,
  WorkspaceHostSoakReachOutcome,
  WorkspaceHostSoakSubject,
} from './soak';

/** Bound on one ssh attempt; a hung IAP tunnel must not eat the sample interval. */
export const WORKSPACE_HOST_SOAK_REACH_ATTEMPT_TIMEOUT_MS = 45_000;
/** Budget for one sample's reach check: up to ~3 attempts, absorbing a single dropped tunnel. */
export const WORKSPACE_HOST_SOAK_REACH_BUDGET_MS = 45_000;
export const WORKSPACE_HOST_SOAK_REACH_RETRY_MS = 15_000;

export interface GcpWorkspaceHostSoakSeamsInput {
  workspaceId: string;
  hostId: string;
  /** Test seams; production reads the durable host record, the controller env and real Compute. */
  readDesiredSpec?: typeof readWorkspaceHostDesiredSpec;
  controller?: WorkspaceHostInitializationControllerProfile;
  gcpClient?: Pick<GcpWorkspaceHostApiClient, 'getInstance'>;
  runner?: GcpIapWorkspaceHostInitializationCommandRunner;
  timing?: { now?: () => number; sleep?: (ms: number) => Promise<void> };
  now?: () => Date;
}

export interface GcpWorkspaceHostSoakSeams {
  desired: WorkspaceHostDesiredSpec;
  readInstance(): Promise<WorkspaceHostSoakInstanceReading>;
  probeFor(subject: WorkspaceHostSoakSubject): WorkspaceHostSoakProbe;
}

function detailOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export async function resolveGcpWorkspaceHostSoakSeams(
  input: GcpWorkspaceHostSoakSeamsInput,
): Promise<GcpWorkspaceHostSoakSeams> {
  const lookup = await (input.readDesiredSpec ?? readWorkspaceHostDesiredSpec)(input.workspaceId, input.hostId);
  if (!lookup.desired) {
    throw new WorkspaceHostDesiredSpecUnavailableError(input.hostId, lookup.miss ?? 'no-recorded-spec');
  }
  const desired = lookup.desired;
  const identity = resolveGcpWorkspaceHostInstanceIdentity(desired);
  const client = input.gcpClient ?? createGcpWorkspaceHostApiClientForDesired(desired);
  const now = input.now ?? (() => new Date());

  const readInstance = async (): Promise<WorkspaceHostSoakInstanceReading> => {
    try {
      const instance = await client.getInstance(identity.projectId, identity.zone, identity.instanceName);
      if (!instance) return { kind: 'absent' };
      return {
        kind: 'observed',
        status: instance.status,
        ...(instance.instanceId ? { instanceId: instance.instanceId } : {}),
        ...(instance.sourceImage ? { sourceImage: instance.sourceImage } : {}),
      };
    } catch (error) {
      return { kind: 'unreadable', detail: detailOf(error) };
    }
  };

  const probeFor = (subject: WorkspaceHostSoakSubject): WorkspaceHostSoakProbe => ({
    readInstance,
    now,
    async probeReach(): Promise<WorkspaceHostSoakReachOutcome> {
      const operations = new GcpIapWorkspaceHostInitializationOperations(
        resolveGcpIapWorkspaceHostInitializationProfile(
          desired,
          input.controller ?? resolveWorkspaceHostInitializationControllerProfile(),
          { instanceId: subject.instanceId },
        ),
        input.runner ??
          new NodeGcpIapWorkspaceHostInitializationCommandRunner({
            timeoutMs: WORKSPACE_HOST_SOAK_REACH_ATTEMPT_TIMEOUT_MS,
          }),
        input.timing ?? {},
      );
      try {
        await operations.awaitBootstrapReady({
          timeoutMs: WORKSPACE_HOST_SOAK_REACH_BUDGET_MS,
          pollIntervalMs: WORKSPACE_HOST_SOAK_REACH_RETRY_MS,
        });
        return { kind: 'reached' };
      } catch (error) {
        // Matched by name as well as prototype: DBOS serialization erases prototypes elsewhere
        // in this subsystem, and a misclassified outcome here would blur the two failure kinds.
        if (
          error instanceof GcpIapWorkspaceHostBootstrapNotReadyError ||
          (error instanceof Error && error.name === 'GcpIapWorkspaceHostBootstrapNotReadyError')
        ) {
          const typed = error as GcpIapWorkspaceHostBootstrapNotReadyError;
          return typed.answered
            ? { kind: 'conduit-missing', detail: detailOf(error) }
            : { kind: 'transport-failure', detail: detailOf(error) };
        }
        return { kind: 'transport-failure', detail: detailOf(error) };
      }
    },
  });

  return { desired, readInstance, probeFor };
}
