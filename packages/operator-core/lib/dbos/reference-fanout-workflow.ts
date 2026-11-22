import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import { coordScopeReady } from '../agent-tools/coordination/log';
import { outboxFanoutDeps, runFanoutForChange } from '../sync/hyperbee/fanout-projection';
import { REFERENCE_FANOUT_QUEUE, REFERENCE_FANOUT_WORKFLOW, type ReferenceFanoutInput } from '../sync/hyperbee/durable-fanout';
import { runWithWorkspace } from '../workspace-als';
import { idempotentRegisterWorkflow, idempotentWorkflowQueue } from './idempotent-register-workflow';

idempotentWorkflowQueue(REFERENCE_FANOUT_QUEUE, () =>
  new WorkflowQueue(REFERENCE_FANOUT_QUEUE, { partitionConcurrency: 1 }));

async function referenceFanout(input: ReferenceFanoutInput): Promise<number> {
  return runWithWorkspace(input.workspaceId, () => runFanoutForChange(input, {
    resolve: object => DBOS.runStep(async () => {
      await coordScopeReady();
      return outboxFanoutDeps.resolve(object);
    }, { name: 'refresh-recipients' }),
    deliver: (id, sub, ev, object) => DBOS.runStep(async () => {
      await coordScopeReady();
      return outboxFanoutDeps.deliver(id, sub, ev, object);
    }, { name: 'write-recipient' }),
    recordFailure: (id, sub, ev, object, error) => DBOS.runStep(async () => {
      await coordScopeReady();
      await outboxFanoutDeps.recordFailure(id, sub, ev, object, error);
    }, { name: 'record-recipient-failure' }),
  }));
}

export const referenceFanoutWorkflow = idempotentRegisterWorkflow(REFERENCE_FANOUT_WORKFLOW, () =>
  DBOS.registerWorkflow(referenceFanout, { name: REFERENCE_FANOUT_WORKFLOW }));
