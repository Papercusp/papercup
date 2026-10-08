import { test, expect } from '@playwright/test';
import type { OrderedSelectionPolicy } from '../../../packages/operator-core/lib/typed-properties';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { insertNativeCollectionGoal } from './_ongoing-work-native-fixture';

// An explicit ESM entry keeps the backend writer graph on Playwright's ESM loader.
async function loadNativeCollectionWriter() {
  const { default: postgres } = await import('postgres');
  const { applyGoalPropertyWrite } = await import('../../../packages/operator-core/lib/typed-properties-db');
  const { ensureOrderedSelectionPolicyDatatype, ensurePlanRefListDatatype } = await import('../../../packages/operator-core/lib/goals/package-property-datatypes');
  return { postgres, applyGoalPropertyWrite, ensureOrderedSelectionPolicyDatatype, ensurePlanRefListDatatype };
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

test('native declared collections persist controls and reject a barrier-controlled stale save', async ({ request }, info) => {
  test.skip(!process.env.VERIFY_TAURI_PID, 'Run with scripts/run-operator-e2e-isolated.sh for the owned Tauri bridge');
  test.setTimeout(180_000);
  const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID!;
  const adminUrl = process.env.HARNESS_ADMIN_DATABASE_URL!;
  expect(process.env.VERIFY_TAURI_ISOLATED_DB, 'Native writes require the maintained private database').toBe('1');
  expect(workspaceId).toMatch(/^verify-tauri-isolated-/);
  expect(adminUrl).toBeTruthy();
  expect(adminUrl).not.toBe(process.env.PAPERCUSP_TEST_RUNS_DB_URL);
  const { postgres, applyGoalPropertyWrite, ensureOrderedSelectionPolicyDatatype, ensurePlanRefListDatatype } = await loadNativeCollectionWriter();
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
          await sql`INSERT INTO harness_shared.harness_plans (workspace_id,harness_slug,plan_slug,title,status,op_status)
            VALUES (${workspaceId},${harness},${slug},${labels[index]},${slug === 'blocked' ? 'draft' : 'active'},NULL)`;
        }
        await sql`INSERT INTO harness_shared.harness_plans (workspace_id,harness_slug,plan_slug,title,status,op_status)
          VALUES (${workspaceId},'native-unrelated','preserved','Unrelated preserved plan','active',NULL)`;
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
      await clickAndSave(checkbox(labels[1]), 1);
      await expect.poll(async () => (await policy())?.version).toBe(2);
      expect((await policy())?.value.excluded).toEqual([dormant, ids[1]]);
      await reload();
      await ready(`document.querySelector(${JSON.stringify(checkbox(labels[1]))})?.getAttribute('aria-checked') === 'false' && document.querySelector(${JSON.stringify(`${editor} li`)})?.textContent.includes('Excluded') === true`);
      expect((await readback()).rows.filter((row: { selected: boolean }) => row.selected).map((row: { id: string }) => row.id))
        .toEqual(initialIds.filter((id) => id !== ids[1]));
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
    await sql.end({ timeout: 5 });
  }
});
