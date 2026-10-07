import { test, expect } from './_egress';

type Goal = { id: string; title: string; standing?: boolean };
type Package = { ref: string; title: string; standing: boolean; activeGoalId: string | null };
type Goals = { goals: Goal[]; goalPackages: Package[] };

test('real ongoing goal data reaches featured, compact and standing detail on the identified artifact', async ({ page, request }, info) => {
  const expectedSha = process.env.PAPERCUSP_ONGOING_ACCEPTANCE_SHA?.trim();
  expect(expectedSha, 'Supply the independently resolved runtime SHA; a missing identity cannot certify shipment').toMatch(/^[a-f0-9]{10,40}$/);
  const healthResponse = await request.get('/api/health');
  expect(healthResponse.ok()).toBe(true);
  const health = await healthResponse.json();
  expect(health.bundleStale, 'A fallback bundle cannot establish the current artifact').toBeUndefined();
  expect(health.sha).toBe(expectedSha);

  // Observe the normal wire response. This profile never intercepts or seeds goal data.
  const listResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/zero-harness/rest-query' && url.searchParams.get('name') === 'goals.list';
  });
  await page.goto('/adv?tab=hud&scope=all&hudtab=goals&welcome=0');
  const response = await listResponse;
  expect(response.ok()).toBe(true);
  const payload = (await response.json()).rows[0] as Goals;
  const entry = payload.goalPackages.find((item) => item.ref === 'work-on-everything');
  expect(entry, 'The real workspace must have its existing ongoing package').toBeDefined();
  expect(entry!.standing).toBe(true);
  expect(entry!.activeGoalId).toBeTruthy();
  const goal = payload.goals.find((item) => item.id === entry!.activeGoalId);
  expect(goal, 'The projected package must resolve to an actual goal row').toBeDefined();
  expect(goal!.standing, 'The introduced standing read-model projection must be present').toBe(true);

  const featured = page.locator('.hud-ongoing--featured').filter({ has: page.getByRole('heading', { name: entry!.title, exact: true }) });
  await expect(featured).toBeVisible();
  await expect(featured.locator('svg.lucide-infinity')).toHaveCount(1);
  await expect(featured.getByRole('button', { name: 'View ongoing work', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('real-ongoing-featured.png') });

  for (const tab of ['Sessions', 'Plans', 'Work items']) {
    await page.getByRole('tablist', { name: 'HUD board' }).getByRole('tab', { name: tab, exact: true }).click();
    const compact = page.locator('.hud-ongoing--compact').filter({ has: page.getByRole('heading', { name: entry!.title, exact: true }) });
    await expect(compact).toBeVisible();
    await expect(compact.getByRole('button', { name: 'View work', exact: true })).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath('real-ongoing-compact.png') });
  const open = page.locator('.hud-ongoing--compact').filter({ has: page.getByRole('heading', { name: entry!.title, exact: true }) }).getByRole('button', { name: 'View work', exact: true });
  await open.focus();
  await open.press('Enter');
  await expect.poll(() => new URL(page.url()).searchParams.get('hudgoal')).toBe(goal!.id);
  const detail = page.locator('.hud-ongoing--detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'Where work is moving', exact: true })).toBeVisible();
  expect(await detail.evaluate((node) => {
    const ends = document.querySelector('[data-testid="goal-ends-section"]');
    return !!ends && !!(node.compareDocumentPosition(ends) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  await page.screenshot({ path: info.outputPath('real-ongoing-detail.png') });

  const healthAfter = await (await request.get('/api/health')).json();
  expect(healthAfter.sha, 'The runtime must not move during the acceptance journey').toBe(expectedSha);
  expect(healthAfter.bundleStale).toBeUndefined();
  await info.attach('ongoing-real-data-receipt', {
    body: JSON.stringify({ expectedSha, actualSha: health.sha, goalId: goal!.id, packageRef: entry!.ref,
      views: ['featured', 'compact', 'standing-detail'], navigationGoalId: new URL(page.url()).searchParams.get('hudgoal') }),
    contentType: 'application/json',
  });
});
