/**
 * `release:byoc_readiness` — computed, read-only BYOC acceptance evidence.
 *
 * This is deliberately a thin projection over the canonical task-ledger release
 * journal (`byoc-release-carry.ts`). It does not accept an instrument snapshot
 * from the caller and it does not infer readiness from prose: each BAR verdict
 * is recomputed from committed receipt milestones and their evidence references
 * at read time. It is intentionally not registered in the live tool index yet:
 * the current release journal carries publication receipts, but not the complete
 * R-5/R-6 operational evidence population, so exposing this draft as a grading
 * probe would create a false confidence path.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  readLinkedByocReleaseCarries,
  type ByocReleaseCarrySnapshot,
  type ByocReleaseMilestoneKey,
} from '../../byoc-release-carry';

export type ByocAcceptanceBar = 'R-4' | 'R-5' | 'R-6';
export type ByocReadinessVerdict = 'pass' | 'fail' | 'unknown';

const BAR_MILESTONES: Record<ByocAcceptanceBar, readonly ByocReleaseMilestoneKey[]> = {
  'R-4': ['build', 'publication'],
  'R-5': ['root-bootstrap', 'fixed-agent-initialization', 'customer-acceptance'],
  'R-6': ['soak-24h', 'resource-census', 'billing-closure', 'cleanup', 'shipment'],
};

function nonEmptyObject(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
}

function milestoneFor(snapshot: ByocReleaseCarrySnapshot, key: ByocReleaseMilestoneKey) {
  return snapshot.milestoneProjection.milestones.find((milestone) => milestone.key === key) ?? null;
}

export interface ByocReadinessResult {
  verdict: ByocReadinessVerdict;
  bar: ByocAcceptanceBar;
  workItemId: string;
  measuredAt: string;
  taskIds: string[];
  evidenceRefs: string[];
  missingMilestones: string[];
  failedMilestones: string[];
  contradictions: string[];
  artifactIdentityPresent: boolean;
  releaseTaskSelection: 'explicit' | 'ambiguous' | 'absent';
}

export function evaluateByocReadiness(
  bar: ByocAcceptanceBar,
  workItemId: string,
  snapshots: readonly ByocReleaseCarrySnapshot[],
  measuredAt = new Date().toISOString(),
): ByocReadinessResult {
  const taskIds = snapshots.map((snapshot) => snapshot.taskId);
  const evidenceRefs = [...new Set(snapshots.flatMap((snapshot) => snapshot.evidenceRefs))];
  const contradictions = [...new Set(snapshots.flatMap((snapshot) => snapshot.milestoneProjection.contradictions))];
  const missingMilestones: string[] = [];
  const failedMilestones: string[] = [];
  let artifactIdentityPresent = false;

  for (const snapshot of snapshots) {
    artifactIdentityPresent ||= nonEmptyObject(snapshot.artifactIdentity);
    for (const key of BAR_MILESTONES[bar]) {
      const milestone = milestoneFor(snapshot, key);
      if (!milestone || milestone.status === 'pending' || milestone.status === 'blocked') {
        missingMilestones.push(`${snapshot.taskId}:${key}`);
      } else if (milestone.status === 'failed') {
        failedMilestones.push(`${snapshot.taskId}:${key}`);
      }
      if (milestone && milestone.status === 'verified' && milestone.evidenceRefs.length === 0) {
        missingMilestones.push(`${snapshot.taskId}:${key}:evidence`);
      }
    }
  }

  if (snapshots.length === 0) {
    return {
      verdict: 'unknown',
      bar,
      workItemId,
      measuredAt,
      taskIds,
      evidenceRefs,
      missingMilestones: ['release-task'],
      failedMilestones,
      contradictions,
      artifactIdentityPresent,
      releaseTaskSelection: 'absent',
    };
  }

  // A work-item can retain multiple historical release tasks. Treating "any of
  // the latest three" as the acceptance subject would let an older successful
  // receipt launder a newer failed attempt. The caller must narrow to one task
  // before this reader can produce a positive verdict.
  if (snapshots.length !== 1) {
    return {
      verdict: 'unknown',
      bar,
      workItemId,
      measuredAt,
      taskIds,
      evidenceRefs,
      missingMilestones: ['release-task-selection'],
      failedMilestones,
      contradictions,
      artifactIdentityPresent,
      releaseTaskSelection: 'ambiguous',
    };
  }

  if (bar === 'R-4' && !artifactIdentityPresent) missingMilestones.push('artifact-identity');
  const verdict: ByocReadinessVerdict =
    failedMilestones.length > 0 || contradictions.length > 0
      ? 'fail'
      : missingMilestones.length > 0
        ? 'unknown'
        : 'pass';

  return {
    verdict,
    bar,
    workItemId,
    measuredAt,
    taskIds,
    evidenceRefs,
    missingMilestones: [...new Set(missingMilestones)],
    failedMilestones: [...new Set(failedMilestones)],
    contradictions,
    artifactIdentityPresent,
    releaseTaskSelection: 'explicit',
  };
}

export default defineTool({
  name: 'release:byoc_readiness',
  description:
    'Read computed BYOC acceptance readiness for one BAR from the canonical task-ledger release journal. ' +
    'This is a live, read-only evidence projection for typed scorecard probes; it never accepts caller-supplied snapshots.',
  guidance: {
    when: 'At grading time for BYOC R-4, R-5, or R-6, after the maintained release driver has recorded receipts.',
    notWhen: 'To mutate a release, replace a live journey, or treat a missing receipt as success.',
    chaining:
      'release:byoc_readiness { bar:"R-4"|"R-5"|"R-6", workItemId } → verdict:"pass" is the only healthy reading; unknown/fail are not shippable.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES, 'release-fixer'],
  args: z.object({
    bar: z.enum(['R-4', 'R-5', 'R-6']),
    workItemId: z.string().min(1).max(120),
    taskId: z.string().min(1).max(120).optional(),
  }),
  async handler(args) {
    const snapshots = await readLinkedByocReleaseCarries(
      {
        ownerId: '',
        workspaceId: activeWorkspaceId(),
        heldWorkItemIds: [args.workItemId],
        limit: 3,
      },
      getOrgPg().sql,
    );
    const selected = args.taskId
      ? snapshots.filter((snapshot) => snapshot.taskId === args.taskId)
      : snapshots;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(evaluateByocReadiness(args.bar, args.workItemId, selected)),
        },
      ],
    };
  },
});
