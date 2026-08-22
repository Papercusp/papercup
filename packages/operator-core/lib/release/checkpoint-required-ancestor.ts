import { spawnSync } from 'node:child_process';
import {
  checkpointCandidateContainsAncestor,
  currentCheckpointCandidate,
} from '../release-checkpoint-launch';
import { integrationRoot } from '../release-deploy-launch';
import {
  decideFrozenCandidateRepairQueue,
  type FrozenCandidateRepairQueue,
  type FrozenRepairQueueDecision,
} from './frozen-candidate-repair-queue';

export type RequiredAncestorPreflight = {
  ok: boolean;
  reason: 'contained' | 'not-ancestor' | 'unverifiable' | 'queue-unreadable' | 'queue-not-runnable';
  requiredAncestor: string | null;
  candidate: string | null;
  candidateSource: 'frozen-repair-queue' | 'current-quiet-cut' | 'unresolved';
  repairQueue: FrozenCandidateRepairQueue | null;
  queueDecision: FrozenRepairQueueDecision['kind'] | null;
  fixerAlive: boolean | null;
  detail?: string;
};

export type FrozenRepairQueuePreflight = {
  /** True when the detached writer can reach a suite-producing path. */
  proceed: boolean;
  reason: 'clear' | 'repair-in-progress' | 'queue-unreadable';
  candidate: string | null;
  repairQueue: FrozenCandidateRepairQueue | null;
  queueDecision: FrozenRepairQueueDecision['kind'] | null;
  nextAttempt: number | null;
  fixerSpawnId: string | null;
  fixerAlive: boolean | null;
  detail?: string;
};

type FrozenRepairQueueState = {
  repairQueue: FrozenCandidateRepairQueue | null;
  queueDecision: FrozenRepairQueueDecision;
  fixerAlive: boolean | null;
};

/**
 * Read the same persisted queue and fixer liveness used by the detached checkpoint writer.
 * Keeping this read beside the required-ancestor guard prevents the manual launcher from
 * inventing a second queue policy.
 */
async function readFrozenRepairQueueState(): Promise<FrozenRepairQueueState> {
  const [
    { activeWorkspaceId },
    { operatorHomeHarnessSlug },
    { readFrozenCandidateRepairQueue, releaseFixerSpawnAlive },
  ] = await Promise.all([
    import('../workspace-registry'),
    import('../harness/operator-home-harness'),
    import('../harness/routines/release-actions'),
  ]);
  const repairQueue = await readFrozenCandidateRepairQueue({
    workspaceId: activeWorkspaceId(),
    installSlug: operatorHomeHarnessSlug(),
  });

  let fixerAlive: boolean | null = null;
  if (repairQueue?.phase === 'awaiting-fixer' && repairQueue.fixerSpawnId) {
    try {
      const { getOrgPg } = await import('@papercusp/db-org');
      fixerAlive = await releaseFixerSpawnAlive(getOrgPg().sql, repairQueue.fixerSpawnId);
    } catch {
      // Liveness UNKNOWN must preserve the queue and refuse a launch that could short-circuit.
      fixerAlive = null;
    }
  }

  return {
    repairQueue,
    fixerAlive,
    queueDecision: decideFrozenCandidateRepairQueue(repairQueue, { nowMs: Date.now(), fixerAlive }),
  };
}

/**
 * Guard an ordinary detached launch against queue states whose writer returns
 * `repair-in-progress` without running a suite. The writer's `abandon-repair` and
 * `verify-repair` decisions continue into a suite-producing path, so they are allowed here;
 * every other queue decision refuses before the systemd unit is created.
 */
export async function assessFrozenRepairQueuePreflight(): Promise<FrozenRepairQueuePreflight> {
  let repairQueue: FrozenCandidateRepairQueue | null = null;
  let fixerAlive: boolean | null = null;
  try {
    const state = await readFrozenRepairQueueState();
    repairQueue = state.repairQueue;
    fixerAlive = state.fixerAlive;
    const { queueDecision } = state;
    const suiteProducingDecision =
      queueDecision.kind === 'run-normal-gate' ||
      queueDecision.kind === 'verify-repair' ||
      queueDecision.kind === 'abandon-repair';
    return {
      proceed: suiteProducingDecision,
      reason: suiteProducingDecision ? 'clear' : 'repair-in-progress',
      candidate: repairQueue?.repairHead ?? null,
      repairQueue,
      queueDecision: queueDecision.kind,
      nextAttempt: queueDecision.kind === 'dispatch-fixer' ? queueDecision.nextAttempt : null,
      fixerSpawnId: repairQueue?.fixerSpawnId ?? null,
      fixerAlive,
      ...(!suiteProducingDecision
        ? { detail: `frozen repair policy chose ${queueDecision.kind}; the writer will not run a suite` }
        : {}),
    };
  } catch (error) {
    return {
      proceed: false,
      reason: 'queue-unreadable',
      candidate: null,
      repairQueue,
      queueDecision: null,
      nextAttempt: null,
      fixerSpawnId: null,
      fixerAlive,
      detail: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
    };
  }
}

/**
 * Resolve and verify the candidate a detached checkpoint writer will use when a caller
 * supplies a release-critical required ancestor. The durable eligibility waiter calls this
 * again after its quiet-cut delay, so a deferred launch cannot outlive the caller's lineage
 * guarantee.
 */
export async function assessRequiredAncestorPreflight(
  requiredAncestor: string,
  predictedCandidate: string | null,
  root = integrationRoot(),
): Promise<RequiredAncestorPreflight> {
  let repairQueue: FrozenCandidateRepairQueue | null = null;
  let fixerAlive: boolean | null = null;
  let queueDecision: FrozenRepairQueueDecision;
  try {
    const state = await readFrozenRepairQueueState();
    repairQueue = state.repairQueue;
    fixerAlive = state.fixerAlive;
    queueDecision = state.queueDecision;
  } catch (error) {
    return {
      ok: false,
      reason: 'queue-unreadable',
      requiredAncestor: null,
      candidate: null,
      candidateSource: 'unresolved',
      repairQueue,
      queueDecision: null,
      fixerAlive,
      detail: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
    };
  }

  const execFn = (cmd: string, argv: string[]) => {
    const result = spawnSync(cmd, argv, { encoding: 'utf8' });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
  const current = predictedCandidate ?? currentCheckpointCandidate(root, execFn).current_candidate;
  const runnableCandidate =
    queueDecision.kind === 'verify-repair'
      ? { candidate: queueDecision.candidate, source: 'frozen-repair-queue' as const }
      : queueDecision.kind === 'run-normal-gate' || queueDecision.kind === 'abandon-repair'
        ? { candidate: current, source: current ? ('current-quiet-cut' as const) : ('unresolved' as const) }
        : null;
  if (!runnableCandidate) {
    return {
      ok: false,
      reason: 'queue-not-runnable',
      requiredAncestor: null,
      candidate: null,
      candidateSource: 'unresolved',
      repairQueue,
      queueDecision: queueDecision.kind,
      fixerAlive,
      detail: `frozen repair policy chose ${queueDecision.kind}`,
    };
  }
  const { candidate, source: candidateSource } = runnableCandidate;
  if (!candidate) {
    return {
      ok: false,
      reason: 'unverifiable',
      requiredAncestor: null,
      candidate: null,
      candidateSource,
      repairQueue,
      queueDecision: queueDecision.kind,
      fixerAlive,
    };
  }

  const check = checkpointCandidateContainsAncestor(root, requiredAncestor, candidate, execFn);
  return {
    ...check,
    candidateSource,
    repairQueue,
    queueDecision: queueDecision.kind,
    fixerAlive,
  };
}
