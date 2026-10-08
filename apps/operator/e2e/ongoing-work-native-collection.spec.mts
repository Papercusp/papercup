import { test, expect } from '@playwright/test';
import type { OrderedSelectionPolicy } from '../../../packages/operator-core/lib/typed-properties';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { insertNativeCollectionGoal, insertNativeCollectionPlan, setNativeCollectionPlanArchived } from './_ongoing-work-native-fixture';

// An explicit ESM entry keeps the backend writer graph on Playwright's ESM loader.
async function loadNativeCollectionWriter() {
  const { default: postgres } = await import('postgres');
  const { applyGoalPropertyWrite } = await import('../../../packages/operator-core/lib/typed-properties-db');
  const { ensureOrderedSelectionPolicyDatatype, ensurePlanRefListDatatype } = await import('../../../packages/operator-core/lib/goals/package-property-datatypes');
  const { claimNextWorkItem, releaseWorkItem } = await import('../../../packages/operator-core/lib/work-items');
  const { readGoalPortfolioBrief } = await import('../../../packages/operator-core/lib/goal-launch-settings');
  const { FLAGS } = await import('@papercusp/flags');
  const { setFlagOverridesForTest } = await import('@papercusp/flags/test');
  // These overrides belong only to this isolated fixture process. They mirror
  // the canonical claim-boundary integration suite's raw-row test route.
  const schedulerFixtureFlags = (enabled: boolean) => setFlagOverridesForTest(enabled
    ? { [FLAGS.SCHEDULER_MAINTAINED_READY]: false } : {});
  return { postgres, applyGoalPropertyWrite, ensureOrderedSelectionPolicyDatatype, ensurePlanRefListDatatype,
    claimNextWorkItem, releaseWorkItem, readGoalPortfolioBrief, schedulerFixtureFlags };
}

// This uses the same Node loader and complete graph as the native fixture, but
// needs no browser or database. Run it before booting the costly owned rig.
test('native collection fixture writer graph loads under the Playwright Node loader', async () => {
  const singleton = await import('@papercusp/module-singleton');
  await test.info().attach('singleton-loader-exports', { body: JSON.stringify({
    keys: Object.keys(singleton), pin: typeof singleton.pinModuleState,
    node: process.version, execArgv: process.execArgv,
  }), contentType: 'application/json' });
  expect(typeof singleton.pinModuleState).toBe('function');
  const writer = await loadNativeCollectionWriter();
  for (const method of Object.values(writer)) expect(typeof method).toBe('function');
});

test('Work on Everything design stays readable and draft controls work in the native viewport', async ({ request }, info) => {
  test.skip(!process.env.VERIFY_TAURI_PID, 'Requires the maintained isolated native rig');
  test.setTimeout(180_000);
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID!;
  expect(workspaceId).toMatch(/^verify-tauri-isolated-/);
  const { postgres, ensureOrderedSelectionPolicyDatatype, ensurePlanRefListDatatype } = await loadNativeCollectionWriter();
  const sql = postgres(process.env.HARNESS_ADMIN_DATABASE_URL!, { max: 1, connect_timeout: 5 });
  const run = promisify(execFile), bridge = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!;
  expect(bridge).toBeTruthy();
  async function native(command: string, ...args: string[]) {
    const result = await run(bridge, [command, '--pid', process.env.VERIFY_TAURI_PID!, ...args], { timeout: 20_000 });
    if (command === 'screenshot') return result.stdout.trim();
    const value = JSON.parse(result.stdout);
    return typeof value === 'string' ? JSON.parse(value) : value;
  }
  const measure = (expression: string) => native('eval', `JSON.stringify(${expression})`);
  const ready = (expression: string) => expect.poll(() => measure(expression), { timeout: 45_000,
    intervals: [300, 1000] }).toBe(true);
  const panel = '[data-testid="work-on-everything-console"]';
  const goalId = 'native-worklist-design';
  const ids = ['desktop', 'search', 'mobile'].map(slug => `plan:native-design/${slug}`);
  const labels = ['Design desktop release', 'Design search reliability', 'Design mobile workspace'];
  try {
    await ensureOrderedSelectionPolicyDatatype(sql, workspaceId);
    await ensurePlanRefListDatatype(sql, workspaceId);
    await insertNativeCollectionGoal(sql, { workspaceId, goalId, title: 'Work on everything · design acceptance', schema: {
      worklist: { datatype: 'plan-ref-list', editable_by: 'both', default: ids,
        collection: { source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority', selectable: true, defaultSelected: false } },
      worklist_policy: { datatype: 'ordered-selection-policy', editable_by: 'owner',
        default: { order: ids, included: ids.slice(0, 2), excluded: [ids[2]] } },
    } });
    await sql`UPDATE harness_shared.goals SET metadata = ${JSON.stringify({ goalPackageRef: 'work-on-everything' })}::text::jsonb
      WHERE workspace_id=${workspaceId} AND id=${goalId}`;
    for (const [index, slug] of ['desktop', 'search', 'mobile'].entries()) {
      await sql`INSERT INTO harness_shared.harness_plans (workspace_id,harness_slug,plan_slug,title,status,op_status)
        VALUES (${workspaceId},'native-design',${slug},${labels[index]},'active',NULL)`;
    }
    const readback = await request.get(`${process.env.VERIFY_TAURI_DEV_URL}/api/zero-harness/rest-query`, {
      params: { name: 'goals.detail', args: JSON.stringify({ workspaceId, goalId }) },
      headers: { 'x-papercusp-workspace': workspaceId },
    });
    expect(readback.ok()).toBe(true);
    const detail = (await readback.json()).rows[0];
    expect(detail.goal.goalPackage.ref).toBe('work-on-everything');
    expect(detail.goalData.collections.worklist.selection.configured).toBe(true);
    await native('navigate', `${process.env.VERIFY_TAURI_DEV_URL}/adv?tab=hud&scope=all&hudtab=goals&welcome=0&hudgoal=${goalId}&hudwoesearch=Design`, '--json');
    await ready(`document.querySelectorAll('${panel} [role="option"]').length === 3`);
    const layout = await measure(`(() => {
      const root = document.querySelector('${panel}');
      return { width: innerWidth, height: innerHeight,
        layoutColumns: getComputedStyle(root.querySelector('.woe__layout')).gridTemplateColumns,
        summary: Array.from(root.querySelectorAll('.woe__overview dd')).map(n => n.textContent),
        overflow: Array.from(root.querySelectorAll('.woe__row, .woe__overview, .woe__inspector, .woe__body'))
          .filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.className),
        nextSteps: Array.from(root.querySelectorAll('.woe__next')).map(n => ({ text: n.textContent,
          displayed: getComputedStyle(n).display, width: n.getBoundingClientRect().width })),
        inspector: !!root.querySelector('[aria-label="Plan inspector"]') };
    })()`);
    const expectedWidth = Number(process.env.VERIFY_TAURI_WINDOW?.split('x')[0] ?? 1280);
    expect(layout.width).toBe(expectedWidth);
    expect(layout.overflow).toEqual([]);
    expect(layout.summary[0]).toBe('2');
    expect(layout.summary[2]).toBe('0');
    expect(layout.inspector).toBe(true);
    for (const next of layout.nextSteps) {
      expect(next.text.length).toBeGreaterThan(0);
      expect(next.displayed).not.toBe('none');
      expect(next.width).toBeGreaterThan(0);
    }
    if (expectedWidth <= 650) expect(layout.layoutColumns.trim().split(/\s+/)).toHaveLength(1);
    await native('screenshot', '--output', info.outputPath(`worklist-${expectedWidth}.png`));
    await native('click', 'button[aria-label="Move Design search reliability up"]', '--json');
    await ready(`document.querySelector('${panel} [role="option"] strong')?.textContent === ${JSON.stringify(labels[1])}`);
    await native('click', 'button[aria-label="Remove Design desktop release"]', '--json');
    await ready(`document.querySelector('${panel} .woe__overview dd')?.textContent === '1'`);
    await native('eval', `(() => { const body = document.querySelector('${panel} .woe__body'); body.scrollTop = body.scrollHeight; return true; })()`);
    await native('click', '.woe__draft-bar .pc-ctl-act--primary', '--json');
    await ready(`Array.from(document.querySelectorAll('[role="dialog"]')).some(n => n.textContent.includes('After apply'))`);
    expect(await measure(`Array.from(document.querySelectorAll('.woe__diff li')).map(n => n.textContent)`))
      .toContain(labels[1]);
    await native('screenshot', '--output', info.outputPath(`review-${expectedWidth}.png`));
    await native('eval', `(() => { const button = Array.from(document.querySelectorAll('.woe__review button')).find(n => n.textContent === 'Keep editing'); button.click(); return true; })()`);
    await ready(`!document.querySelector('.woe__review')`);
    await native('eval', `(() => { const button = Array.from(document.querySelectorAll('.woe__draft-bar button')).find(n => n.textContent === 'Discard'); button.click(); return true; })()`);
    await ready(`!document.querySelector('.woe__draft-bar') && document.querySelector('${panel} .woe__overview dd')?.textContent === '2'`);
    const [saved] = await sql`SELECT properties FROM harness_shared.goals WHERE workspace_id=${workspaceId} AND id=${goalId}`;
    expect(saved.properties?.worklist_policy).toBeUndefined();
    await info.attach('native-design-layout', { body: JSON.stringify({ layout, fixture: { goalId, labels },
      draftReordered: true, scopeStaged: true, reviewOpened: true, discardRestored: true, applyClicked: false }), contentType: 'application/json' });
  } finally {
    await sql.end();
  }
});

test('native declared collections persist controls and reject a barrier-controlled stale save', async ({ request }, info) => {
  test.skip(!process.env.VERIFY_TAURI_PID, 'Run with scripts/run-operator-e2e-isolated.sh for the owned Tauri bridge');
  test.setTimeout(180_000);
  const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID!;
  const adminUrl = process.env.HARNESS_ADMIN_DATABASE_URL!;
  expect(process.env.VERIFY_TAURI_ISOLATED_DB, 'Native writes require the maintained private database').toBe('1');
  expect(workspaceId).toMatch(/^verify-tauri-isolated-/);
  expect(adminUrl).toBeTruthy();
  expect(adminUrl).not.toBe(process.env.PAPERCUSP_TEST_RUNS_DB_URL);
  const { postgres, applyGoalPropertyWrite, ensureOrderedSelectionPolicyDatatype, ensurePlanRefListDatatype,
    claimNextWorkItem, releaseWorkItem, readGoalPortfolioBrief, schedulerFixtureFlags } = await loadNativeCollectionWriter();
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
  async function clickControl(selector: string) {
    // The native click bridge does not provide Playwright's enabled check.
    await ready(`(() => { const control = document.querySelector(${JSON.stringify(selector)}); return !!control && !control.disabled && control.getAttribute('aria-disabled') !== 'true'; })()`);
    await native('click', selector, '--json');
  }
  async function observeWrites() {
    await native('eval', `(() => {
      if (window.__nativeCollectionWrites) return true;
      window.__nativeCollectionWrites = [];
      const original = window.fetch;
      window.fetch = async (input, init) => {
        if (!String(input).includes('/api/admin/goals/set-property')) return original(input, init);
        const entry = { body: JSON.parse(init.body), startedAt: Date.now(), settled: false };
        window.__nativeCollectionWrites.push(entry);
        try {
          const response = await original(input, init);
          entry.status = response.status;
          entry.response = await response.clone().json();
          return response;
        } catch (error) { entry.error = String(error); throw error; }
        finally { entry.settled = true; entry.elapsedMs = Date.now() - entry.startedAt; }
      };
      return true;
    })()`);
  }
  async function clickAndSave(selector: string, expectedVersion: number) {
    const count = await measure('window.__nativeCollectionWrites.length');
    await clickControl(selector);
    await ready(`window.__nativeCollectionWrites.length === ${count + 1}`);
    await ready(`window.__nativeCollectionWrites[${count}].settled === true`);
    const receipt = await measure(`window.__nativeCollectionWrites[${count}]`);
    evidence.push({ writeReceipt: receipt });
    expect(receipt.body.expectedVersion).toBe(expectedVersion);
    expect(receipt.error).toBeUndefined();
    expect(receipt.status).toBe(200);
    expect(receipt.response.ok).toBe(true);
  }
  try {
    schedulerFixtureFlags(true);
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
      await insertNativeCollectionGoal(sql, { workspaceId, goalId, title: `Native ${kind} collection`, schema });
      if (kind === 'plans') {
        for (const [index, slug] of ['alpha', 'beta', 'blocked'].entries()) {
          await insertNativeCollectionPlan(sql, { workspaceId, harness, slug, title: labels[index],
            status: slug === 'blocked' ? 'draft' : 'active' });
        }
        await sql`INSERT INTO harness_shared.harness_plans (workspace_id,harness_slug,plan_slug,title,status,op_status)
          VALUES (${workspaceId},'native-unrelated','preserved','Unrelated preserved plan','active',NULL)`;
        // Validate admission premises before native navigation or owner writes.
        // A metadata-only seed has no canonical actionable item.
        const seeded = await readGoalPortfolioBrief({ workspaceId, goalId, sql, claimability: 'skip' });
        evidence.push({ seededAdmission: seeded?.worklist.map(plan => ({ slug: plan.slug, next: plan.next,
          state: plan.placement.state, reason: plan.placement.reconciliation.reason })) });
        expect(seeded?.worklist.find(plan => plan.slug === 'alpha')?.next?.id).toBe('P-001');
        expect(seeded?.worklist.find(plan => plan.slug === 'beta')?.next?.id).toBe('P-001');
      }
      const url = `${process.env.VERIFY_TAURI_DEV_URL}/adv?tab=hud&scope=all&hudtab=goals&welcome=0&hudgoal=${goalId}`;
      const policy = async () => {
        const [row] = await sql`SELECT properties FROM harness_shared.goals WHERE workspace_id=${workspaceId} AND id=${goalId}`;
        return row.properties[policyName] as { value: OrderedSelectionPolicy; version: number; provenance: string } | undefined;
      };
      async function reload() {
        evidence.push({ writesBeforeNavigation: await measure('window.__nativeCollectionWrites ?? []') });
        await native('navigate', url, '--json');
        await ready(`!!document.querySelector(${JSON.stringify(editor)}) && document.querySelector(${JSON.stringify(editor)})?.getBoundingClientRect().height > 0`);
        await observeWrites();
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
      const initialIds: string[] = initial.rows.map((row: { id: string }) => row.id);
      // A migrated workspace also contains maintained rubric plans. Pin our
      // independently seeded controls and preserve the complete discovered
      // population through edits instead of assuming the database is empty.
      expect(initialIds.slice(0, ids.length)).toEqual(ids);
      expect(new Set(initialIds).size).toBe(initialIds.length);
      if (kind === 'plans') {
        expect(initialIds).toContain('plan:native-unrelated/preserved');
        expect(initial.rows[2].reason).toBeTruthy();
        await ready(`document.querySelector(${JSON.stringify(editor)})?.textContent.includes(${JSON.stringify(initial.rows[2].reason)}) === true`);
      } else expect(initialIds).toEqual(ids);
      const reorderedIds = [initialIds[1], initialIds[0], ...initialIds.slice(2)];
      await clickAndSave(`${editor} button[aria-label=${JSON.stringify(`Move ${labels[1]} up`)}]`, 0);
      await expect.poll(async () => (await policy())?.version).toBe(1);
      expect((await policy())?.value.order).toEqual([...reorderedIds, dormant]);
      expect((await policy())?.provenance).toBe('owner-edit');
      await reload();
      await ready(`document.querySelector(${JSON.stringify(`${editor} li`)})?.textContent.includes(${JSON.stringify(labels[1])}) === true`);
      expect((await readback()).rows.map((row: { id: string }) => row.id)).toEqual(reorderedIds);
      if (kind === 'plans') {
        // Pick real goal-stamped rows after the ACTUAL native owner write. A
        // display-only reorder cannot change this canonical claim result.
        for (const [index, slug] of ['alpha', 'beta'].entries()) {
          await sql`INSERT INTO harness_shared.work_items
            (workspace_id,harness_slug,feature_id,item_kind,title,status,admission,goal_id,source_plan_slug,created_ts,updated_ts,payload)
            VALUES (${workspaceId},${harness},${`WI-native-${slug}`},'feature',${`Native ${slug}`},'open','admitted',
              ${goalId},${slug},${index + 1},0,'{}'::jsonb)`;
        }
        const picked = await claimNextWorkItem({ harness, assignee: 'native-policy-picker' });
        expect(picked?.id).toBe('WI-native-beta');
        evidence.push({ canonicalPickAfterNativeReorder: picked?.id });
        // Fill both eligible lanes through the canonical claim boundary. A
        // later requester must preserve those claims after the native reorder.
        const peerPick = await claimNextWorkItem({ harness, assignee: 'native-peer-holder' });
        expect(peerPick?.id).toBe('WI-native-alpha');
        const refused = await claimNextWorkItem({ harness, assignee: 'native-later-requester' });
        expect(refused).toBeNull();
        const heldRows = await sql`SELECT feature_id, taken_by FROM harness_shared.work_items
          WHERE workspace_id=${workspaceId} AND harness_slug=${harness}
            AND feature_id IN ('WI-native-alpha', 'WI-native-beta') ORDER BY feature_id`;
        expect(heldRows.map(row => ({ id: row.feature_id, assignee: row.taken_by }))).toEqual([
          { id: 'WI-native-alpha', assignee: 'native-peer-holder' },
          { id: 'WI-native-beta', assignee: 'native-policy-picker' },
        ]);
        evidence.push({ peerClaimRefusedAfterNativeReorder: refused, retainedHolders: heldRows });
        await releaseWorkItem('WI-native-alpha', { harness });
        await releaseWorkItem('WI-native-beta', { harness });
        const portfolio = await readGoalPortfolioBrief({ workspaceId, goalId, sql, claimability: 'skip' });
        evidence.push({ admissionAfterNativeReorder: portfolio?.worklist.map(plan => ({
          slug: plan.slug, state: plan.placement.state, reason: plan.placement.reconciliation.reason,
          nextCall: plan.placement.reconciliation.toolCall,
        })) });
        expect(portfolio).not.toBeNull();
        expect(portfolio!.worklist.find(plan => plan.slug === 'blocked')?.placement.reconciliation.toolCall).toBeNull();
        expect(portfolio!.worklist.find(plan => plan.slug === 'blocked')?.placement.reconciliation.reason).toMatch(/draft.*cannot launch/i);
        expect(portfolio!.worklist.find(plan => plan.placement.reconciliation.toolCall !== null)?.slug).toBe('beta');
      }
      await clickAndSave(checkbox(labels[1]), 1);
      await expect.poll(async () => (await policy())?.version).toBe(2);
      expect((await policy())?.value.excluded).toEqual([dormant, ids[1]]);
      await reload();
      await ready(`document.querySelector(${JSON.stringify(checkbox(labels[1]))})?.getAttribute('aria-checked') === 'false' && document.querySelector(${JSON.stringify(`${editor} li`)})?.textContent.includes('Excluded') === true`);
      expect((await readback()).rows.filter((row: { selected: boolean }) => row.selected).map((row: { id: string }) => row.id))
        .toEqual(initialIds.filter((id) => id !== ids[1]));
      if (kind === 'plans') {
        const picked = await claimNextWorkItem({ harness, assignee: 'native-policy-picker' });
        expect(picked?.id).toBe('WI-native-alpha');
        await releaseWorkItem('WI-native-alpha', { harness });
        // Remove beta from both source legs, then rediscover it. The stored
        // owner overlay must survive every reload and source reconciliation.
        await setNativeCollectionPlanArchived(sql, { workspaceId, harness, slug: 'beta', archived: true });
        const sourceWrite = await sql.begin(tx => applyGoalPropertyWrite(tx as unknown as typeof sql, {
          workspaceId, goalId, property, value: [ids[0], ids[2]], expectedVersion: 0,
          provenance: 'agent-edit', actorId: 'native-fixture-agent',
        }));
        expect(sourceWrite.ok).toBe(true);
        await reload();
        expect((await readback()).rows.map((row: { id: string }) => row.id)).not.toContain(ids[1]);
        expect((await policy())?.value.excluded).toEqual([dormant, ids[1]]);
        await setNativeCollectionPlanArchived(sql, { workspaceId, harness, slug: 'beta', archived: false });
        await reload();
        await ready(`document.querySelector(${JSON.stringify(checkbox(labels[1]))})?.getAttribute('aria-checked') === 'false'`);
        expect((await readback()).rows.map((row: { id: string }) => row.id)).toEqual(reorderedIds);
        expect((await policy())?.version).toBe(2);
        expect((await policy())?.value.order).toEqual([...reorderedIds, dormant]);
        evidence.push({ archiveReactivateAndAgentRefresh: true, ownerPolicy: await policy() });
      }
      await clickAndSave(checkbox(labels[1]), 2);
      await expect.poll(async () => (await policy())?.version).toBe(3);
      await reload();
      await ready(`document.querySelector(${JSON.stringify(checkbox(labels[1]))})?.getAttribute('aria-checked') === 'true'`);
      // Hold the actual UI request, advance the canonical owner revision, then
      // release the original body. A synthetic 409 cannot satisfy this test.
      await native('eval', `(() => { const original = window.fetch; window.__nativeCollectionBarrier = { release: null, body: null }; window.fetch = async (input, init) => { if (String(input).includes('/api/admin/goals/set-property')) { window.__nativeCollectionBarrier.body = JSON.parse(init.body); await new Promise(resolve => { window.__nativeCollectionBarrier.release = resolve; }); } return original(input, init); }; return true; })()`);
      await clickControl(checkbox(labels[0]));
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
    try {
      evidence.push({ finalWrites: await measure('window.__nativeCollectionWrites ?? []'),
        controls: await measure(`Array.from(document.querySelectorAll(${JSON.stringify(`${editor} [role="checkbox"]`)})).map(control => ({ label: control.getAttribute('aria-label'), disabled: control.disabled, checked: control.getAttribute('aria-checked') }))`) });
    } catch (error) { evidence.push({ writeDiagnosticsError: String(error) }); }
    const screenshot = info.outputPath('native-collection-final.png');
    try {
      await native('screenshot', '--output', screenshot);
      await info.attach('native-collection-final', { path: screenshot, contentType: 'image/png' });
    } catch (error) { evidence.push({ screenshotError: String(error) }); }
    await info.attach('native-collection-readbacks', { body: JSON.stringify(evidence), contentType: 'application/json' });
    schedulerFixtureFlags(false);
    await sql.end({ timeout: 5 });
  }
});
