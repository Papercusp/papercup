/**
 * Standing health for live hosted workspace hosts (WI-10004950).
 *
 * Until this existed, `workspace_hosts.health_status` was written only by a soak
 * (`recordWorkspaceHostSoakSample` → `recordWorkspaceHostHealth`), so every live host that was
 * not mid-soak read NULL. Nothing told anyone that a customer's host was down, unreachable, or
 * about to lose its agent login.
 *
 * This pass is the standing producer. It reuses the soak's seams and check builders rather than
 * forking them, so a host's health means the same thing whichever producer wrote it:
 *   - seams: `resolveWorkspaceHostSoakSeams` (provider read + controller reach over GCP IAP or AWS SSM),
 *   - checks: `workspaceHostComputeCheck` / `workspaceHostReachCheck` from soak.ts,
 *   - writer: `recordWorkspaceHostHealth`.
 *
 * Three rules:
 *
 * 1. ONLY THE CONTROLLER PROBES. A host is probed by the process whose controller id is stamped
 *    on its row (`controller_id`), the same authority that provisions it, so two operators on one
 *    database never double the IAP cost or race each other's attestation.
 *
 * 2. A FRESH ATTESTATION IS LEFT ALONE. A host attested within `freshMs` is skipped: an active
 *    soak samples every few minutes and owns the host's health while it runs. The standing pass
 *    writes every 15 minutes, so its own last write is never "fresh" at the next tick.
 *
 * 3. NO VACUOUS CHECKS, NO SILENT SKIPS. Incarnation and image stability are properties of a
 *    WINDOW (the soak's job); one sample pinned from its own reading would report them as
 *    trivially ok, so they are not written here. And a host that could not be asked is still
 *    attested, with `ok: null` checks naming why, so "unknown" is visible rather than absent.
 */
import {
  resolveWorkspaceHostHealthStatus,
  type WorkspaceHostHealthAttestation,
  type WorkspaceHostHealthCheck,
} from '@papercusp/deployment-driver';
import {
  workspaceHostAgentCredentialChecks,
  type WorkspaceHostAgentCredentialExpiryReading,
} from './agent-credential-expiry';
import {
  workspaceHostComputeCheck,
  workspaceHostReachCheck,
  type WorkspaceHostSoakInstanceReading,
  type WorkspaceHostSoakReachOutcome,
  type WorkspaceHostSoakSubject,
} from './soak';

/** Cadence of the scheduled pass; each due host costs one provider read and one IAP reach. */
export const WORKSPACE_HOST_STANDING_HEALTH_CRONTAB = '*/15 * * * *';
/** A host attested more recently than this is skipped (an active soak owns its health). */
export const WORKSPACE_HOST_STANDING_HEALTH_FRESH_MS = 10 * 60_000;
/** The `soakId` slot of the reach subject; the standing pass is not a soak and stores no samples. */
export const WORKSPACE_HOST_STANDING_HEALTH_SUBJECT_ID = 'standing-health';

export interface WorkspaceHostStandingHealthTarget {
  workspaceId: string;
  hostId: string;
  /** ISO timestamp of the host's last attestation from any producer, or null when never attested. */
  healthAttestedAt: string | null;
}

/** The subset of the soak seams this pass uses. */
export interface WorkspaceHostStandingHealthSeams {
  readInstance(): Promise<WorkspaceHostSoakInstanceReading>;
  probeFor(subject: WorkspaceHostSoakSubject): {
    probeReach(): Promise<WorkspaceHostSoakReachOutcome>;
    /**
     * Read the agent logins' expiry on the host (WI-10003720). Optional so a provider without it
     * still attests compute + reach; asked only after a successful reach, over the same transport.
     */
    readAgentCredentialExpiry?(): Promise<WorkspaceHostAgentCredentialExpiryReading>;
  };
}

export type WorkspaceHostStandingHealthOutcome =
  | {
      kind: 'attested';
      workspaceId: string;
      hostId: string;
      status: WorkspaceHostHealthAttestation['status'];
      checks: readonly WorkspaceHostHealthCheck[];
    }
  | { kind: 'skipped-fresh'; workspaceId: string; hostId: string; attestedAt: string }
  | { kind: 'record-failed'; workspaceId: string; hostId: string; error: string };

export interface WorkspaceHostStandingHealthRuntime {
  /** A checkpointed step: on replay its recorded result is returned without re-running `fn`. */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** The controller id this process holds authority as. */
  controllerId: string;
  listTargets(controllerId: string): Promise<WorkspaceHostStandingHealthTarget[]>;
  resolveSeams(input: { workspaceId: string; hostId: string }): Promise<WorkspaceHostStandingHealthSeams>;
  recordHealth(workspaceId: string, attestation: WorkspaceHostHealthAttestation): Promise<void>;
  /** Wall clock, read ONLY inside steps so a replay sees the recorded value. */
  now(): Date;
  freshMs?: number;
}

export interface WorkspaceHostStandingHealthPassResult {
  controllerId: string;
  outcomes: WorkspaceHostStandingHealthOutcome[];
}

function errorDetail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function notAttempted(why: string): WorkspaceHostHealthCheck {
  return { name: 'controller-reach', ok: null, detail: `not attempted: ${why}` };
}

/** Why a reach cannot be attempted for this reading, or null when it can. */
function reachBlocker(reading: WorkspaceHostSoakInstanceReading): string | null {
  if (reading.kind === 'unreadable') return 'the provider could not be read';
  if (reading.kind === 'absent') return 'the provider reports no instance';
  if (reading.status !== 'RUNNING') return `the instance is ${reading.status}, not RUNNING`;
  if (!reading.instanceId) return 'the provider returned no instance id';
  return null;
}

/**
 * Take one standing attestation of a host. Never throws for a probe failure: a host that could
 * not be read or reached IS the observation.
 */
export async function probeWorkspaceHostStandingHealth(
  target: { workspaceId: string; hostId: string },
  deps: Pick<WorkspaceHostStandingHealthRuntime, 'resolveSeams' | 'now'>,
): Promise<WorkspaceHostHealthAttestation> {
  const observedAt = deps.now().toISOString();
  let checks: WorkspaceHostHealthCheck[];
  let seams: WorkspaceHostStandingHealthSeams | null = null;
  let seamsError: string | null = null;
  try {
    seams = await deps.resolveSeams(target);
  } catch (error) {
    seamsError = errorDetail(error);
  }
  if (!seams) {
    const why = `the controller could not resolve the host (${seamsError})`;
    checks = [{ name: 'compute-running', ok: null, detail: why }, notAttempted(why)];
  } else {
    const reading = await seams
      .readInstance()
      .catch((error: unknown): WorkspaceHostSoakInstanceReading => ({ kind: 'unreadable', detail: errorDetail(error) }));
    const blocker = reachBlocker(reading);
    let reach: WorkspaceHostHealthCheck;
    let agentChecks: WorkspaceHostHealthCheck[] = [];
    if (blocker !== null || reading.kind !== 'observed') {
      reach = notAttempted(blocker ?? 'no observed instance');
    } else {
      const subject: WorkspaceHostSoakSubject = {
        workspaceId: target.workspaceId,
        hostId: target.hostId,
        soakId: WORKSPACE_HOST_STANDING_HEALTH_SUBJECT_ID,
        instanceId: reading.instanceId!,
        image: reading.sourceImage ?? '',
      };
      const probe = seams.probeFor(subject);
      const outcome = await probe
        .probeReach()
        .catch((error: unknown): WorkspaceHostSoakReachOutcome => ({
          kind: 'transport-failure',
          detail: errorDetail(error),
        }));
      reach = workspaceHostReachCheck(outcome);
      // Only a host we actually reached is asked about its logins: an unreached host already
      // says why in its reach check, and a second failed ssh would only repeat it.
      if (outcome.kind === 'reached' && probe.readAgentCredentialExpiry) {
        const expiry = await probe
          .readAgentCredentialExpiry()
          .catch((error: unknown): WorkspaceHostAgentCredentialExpiryReading => ({
            kind: 'transport-failure',
            detail: errorDetail(error),
          }));
        agentChecks = workspaceHostAgentCredentialChecks(expiry, new Date(observedAt));
      }
    }
    checks = [workspaceHostComputeCheck(reading), reach, ...agentChecks];
  }
  const compute = checks.find((check) => check.name === 'compute-running');
  return {
    hostId: target.hostId,
    observedAt,
    status: resolveWorkspaceHostHealthStatus({ reachable: compute?.ok !== false, checks }),
    checks,
  };
}

/** True when the host was attested within `freshMs` of `nowMs` by any producer. */
export function workspaceHostStandingHealthIsFresh(
  target: WorkspaceHostStandingHealthTarget,
  nowMs: number,
  freshMs: number = WORKSPACE_HOST_STANDING_HEALTH_FRESH_MS,
): boolean {
  if (!target.healthAttestedAt) return false;
  const attestedMs = Date.parse(target.healthAttestedAt);
  return Number.isFinite(attestedMs) && nowMs - attestedMs < freshMs;
}

/**
 * One pass over every live host this controller holds authority for: each due host is probed
 * and attested in its OWN step, so a crash mid-pass resumes at the next host instead of
 * re-probing (and re-paying IAP for) the ones already done.
 */
export async function runWorkspaceHostStandingHealthPass(
  runtime: WorkspaceHostStandingHealthRuntime,
): Promise<WorkspaceHostStandingHealthPassResult> {
  const freshMs = runtime.freshMs ?? WORKSPACE_HOST_STANDING_HEALTH_FRESH_MS;
  const listed = await runtime.step('standing-health-list', async () => ({
    targets: await runtime.listTargets(runtime.controllerId),
    nowMs: runtime.now().getTime(),
  }));
  const outcomes: WorkspaceHostStandingHealthOutcome[] = [];
  for (const target of listed.targets) {
    const { workspaceId, hostId } = target;
    if (workspaceHostStandingHealthIsFresh(target, listed.nowMs, freshMs)) {
      outcomes.push({ kind: 'skipped-fresh', workspaceId, hostId, attestedAt: target.healthAttestedAt! });
      continue;
    }
    const outcome = await runtime.step(
      `standing-health-host:${workspaceId}:${hostId}`,
      async (): Promise<WorkspaceHostStandingHealthOutcome> => {
        const attestation = await probeWorkspaceHostStandingHealth({ workspaceId, hostId }, runtime);
        try {
          await runtime.recordHealth(workspaceId, attestation);
        } catch (error) {
          return { kind: 'record-failed', workspaceId, hostId, error: errorDetail(error) };
        }
        return { kind: 'attested', workspaceId, hostId, status: attestation.status, checks: attestation.checks };
      },
    );
    outcomes.push(outcome);
  }
  return { controllerId: runtime.controllerId, outcomes };
}
