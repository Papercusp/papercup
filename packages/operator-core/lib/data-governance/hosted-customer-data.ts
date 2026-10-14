/** Hosted customer-data operations (cloud-portal P-010).
 * Uses the existing service transaction and the single organization receipt writer.
 */
import type { Sql } from 'postgres';
import { createHostedPrincipal, type HostedPrincipal } from '../auth/hosted-principal';
import { HostedSessionStore } from '../auth/hosted-session';
import { PostgresHostedMembershipAuthority } from '../auth/hosted-membership-authority';
import { exportOrganizationData, type OrganizationDataExport } from './organization-data-receipts';

export class HostedCustomerDataAuthorizationError extends Error {
  constructor() { super('customer_data_forbidden'); }
}

/** Session, current membership and lifecycle checks remain locked until the export
 * and its receipt commit. A browser cannot choose an organization or workspace.
 */
export async function exportHostedOrganizationData(tx: Sql, principal: HostedPrincipal): Promise<OrganizationDataExport> {
  return exportHostedCustomerData(tx, principal, false);
}

export async function exportHostedUserData(tx: Sql, principal: HostedPrincipal): Promise<OrganizationDataExport> {
  return exportHostedCustomerData(tx, principal, true);
}

async function exportHostedCustomerData(tx: Sql, principal: HostedPrincipal, userOnly: boolean): Promise<OrganizationDataExport> {
  const session = await new HostedSessionStore(tx as never).resolveForUpdate(principal.sessionId, {
    expectedPermissionVersion: principal.sessionVersion,
  });
  if (!session || session.userId !== principal.userId || session.organizationId !== principal.activeOrganizationId
    || session.workspaceId !== (principal.selectedWorkspaceId ?? null)) {
    throw new HostedCustomerDataAuthorizationError();
  }
  const membership = await new PostgresHostedMembershipAuthority(tx as never).resolveActiveForUpdate({
    userId: principal.userId, organizationId: principal.activeOrganizationId,
  });
  if (!membership || membership.permissionVersion !== session.permissionVersion
    || !membership.permissions.has(userOnly ? 'workspace:view' : 'members:manage')) throw new HostedCustomerDataAuthorizationError();
  const active = await tx`
    SELECT u.id FROM papercusp_auth.hosted_users u
      JOIN papercusp_auth.organizations o ON o.id = ${principal.activeOrganizationId}::uuid
     WHERE u.id = ${principal.userId}::uuid AND u.status = 'active' AND o.status = 'active'
     FOR SHARE OF u, o`;
  if (active.length !== 1) throw new HostedCustomerDataAuthorizationError();
  const fresh = createHostedPrincipal({ ...principal, permissions: membership.permissions });
  await tx`SELECT set_config('app.organization_id', ${fresh.activeOrganizationId}, true)`;
  return exportOrganizationData(tx, {
    hostedReadBridge: true,
    executor: 'hosted-control-plane', scope: { organizationId: fresh.activeOrganizationId, workspaceIds: [],
      ...(userOnly ? { userId: fresh.userId } : {}) },
    actor: { kind: 'customer_user', principal: fresh }, purpose: userOnly ? 'Self-service user data export' : 'Self-service organization data export',
  }, tx);
}
