/** Real loopback HTTP -> Hono authority fence -> production hosted_service
 * allocation transactions on a private migrated PostgreSQL database.
 * Principals and amounts are synthetic test inputs. This does not exercise
 * the session resolver, Portal mount, provider billing or native acceptance. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createHostedPrincipal } from '../auth/hosted-principal';
import type { HostedPrincipalResolver } from '../auth/hosted-principal-resolver';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
import { defineHostedAllocation, reserveHostedAllocation,
  type HostedAllocationOrganization } from '../auth/hosted/billing/allocation-store';
import { createHostedBillingRuntime } from './hosted-billing-runtime';
import type { HostedBillingAllocationFinance } from './routes/hosted-billing';

const MONTH = '2026-10';
const T = Date.UTC(2026, 9, 2);
const COST_CLASSES = ['model', 'hosting', 'subscription'] as const;
const publicOrigin = 'https://finance.integration.test';
const route = '/api/hosted/billing/usage?view=allocations';
const orgA = { controlWorkspaceId: randomUUID(), organizationId: randomUUID() };
// Same control workspace: isolation must depend on organization as well.
const orgB = { ...orgA, organizationId: randomUUID() };
const orgOtherControl = { ...orgA, controlWorkspaceId: randomUUID() };
let db: OrgTestDb;
let server: ServerType;
let base: string;
let serviceTransactions = 0;

const runService: HostedServiceContextRunner = <R>(fn: (sql: Sql) => Promise<R>) =>
  db.appSql.begin(async tx => {
    serviceTransactions++;
    await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    return fn(tx as unknown as Sql);
  }) as Promise<R>;

const resolvePrincipal: HostedPrincipalResolver = async headers => {
  const session = headers.get('test-session');
  if (!session) return { ok: false, reason: 'session_cookie_missing' };
  if (session === 'revoked') return { ok: false, reason: 'membership_not_active' };
  if (session === 'outage') return { ok: false, reason: 'authority_unavailable' };
  const organization = session === 'other-org' ? orgB : session === 'other-control' ? orgOtherControl : orgA;
  return { ok: true, principal: createHostedPrincipal({ workspaceId: organization.controlWorkspaceId,
    activeOrganizationId: organization.organizationId, userId: `fixture-${session}`, sessionId: `fixture-${session}`,
    sessionVersion: 1, permissions: session === 'member' ? ['workspace:view'] : ['workspace:view', 'billing:manage'],
  }), session: {} as never, membership: {} as never };
};

const requestBody = (capMicros = 1_000_001) => ({ allocationId: 'model-project', parentAllocationId: 'model-department',
  level: 'project', costClass: 'model', month: MONTH, capMicros, maxUnreconciledMicros: 500_000 });
async function call(url = route, body?: unknown, session = 'admin', origin = publicOrigin) {
  const response = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST',
    headers: { connection: 'close', ...(session ? { 'test-session': session } : {}), origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  try { return { response, body: JSON.parse(text) }; }
  catch { throw new Error(`Unexpected HTTP ${response.status} for ${url}: ${text.slice(0, 500)}`); }
}
async function finance(session = 'admin', month = MONTH): Promise<HostedBillingAllocationFinance> {
  const result = await call(`${route}&month=${month}`, undefined, session);
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get('cache-control')).toBe('no-store');
  expect(result.body.ok).toBe(true);
  return result.body.allocations;
}
async function revisions() {
  // Independent administrator read, not the runtime source under test.
  return db.adminSql`SELECT control_workspace_id, organization_id, allocation_id, revision,
    cap_micros, max_unreconciled_micros, recorded_by, evidence_ref
    FROM papercusp_auth.hosted_budget_allocations
    ORDER BY control_workspace_id, organization_id, allocation_id, revision`;
}
async function seed(organization: HostedAllocationOrganization, committed: number) {
  for (const costClass of COST_CLASSES) {
    for (const [suffix, parent, level, cap] of [
      ['root', null, 'organization', 10_000_000],
      ['department', `${costClass}-root`, 'department', 5_000_000],
      ['project', `${costClass}-department`, 'project', 2_000_000],
    ] as const) {
      const result = await runService(sql => defineHostedAllocation(sql, { organization, month: MONTH,
        allocationId: `${costClass}-${suffix}`, parentAllocationId: parent, level, costClass,
        capMicros: cap, maxUnreconciledMicros: cap, recordedBy: 'fixture-seed', evidenceRef: 'synthetic:http-pg' }));
      expect(result.outcome).toBe('created');
    }
    const result = await runService(sql => reserveHostedAllocation(sql, { organization, month: MONTH, costClass,
      allocationId: `${costClass}-project`, reservationId: `${costClass}-reservation`, maximumCostMicros: committed,
      observedAtMs: T, evidenceRef: 'synthetic:pending-provider' }));
    expect(result.outcome).toBe('admitted');
  }
}

beforeAll(async () => {
  db = await createOrgTestDb();
  // Mirror the existing allocation integration fixture while 1495 is a draft.
  const draft = new URL('../../../../libs/papercusp/libs/db/sql/1495-hosted-budget-allocations.sql.DRAFT', import.meta.url);
  const armed = new URL('../../../../libs/papercusp/libs/db/sql/1495-hosted-budget-allocations.sql', import.meta.url);
  let migration: string;
  try { migration = readFileSync(draft, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; migration = readFileSync(armed, 'utf8'); }
  await db.adminSql.unsafe(migration);
  await seed(orgA, 123_456);
  await seed(orgB, 654_321);
  await seed(orgOtherControl, 234_567);
  const runtime = await createHostedBillingRuntime({ publicOrigin, plans: [], stripeSecretKeyRef: null,
    stripeWebhookSecretRef: null }, { resolvePrincipal, runService, clock: () => new Date(T),
    fetchImpl: async () => { throw new Error('Provider network is outside this private integration test'); } });
  expect(runtime.configured).toBe(false);
  await new Promise<void>(resolve => {
    server = serve({ fetch: runtime.app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);
afterAll(async () => {
  try { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  finally { await db?.cleanup(); }
}, 120_000);

describe('hosted allocation real HTTP and PostgreSQL boundary', () => {
  it('returns subscription scope and all three recorded cost classes from production stores', async () => {
    const subscription = await call('/api/hosted/billing/subscription');
    expect(subscription.response.status).toBe(200);
    expect(subscription.body).toMatchObject({ organization: orgA, canManage: true });
    const view = await finance();
    expect(view.organization).toEqual(orgA);
    expect(Object.keys(view.report.byCostClass)).toEqual([...COST_CLASSES]);
    for (const costClass of COST_CLASSES) {
      expect(view.report.byCostClass[costClass]).toMatchObject({ committedMicros: 123_456, unreconciledMicros: 123_456 });
      expect(view.accounting.byCostClass[costClass]).toMatchObject({ reservations: 1, pendingProviderFinal: 1,
        committedMicros: 123_456, providerFinalMicros: 0 });
      const row = view.accounting.rows.find(r => r.costClass === costClass)!;
      expect(row.providerFinalCostMicros).toHaveProperty('unknownReason');
      expect(row.allocationPath).toEqual([`${costClass}-root`, `${costClass}-department`, `${costClass}-project`]);
    }
    expect(view.accounting.outcomes).toEqual([]);
  });

  it('isolates the same allocation identifiers by organization, control workspace and month', async () => {
    for (const [session, organization, committed] of [
      ['admin', orgA, 123_456], ['other-org', orgB, 654_321], ['other-control', orgOtherControl, 234_567],
    ] as const) {
      const view = await finance(session);
      expect(view.organization).toEqual(organization);
      expect(view.report.byCostClass.model.committedMicros).toBe(committed);
      expect(view.accounting.rows).toHaveLength(3);
      expect((await finance(session, '2026-09')).accounting.rows).toEqual([]);
    }
  });

  it('persists an exact micro-dollar revision, binds its actor, and refuses a cap below real commitments', async () => {
    const saved = await call(route, requestBody());
    expect(saved.response.status).toBe(200);
    expect(saved.body).toMatchObject({ ok: true, outcome: 'revised', allocation: { capMicros: 1_000_001, revision: 2 } });
    expect(saved.response.headers.get('cache-control')).toBe('no-store');
    const before = await revisions();
    const row = before.find(r => r.organization_id === orgA.organizationId && r.control_workspace_id === orgA.controlWorkspaceId
      && r.allocation_id === 'model-project' && r.revision === 2);
    expect(row).toMatchObject({ cap_micros: 1_000_001, max_unreconciled_micros: 500_000, recorded_by: 'fixture-admin' });
    expect(row?.evidence_ref).toMatch(/^hosted-billing-allocation:/);
    const refused = await call(route, { ...requestBody(123_455), maxUnreconciledMicros: 123_455 });
    expect(refused.response.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: 'allocation_refused', safeMessage: 'cap-below-committed' } });
    expect(await revisions()).toEqual(before);
    expect((await finance()).report.byCostClass.model.allocations.find(a => a.allocationId === 'model-project')?.capMicros)
      .toBe(1_000_001);
    expect((await finance('other-org')).report.byCostClass.model.allocations.find(a => a.allocationId === 'model-project')?.capMicros)
      .toBe(2_000_000);
  });

  it.each([['', 401], ['member', 403], ['revoked', 403], ['outage', 503]] as const)(
    'denies %s before any service transaction or persisted change', async (session, status) => {
      const before = await revisions(); const transactions = serviceTransactions;
      for (const body of [undefined, requestBody()]) {
        expect((await call(route, body, session)).response.status).toBe(status);
      }
      expect(serviceTransactions).toBe(transactions);
      expect(await revisions()).toEqual(before);
    });

  it('rejects forged scope, actor, fractional money and foreign-origin writes without touching PostgreSQL', async () => {
    const before = await revisions(); const transactions = serviceTransactions;
    for (const key of ['organization', 'organizationId', 'controlWorkspaceId', 'recordedBy', 'evidenceRef']) {
      expect((await call(route, { ...requestBody(), [key]: 'forged' })).response.status).toBe(400);
      expect((await call(`${route}&${key}=forged`)).response.status).toBe(400);
    }
    expect((await call(route, { ...requestBody(), capMicros: 1.5 })).response.status).toBe(400);
    expect((await call(route, requestBody(), 'admin', 'https://foreign.example')).response.status).toBe(403);
    expect(serviceTransactions).toBe(transactions);
    expect(await revisions()).toEqual(before);
  });
});
