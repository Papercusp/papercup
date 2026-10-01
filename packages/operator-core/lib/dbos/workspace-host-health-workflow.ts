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
import { resolveGcpWorkspaceHostSoakSeams } from '../workspace-host/soak-gcp';
import { recordWorkspaceHostHealth } from '../workspace-host/observability-store';
import { DEFAULT_WORKSPACE_HOST_CONTROLLER_AUTHORITY } from '../workspace-host/provisioning-runner';
import { listWorkspaceHostStandingHealthTargets } from '../workspace-host/standing-health-store';
import {
  runWorkspaceHostStandingHealthPass,
  WORKSPACE_HOST_STANDING_HEALTH_CRONTAB,
  type WorkspaceHostStandingHealthPassResult,
  type WorkspaceHostStandingHealthRuntime,
} from '../workspace-host/standing-health';

export const WORKSPACE_HOST_HEALTH_WORKFLOW_NAME = 'workspaceHostStandingHealth';

export function workspaceHostStandingHealthDbosRuntime(): WorkspaceHostStandingHealthRuntime {
  return {
    // One attempt per host per tick: a probe that failed IS the observation (it is attested as
    // such), and retrying would only re-pay the IAP reach the next tick pays anyway.
    step: (name, fn) => DBOS.runStep(fn, { name, retriesAllowed: false }),
    controllerId: DEFAULT_WORKSPACE_HOST_CONTROLLER_AUTHORITY.controllerId,
    listTargets: (controllerId) => listWorkspaceHostStandingHealthTargets(controllerId),
    resolveSeams: (input) => resolveGcpWorkspaceHostSoakSeams(input),
    recordHealth: recordWorkspaceHostHealth,
    now: () => new Date(),
  };
}

/** A one-line summary, or null when every probed host is healthy and nothing failed. */
export function workspaceHostStandingHealthSummary(result: WorkspaceHostStandingHealthPassResult): string | null {
  const attested = result.outcomes.filter((outcome) => outcome.kind === 'attested');
  const unhealthy = attested.filter((outcome) => outcome.status !== 'healthy');
  const failed = result.outcomes.filter((outcome) => outcome.kind === 'record-failed');
  if (unhealthy.length === 0 && failed.length === 0) return null;
  const parts = [
    ...unhealthy.map((outcome) => `${outcome.workspaceId}/${outcome.hostId}=${outcome.status}`),
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
