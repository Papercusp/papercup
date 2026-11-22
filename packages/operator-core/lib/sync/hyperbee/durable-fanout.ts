import { createHash } from 'node:crypto';
import type { DBOSClient } from '@dbos-inc/dbos-sdk';
import { getOrgPg } from '@papercusp/db-org';
import { coordScopeWorkspace, coordScopeReady } from '../../agent-tools/coordination/log';
import { runWithWorkspace } from '../../workspace-als';
import { FANOUT_PENDING } from './outbox-drain';
import { prepareFanoutChange, type FanoutChange, type OutboxFanoutRow } from './fanout-projection';

export const REFERENCE_FANOUT_WORKFLOW = 'referenceFanout';
export const REFERENCE_FANOUT_QUEUE = 'reference-fanout';

export interface ReferenceFanoutInput extends FanoutChange {
  workspaceId: string;
}

function digest(parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Preserve the snapshot of recipients and every step preceding the first failed effect. */
async function firstUnfinishedStep(client: DBOSClient, workflowId: string): Promise<number> {
  let offset = 0;
  let next = 0;
  const pageSize = 128;
  for (;;) {
    const steps = await client.listWorkflowSteps(workflowId, { offset, limit: pageSize });
    if (!steps) throw new Error(`Missing reference fan-out journal for ${workflowId}`);
    for (const step of steps) {
      if (step.error) return step.functionID;
      next = step.functionID + 1;
    }
    if (steps.length < pageSize) return next;
    offset += steps.length;
  }
}

/** Queue by object for ordering, identify work by the immutable version. A second
 * version may enter the queue while the first version is executing. */
export async function dispatchOutboxFanout(workspaceId: string, row: OutboxFanoutRow) {
  const change = prepareFanoutChange(row);
  if (!change) return;
  const input: ReferenceFanoutInput = { workspaceId, ...change };
  const workflowID = 'reference-fanout:' + digest([workspaceId, change.outboxId]);
  const queuePartitionKey = digest([workspaceId, change.object.kind, change.object.ref]);
  const { getPrimaryDbosClient, primaryDbosAppVersion } = await import('../../dbos/primary-dbos-client');
  const client = await getPrimaryDbosClient();
  let status = await client.getWorkflow(workflowID);
  if (!status) {
    await client.enqueue({ workflowID, workflowName: REFERENCE_FANOUT_WORKFLOW,
      queueName: REFERENCE_FANOUT_QUEUE, queuePartitionKey, appVersion: primaryDbosAppVersion() }, input);
    return FANOUT_PENDING;
  }
  if (status.status === 'ERROR') {
    // A failed original remains in DBOS. Find its latest recovery before admitting another.
    const [latest] = await client.listWorkflows({ workflow_id_prefix: workflowID + ':retry:',
      workflowName: REFERENCE_FANOUT_WORKFLOW, sortDesc: true, limit: 1, loadInput: false, loadOutput: false });
    status = latest ?? status;
  }
  switch (status.status) {
    case 'SUCCESS': {
      // A failed recipient may already be in the separate per-subscriber retry ledger.
      // Retain the source row until that delivery is settled as well.
      return runWithWorkspace(workspaceId, async () => {
        await coordScopeReady();
        const pending = await getOrgPg().sql`
          SELECT 1 FROM harness_shared.substrate_fanout_deliveries
           WHERE workspace_id = ${coordScopeWorkspace()} AND outbox_id = ${change.outboxId}::bigint
             AND state = 'pending' LIMIT 1`;
        return pending.length ? FANOUT_PENDING : undefined;
      });
    }
    case 'ERROR':
      await client.forkWorkflow(status.workflowID, await firstUnfinishedStep(client, status.workflowID), {
        newWorkflowID: workflowID + ':retry:' + digest([status.workflowID]), queueName: REFERENCE_FANOUT_QUEUE,
        queuePartitionKey, applicationVersion: primaryDbosAppVersion(),
      });
      break;
    case 'CANCELLED':
    case 'MAX_RECOVERY_ATTEMPTS_EXCEEDED':
      await client.resumeWorkflow(status.workflowID, { queueName: REFERENCE_FANOUT_QUEUE });
      break;
    case 'PENDING':
    case 'ENQUEUED':
    case 'DELAYED':
      break;
    default:
      throw new Error(`Unknown reference fan-out status ${status.status} for ${status.workflowID}`);
  }
  return FANOUT_PENDING;
}
