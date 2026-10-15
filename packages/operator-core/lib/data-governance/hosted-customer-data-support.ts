/** Internal P-010 support recovery. Reuses customer consent, the immutable
 * admission, the version-pinned DBOS client and the organization audit ledger.
 * This consumer does not grant staff capabilities or expose a public route. */
import { randomUUID } from 'node:crypto';
import { withHostedServiceContext } from '@papercusp/db-org';
import type { Principal } from '@papercusp/agent-mcp';
import type { Sql } from 'postgres';
import { appendOrganizationAuditEvent } from '../auth/hosted/governance';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
import type { HostedCustomerDeletionEnqueuer, HostedCustomerDeletionRecovery } from '../dbos/workspace-host-provision-client';
import { resolveApprovedHostedCustomerDeletionPolicy, type HostedCustomerDeletionPolicy } from './hosted-customer-deletion';
import { readAdmittedHostedCustomerDeletion } from './hosted-customer-deletion-store';

export const CUSTOMER_DELETION_RECOVERY_SCOPE = 'customer-data:deletion:recover';

export class PostgresHostedCustomerDataSupport {
  constructor(private readonly options: {
    client: Pick<HostedCustomerDeletionEnqueuer, 'recoverCustomerDeletion'>;
    runService?: HostedServiceContextRunner;
    resolveApprovedPolicy?: () => Promise<HostedCustomerDeletionPolicy | null>;
  }) {}

  async recoverDeletion(principal: Principal | null, input: { organizationId: string; operationId: string; grantId: string }) {
    if (!principal || principal.kind !== 'user' || principal.trust !== 'verified'
      || principal.authMethod !== 'cookie-session' || !principal.slug.trim() || !principal.roles?.has('staff')
      || !principal.capabilities.has(CUSTOMER_DELETION_RECOVERY_SCOPE)) throw new Error('customer_data_support_staff_required');
    const pin = { ...input, staffId: principal.slug, attemptId: randomUUID() };
    const run = this.options.runService ?? withHostedServiceContext;
    const policy = this.options.resolveApprovedPolicy ?? resolveApprovedHostedCustomerDeletionPolicy;
    const authorize = async (tx: Sql) => {
      await tx`SELECT set_config('app.organization_id', ${pin.organizationId}, true)`;
      const grants = await tx<{ purpose: string }[]>`
        SELECT data->>'purpose' AS purpose FROM papercusp_auth.read_hosted_customer_export_rows(
          'papercusp_auth.support_access_grants', ${pin.organizationId})
         WHERE data->>'id' = ${pin.grantId} AND data->>'staff_principal_id' = ${pin.staffId}
           AND data->>'workspace_id' IS NULL
           AND data->'scopes' @> jsonb_build_array(${CUSTOMER_DELETION_RECOVERY_SCOPE}::text)
           AND (data->>'starts_at')::timestamptz <= clock_timestamp()
           AND (data->>'expires_at')::timestamptz > clock_timestamp() AND data->>'revoked_at' IS NULL`;
      if (grants.length !== 1 || !grants[0]?.purpose.trim()) throw new Error('customer_data_support_grant_inactive');
      // Frozen lifecycle is expected here. It never grants arbitrary reads or
      // new deletion authority: only this previously admitted operation may run.
      return { purpose: grants[0].purpose, request: await readAdmittedHostedCustomerDeletion(tx,
        pin.organizationId, pin.operationId, policy) };
    };
    const receipt = (tx: Sql, purpose: string, phase: string, result?: HostedCustomerDeletionRecovery) => appendOrganizationAuditEvent({
      organizationId: pin.organizationId, actorKind: 'staff_admin', actorId: pin.staffId,
      action: `organization.data.deletion.recovery.${phase}`, purpose, targetType: 'deletion_operation', targetId: pin.operationId,
      metadata: { operationId: pin.operationId, grantId: pin.grantId, attemptId: pin.attemptId,
        ...(result ? { workflowId: result.workflowId, originalWorkflowId: result.originalWorkflowId ?? result.workflowId,
          recoveredFromWorkflowId: result.recoveredFromWorkflowId ?? null } : {}) },
    }, tx);
    // The attempt must be durably auditable BEFORE a separate DBOS write.
    await run(async tx => { const { purpose } = await authorize(tx); await receipt(tx, purpose, 'requested'); });
    return run(async tx => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`hosted-deletion-recovery:${pin.organizationId}:${pin.operationId}`}, 0))`;
      const { purpose, request } = await authorize(tx);
      const result = await this.options.client.recoverCustomerDeletion(request);
      await receipt(tx, purpose, result.outcome, result);
      return result;
    });
  }
}
