import { test, expect, type Page, type Locator } from './_egress';
import { stubSyncQueries } from './_sync-stub';
import { readTypedPropertyCollection, type OrderedSelectionPolicy } from '../../../packages/operator-core/lib/typed-properties';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

// These shell reads share the finite-request scheduler with the goal queries.
// Letting them reach the shared backend makes a fixture's goal admission depend
// on live process scans, attention aggregation and plan-list hydration. Model
// those ancillary contracts here without swallowing the required dock layout;
// the separate shipment profile still exercises real goal data without stubs.
function headerRows(name: string): readonly unknown[] | undefined {
  if (name === 'taskManager.inventory') return [{ enabled: false }];
  if (name === 'hive.controlState') return [];
  if (name === 'plans.attentionCounts') return [{ decisionItems: 0, decisionPlans: 0, alerts: 0, total: 0, degraded: false }];
  if (name === 'plans.list' || name === 'plans.attention' || name === 'planWorkActivity.list') return [];
  return undefined;
}

async function openHud(page: Page, path: string, ready: Locator = page.getByRole('tablist', { name: 'HUD board' })) {
  await page.goto(path);
  // Deep-linked goal dialogs hide the background HUD from accessibility queries.
  // Wait on the visible caller being exercised, with the same readiness deadline.
  await ready.waitFor({ state: 'visible', timeout: 30_000 });
}

async function scopeFixture(page: Page) {
  const projects = [{ slug: 'papercusp', name: 'papercusp', path: '/tmp/ongoing-ui-fixture',
    hasState: true, hasSpec: true, parent_slug: null, harness_kind: 'project', is_shared: false }];
  await page.route('**/api/harness/projects/lite', (route) => route.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify({ projects }) }));
  return projects;
}

test('native declared collections persist controls and reject a barrier-controlled stale save', async ({ request }, info) => {
  test.skip(!process.env.VERIFY_TAURI_PID, 'Run with scripts/run-operator-e2e-isolated.sh for the owned Tauri bridge');
  test.setTimeout(180_000);
  const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID!;
  const adminUrl = process.env.HARNESS_ADMIN_DATABASE_URL!;
  expect(process.env.VERIFY_TAURI_ISOLATED_DB, 'Native writes require the maintained private database').toBe('1');
  expect(workspaceId).toMatch(/^verify-tauri-isolated-/);
  expect(adminUrl).toBeTruthy();
  expect(adminUrl).not.toBe(process.env.PAPERCUSP_TEST_RUNS_DB_URL);
  const { default: postgres } = await import('postgres');
  const { applyGoalPropertyWrite } = await import('../../../packages/operator-core/lib/typed-properties-db');
  const { ensureOrderedSelectionPolicyDatatype, ensurePlanRefListDatatype } = await import('../../../packages/operator-core/lib/goals/package-property-datatypes');
  const sql = postgres(adminUrl, { max: 1, connect_timeout: 5 });
  const run = promisify(execFile);
  const bridge = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!;
  expect(bridge).toBeTruthy();
  const evidence: unknown[] = [];
  async function native(command: string, ...args: string[]) {
    const result = await run(bridge, [command, '--pid', process.env.VERIFY_TAURI_PID!, ...args], { timeout: 15_000 });
    if (command === 'screenshot') return result.stdout.trim();
    const parsed = JSON.parse(result.stdout);
    return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
  }
  const measure = (expression: string) => native('eval', `JSON.stringify(${expression})`);
  const editor = '[data-testid="goal-data"]';
  async function ready(expression: string) {
    await expect.poll(() => measure(expression), { timeout: 30_000, intervals: [200, 500, 1000] }).toBe(true);
  }
  try {
    await ensureOrderedSelectionPolicyDatatype(sql, workspaceId);
    await ensurePlanRefListDatatype(sql, workspaceId);
    for (const kind of ['plans', 'tea'] as const) {
      const goalId = `native-collection-${kind}`;
      const harness = 'native-collection';
      const property = kind === 'plans' ? 'worklist' : 'tea_choices';
      const policyName = kind === 'plans' ? 'worklist_policy' : 'tea_policy';
      const labels = kind === 'plans' ? ['Native alpha', 'Native beta', 'Native blocked'] : ['mint', 'chamomile', 'rooibos'];
      const ids = kind === 'plans' ? ['alpha', 'beta', 'blocked'].map((slug) => `plan:${harness}/${slug}`) : labels;
      const dormant = kind === 'plans' ? `plan:${harness}/dormant` : 'lavender';
      const schema = {
        [property]: { datatype: kind === 'plans' ? 'plan-ref-list' : 'string-list', editable_by: 'both', default: ids,
          collection: { source: kind === 'plans' ? 'active-workspace-plans' : 'manual', policy: policyName,
            order: kind === 'plans' ? 'priority' : 'display', selectable: true, defaultSelected: true } },
        [policyName]: { datatype: 'ordered-selection-policy', editable_by: 'owner', default: { order: [ids[0], dormant], excluded: [dormant] } },
      };
      // These real records live only in the rig's verified throwaway database.
      await sql`INSERT INTO harness_shared.goals (workspace_id,id,install_slug,title,status,property_schema)
        VALUES (${workspaceId},${goalId},${goalId},${`Native ${kind} collection`},'active',${JSON.stringify(schema)}::jsonb)`;
      if (kind === 'plans') {
        for (const [index, slug] of ['alpha', 'beta', 'blocked'].entries()) {
          await sql`INSERT INTO harness_shared.harness_plans (workspace_id,harness_slug,plan_slug,title,status,op_status)
            VALUES (${workspaceId},${harness},${slug},${labels[index]},${slug === 'blocked' ? 'draft' : 'active'},NULL)`;
        }
      }
      const url = `${process.env.VERIFY_TAURI_DEV_URL}/adv?tab=hud&scope=all&hudtab=goals&welcome=0&hudgoal=${goalId}`;
      const policy = async () => {
        const [row] = await sql`SELECT properties FROM harness_shared.goals WHERE workspace_id=${workspaceId} AND id=${goalId}`;
        return row.properties[policyName] as { value: OrderedSelectionPolicy; version: number; provenance: string } | undefined;
      };
      async function reload() {
        await native('navigate', url, '--json');
        await ready(`!!document.querySelector(${JSON.stringify(editor)}) && document.querySelector(${JSON.stringify(editor)})?.getBoundingClientRect().height > 0`);
      }
      async function readback() {
        const response = await request.get(`${process.env.VERIFY_TAURI_DEV_URL}/api/zero-harness/rest-query`, {
          params: { name: 'goals.detail', args: JSON.stringify({ workspaceId, goalId }) },
        });
        expect(response.ok()).toBe(true);
        const data = (await response.json()).rows[0].goalData.collections[property];
        evidence.push({ kind, policy: await policy(), collection: data });
        return data;
      }
      const checkbox = (label: string) => `${editor} [role="checkbox"][aria-label=${JSON.stringify(`Include ${label}`)}]`;
      await reload();
      const initial = await readback();
      expect(initial.rows.map((row: { id: string }) => row.id)).toEqual(ids);
      if (kind === 'plans') {
        expect(initial.rows[2].reason).toBeTruthy();
        await ready(`document.querySelector(${JSON.stringify(editor)})?.textContent.includes(${JSON.stringify(initial.rows[2].reason)}) === true`);
      }
      await native('click', `${editor} button[aria-label=${JSON.stringify(`Move ${labels[1]} up`)}]`, '--json');
      await expect.poll(async () => (await policy())?.version).toBe(1);
      expect((await policy())?.value.order).toEqual([ids[1], ids[0], ids[2], dormant]);
      expect((await policy())?.provenance).toBe('owner-edit');
      await reload();
      await ready(`document.querySelector(${JSON.stringify(`${editor} li`)})?.textContent.includes(${JSON.stringify(labels[1])}) === true`);
      expect((await readback()).rows.map((row: { id: string }) => row.id)).toEqual([ids[1], ids[0], ids[2]]);
      await native('click', checkbox(labels[1]), '--json');
      await expect.poll(async () => (await policy())?.version).toBe(2);
      expect((await policy())?.value.excluded).toEqual([dormant, ids[1]]);
      await reload();
      await ready(`document.querySelector(${JSON.stringify(checkbox(labels[1]))})?.getAttribute('aria-checked') === 'false' && document.querySelector(${JSON.stringify(`${editor} li`)})?.textContent.includes('Excluded') === true`);
      expect((await readback()).rows.filter((row: { selected: boolean }) => row.selected).map((row: { id: string }) => row.id)).toEqual([ids[0], ids[2]]);
      await native('click', checkbox(labels[1]), '--json');
      await expect.poll(async () => (await policy())?.version).toBe(3);
      await reload();
      await ready(`document.querySelector(${JSON.stringify(checkbox(labels[1]))})?.getAttribute('aria-checked') === 'true'`);
      // Hold the actual UI request, advance the canonical owner revision, then
      // release the original body. A synthetic 409 cannot satisfy this test.
      await native('eval', `(() => { const original = window.fetch; window.__nativeCollectionBarrier = { release: null, body: null }; window.fetch = async (input, init) => { if (String(input).includes('/api/admin/goals/set-property')) { window.__nativeCollectionBarrier.body = JSON.parse(init.body); await new Promise(resolve => { window.__nativeCollectionBarrier.release = resolve; }); } return original(input, init); }; return true; })()`);
      await native('click', checkbox(labels[0]), '--json');
      await ready('window.__nativeCollectionBarrier?.body?.expectedVersion === 3');
      const currentPolicy = (await policy())!;
      const competing = await sql.begin((tx) => applyGoalPropertyWrite(tx as unknown as typeof sql, {
        workspaceId, goalId, property: policyName, value: currentPolicy.value,
        expectedVersion: currentPolicy.version, provenance: 'owner-edit', actorId: 'native-fixture-owner',
      }));
      expect(competing.ok).toBe(true);
      await native('eval', 'window.__nativeCollectionBarrier.release(); true');
      await ready(`document.querySelector(${JSON.stringify(`${editor} [role="alert"]`)})?.textContent.includes('stale') === true`);
      expect((await policy())?.version).toBe(4);
      expect((await policy())?.value.excluded).toEqual([dormant]);
      await ready(`document.querySelector(${JSON.stringify(checkbox(labels[0]))})?.getAttribute('aria-checked') === 'true'`);
      await readback();
      const screenshot = info.outputPath(`native-collection-${kind}.png`);
      await native('screenshot', '--output', screenshot);
      await info.attach(`native-collection-${kind}`, { path: screenshot, contentType: 'image/png' });
      // Positive subject guard precedes the deliberately missing selector.
      await expect(run(bridge, ['check', '--pid', process.env.VERIFY_TAURI_PID!, '--selector', `${editor} .native-missing-control`, '--json'], { timeout: 15_000 })).rejects.toThrow();
    }
  } finally {
    const screenshot = info.outputPath('native-collection-final.png');
    try {
      await native('screenshot', '--output', screenshot);
      await info.attach('native-collection-final', { path: screenshot, contentType: 'image/png' });
    } catch (error) { evidence.push({ screenshotError: String(error) }); }
    await info.attach('native-collection-readbacks', { body: JSON.stringify(evidence), contentType: 'application/json' });
    await sql.end({ timeout: 5 });
  }
});

for (const kind of ['plans', 'tea'] as const) {
  test(`declared ${kind} collection preserves owner order and selection through reload`, async ({ page }) => {
    const projects = await scopeFixture(page);
    const goal = { id: `collection-${kind}`, title: `${kind} collection`, status: 'active', standing: kind === 'plans' };
    const property = kind === 'plans' ? 'worklist' : 'tea_choices';
    const policyName = kind === 'plans' ? 'worklist_policy' : 'tea_policy';
    const ids = kind === 'plans' ? ['plan:papercusp/alpha', 'plan:papercusp/beta', 'plan:papercusp/blocked'] : ['mint', 'chamomile', 'rooibos'];
    const dormant = kind === 'plans' ? 'plan:papercusp/dormant' : 'lavender';
    const labels = ['First choice', 'Second choice', 'Blocked choice'];
    const schema = {
      [property]: { datatype: kind === 'plans' ? 'plan-ref-list' : 'string-list', default: [], editable_by: 'both',
        collection: { source: kind === 'plans' ? 'active-workspace-plans' : 'manual', policy: policyName,
          order: kind === 'plans' ? 'priority' : 'display', selectable: true, defaultSelected: true } },
      [policyName]: { datatype: 'ordered-selection-policy', default: { order: [], excluded: [] }, editable_by: 'owner' },
    };
    let policy: OrderedSelectionPolicy = { order: [ids[0], dormant], excluded: [dormant] };
    let version = 4;
    let refuseSave = false;
    const writes: Array<{ value: OrderedSelectionPolicy; expectedVersion: number }> = [];
    const reads: Array<{ version: number; order: string[] }> = [];
    const selection = () => readTypedPropertyCollection({ propertySchema: schema, property,
      properties: { [property]: { value: ids, version: 2, edited_by: 'agent', provenance: 'agent-edit', edited_at: '2026-10-07T00:00:00Z' },
        [policyName]: { value: policy, version, edited_by: 'owner', provenance: 'owner-edit', edited_at: '2026-10-07T00:00:00Z' } },
      ...(kind === 'plans' ? { source: { ok: true as const, items: ids } } : {}) });
    const sync = await stubSyncQueries(page, (name) => {
      if (name === 'harnessProjects.lite') return projects;
      if (name === 'advRoster.list') return [{ active: [], pending: [] }];
      if (name === 'goals.list') return [{ goals: [goal], totalGoals: 1, goalPackages: [] }];
      if (name === 'goals.detail') {
        const selected = selection();
        if (!selected.ok || !selected.configured) throw new Error(JSON.stringify(selected));
        reads.push({ version: selected.policyVersion, order: selected.items.map((row) => row.id) });
        return [{ goal, goalData: { collections: { [property]: { selection: selected,
          rows: selected.items.map((row) => ({ ...row, label: labels[ids.indexOf(row.id)],
            state: row.id === ids[2] ? 'blocked' : 'ready', reason: row.id === ids[2] ? 'Waiting for dependency' : null })) } } } }];
      }
      return headerRows(name);
    });
    await page.route('**/api/admin/goals/set-property', async (route) => {
      const posted = route.request().postDataJSON();
      expect(posted.goalId).toBe(goal.id);
      expect(posted.property).toBe(policyName);
      expect(posted).not.toHaveProperty('provenance');
      if (refuseSave || posted.expectedVersion !== version) {
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'stale', actualVersion: version }) });
        return;
      }
      writes.push(posted);
      policy = posted.value;
      version++;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, version, provenance: 'owner-edit' }) });
    });
    await openHud(page, `/adv?tab=hud&scope=all&hudtab=goals&hudgoal=${goal.id}&welcome=0`, page.getByTestId('goal-data'));
    await sync.waitForServed(['goals.detail']);
    const editor = page.getByTestId('goal-data');
    async function reloadWithReadback() {
      const readback = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname.endsWith('/rest-query') && url.searchParams.get('name') === 'goals.detail';
      });
      await page.reload();
      try {
        const payload = await (await readback).json();
        expect(payload.rows[0].goalData.collections[property].selection.policyVersion).toBe(version);
        const expected = selection();
        if (!expected.ok || !expected.configured) throw new Error('collection unavailable');
        expect(payload.rows[0].goalData.collections[property].rows.map((row: { id: string }) => row.id))
          .toEqual(expected.items.map((row) => row.id));
      } finally {
        await test.info().attach(`collection-${kind}-readback-v${version}`, {
          body: JSON.stringify({ reads, writes, policy, version }), contentType: 'application/json',
        });
      }
    }
    await expect(editor.getByText('Waiting for dependency')).toBeVisible();
    const saved = page.waitForResponse('**/api/admin/goals/set-property');
    await editor.getByRole('button', { name: 'Move Second choice up' }).click();
    expect((await saved).status()).toBe(200);
    expect(policy.order).toEqual([ids[1], ids[0], ids[2], dormant]);
    await reloadWithReadback();
    await expect(editor.locator('li').first()).toContainText('Second choice');
    const excluded = page.waitForResponse('**/api/admin/goals/set-property');
    await editor.getByRole('checkbox', { name: 'Include Second choice' }).click();
    expect((await excluded).status()).toBe(200);
    expect(policy.excluded).toEqual([dormant, ids[1]]);
    await reloadWithReadback();
    await expect(editor.getByRole('checkbox', { name: 'Include Second choice' })).not.toBeChecked();
    await expect(editor.locator('li').first()).toContainText('Excluded');
    const afterExclusion = selection();
    if (!afterExclusion.ok || !afterExclusion.configured) throw new Error('collection unavailable');
    expect(afterExclusion.items.filter((row) => row.selected).map((row) => row.id)).toEqual([ids[0], ids[2]]);
    const reselected = page.waitForResponse('**/api/admin/goals/set-property');
    await editor.getByRole('checkbox', { name: 'Include Second choice' }).click();
    expect((await reselected).status()).toBe(200);
    await reloadWithReadback();
    await expect(editor.getByRole('checkbox', { name: 'Include Second choice' })).toBeChecked();
    expect(policy.excluded).toEqual([dormant]);
    expect(writes.map((write) => write.expectedVersion)).toEqual([4, 5, 6]);
    refuseSave = true;
    await editor.getByRole('checkbox', { name: 'Include First choice' }).click();
    await expect(editor.getByRole('alert')).toContainText('stale');
    await expect(editor.getByRole('checkbox', { name: 'Include First choice' })).toBeChecked();
    expect(version).toBe(7);
    await page.screenshot({ path: test.info().outputPath(`collection-${kind}.png`) });
    sync.assertServed('goals.list', 'goals.detail');
  });
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
  await openHud(page, '/adv?tab=hud&scope=all&hudtab=goals&welcome=0');
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
    const target = page.getByRole('tablist', { name: 'HUD board' }).getByRole('tab', { name: tab, exact: true });
    await target.click();
    await expect(target).toHaveAttribute('aria-selected', 'true');
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
  await openHud(page, '/adv?tab=hud&scope=all&hudtab=sessions&welcome=0');
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
  sync.assertServed('plans.attentionCounts', 'plans.list', 'plans.attention');
});
