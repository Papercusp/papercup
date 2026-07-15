import { markAdvSessionEnded, updateAdvSessionPortStatus } from '../adv-sessions';
import { deleteSessionPortArtifact, pruneStaleSessionPortArtifacts } from './artifact';
import {
  sessionPortsNeedingCleanup,
  transitionSessionPort,
  type SessionPortRow,
} from './store';

export interface SessionPortCleanupResult {
  expiredRows: number;
  targetsFailed: number;
  artifactsDeleted: number;
  orphanArtifactsDeleted: number;
  errors: number;
}

/** Reused by the existing telemetry-retention action. This is deliberately not
 * its own timer/routine: immediate delivery deletion is primary, and this
 * idempotent pass repairs only crash/TTL residue. */
export async function cleanupExpiredSessionPorts(input: {
  workspaceId: string;
  rows?: SessionPortRow[];
  list?: typeof sessionPortsNeedingCleanup;
  deleteArtifact?: typeof deleteSessionPortArtifact;
  pruneArtifacts?: typeof pruneStaleSessionPortArtifacts;
  updateTarget?: typeof updateAdvSessionPortStatus;
  endTarget?: typeof markAdvSessionEnded;
  transition?: typeof transitionSessionPort;
}): Promise<SessionPortCleanupResult> {
  const list = input.list ?? sessionPortsNeedingCleanup;
  const rows = input.rows ?? await list(input.workspaceId);
  const deleteArtifact = input.deleteArtifact ?? deleteSessionPortArtifact;
  const updateTarget = input.updateTarget ?? updateAdvSessionPortStatus;
  const endTarget = input.endTarget ?? markAdvSessionEnded;
  const transition = input.transition ?? transitionSessionPort;
  const out: SessionPortCleanupResult = {
    expiredRows: rows.length,
    targetsFailed: 0,
    artifactsDeleted: 0,
    orphanArtifactsDeleted: 0,
    errors: 0,
  };

  for (const row of rows) {
    let artifactComplete = false;
    try {
      const deleted = await deleteArtifact(row.artifactPath);
      if (deleted) out.artifactsDeleted += 1;
      artifactComplete = true; // false means already absent, also complete
    } catch {
      out.errors += 1;
    }

    let targetComplete = row.targetAdvSessionId == null;
    if (row.targetAdvSessionId != null) {
      try {
        targetComplete = await updateTarget(row.targetAdvSessionId, input.workspaceId, 'failed', {
          deliveryErrorClass: 'preparation-expired',
        });
        await endTarget(row.targetAdvSessionId, 1);
        if (targetComplete) out.targetsFailed += 1;
        else out.errors += 1;
      } catch {
        out.errors += 1;
      }
    }

    try {
      await transition(row.id, input.workspaceId, 'expired', {
        metadata: {
          cleanupComplete: artifactComplete && targetComplete,
          cleanupArtifactAbsent: artifactComplete,
          cleanupTargetEnded: targetComplete,
        },
      });
    } catch {
      out.errors += 1;
    }
  }

  try {
    const pruned = await (input.pruneArtifacts ?? pruneStaleSessionPortArtifacts)();
    out.orphanArtifactsDeleted = pruned.removed;
    out.errors += pruned.errors;
  } catch {
    out.errors += 1;
  }
  return out;
}
