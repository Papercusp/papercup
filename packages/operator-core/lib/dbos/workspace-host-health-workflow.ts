/**
 * Standing workspace-host health (WI-10004950): every 15 minutes the controller attests each live
 * hosted host it holds authority for, so `workspace_hosts.health_status` is a current reading for
 * every running customer host rather than NULL outside a soak.
 *
 * The pass itself (`runWorkspaceHostStandingHealthPass`) is DBOS-free and tested over an injected
 * runtime; this module only binds it to `DBOS.runStep` and the real seams/writer, then schedules it.
 * Default skip-missed mode: after downtime one pass re-attests every host, there is no backlog.
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import { idempotentRegisterWorkflow } from './idempotent-register-workflow';
import { resolveWorkspaceHostSoakSeams } from '../workspace-host/soak-seams';
import { recordWorkspaceHostHealth } from '../workspace-host/observability-store';
import { DEFAULT_WORKSPACE_HOST_CONTROLLER_AUTHORITY } from '../workspace-host/provisioning-runner';
import {
  listWorkspaceHostStandingHealthTargets,
  prepareWorkspaceHostReclaimRestart,
  type WorkspaceHostReclaimRestartInput,
} from '../workspace-host/standing-health-store';
import {
  runWorkspaceHostStandingHealthPass,
  WORKSPACE_HOST_STANDING_HEALTH_CRONTAB,
  type WorkspaceHostReclaimRecovery,
  type WorkspaceHostReclaimRestartSeams,
  type WorkspaceHostStandingHealthPassResult,
  type WorkspaceHostStandingHealthRuntime,
} from '../workspace-host/standing-health';
/**
 * Restart a reclaimed spot host with the controller's own lifecycle `start` (WI-10005210).
 * `enqueue` runs at the workflow layer of the standing-health tick, where DBOS allows starting a
 * child workflow; the per-host dedup id makes a busy host a skip, never a second operation.
 *
 * The lifecycle module is imported lazily: it registers the provisioning workflow and its queue at
 * load, which the host has already done at boot, and an eager import would drag that registration
 * into every importer of this schedule.
 */
export function workspaceHostReclaimRestartSeams(
  enqueue?: (input: WorkspaceHostReclaimRestartInput) => Promise<unknown>,
): WorkspaceHostReclaimRestartSeams {
  return {
    prepare: (target, operationId) => prepareWorkspaceHostReclaimRestart(target, operationId),
    enqueue: async ({ operationId, input }): Promise<WorkspaceHostReclaimRecovery> => {
      const lifecycle = await import('./workspace-host-provision-workflow');
      try {
        await (enqueue ?? lifecycle.enqueueWorkspaceHostLifecycleWorkflow)(input as WorkspaceHostReclaimRestartInput);
        return { kind: 'restart-enqueued', operationId };
      } catch (error) {
        if (error instanceof lifecycle.WorkspaceHostProvisioningConflictError) {
          return { kind: 'restart-skipped', reason: 'another lifecycle operation holds the host' };
        }
        throw error;
      }
    },
  };
}

export const WORKSPACE_HOST_HEALTH_WORKFLOW_NAME = 'workspaceHostStandingHealth';

export function workspaceHostStandingHealthDbosRuntime(): WorkspaceHostStandingHealthRuntime {
  return {
    // One attempt per host per tick: a probe that failed IS the observation (it is attested as
    // such), and retrying would only re-pay the IAP reach the next tick pays anyway.
    step: (name, fn) => DBOS.runStep(fn, { name, retriesAllowed: false }),
    controllerId: DEFAULT_WORKSPACE_HOST_CONTROLLER_AUTHORITY.controllerId,
    listTargets: (controllerId) => listWorkspaceHostStandingHealthTargets(controllerId),
    resolveSeams: (input) => resolveWorkspaceHostSoakSeams(input),
    recordHealth: recordWorkspaceHostHealth,
    now: () => new Date(),
    reclaim: workspaceHostReclaimRestartSeams(),
  };
}

function recoveryNote(recovery: WorkspaceHostReclaimRecovery | undefined): string {
  if (!recovery) return '';
  if (recovery.kind === 'restart-enqueued') return ` (spot reclaimed, restart enqueued ${recovery.operationId})`;
  if (recovery.kind === 'restart-skipped') return ` (spot reclaimed, restart skipped: ${recovery.reason})`;
  return ` (spot reclaimed, restart FAILED: ${recovery.error})`;
}

/** A one-line summary, or null when every probed host is healthy and nothing failed. */
export function workspaceHostStandingHealthSummary(result: WorkspaceHostStandingHealthPassResult): string | null {
  const attested = result.outcomes.filter((outcome) => outcome.kind === 'attested');
  const unhealthy = attested.filter((outcome) => outcome.status !== 'healthy');
  const failed = result.outcomes.filter((outcome) => outcome.kind === 'record-failed');
  if (unhealthy.length === 0 && failed.length === 0) return null;
  const parts = [
    ...unhealthy.map(
      (outcome) => `${outcome.workspaceId}/${outcome.hostId}=${outcome.status}${recoveryNote(outcome.recovery)}`,
    ),
    ...failed.map((outcome) => `${outcome.workspaceId}/${outcome.hostId} record failed: ${outcome.error}`),
  ];
  return (
    `[workspace-host-health] ${result.controllerId}: ${attested.length} attested, ` +
    `${unhealthy.length} not healthy, ${failed.length} not recorded | ${parts.join(' | ')}`
  );
}

async function workspaceHostStandingHealthTick(): Promise<WorkspaceHostStandingHealthPassResult> {
  const result = await runWorkspaceHostStandingHealthPass(workspaceHostStandingHealthDbosRuntime());
  const summary = workspaceHostStandingHealthSummary(result);
  if (summary) console.log(summary);
  return result;
}

const workspaceHostStandingHealthWorkflow = idempotentRegisterWorkflow(WORKSPACE_HOST_HEALTH_WORKFLOW_NAME, () =>
  DBOS.registerWorkflow(workspaceHostStandingHealthTick, {
    name: WORKSPACE_HOST_HEALTH_WORKFLOW_NAME,
    maxRecoveryAttempts: 3,
  }),
);

DBOS.registerScheduled(workspaceHostStandingHealthWorkflow, {
  name: WORKSPACE_HOST_HEALTH_WORKFLOW_NAME,
  crontab: WORKSPACE_HOST_STANDING_HEALTH_CRONTAB,
});
