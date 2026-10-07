import { test, expect } from './_egress';
import { resolveTestRunWorkspaceId } from '@papercusp/test-config/admin-test-runs-reporter';

type Goal = { id: string; title: string; standing?: boolean };
type Package = { ref: string; title: string; standing: boolean; featured: boolean; activeGoalId: string | null };
type Goals = { goals: Goal[]; goalPackages: Package[] };

test('real ongoing goal data reaches featured, compact and standing detail on the identified artifact', async ({ page, request }, info) => {
  const workspaceId = resolveTestRunWorkspaceId();
  expect(workspaceId, 'The real workspace must be explicit before reading goal data').toBeTruthy();
  const diagnostics: string[] = [];
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message.slice(0, 500)}`));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.includes('rest-query')) diagnostics.push(`${url.searchParams.get('name')}: ${response.status()}`);
  });
  try {
  const expectedSha = process.env.PAPERCUSP_ONGOING_ACCEPTANCE_SHA?.trim();
  expect(expectedSha, 'Supply the independently resolved runtime SHA; a missing identity cannot certify shipment').toMatch(/^[a-f0-9]{10,40}$/);
  const healthResponse = await request.get('/api/health');
  expect(healthResponse.ok()).toBe(true);
  const health = await healthResponse.json();
  expect(health.bundleStale, 'A fallback bundle cannot establish the current artifact').toBeUndefined();
  expect(health.sha).toBe(expectedSha);

  // The maintained REST query reads real data independently of whether the UI's
  // initial delivery came through REST, SSE or its synchronized cache.
  const response = await request.get('/api/zero-harness/rest-query', {
    params: { name: 'goals.list', args: JSON.stringify({ workspaceId }) },
  });
  expect(response.ok()).toBe(true);
  const payload = (await response.json()).rows[0] as Goals;
  const entry = payload.goalPackages.find((item) => item.ref === 'work-on-everything');
  expect(entry, 'The real workspace must have its existing ongoing package').toBeDefined();
  expect(entry!.standing).toBe(true);
  expect(entry!.featured, 'The existing ongoing package must retain its featured server projection').toBe(true);
  expect(entry!.activeGoalId).toBeTruthy();
  const goal = payload.goals.find((item) => item.id === entry!.activeGoalId);
  expect(goal, 'The projected package must resolve to an actual goal row').toBeDefined();
  expect(goal!.standing, 'The introduced standing read-model projection must be present').toBe(true);

  await page.goto(`/adv?tab=hud&scope=all&hudtab=goals&welcome=0&ws=${encodeURIComponent(workspaceId!)}`);
  await expect(page.getByRole('tablist', { name: 'HUD board' }), 'The real HUD must mount before judging goal rendering').toBeVisible();

  const featured = page.locator('section.hud-ongoing--featured[data-testid="ongoing-work-overview"]').filter({ has: page.getByRole('heading', { name: entry!.title, exact: true }) });
  await expect(featured).toBeVisible();
  await expect(featured.locator('svg.lucide-infinity')).toHaveCount(1);
  await expect(featured.getByRole('button', { name: 'View ongoing work', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('real-ongoing-featured.png') });

  for (const tab of ['Sessions', 'Plans', 'Work items']) {
    await page.getByRole('tablist', { name: 'HUD board' }).getByRole('tab', { name: tab, exact: true }).click();
    const compact = page.locator('section.hud-ongoing--compact[data-testid="ongoing-work-overview"]').filter({ has: page.getByRole('heading', { name: entry!.title, exact: true }) });
    await expect(compact).toBeVisible();
    await expect(compact.getByRole('button', { name: 'View work', exact: true })).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath('real-ongoing-compact.png') });
  const open = page.locator('section.hud-ongoing--compact[data-testid="ongoing-work-overview"]').filter({ has: page.getByRole('heading', { name: entry!.title, exact: true }) }).getByRole('button', { name: 'View work', exact: true });
  await open.focus();
  await open.press('Enter');
  await expect.poll(() => new URL(page.url()).searchParams.get('hudgoal')).toBe(goal!.id);
  const detail = page.locator('section.hud-ongoing--detail[data-testid="ongoing-work-overview"]');
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
    body: JSON.stringify({ expectedSha, actualSha: health.sha, workspaceId, goalId: goal!.id, packageRef: entry!.ref,
      views: ['featured', 'compact', 'standing-detail'], navigationGoalId: new URL(page.url()).searchParams.get('hudgoal') }),
    contentType: 'application/json',
  });
  } finally {
    await info.attach('ongoing-real-data-diagnostics', {
      body: JSON.stringify({ workspaceId, url: page.url(), observations: diagnostics.slice(-40) }),
      contentType: 'application/json',
    });
  }
});
