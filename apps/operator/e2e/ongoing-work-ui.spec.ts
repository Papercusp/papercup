import { test, expect, type Page } from './_egress';
import { stubSyncQueries } from './_sync-stub';

const current = {
  id: 'ongoing-current', title: 'Renamed workspace steward', status: 'active', standing: true,
  effectiveStatus: 'active', holderLiveness: 'held', needsHuman: 31,
  spendRecentUsd: 12.34, spendRecentWindowDays: 3, budgetCents: 10000, budgetWindowSec: 604800,
};
const packageRow = {
  ref: 'work-on-everything', title: current.title, description: 'Advances priority work across the workspace.',
  layer: 'bundled', version: '1.0.0', standing: true, featured: true,
  budgetCents: 10000, budgetWindowSec: 604800, activeGoalId: current.id,
  instances: [{ goalId: current.id, status: 'active', adoptableStub: false }],
};

// These header reads share the finite-request scheduler with the goal queries.
// Letting them reach the shared backend makes a fixture's goal admission depend
// on a live process scan and hive registry. Model those two shell contracts here;
// the separate shipment profile still exercises real goal data without stubs.
function headerRows(name: string): readonly unknown[] | undefined {
  if (name === 'taskManager.inventory') return [{ enabled: false }];
  if (name === 'hive.controlState') return [];
  return undefined;
}

async function scopeFixture(page: Page) {
  const projects = [{ slug: 'papercusp', name: 'papercusp', path: '/tmp/ongoing-ui-fixture',
    hasState: true, hasSpec: true, parent_slug: null, harness_kind: 'project', is_shared: false }];
  await page.route('**/api/harness/projects/lite', (route) => route.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify({ projects }) }));
  return projects;
}

test('ongoing work stays visible across tabs, keeps ordinary goals, and opens the same detail', async ({ page }) => {
  const projects = await scopeFixture(page);
  const sync = await stubSyncQueries(page, (name) => {
    if (name === 'harnessProjects.lite') return projects;
    if (name === 'advRoster.list') return [{ active: [], pending: [] }];
    if (name === 'goals.list') return [{ goals: [current,
      { id: 'ordinary', title: 'Work on everything', status: 'active', standing: false },
      { id: 'previous-instance', title: 'Previous workspace steward', status: 'killed', standing: true }],
      totalGoals: 3, goalPackages: [packageRow] }];
    if (name === 'goals.detail') return [{ goal: current, holderLiveness: 'held', effectiveStatus: 'active',
      goalModeState: { portfolio: { priorities: ['Reconcile priority placement', 'Triage blocked work'] } },
      waitingOnYouTotal: 31, waitingOnYou: [{ id: 'WI-approval', title: 'Choose release scope' }],
      activity: [{ id: 'WI-outcome', title: 'Search repair verified', status: 'done', closedAt: '2026-10-06T12:00:00Z' }],
      plans: [{ planSlug: 'search', harnessSlug: 'papercusp', title: 'Search plan', stamped: true, openItems: 2 }] }];
    return headerRows(name);
  });
  await page.goto('/adv?tab=hud&scope=all&hudtab=goals&welcome=0');
  await sync.waitForServed(['goals.list', 'goals.detail']);
  const rail = page.getByTestId('goal-packages-rail');
  await expect(rail.getByRole('button', { name: 'View ongoing work' })).toBeVisible();
  await expect(rail.getByText('Reconcile priority placement')).toBeVisible();
  await expect(rail.getByText('31 waiting on you')).toBeVisible();
  await expect(page.getByText('Work on everything', { exact: true })).toBeVisible();
  await expect(page.getByText('Previous workspace steward', { exact: true })).toBeVisible();
  const featured = page.getByRole('region', { name: `Ongoing work: ${current.title}` });
  await expect(featured).toBeVisible();
  await expect(featured.locator('svg.lucide-infinity')).toHaveCount(1);
  const featuredBox = await featured.boundingBox();
  const ordinaryBox = await page.getByText('Previous workspace steward', { exact: true }).boundingBox();
  expect(featuredBox).not.toBeNull();
  expect(ordinaryBox).not.toBeNull();
  expect(featuredBox!.y + featuredBox!.height).toBeLessThanOrEqual(ordinaryBox!.y);
  // The represented id has exactly one displayed title; title matching cannot hide ordinary goals.
  await expect(page.getByRole('heading', { name: current.title, exact: true })).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath('ongoing-featured.png') });
  for (const tab of ['Sessions', 'Plans', 'Work items']) {
    await page.getByRole('tablist', { name: 'HUD board' }).getByRole('tab', { name: tab, exact: true }).click();
    await expect(rail.getByRole('button', { name: 'View work' })).toBeVisible();
    await expect(rail.getByText('31 needs you')).toBeVisible();
  }
  const openWork = rail.getByRole('button', { name: 'View work' });
  await openWork.focus();
  await expect(openWork).toBeFocused();
  await openWork.press('Enter');
  await expect(page).toHaveURL(/hudgoal=ongoing-current/);
  const overview = page.locator('.hud-ongoing--detail');
  await expect(overview.getByText('Where work is moving')).toBeVisible();
  await expect(overview.getByRole('button', { name: 'Search plan' })).toBeVisible();
  const overviewBeforeEnds = await overview.evaluate((node) => {
    const ends = document.querySelector('[data-testid="goal-ends-section"]');
    return !!ends && !!(node.compareDocumentPosition(ends) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(overviewBeforeEnds).toBe(true);
  await page.screenshot({ path: test.info().outputPath('ongoing-detail.png') });
  await overview.getByRole('button', { name: 'Search repair verified' }).click();
  await expect(page).toHaveURL(/hudwi=WI-outcome/);
  sync.assertServed('goals.list');
  sync.assertServed('goals.detail');
});

test('mobile strip preserves truthful status after a refused pause', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const projects = await scopeFixture(page);
  const sync = await stubSyncQueries(page, (name) => {
    if (name === 'harnessProjects.lite') return projects;
    if (name === 'advRoster.list') return [{ active: [], pending: [] }];
    if (name === 'goals.list') return [{ goals: [current], totalGoals: 1, goalPackages: [packageRow] }];
    if (name === 'goals.detail') return [{ goal: current, holderLiveness: 'held', effectiveStatus: 'active' }];
    return headerRows(name);
  });
  await page.route('**/api/admin/goals/update', (route) => route.fulfill({ status: 409,
    contentType: 'application/json', body: JSON.stringify({ error: { message: 'Pause refused for test' } }) }));
  await page.goto('/adv?tab=hud&scope=all&hudtab=sessions&welcome=0');
  await sync.waitForServed(['goals.list', 'goals.detail']);
  const rail = page.getByTestId('goal-packages-rail');
  await expect(rail.getByText('Running', { exact: true })).toBeVisible();
  const write = page.waitForResponse('**/api/admin/goals/update');
  await rail.getByRole('button', { name: /Pause/ }).click();
  await page.getByRole('dialog', { name: 'Pause this goal?' }).getByRole('button', { name: 'Pause goal', exact: true }).click();
  expect((await write).status()).toBe(409);
  await expect(rail.getByText('Running', { exact: true })).toBeVisible();
  await expect(rail.getByRole('button', { name: 'View work' })).toBeInViewport();
  const horizontalOverflow = await rail.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(horizontalOverflow).toBe(false);
  await page.screenshot({ path: test.info().outputPath('ongoing-mobile.png') });
  await page.getByRole('tablist', { name: 'HUD board' }).getByRole('tab', { name: 'Goals', exact: true }).click();
  await expect(rail.getByRole('button', { name: 'View ongoing work' })).toBeInViewport();
  expect(await rail.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
  await page.screenshot({ path: test.info().outputPath('ongoing-mobile-featured.png') });
  await rail.getByRole('button', { name: 'View ongoing work' }).click();
  const overview = page.locator('.hud-ongoing--detail');
  await expect(overview.getByText('Where work is moving')).toBeVisible();
  expect(await overview.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
  await expect(page.getByTestId('goal-work-rail')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('ongoing-mobile-detail.png') });
  sync.assertServed('goals.list');
  sync.assertServed('goals.detail');
});
