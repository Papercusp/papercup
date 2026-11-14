/** Chromium -> Vite proxy -> real Hono HTTP -> hosted_service transactions on
 * createOrgTestDb's private migrated PostgreSQL. Only authority and costs are
 * synthetic; this does not certify Portal, session resolution or provider/native acceptance. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import type { Sql } from 'postgres';
import type { Page, TestInfo } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { expect, test } from './_egress';
import { root, startDesktopGridFixtureServer } from './_desktop-grid-fixture-server';
import { createOrgTestDb, type OrgTestDb } from '../../../packages/operator-core/test/_org-test-db';
import { createHostedPrincipal } from '../../../packages/operator-core/lib/auth/hosted-principal';
import type { HostedPrincipalResolver } from '../../../packages/operator-core/lib/auth/hosted-principal-resolver';
import type { HostedServiceContextRunner } from '../../../packages/operator-core/lib/auth/hosted/workos-lifecycle-postgres';
import { defineHostedAllocation, reserveHostedAllocation } from '../../../packages/operator-core/lib/auth/hosted/billing/allocation-store';
import { createHostedBillingRuntime } from '../../../packages/operator-core/lib/endpoint-route/hosted-billing-runtime';

test.describe.configure({ mode: 'serial' });
const MONTH = '2026-10';
const T = Date.UTC(2026, 9, 2);
const classes = ['model', 'hosting', 'subscription'] as const;
const orgA = { controlWorkspaceId: randomUUID(), organizationId: randomUUID() };
const orgB = { ...orgA, organizationId: randomUUID() };
const output = process.env.ENTERPRISE_FINANCE_HTTP_OUTPUT_DIR;
const sourceFiles = [
  'apps/operator/e2e/enterprise-finance-http.spec.ts',
  'apps/operator/e2e/__fixtures__/enterprise-finance-http.tsx',
  'apps/operator/e2e/_desktop-grid-fixture-server.ts',
  'packages/operator-ui/src/billing/enterprise-allocations.tsx',
  'packages/operator-core/lib/endpoint-route/hosted-billing-runtime.ts',
  'packages/operator-core/lib/endpoint-route/routes/hosted-billing/index.ts',
  'packages/operator-core/lib/auth/hosted/billing/allocation-store.ts',
];
let db: OrgTestDb;
let server: ViteDevServer;
let api: ServerType;
let origin: string;
let sourceHashes: Record<string, string>;
let serviceTransactions = 0;
async function hashes() {
  return Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
    [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')] as const)));
}
const runService: HostedServiceContextRunner = <R>(fn: (sql: Sql) => Promise<R>) =>
  db.appSql.begin(async tx => {
    serviceTransactions++;
    await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    return fn(tx as unknown as Sql);
  }) as Promise<R>;
const resolvePrincipal: HostedPrincipalResolver = async headers => {
  const session = /(?:^|;\s*)test-session=([^;]+)/.exec(headers.get('cookie') ?? '')?.[1];
  if (!session) return { ok: false, reason: 'session_cookie_missing' };
  if (session === 'revoked') return { ok: false, reason: 'membership_not_active' };
  const org = session === 'other-org' ? orgB : orgA;
  return { ok: true, principal: createHostedPrincipal({ workspaceId: org.controlWorkspaceId,
    activeOrganizationId: org.organizationId, userId: `fixture-${session}`, sessionId: `fixture-${session}`,
    sessionVersion: 1, permissions: session === 'member' ? ['workspace:view'] : ['workspace:view', 'billing:manage'],
  }), session: {} as never, membership: {} as never };
};
async function revisions() {
  return db.adminSql`SELECT control_workspace_id, organization_id, allocation_id, revision,
    cap_micros, max_unreconciled_micros, recorded_by FROM papercusp_auth.hosted_budget_allocations
    ORDER BY organization_id, allocation_id, revision`;
}
test.beforeAll(async () => {
  test.setTimeout(180_000);
  sourceHashes = await hashes();
  db = await createOrgTestDb();
  const draft = path.join(root, 'libs/papercusp/libs/db/sql/1495-hosted-budget-allocations.sql.DRAFT');
  let migration: string;
  try { migration = readFileSync(draft, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; migration = readFileSync(draft.replace('.DRAFT', ''), 'utf8'); }
  await db.adminSql.unsafe(migration);
  for (const [organization, multiplier] of [[orgA, 1], [orgB, 2]] as const) {
    for (const [index, costClass] of classes.entries()) {
      for (const [suffix, parent, level, cap] of [
        ['root', null, 'organization', 10_000_000],
        ['department', `${costClass}-root`, 'department', 5_000_000],
        ['project', `${costClass}-department`, 'project', 2_000_000],
      ] as const) {
        expect((await runService(sql => defineHostedAllocation(sql, { organization, month: MONTH,
          allocationId: `${costClass}-${suffix}`, parentAllocationId: parent, level, costClass,
          capMicros: cap, maxUnreconciledMicros: cap, recordedBy: 'fixture-seed', evidenceRef: 'synthetic:browser-http-pg' }))).outcome).toBe('created');
      }
      expect((await runService(sql => reserveHostedAllocation(sql, { organization, month: MONTH, costClass,
        allocationId: `${costClass}-project`, reservationId: `${costClass}-reservation`,
        maximumCostMicros: [123_456, 234_567, 345_678][index]! * multiplier,
        observedAtMs: T, evidenceRef: 'synthetic:pending-provider' }))).outcome).toBe('admitted');
    }
  }
  let runtime: Awaited<ReturnType<typeof createHostedBillingRuntime>> | undefined;
  await new Promise<void>(resolve => { api = serve({ hostname: '127.0.0.1', port: 0,
    fetch: request => runtime ? runtime.app.fetch(request) : new Response('not ready', { status: 503 }),
  }, () => resolve()); });
  const apiOrigin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  ({ server, origin } = await startDesktopGridFixtureServer(
    'apps/operator/e2e/__fixtures__/enterprise-finance-http.tsx', {}, ['@papercusp/grid-core'],
    { '/api/hosted/billing': apiOrigin },
  ));
  runtime = await createHostedBillingRuntime({ publicOrigin: origin, plans: [], stripeSecretKeyRef: null,
    stripeWebhookSecretRef: null }, { resolvePrincipal, runService, clock: () => new Date(T),
    fetchImpl: async () => { throw new Error('Provider requests forbidden in this private browser fixture'); } });
});
test.afterAll(async () => {
  test.setTimeout(120_000);
  try {
    if (sourceHashes) expect(await hashes(), 'source bytes must remain unchanged during browser proof').toEqual(sourceHashes);
  } finally {
    try { await server?.close(); }
    finally {
      try { if (api) await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve())); }
      finally {
        const cleanup = await db?.cleanupWithResult();
        if (output) {
          await mkdir(output, { recursive: true });
          await writeFile(path.join(output, 'source-manifest.json'), JSON.stringify({
            kind: 'browser-real-http-private-pg', sourceHashes, privateDatabase: db?.dbName, cleanup,
            realComponent: true, realBillingHttp: true, realAllocationStore: true,
            substituted: ['principal resolver', 'seeded amounts'], portalIntegrationProven: false,
            providerBillingProven: false, nativeAcceptanceProven: false, shipmentProven: false,
          }, null, 2));
        }
        if (db) expect(cleanup, 'private database must actually be dropped').toBe('dropped');
      }
    }
  }
});
async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/?financeMonth=${MONTH}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Download accounting JSON' })).toBeVisible();
  return errors;
}
async function capture(page: Page, info: TestInfo, name: string) {
  const screenshot = await page.screenshot({ fullPage: true });
  await info.attach(name, { body: screenshot, contentType: 'image/png' });
  await info.attach('source-identity', { body: JSON.stringify(sourceHashes), contentType: 'application/json' });
  if (output) { await mkdir(output, { recursive: true }); await writeFile(path.join(output, `${name}.png`), screenshot); }
}

test('browser persists exact limits, refuses real commitments, and exports recorded accounting', async ({ page }, info) => {
  const errors = await open(page);
  for (const [costClass, amount] of [['model', '$0.123456'], ['hosting', '$0.234567'], ['subscription', '$0.345678']]) {
    await expect(page.getByRole('region', { name: `${costClass} allocation costs` })
      .getByText(`Committed: ${amount}`, { exact: false })).toBeVisible();
  }
  await page.getByRole('combobox', { name: /^Allocation/ }).selectOption(JSON.stringify(['model', 'model-project']));
  await page.getByLabel('Limit in USD', { exact: true }).fill('1.000001');
  await page.getByLabel('Maximum unreconciled cost in USD').fill('0.500000');
  await page.getByRole('button', { name: 'Save allocation', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Allocation saved.' })).toBeVisible();
  const before = await revisions();
  expect(before.find(r => r.organization_id === orgA.organizationId && r.allocation_id === 'model-project' && r.revision === 2))
    .toMatchObject({ cap_micros: 1_000_001, max_unreconciled_micros: 500_000, recorded_by: 'fixture-admin' });
  expect(before.filter(r => r.organization_id === orgB.organizationId && r.allocation_id === 'model-project'))
    .toMatchObject([{ revision: 1, cap_micros: 2_000_000 }]);
  await page.getByRole('combobox', { name: /^Allocation/ }).selectOption(JSON.stringify(['model', 'model-project']));
  await page.getByLabel('Limit in USD', { exact: true }).fill('0.123455');
  await page.getByLabel('Maximum unreconciled cost in USD').fill('0.123455');
  await page.getByRole('button', { name: 'Save allocation', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('This limit was refused.');
  expect(await revisions()).toEqual(before);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download accounting JSON' }).click()]);
  expect(download.suggestedFilename()).toBe('allocation-accounting-2026-10.json');
  const accounting = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(accounting.organization).toEqual(orgA);
  expect(accounting.rows).toHaveLength(3);
  for (const [index, costClass] of classes.entries()) {
    expect(accounting.byCostClass[costClass]).toMatchObject({ reservations: 1, pendingProviderFinal: 1,
      committedMicros: [123_456, 234_567, 345_678][index], providerFinalMicros: 0 });
    expect(accounting.rows.find((row: { costClass: string }) => row.costClass === costClass).providerFinalCostMicros)
      .toHaveProperty('unknownReason');
  }
  await capture(page, info, 'finance-real-http-persisted-refusal');
  expect(errors).toEqual([]);
});

test('browser organization and month changes read isolated persisted data', async ({ page }, info) => {
  const errors = await open(page);
  await page.getByRole('button', { name: 'Switch to organization B' }).click();
  await expect(page.getByRole('region', { name: 'model allocation costs' }).getByText('Committed: $0.246912', { exact: false })).toBeVisible();
  await page.getByLabel('Finance month').fill('2026-09');
  await expect(page).toHaveURL(/financeMonth=2026-09/);
  await expect(page.getByRole('region', { name: 'model allocation costs' }).getByText('Committed: $0.000000', { exact: false })).toBeVisible();
  const accounting = await page.evaluate(async () => (await fetch('/api/hosted/billing/usage?view=allocations&month=2026-09')).json());
  expect(accounting.allocations.organization).toEqual(orgB);
  expect(accounting.allocations.accounting.rows).toEqual([]);
  await capture(page, info, 'finance-real-http-other-org-month');
  expect(errors).toEqual([]);
});

test('revoked server authority denies a stale browser and cannot persist changes', async ({ page }, info) => {
  const errors = await open(page);
  const before = await revisions();
  const transactions = serviceTransactions;
  await page.context().addCookies([{ name: 'test-session', value: 'revoked', url: origin }]);
  await page.getByLabel('Finance month').fill('2026-09');
  await expect(page.getByRole('alert')).toContainText('A billing administrator account is required.');
  await expect(page.getByRole('button', { name: 'Download accounting JSON' })).toHaveCount(0);
  const denied = await page.evaluate(async () => (await fetch('/api/hosted/billing/usage?view=allocations', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      allocationId: 'model-project', parentAllocationId: 'model-department', level: 'project', costClass: 'model',
      month: '2026-10', capMicros: 1_000_002, maxUnreconciledMicros: 500_000,
    }),
  })).status);
  expect(denied).toBe(403);
  expect(serviceTransactions).toBe(transactions);
  expect(await revisions()).toEqual(before);
  await capture(page, info, 'finance-real-http-revoked');
  expect(errors).toEqual([]);
});
