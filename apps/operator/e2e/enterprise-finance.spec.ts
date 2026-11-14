import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page, Route, TestInfo } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { expect, test } from './_egress';
import { root, startDesktopGridFixtureServer } from './_desktop-grid-fixture-server';
import type { HostedBillingAllocationFinance } from '../../../packages/operator-core/lib/endpoint-route/routes/hosted-billing/index';

let server: ViteDevServer;
let origin: string;
let sourceHashes: Record<string, string>;
const output = process.env.ENTERPRISE_FINANCE_OUTPUT_DIR;
const sourceFiles = [
  'packages/operator-ui/src/billing/enterprise-allocations.tsx',
  'packages/operator-ui/src/index.ts',
  'apps/operator/e2e/__fixtures__/enterprise-finance.tsx',
  'apps/operator/e2e/enterprise-finance.spec.ts',
  'apps/operator/e2e/_desktop-grid-fixture-server.ts',
];
async function hashes() {
  return Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
    [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')] as const)));
}

test.beforeAll(async () => {
  sourceHashes = await hashes();
  // Linked grid-core re-exports Glide's CommonJS dependency graph. Prebundle it
  // through the maintained helper rather than sending lodash CJS to the browser.
  ({ server, origin } = await startDesktopGridFixtureServer(
    'apps/operator/e2e/__fixtures__/enterprise-finance.tsx', {}, ['@papercusp/grid-core'],
  ));
});
test.afterAll(async () => {
  try {
    expect(await hashes(), 'browser evidence must exercise unchanged source bytes').toEqual(sourceHashes);
    if (output) {
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, 'source-manifest.json'), JSON.stringify({
        kind: 'component-browser-fixture', sourceHashes, origin,
        realComponent: true, substituted: ['billing HTTP responses', 'account identity'],
        portalIntegrationProven: false, liveBillingProven: false, shipmentProven: false,
      }, null, 2));
    }
  } finally { await server?.close(); }
});

// Browser expectations use independently specified values, never the component's formatting helpers.
function snapshot(organizationId = 'finance-org-a', month = '2026-10'): HostedBillingAllocationFinance {
  const organization = { controlWorkspaceId: 'finance-browser-control', organizationId };
  const group = (cost: number) => ({ committedMicros: cost, unreconciledMicros: cost, providerFinalMicros: 0,
    allocations: [{ allocationId: `${organizationId}-project`, parentAllocationId: 'finance-department', level: 'project' as const,
      capMicros: 5_000_000, maxUnreconciledMicros: 500_000, committedMicros: cost,
      unreconciledMicros: cost, providerFinalMicros: 0, availableMicros: 5_000_000 - cost, openHolds: 1 }],
    forecast: { method: 'linear-elapsed-utc-month' as const, basisMicros: null, elapsedMs: 1000, periodMs: 2000,
      projectedConsumptionMicros: null, provisional: true, unavailableReason: 'unpriced-usage' as const,
      scope: 'recorded-allocation-costs' as const, evidenceRef: 'browser-fixture-ledger' } });
  return { organization, asOfMs: 1, report: { month,
    byCostClass: { model: group(123_456), hosting: group(234_567), subscription: group(345_678) },
    outcomes: [{ allocationId: `${organizationId}-project`, outcomes: 1,
      byState: { accepted: 1, rejected: 0, 'rework-requested': 0, unknown: 0 }, evidenceClasses: ['internal-simulation'],
      acceptedResultCostMicros: 0, acceptedWithUnknownCost: 1, costPerAcceptedOutcomeMicros: null,
      costPerAcceptedUnknownReason: 'provider-final-pending', reviewEffortKnownSeconds: 0, reviewEffortUnknown: 1,
      reworkKnownTotal: 0, reworkUnknown: 1 }] },
    accounting: { organization, month, currency: 'USD', rows: [{ reservationId: 'finance-browser-reservation',
      allocationId: `${organizationId}-project`, allocationPath: ['finance-department', `${organizationId}-project`],
      costClass: 'model', revision: 1, observedAtMs: 1, costSource: 'estimate', maximumCostMicros: 123_456,
      observedCostMicros: { value: 123_456 }, providerFinalCostMicros: { unknownReason: 'not-final' },
      committedMicros: 123_456, unreconciledMicros: 123_456, outcomeIds: [] }],
      byCostClass: { model: { reservations: 1, pendingProviderFinal: 1, committedMicros: 123_456, unreconciledMicros: 123_456, providerFinalMicros: 0 },
        hosting: { reservations: 1, pendingProviderFinal: 1, committedMicros: 234_567, unreconciledMicros: 234_567, providerFinalMicros: 0 },
        subscription: { reservations: 1, pendingProviderFinal: 1, committedMicros: 345_678, unreconciledMicros: 345_678, providerFinalMicros: 0 } },
      outcomes: [], gaps: [{ kind: 'provider-final-pending', ref: 'finance-browser-reservation', reason: 'not final' }] } };
}
async function respond(route: Route, data = snapshot()) {
  await route.fulfill({ json: { ok: true, allocations: data } });
}
async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/?financeMonth=2026-10`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Department and project budgets' })).toBeVisible();
  return errors;
}
async function capture(page: Page, info: TestInfo, name: string) {
  const screenshot = await page.screenshot({ fullPage: true });
  await info.attach(name, { body: screenshot, contentType: 'image/png' });
  await info.attach('source-identity', { body: JSON.stringify(sourceHashes), contentType: 'application/json' });
  if (output) {
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, `${name}.png`), screenshot);
  }
}

test('separate cost classes, unknowns and real accounting download render in Chromium', async ({ page }, info) => {
  await page.route('**/api/hosted/billing/usage?*', route => respond(route));
  const errors = await open(page);
  for (const [costClass, amount] of [['model', '$0.123456'], ['hosting', '$0.234567'], ['subscription', '$0.345678']]) {
    const region = page.getByRole('region', { name: `${costClass} allocation costs` });
    await expect(region.getByText(`Committed: ${amount}`, { exact: false })).toBeVisible();
    await expect(region.getByText('Recorded-cost forecast: Unknown (unpriced-usage)')).toBeVisible();
    await expect(region.getByText('finance-org-a-project (project)', { exact: true })).toBeVisible();
  }
  await expect(page.getByText('Unknown: provider-final-pending', { exact: true })).toBeVisible();
  await expect(page.getByText('0 recorded seconds; 1 unknown', { exact: true })).toBeVisible();
  await expect(page.getByText('Unknown: not-final', { exact: true })).toBeVisible();
  await expect(page.getByText('$0.703701', { exact: true })).toHaveCount(0);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download accounting JSON' }).click()]);
  expect(download.suggestedFilename()).toBe('allocation-accounting-2026-10.json');
  const downloaded = await download.path();
  expect(JSON.parse(await readFile(downloaded!, 'utf8'))).toEqual(snapshot().accounting);
  await capture(page, info, 'finance-ready-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  const table = page.getByRole('region', { name: 'model allocation table', exact: true });
  await expect(table).toHaveAttribute('tabindex', '0');
  expect(await table.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await table.getByText('$5.000000', { exact: true }).evaluate(element => element.scrollWidth <= element.clientWidth),
    'full six-decimal limits must fit their cells instead of silently clipping').toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'the table scrolls within the page instead of widening the document').toBe(true);
  await table.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => table.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Download accounting JSON' })).toBeVisible();
  await capture(page, info, 'finance-ready-narrow');
  expect(errors).toEqual([]);
});

test('server refusal and success stay distinct while limits cross HTTP as exact integer micros', async ({ page }, info) => {
  const writes: unknown[] = [];
  await page.route('**/api/hosted/billing/usage?*', async route => {
    if (route.request().method() !== 'POST') return respond(route);
    writes.push(route.request().postDataJSON());
    await route.fulfill(writes.length === 1
      ? { status: 409, json: { ok: false, error: 'private accounting detail' } }
      : { json: { ok: true, outcome: 'revised' } });
  });
  const errors = await open(page);
  await page.getByRole('combobox', { name: /^Allocation/ }).selectOption(JSON.stringify(['model', 'finance-org-a-project']));
  await page.getByLabel('Limit in USD', { exact: true }).fill('1.000001');
  await page.getByLabel('Maximum unreconciled cost in USD').fill('0.000001');
  await page.getByRole('button', { name: 'Save allocation', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('This limit was refused.');
  await expect(page.getByText('Allocation saved.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('private accounting detail')).toHaveCount(0);
  await capture(page, info, 'finance-refused');
  await page.getByRole('button', { name: 'Save allocation', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Allocation saved.' })).toBeVisible();
  expect(writes).toEqual([1, 2].map(() => ({ allocationId: 'finance-org-a-project', parentAllocationId: 'finance-department',
    level: 'project', costClass: 'model', month: '2026-10', capMicros: 1_000_001, maxUnreconciledMicros: 1 })));
  expect(errors).toEqual([]);
});

test('URL month and tenant changes clear finance drafts, exports and previous authority', async ({ page }, info) => {
  const reads: string[] = [];
  let organization = 'finance-org-a';
  await page.route('**/api/hosted/billing/usage?*', async route => {
    const month = new URL(route.request().url()).searchParams.get('month')!;
    reads.push(month); await respond(route, snapshot(organization, month));
  });
  const errors = await open(page);
  await page.getByRole('combobox', { name: /^Allocation/ }).selectOption(JSON.stringify(['model', 'finance-org-a-project']));
  await page.getByLabel('Limit in USD', { exact: true }).fill('9.999999');
  await page.getByLabel('Finance month').fill('2026-09');
  await expect(page).toHaveURL(/financeMonth=2026-09/);
  await expect(page.getByRole('combobox', { name: /^Allocation/ })).toHaveValue('');
  await expect(page.getByLabel('Limit in USD', { exact: true })).toHaveValue('');
  organization = 'finance-org-b';
  await page.getByRole('button', { name: 'Switch to organization B' }).click();
  await expect(page.getByRole('option', { name: 'model: finance-org-b-project', exact: true })).toHaveCount(1);
  await expect(page.getByText('finance-org-a-project', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove billing permission' }).click();
  await expect(page.getByText('A billing administrator account is required.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download accounting JSON' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: /^Allocation/ })).toHaveCount(0);
  await capture(page, info, 'finance-permission-removed');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByText('Sign in to view finance data.')).toBeVisible();
  expect(reads).toEqual(['2026-10', '2026-09', '2026-09']);
  expect(errors).toEqual([]);
});

test('loading, unavailable with retry, and forbidden states never expose a finance export', async ({ page }, info) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  await page.route('**/api/hosted/billing/usage?*', async route => {
    if (++reads === 1) { await pending; await route.fulfill({ status: 503, json: { private: 'backend diagnostic' } }); }
    else await route.fulfill({ status: 403, json: { private: 'restricted organization' } });
  });
  const errors = await open(page);
  await expect(page.getByText('Loading finance data…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download accounting JSON' })).toHaveCount(0);
  await capture(page, info, 'finance-loading');
  release();
  await expect(page.getByRole('alert')).toContainText('Finance data is unavailable');
  await expect(page.getByText('backend diagnostic')).toHaveCount(0);
  await capture(page, info, 'finance-unavailable');
  await page.getByRole('button', { name: 'Retry finance data' }).click();
  await expect(page.getByRole('alert')).toContainText('A billing administrator account is required.');
  await expect(page.getByRole('button', { name: 'Download accounting JSON' })).toHaveCount(0);
  await expect(page.getByText('restricted organization')).toHaveCount(0);
  await capture(page, info, 'finance-forbidden');
  expect(errors).toEqual([]);
});
