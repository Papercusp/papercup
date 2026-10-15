import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@papercusp/agent-mcp';
import type { Sql } from 'postgres';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
vi.mock('@papercusp/db-org', () => ({ withHostedServiceContext: vi.fn() }));
vi.mock('../auth/hosted/governance', () => ({ appendOrganizationAuditEvent: vi.fn() }));
vi.mock('./hosted-customer-deletion-store', () => ({ readAdmittedHostedCustomerDeletion: vi.fn() }));
import { appendOrganizationAuditEvent } from '../auth/hosted/governance';
import { readAdmittedHostedCustomerDeletion } from './hosted-customer-deletion-store';
import { CUSTOMER_DELETION_RECOVERY_SCOPE, PostgresHostedCustomerDataSupport } from './hosted-customer-data-support';

const staff = (overrides: Partial<Principal> = {}): Principal => ({ kind: 'user', slug: 'staff-1', workspaceId: 'control',
  trust: 'verified', authMethod: 'cookie-session', roles: new Set(['staff']), capabilities: new Set([CUSTOMER_DELETION_RECOVERY_SCOPE]), ...overrides });
const input = { organizationId: 'org', operationId: 'operation', grantId: 'grant' };
const request = { operationId: 'operation', organizationId: 'org', requestedBy: 'original-customer', target: { kind: 'organization' as const },
  policy: { approvalRef: 'approved', stripe: 'retain' as const, consent: 'retain' as const } };

beforeEach(() => vi.resetAllMocks());
function fixture() {
  const order: string[] = []; let grantActive = true;
  const query = vi.fn(async (parts: TemplateStringsArray) => parts.join('').includes('support_access_grants')
    ? grantActive ? [{ purpose: 'Customer requested recovery' }] : [] : []);
  const runService: HostedServiceContextRunner = async fn => { const result = await fn(query as unknown as Sql); order.push('committed'); return result; };
  vi.mocked(readAdmittedHostedCustomerDeletion).mockImplementation(async (_tx, _org, _operation, resolve) => {
    if (!await resolve()) throw new Error('retention-policy-not-approved'); return request;
  });
  vi.mocked(appendOrganizationAuditEvent).mockImplementation(async event => { order.push(event.action); return 'receipt'; });
  const recoverCustomerDeletion = vi.fn(async () => {
    expect(order.slice(0, 2)).toEqual(['organization.data.deletion.recovery.requested', 'committed']);
    order.push('dbos'); return { workflowId: 'same-workflow', operationId: 'operation', outcome: 'resumed' as const };
  });
  const options = { client: { recoverCustomerDeletion }, runService, resolveApprovedPolicy: async () => request.policy };
  return { options, support: new PostgresHostedCustomerDataSupport(options), recoverCustomerDeletion, query, order,
    revoke: () => { grantActive = false; } };
}

describe('internal customer deletion support recovery', () => {
  it('commits an audit attempt, rereads admission/policy and recovers the original customer request', async () => {
    const f = fixture(); await f.support.recoverDeletion(staff(), input);
    expect(readAdmittedHostedCustomerDeletion).toHaveBeenCalledTimes(2);
    expect(f.recoverCustomerDeletion).toHaveBeenCalledWith(request);
    expect(f.order).toEqual(['organization.data.deletion.recovery.requested', 'committed', 'dbos',
      'organization.data.deletion.recovery.resumed', 'committed']);
    expect(appendOrganizationAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'staff-1',
      targetId: 'operation', metadata: expect.objectContaining({ grantId: 'grant' }) }), expect.anything());
  });

  it.each([null, staff({ roles: new Set() }), staff({ capabilities: new Set() }), staff({ authMethod: 'bearer' as Principal['authMethod'] })])(
    'requires verified staff cookie, explicit role and capability before touching the ledger', async principal => {
      const f = fixture(); await expect(f.support.recoverDeletion(principal, input)).rejects.toThrow('staff_required');
      expect(f.query).not.toHaveBeenCalled(); expect(f.recoverCustomerDeletion).not.toHaveBeenCalled();
    });

  it('refuses absent/revoked consent and a pending policy before DBOS', async () => {
    const f = fixture(); f.revoke(); await expect(f.support.recoverDeletion(staff(), input)).rejects.toThrow('grant_inactive');
    const pending = fixture(); await expect(new PostgresHostedCustomerDataSupport({ ...pending.options, resolveApprovedPolicy: async () => null })
      .recoverDeletion(staff(), input)).rejects.toThrow('retention-policy-not-approved');
    expect(f.recoverCustomerDeletion).not.toHaveBeenCalled(); expect(pending.recoverCustomerDeletion).not.toHaveBeenCalled();
  });

  it('does not mutate DBOS if audit commit fails or consent is revoked after that commit', async () => {
    const f = fixture(); vi.mocked(appendOrganizationAuditEvent).mockRejectedValueOnce(new Error('audit-failed'));
    await expect(f.support.recoverDeletion(staff(), input)).rejects.toThrow('audit-failed');
    expect(f.recoverCustomerDeletion).not.toHaveBeenCalled();
    const changed = fixture(); const run = changed.options.runService;
    const support = new PostgresHostedCustomerDataSupport({ ...changed.options, runService: async fn => {
      const result = await run(fn); changed.revoke(); return result;
    } });
    await expect(support.recoverDeletion(staff(), input)).rejects.toThrow('grant_inactive');
    expect(changed.recoverCustomerDeletion).not.toHaveBeenCalled();
  });
});
