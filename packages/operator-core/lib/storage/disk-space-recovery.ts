import type { AcquireResult, ConditionOwnerSpec } from '../coord/condition-bridge';
import type { WorkItem } from '../work-items';
import type { NudgeRecipient } from '../scout/nudge-recipient';
import type { assignAndWakeActionableWorkItems } from '../agent-tools/coordination/actionable-work-item-dispatch';
import { DISK_SPACE_ALARM_CONDITION_KEY } from '../coord/actionable-conditions';

export interface DiskRecoveryResult {
  workItem: string | null;
  owner: string | null;
  status: 'assigned' | 'unavailable';
  reason?: string;
  pickupConfirmed?: boolean;
}

export interface DiskRecoveryRequest {
  title: string;
  body: string;
  /** Retry a required wake that failed on an earlier pass, even after assignment landed. */
  retryWake?: boolean;
}

export interface DiskRecoveryDeps {
  workspaceId: string;
  harness: string;
  acquire: (key: string, spec: ConditionOwnerSpec) => Promise<Pick<AcquireResult, 'workItem'>>;
  readItem: (id: string) => Promise<Pick<WorkItem, 'assignee'> | null>;
  recipient: () => Promise<NudgeRecipient>;
  dispatch: typeof assignAndWakeActionableWorkItems;
}

/** Reuse the condition singleton and canonical admission/claim/required-wake path.
 * Assignment/wake receipts are deliberately not reported as measured recovery. */
export async function ensureDiskRecoveryOwner(
  request: DiskRecoveryRequest,
  injected?: DiskRecoveryDeps,
): Promise<DiskRecoveryResult> {
  let workItem: string | null = null;
  try {
    const deps = injected ?? await productionDeps();
    const acquired = await deps.acquire(DISK_SPACE_ALARM_CONDITION_KEY, {
      title: request.title, summary: request.body, harness: deps.harness,
      workspaceId: deps.workspaceId, severity: 'critical',
    });
    workItem = acquired.workItem;
    if (!workItem) return { workItem, owner: null, status: 'unavailable', reason: 'Condition ownership could not be established.' };
    const incumbent = await deps.readItem(workItem);
    let owner = incumbent?.assignee ?? null;
    if (!owner) {
      const recipient = await deps.recipient();
      if (recipient.kind !== 'su') return { workItem, owner: null, status: 'unavailable', reason: recipient.why };
      owner = recipient.ownerId;
    }
    const result = await deps.dispatch({
      workItemIds: [workItem], targetAgent: owner, workspaceId: deps.workspaceId,
      harness: deps.harness, actor: 'system:disk-space-alarm',
      summary: request.title, instructions: request.body, source: 'disk-space-alarm',
      // A held incident already has a driver. Avoid a second cleanup assignment.
      wakeRetained: request.retryWake === true,
    });
    if (result.target && (!result.target.present || result.target.sessionState === 'ended')) {
      return { workItem, owner, status: 'unavailable', reason: 'The assigned recovery owner is absent or ended; custody must be recovered.' };
    }
    if (!result.ok || !result.assignment.executionWorkItemIds.includes(workItem)) {
      return { workItem, owner, status: 'unavailable', reason: result.warning ??
        (result.assignment.skipped.map((skip) => skip.reason).join('; ') || 'Recovery dispatch refused.') };
    }
    return { workItem, owner, status: 'assigned',
      ...(result.wake ? { pickupConfirmed: result.wake.pickupConfirmed } : {}) };
  } catch (error) {
    return { workItem, owner: null, status: 'unavailable', reason: String(error) };
  }
}

async function productionDeps(): Promise<DiskRecoveryDeps> {
  // Keep the alarm's readiness graph small until recovery is actually needed.
  const [{ activeWorkspaceId }, { operatorHomeHarnessSlug }, bridge, items, recipients, dispatch] = await Promise.all([
    import('../workspace-registry'), import('../harness/operator-home-harness'),
    import('../coord/condition-bridge'), import('../work-items'),
    import('../scout/nudge-recipient'), import('../agent-tools/coordination/actionable-work-item-dispatch'),
  ]);
  const workspaceId = activeWorkspaceId(), harness = operatorHomeHarnessSlug();
  return {
    workspaceId, harness, acquire: bridge.acquireConditionOwner,
    readItem: (id) => items.getWorkItem(id, harness),
    recipient: () => recipients.resolveNudgeRecipient({ workspaceId, mugOwner: null }),
    dispatch: dispatch.assignAndWakeActionableWorkItems,
  };
}
