/** DBOS adapter for the replay-safe P-010 customer deletion chain. */
import { DBOS } from '@dbos-inc/dbos-sdk';
import { idempotentRegisterWorkflow } from './idempotent-register-workflow';
import {
  runHostedCustomerDeletion,
  type HostedCustomerDeletionRequest,
  type HostedCustomerDeletionResult,
  type HostedCustomerDeletionSeams,
} from '../data-governance/hosted-customer-deletion';

export const HOSTED_CUSTOMER_DELETION_WORKFLOW_NAME = 'hosted-customer-deletion';

export interface HostedCustomerDeletionWorkflowRuntime {
  readonly seams: HostedCustomerDeletionSeams;
}

/**
 * Bind storage/provider seams once at application bootstrap.  DBOS persists the
 * workflow invocation; each injected operation must itself be idempotent on the
 * operation id and its canonical provider receipt.
 */
export function createHostedCustomerDeletionWorkflow(runtime: HostedCustomerDeletionWorkflowRuntime) {
  const implementation = async (request: HostedCustomerDeletionRequest): Promise<HostedCustomerDeletionResult> => {
    return runHostedCustomerDeletion(request, runtime.seams, (name, run) => DBOS.runStep(run, {
      name: `hosted-customer-deletion:${name}`,
      retriesAllowed: name !== 'authorize', maxAttempts: 3, intervalSeconds: 2,
    }));
  };
  return idempotentRegisterWorkflow(HOSTED_CUSTOMER_DELETION_WORKFLOW_NAME, () =>
    DBOS.registerWorkflow(implementation, { name: HOSTED_CUSTOMER_DELETION_WORKFLOW_NAME, maxRecoveryAttempts: 20 }),
  );
}
