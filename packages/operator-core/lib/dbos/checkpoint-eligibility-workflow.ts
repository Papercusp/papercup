/**
 * Durable `release:checkpoint-run { waitForEligibility:true }` waiter.
 *
 * The request handler must not sleep across the MCP transport deadline. This workflow owns the
 * bounded quiet-cut delay, rechecks the candidate after waking, and only then takes the manual
 * checkpoint launch path. DBOS persists the sleep and the checkpointed steps, so an operator
 * restart cannot turn an accepted wait into a silently lost launch.
 */
import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import {
  assessPreLaunchExclusion,
  checkpointEligibilityCompletionEvents,
  checkpointPipelineName,
  launchDetachedCheckpoint,
  type CheckpointEligibilityWaitRequest,
  type CheckpointEligibilityWaitReceipt,
  type LaunchCheckpointResult,
  type PreLaunchExclusion,
  setCheckpointEligibilityWaitRunner,
} from '../release-checkpoint-launch';
import { integrationRoot } from '../release-deploy-launch';
import { emitAwaitedEvent, type EmitAwaitedEventOpts } from '../events/await/engine';
import { idempotentRegisterWorkflow, idempotentWorkflowQueue } from './idempotent-register-workflow';
import { queueConcurrency } from './queue-concurrency';

export interface CheckpointEligibilityWaitOutcome {
  status: 'launched' | 'not-launched';
  reason?: string;
  result?: LaunchCheckpointResult;
}

export interface CheckpointEligibilityWaitDeps {
  sleep: (ms: number) => Promise<void>;
  assess: (args: { paths: string[]; force?: boolean; root?: string }) => Promise<PreLaunchExclusion>;
  launch: (opts: { force?: boolean; replaceStale?: boolean; root?: string }) => Promise<LaunchCheckpointResult>;
  emit: (opts: EmitAwaitedEventOpts) => Promise<unknown>;
}

/**
 * Pure workflow decision seam. Keeping the delay/recheck/launch ordering here makes the
 * recurrence guard testable without starting DBOS or a systemd unit.
 */
export async function runCheckpointEligibilityWait(
  input: CheckpointEligibilityWaitRequest,
  deps: CheckpointEligibilityWaitDeps,
): Promise<CheckpointEligibilityWaitOutcome> {
  // +2s crosses the quiet-window boundary rather than landing exactly on it. The cut is an age
  // test at second granularity, so an exact-boundary wake can still round the wrong way.
  await deps.sleep((Math.max(0, Math.ceil(input.waitSec)) + 2) * 1000);

  const recheck = await deps.assess({
    paths: input.paths,
    force: input.force,
    root: input.root,
  });

  // A newly-arrived commit can move the candidate while this waiter sleeps. Do not silently
  // launch a run that is known to omit the caller's paths; emit the normal inconclusive gate
  // event so a `checkpoint:await` waiter gets an actionable wake and can retry with a fresh
  // preflight instead.
  if (recheck.refuse || recheck.proceedReason === 'wait-exceeds-cap') {
    const reason = recheck.refuse ? 'still-would-exclude-declared-paths' : 'eligibility-wait-exceeds-cap';
    await deps.emit({
      key: `green-checkpoint:inconclusive:${checkpointPipelineName(input.root ?? integrationRoot())}`,
      summary: `checkpoint eligibility wait ${input.pendingId} did not launch: ${reason}`,
      payload: {
        pendingId: input.pendingId,
        reason,
        candidate: recheck.candidate,
        tip: recheck.tip,
        wait_sec: recheck.waitSec,
        blocked_paths: recheck.blockedPaths,
      },
      source: 'checkpoint-eligibility-wait',
    });
    return { status: 'not-launched', reason };
  }

  const result = await deps.launch({
    force: input.force,
    replaceStale: input.replaceStale,
    root: input.root,
  });
  if (result.launched) return { status: 'launched', result };

  // The standard checkpoint verdict events cover a successful detached run. If the launch
  // itself is refused (probe failure, an already-running run, etc.), surface an inconclusive
  // event instead of leaving the receipt with no completion signal.
  await deps.emit({
    key: `green-checkpoint:inconclusive:${checkpointPipelineName(input.root ?? integrationRoot())}`,
    summary: `checkpoint eligibility wait ${input.pendingId} did not launch: ${result.reason ?? 'unknown'}`,
    payload: {
      pendingId: input.pendingId,
      reason: result.reason ?? 'not-launched',
      unit: result.unit,
    },
    source: 'checkpoint-eligibility-wait',
  });
  return { status: 'not-launched', reason: result.reason ?? 'not-launched', result };
}

async function checkpointEligibilityWaitImpl(
  input: CheckpointEligibilityWaitRequest,
): Promise<CheckpointEligibilityWaitOutcome> {
  return runCheckpointEligibilityWait(input, {
    sleep: (ms) => DBOS.sleep(ms),
    assess: (args) =>
      DBOS.runStep(() => assessPreLaunchExclusion(args), {
        name: 'checkpoint-eligibility-recheck',
      }),
    launch: (opts) =>
      DBOS.runStep(() => launchDetachedCheckpoint(opts), {
        name: 'checkpoint-eligibility-launch',
      }),
    emit: (opts) =>
      DBOS.runStep(() => emitAwaitedEvent(opts), {
        name: 'checkpoint-eligibility-inconclusive',
      }),
  });
}

export const checkpointEligibilityWaitWorkflow = idempotentRegisterWorkflow(
  'checkpointEligibilityWait',
  () =>
    DBOS.registerWorkflow(checkpointEligibilityWaitImpl, {
      name: 'checkpointEligibilityWait',
      maxRecoveryAttempts: 5,
    }),
);

const checkpointEligibilityWaitQueue = idempotentWorkflowQueue(
  'checkpoint-eligibility-wait',
  () => new WorkflowQueue('checkpoint-eligibility-wait', { concurrency: queueConcurrency(2) }),
);

/** Enqueue once per pending id and return a receipt before the quiet-cut delay begins. */
export async function enqueueCheckpointEligibilityWait(
  input: CheckpointEligibilityWaitRequest,
): Promise<CheckpointEligibilityWaitReceipt> {
  const root = input.root ?? integrationRoot();
  const normalized = { ...input, root };
  const workflowId = `checkpoint-eligibility:${input.pendingId}`;
  await DBOS.startWorkflow(checkpointEligibilityWaitWorkflow, {
    workflowID: workflowId,
    queueName: checkpointEligibilityWaitQueue.name,
    enqueueOptions: { deduplicationID: workflowId },
  })(normalized);
  return {
    pendingId: input.pendingId,
    workflowId,
    completionEvents: checkpointEligibilityCompletionEvents(root),
  };
}

/** Wire the request-side seam after DBOS has been registered by host bootstrap. */
export function wireCheckpointEligibilityWait(): void {
  setCheckpointEligibilityWaitRunner(enqueueCheckpointEligibilityWait);
}
