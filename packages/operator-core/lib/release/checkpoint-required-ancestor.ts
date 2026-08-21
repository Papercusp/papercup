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
    const [
      { activeWorkspaceId },
      { operatorHomeHarnessSlug },
      { readFrozenCandidateRepairQueue, releaseFixerSpawnAlive },
    ] = await Promise.all([
      import('../workspace-registry'),
      import('../harness/operator-home-harness'),
      import('../harness/routines/release-actions'),
    ]);
    repairQueue = await readFrozenCandidateRepairQueue({
      workspaceId: activeWorkspaceId(),
      installSlug: operatorHomeHarnessSlug(),
    });

    if (repairQueue?.phase === 'awaiting-fixer' && repairQueue.fixerSpawnId) {
      try {
        const { getOrgPg } = await import('@papercusp/db-org');
        fixerAlive = await releaseFixerSpawnAlive(getOrgPg().sql, repairQueue.fixerSpawnId);
      } catch {
        // Liveness UNKNOWN must preserve the queue and refuse this exact-lineage launch.
        fixerAlive = null;
      }
    }
    queueDecision = decideFrozenCandidateRepairQueue(repairQueue, { nowMs: Date.now(), fixerAlive });
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
