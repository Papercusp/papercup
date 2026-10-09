import { test, expect, type TestInfo } from '@playwright/test';
import type { OrderedSelectionPolicy } from '../../../packages/operator-core/lib/typed-properties';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { basename, dirname } from 'node:path';
import { decodeNativeBridgeJson } from './_native-bridge-json';

// Native failures can happen in the initial API read before a browser is
// navigated or a cockpit screenshot exists. The default on-first-retry trace
// records nothing when this owned, expensive verifier runs without retries.
test.use({ trace: 'retain-on-failure' });

test('native CLI JSON boundary preserves scalar and JSON-looking string values', () => {
  // Captured CLI output from the real HUD assertion must remain a string.
  expect(decodeNativeBridgeJson('"hud"')).toBe('hud');
  expect(decodeNativeBridgeJson('"false"')).toBe('false');
  expect(decodeNativeBridgeJson(JSON.stringify('{"value":1}'))).toBe('{"value":1}');
  expect(decodeNativeBridgeJson('false')).toBe(false);
  expect(decodeNativeBridgeJson('0')).toBe(0);
  expect(decodeNativeBridgeJson('null')).toBeNull();
  expect(decodeNativeBridgeJson('{"value":1}')).toEqual({ value: 1 });
  expect(decodeNativeBridgeJson('[1,"hud"]')).toEqual([1, 'hud']);
  expect(() => decodeNativeBridgeJson('not JSON')).toThrow();
});
import { insertNativeCollectionGoal, insertNativeCollectionPlan, nativeCollectionDeclaration, setNativeCollectionPlanArchived,
  recordNativeCollectionJourney } from './_ongoing-work-native-fixture';

async function recordJourney(info: TestInfo, run: () => Promise<void>) {
  expect(process.env.VH_PHASE_DIR, 'Owned verifier assertion phase required').toBeTruthy();
  const sourceReceipt = JSON.parse(await readFile(process.env.VERIFY_TAURI_SOURCE_RECEIPT!, 'utf8'));
  const completedRuntime = await recordNativeCollectionJourney({ sourceReceipt,
    sourceRoot: process.env.OPERATOR_SOURCE_ROOT!,
    verifierRunId: basename(dirname(dirname(process.env.VH_PHASE_DIR!))),
    testPath: 'apps/operator/e2e/ongoing-work-native-collection.spec.mts', run });
  await info.attach('native-completed-runtime', { body: JSON.stringify({ completedRuntime,
    runtimeUnits: [`verify-tauri-headless:${process.env.VERIFY_TAURI_PID}`] }), contentType: 'application/json' });
}

// The app directory is CommonJS; the native spec and e2e helpers are ESM.
const { isWorkOnEverything }: typeof import('../app/adv/hud/ongoing-work-draft') =
  createRequire(import.meta.url)('../app/adv/hud/ongoing-work-draft');

function nativeCollectionDocumentReady(editor: string) {
  return `window.__nativeCollectionPreviousDocument !== true && document.readyState === 'complete' && !!document.querySelector(${JSON.stringify(editor)}) && document.querySelector(${JSON.stringify(editor)})?.getBoundingClientRect().height > 0`;
}

function nativeWorklistKeyReceived(key: string, target: string) {
  return `window.__nativeWorklistKeys.some(e => e.key === ${JSON.stringify(key)} && e.trusted === true && e.target === ${JSON.stringify(target)})`;
}

test('native keyboard receipt rejects unidentified, untrusted and wrong-target keys', () => {
  const target = 'Move Design search reliability up';
  const window = { __nativeWorklistKeys: [{ key: 'Unidentified', trusted: true, target }] };
  const script = nativeWorklistKeyReceived('Shift', target);
  expect(runInNewContext(script, { window })).toBe(false);
  window.__nativeWorklistKeys = [{ key: 'Shift', trusted: false, target }];
  expect(runInNewContext(script, { window })).toBe(false);
  window.__nativeWorklistKeys = [{ key: 'Shift', trusted: true, target: 'Other control' }];
  expect(runInNewContext(script, { window })).toBe(false);
  window.__nativeWorklistKeys = [{ key: 'Shift', trusted: true, target }];
  expect(runInNewContext(script, { window })).toBe(true);
  expect(runInNewContext(nativeWorklistKeyReceived(' ', target), { window })).toBe(false);
  window.__nativeWorklistKeys = [{ key: ' ', trusted: true, target }];
  expect(runInNewContext(nativeWorklistKeyReceived(' ', target), { window })).toBe(true);
});

test('native reload readiness rejects a still-visible previous document', () => {
  const window: { __nativeCollectionPreviousDocument?: boolean } = { __nativeCollectionPreviousDocument: true };
  let height = 20;
  const document = { readyState: 'complete', querySelector: () => ({ getBoundingClientRect: () => ({ height }) }) };
  const script = nativeCollectionDocumentReady('[data-testid="goal-data"]');
  // The bridge acknowledges location assignment while this old editor is still
  // painted. Presence/visibility alone must never satisfy reload readiness.
  expect(runInNewContext(script, { window, document })).toBe(false);
  delete window.__nativeCollectionPreviousDocument;
  expect(runInNewContext(script, { window, document })).toBe(true);
  document.readyState = 'loading';
  expect(runInNewContext(script, { window, document })).toBe(false);
  document.readyState = 'complete';
  height = 0;
  expect(runInNewContext(script, { window, document })).toBe(false);
});

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
  const { runHarness, defaultEvidenceRoot } = await import('@papercusp/verification-harness');
  expect(typeof runHarness).toBe('function');
  expect(typeof defaultEvidenceRoot).toBe('function');
});

test('Work on Everything Design C cockpit and priority editor stay readable in the native viewport', async ({ request }, info) => {
  test.skip(!process.env.VERIFY_TAURI_PID, 'Requires the maintained isolated native rig');
  await recordJourney(info, async () => {
  test.setTimeout(180_000);
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID!;
  expect(workspaceId).toMatch(/^verify-tauri-isolated-/);
  const { postgres, ensureOrderedSelectionPolicyDatatype, ensurePlanRefListDatatype } = await loadNativeCollectionWriter();
  const sql = postgres(process.env.HARNESS_ADMIN_DATABASE_URL!, { max: 1, connect_timeout: 5 });
  const run = promisify(execFile), bridge = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!;
  expect(bridge).toBeTruthy();
  const sourceReceiptPath = process.env.VERIFY_TAURI_SOURCE_RECEIPT;
  expect(sourceReceiptPath, 'Native acceptance must identify its immutable source').toBeTruthy();
  const sourceReceipt = JSON.parse(await readFile(sourceReceiptPath!, 'utf8'));
  async function native(command: string, ...args: string[]) {
    await run('bash', [process.env.VERIFY_TAURI_LIVENESS_CHECK!], { timeout: 10_000 });
    const result = await run(bridge, [command, '--pid', process.env.VERIFY_TAURI_PID!, ...args], { timeout: 20_000 });
    if (command === 'screenshot') return result.stdout.trim();
    return decodeNativeBridgeJson(result.stdout);
  }
  const measure = (expression: string) => native('eval', `JSON.stringify(${expression})`);
  let readyFailureCount = 0;
  const ready = async (expression: string) => {
    try {
      await expect.poll(() => measure(expression), { timeout: 45_000, intervals: [300, 1000] }).toBe(true);
    } catch (error) {
      const failure = ++readyFailureCount;
      try {
        const state = await measure(`({
          expression: ${JSON.stringify(expression)}, url: location.href,
          routerSearch: window.__TSR_ROUTER__?.latestLocation?.search ?? window.__TSR_ROUTER__?.state?.location?.search ?? null,
          priorityIds: Array.from(document.querySelectorAll('[data-testid="ongoing-priority-row"]')).map(n => n.dataset.worklistId),
          buttons: Array.from(document.querySelectorAll('[data-testid="work-on-everything-console"] button')).map(n => ({
            text: n.textContent, pressed: n.getAttribute('aria-pressed'), disabled: n.disabled,
          })),
          alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(n => n.textContent),
          body: document.body.innerText,
        })`);
        await info.attach(`native-ready-failure-${failure}`, {
          body: JSON.stringify({ state, sourceReceipt }), contentType: 'application/json',
        });
        await native('screenshot', '--output', info.outputPath(`ready-failure-${failure}.png`));
      } catch (captureError) {
        await info.attach(`native-ready-capture-error-${failure}`, {
          body: String(captureError), contentType: 'text/plain',
        });
      }
      throw error;
    }
  };
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
    // Match the real pre-package goal: its stored worklist seeds two picks,
    // while the declaration discovers all three plans. No package metadata.
    await sql`UPDATE harness_shared.goals SET properties = ${JSON.stringify({ worklist: {
      value: ids.slice(0, 2), version: 1,
    } })}::text::jsonb
      WHERE workspace_id=${workspaceId} AND id=${goalId}`;
    for (const [index, slug] of ['desktop', 'search', 'mobile'].entries()) {
      await insertNativeCollectionPlan(sql, { workspaceId, harness: 'native-design', slug,
        title: labels[index], status: 'active' });
    }
    const readback = await request.get(`${process.env.VERIFY_TAURI_DEV_URL}/api/zero-harness/rest-query`, {
      params: { name: 'goals.detail', args: JSON.stringify({ workspaceId, goalId }) },
      headers: { 'x-papercusp-workspace': workspaceId },
    });
    expect(readback.ok()).toBe(true);
    const detail = (await readback.json()).rows[0];
    expect(detail.goal.goalPackage).toBeNull();
    expect(detail.goalData.collections.worklist.selection.configured).toBe(true);
    expect(detail.goalData.collections.worklist.selection.selected).toEqual(ids.slice(0, 2));
    expect(detail.goalData.collections.worklist.rows.map((r: { id: string }) => r.id).sort())
      .toEqual([...ids].sort());
    // insertNativeCollectionPlan seeds one real todo item per plan. Two
    // measured selected plans are not an empty or unknown progress fixture.
    expect(detail.goalData.collections.worklist.rows.filter((r: { selected: boolean }) => r.selected)
      .map((r: { counts: { todo: number; done: number } }) => ({ todo: r.counts.todo, done: r.counts.done })))
      .toEqual([{ todo: 1, done: 0 }, { todo: 1, done: 0 }]);
    expect(detail.rubricStewardship).toMatchObject({
      rubricRef: 'work-on-everything-stewardship-health', cycles: [], error: null,
    });
    await native('navigate', `${process.env.VERIFY_TAURI_DEV_URL}/adv?tab=hud&scope=all&hudtab=goals&welcome=0&ws=${encodeURIComponent(workspaceId)}&hudgoal=${goalId}&hudwoesearch=Design&hudwoesort=rank`, '--json');
    await ready(`document.querySelectorAll('${panel} [data-testid="ongoing-priority-row"]').length === 2`);
    const cockpit = await measure(`(() => {
      const root = document.querySelector('${panel}');
      return {
        priorities: Array.from(root.querySelectorAll('[data-testid="ongoing-priority-row"]')).map(n => n.dataset.worklistId),
        health: !!root.querySelector('[aria-label="Goal health"]'),
        needsYou: !!root.querySelector('[aria-label="Needs you"]'),
        activity: !!root.querySelector('[aria-label="Recent activity"]'),
        progressText: root.querySelector('[aria-label="Selected plan progress"]')?.textContent,
        overflowingPanel: root.scrollWidth > root.clientWidth + 1,
        columns: getComputedStyle(root.querySelector('.woe__cockpit')).gridTemplateColumns,
        hasDraftControls: !!root.querySelector('button[aria-label^="Remove "]'),
      };
    })()`);
    // Preserve the native view and canonical readback even when an assertion
    // fails, before the owned rig tears down its temporary source and profile.
    await native('screenshot', '--output', info.outputPath('goal-cockpit.png'));
    await info.attach('native-design-c-cockpit', {
      body: JSON.stringify({ cockpit, detail, sourceReceipt }), contentType: 'application/json',
    });
    expect(cockpit.priorities).toEqual(ids.slice(0, 2));
    expect(cockpit.health).toBe(true); expect(cockpit.needsYou).toBe(true); expect(cockpit.activity).toBe(true);
    expect(cockpit.progressText).toContain('0 of 2 items done');
    expect(cockpit.progressText).toContain('0% of measured items complete');
    expect(cockpit.progressText).toContain('2 of 2 selected plans measured');
    expect(cockpit.overflowingPanel).toBe(false);
    expect(cockpit.hasDraftControls).toBe(false);
    const browse = `${panel} .woe__priority .woe__actions button:last-child`;
    expect(await measure(`document.querySelector(${JSON.stringify(browse)})?.textContent`)).toBe('Browse all plans');
    await native('click', browse, '--json');
    await ready(`new URL(location.href).searchParams.get('hudwoebrowse') === 'true'`);
    await ready(`document.querySelectorAll('${panel} [data-testid="ongoing-priority-row"]').length === 3`);
    expect(await measure(`!!document.querySelector('${panel} .woe__draft-bar')`)).toBe(false);
    await native('click', '.woe__header button[aria-pressed]', '--json');
    await ready(`document.querySelectorAll('${panel} [data-testid="ongoing-worklist-row"]').length === 3`);
    // An empty isolated goal must expose its duties without inventing measured
    // quality or a completed grading cycle. Exercise the actual native view.
    const stewardship = await measure(`(() => {
      const quality = document.querySelector('${panel} [aria-label="Rubric stewardship"]');
      return quality ? {
        duties: Array.from(quality.querySelectorAll('h4')).map(n => n.textContent),
        states: Array.from(quality.querySelectorAll('.woe__quality-duties .woe__state')).map(n => n.textContent),
        empty: quality.textContent.includes('No goal-attributed grading cycles are recorded'),
        claimsImprovement: quality.textContent.includes('Improvement verified'),
        rubricLink: quality.querySelector('a')?.getAttribute('href'),
      } : null;
    })()`);
    expect(stewardship).toEqual({
      duties: ['Maintain rubric coverage', 'Improve rubric quality', 'Grade, improve and re-grade'],
      states: ['Not measured', 'Not measured', 'Not measured'],
      empty: true, claimsImprovement: false, rubricLink: '/rubrics',
    });
    await info.attach('native-rubric-stewardship-empty-goal', {
      body: JSON.stringify({ stewardship, reading: detail.rubricStewardship, sourceReceipt }),
      contentType: 'application/json',
    });
    const layout = await measure(`(() => {
      const root = document.querySelector('${panel}');
      return { width: innerWidth, height: innerHeight,
        headings: Array.from(root.querySelectorAll('.woe__table th')).map(n => n.textContent),
        selected: root.querySelectorAll('.woe__scope--in').length,
        unselected: root.querySelectorAll('button[aria-label^="Add "]').length,
        totals: !!root.querySelector('[role="group"][aria-label="Totals"]'),
        chart: !!root.querySelector('.woe__chart svg[role="img"]'),
        overflowingPanel: root.scrollWidth > root.clientWidth + 1,
        nextSteps: Array.from(root.querySelectorAll('.woe__table tbody tr td:last-child')).map(n => n.textContent) };
    })()`);
    const expectedWidth = Number(process.env.VERIFY_TAURI_WINDOW?.split('x')[0] ?? 1280);
    expect(layout.width).toBe(expectedWidth);
    expect(layout.overflowingPanel).toBe(false);
    expect(layout.headings).toEqual(['Worklist', 'Plan', 'Progress', 'State', 'Why / next step']);
    expect(layout.selected).toBe(2);
    expect(layout.unselected).toBe(1);
    expect(layout.totals).toBe(true);
    expect(layout.chart).toBe(true);
    for (const next of layout.nextSteps) expect(next.trim().length).toBeGreaterThan(0);
    await native('screenshot', '--output', info.outputPath(`worklist-${expectedWidth}.png`));
    // Drive an offered draft control through trusted native keyboard input.
    const toggle = 'button[aria-label="Move Design search reliability up"]';
    await native('focus', toggle, '--json');
    const xEnv = { ...process.env, DISPLAY: process.env.VERIFY_TAURI_DISPLAY! };
    expect(xEnv.DISPLAY).toMatch(/^:\d+$/);
    const windows = await run('xdotool', ['search', '--onlyvisible', '--pid', process.env.VERIFY_TAURI_PID!],
      { timeout: 10_000, env: xEnv });
    const windowIds = windows.stdout.trim().split(/\s+/);
    expect(windowIds).toHaveLength(1);
    await run('xdotool', ['windowfocus', '--sync', windowIds[0]], { timeout: 10_000, env: xEnv });
    const focused = await run('xdotool', ['getwindowfocus'], { timeout: 10_000, env: xEnv });
    expect(focused.stdout.trim(), 'Keyboard input must stay on the owned native window').toBe(windowIds[0]);
    await native('focus', toggle, '--json');
    await native('eval', `(() => {
      window.__nativeWorklistKeys = [];
      document.addEventListener('keydown', e => window.__nativeWorklistKeys.push({
        key: e.key, code: e.code, altKey: e.altKey, trusted: e.isTrusted,
        target: e.target?.getAttribute?.('aria-label'),
      }), true);
      return true;
    })()`);
    try {
      // Without --window, xdotool uses XTest delivery to the verified focus;
      // --window uses XSendEvent, which is not an equivalent WebKit input path.
      // This WebKit runtime maps F23 to a trusted Unidentified key. A neutral
      // modifier has a named DOM key and leaves the offered control unchanged.
      await run('xdotool', ['key', '--clearmodifiers', 'Shift_L'], { timeout: 10_000, env: xEnv });
      await ready(nativeWorklistKeyReceived('Shift', 'Move Design search reliability up'));
      await run('xdotool', ['key', '--clearmodifiers', 'space'], { timeout: 10_000, env: xEnv });
      await ready(nativeWorklistKeyReceived(' ', 'Move Design search reliability up'));
      await ready(`document.querySelector('${panel} [data-testid="ongoing-worklist-row"] td:nth-child(2)')?.textContent?.trim().startsWith(${JSON.stringify(labels[1])})`);
      await info.attach('native-key-delivery-success', { body: JSON.stringify({
        keys: await measure('window.__nativeWorklistKeys'), sourceReceipt, nativeKeyboardReorder: true,
      }), contentType: 'application/json' });
    } catch (error) {
      await info.attach('native-key-delivery', { body: JSON.stringify(await measure(`({
        keys: window.__nativeWorklistKeys, tab: new URL(location.href).searchParams.get('tab'),
        focusedControl: document.activeElement?.getAttribute('aria-label'),
        included: Array.from(document.querySelectorAll('${panel} .woe__scope--in')).map(e => e.getAttribute('aria-label')),
      })`)), contentType: 'application/json' });
      await native('screenshot', '--output', info.outputPath('keyboard-failure.png'));
      throw error;
    }
    expect(await measure(`new URL(location.href).searchParams.get('tab')`)).toBe('hud');
    await ready(`!!document.querySelector('${panel} .woe__draft-bar')`);
    await native('click', 'button[aria-label="Remove Design desktop release"]', '--json');
    await ready(`document.querySelectorAll('${panel} .woe__scope--in').length === 1`);
    await native('click', '.woe__draft-bar .pc-ctl-act--primary', '--json');
    await ready(`Array.from(document.querySelectorAll('[role="dialog"]')).some(n => n.textContent.includes('After apply'))`);
    expect((await measure(`Array.from(document.querySelectorAll('.woe__diff li')).map(n => n.textContent)`))
      .some((text: string) => text.includes(labels[1]))).toBe(true);
    await native('screenshot', '--output', info.outputPath(`review-${expectedWidth}.png`));
    await native('eval', `(() => { const button = Array.from(document.querySelectorAll('.woe__review button')).find(n => n.textContent === 'Keep editing'); button.click(); return true; })()`);
    await ready(`!document.querySelector('.woe__review')`);
    await native('eval', `(() => { const button = Array.from(document.querySelectorAll('.woe__draft-bar button')).find(n => n.textContent === 'Discard'); button.click(); return true; })()`);
    await ready(`!document.querySelector('.woe__draft-bar') && document.querySelectorAll('${panel} .woe__scope--in').length === 2`);
    const [saved] = await sql`SELECT properties FROM harness_shared.goals WHERE workspace_id=${workspaceId} AND id=${goalId}`;
    expect(saved.properties?.worklist_policy).toBeUndefined();
    await info.attach('native-design-layout', { body: JSON.stringify({ layout, sourceReceipt,
      nativeKeys: await measure('window.__nativeWorklistKeys'),
      fixture: { goalId, labels }, legacyWithoutPackage: true, nativeKeyboardReorder: true,
      globalHudTabRetained: true, scopeStaged: true, reviewOpened: true, discardRestored: true,
      applyClicked: false }), contentType: 'application/json' });
  } finally {
    await sql.end();
  }
  });
});

test('native declared collections persist controls and reject a barrier-controlled stale save', async ({ request }, info) => {
  test.skip(!process.env.VERIFY_TAURI_PID, 'Run with scripts/run-operator-e2e-isolated.sh for the owned Tauri bridge');
  await recordJourney(info, async () => {
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
    return decodeNativeBridgeJson(result.stdout);
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
      const labels = kind === 'plans' ? ['Native alpha', 'Native beta', 'Native blocked'] : ['mint', 'chamomile', 'rooibos'];
      const ids = kind === 'plans' ? ['alpha', 'beta', 'blocked'].map((slug) => `plan:${harness}/${slug}`) : labels;
      const dormant = kind === 'plans' ? `plan:${harness}/dormant` : 'lavender';
      const { property, policyName, schema } = nativeCollectionDeclaration(kind, ids,
        { order: [ids[0], dormant], excluded: [dormant] });
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
        // navigate acknowledges location assignment before the old document
        // unloads. An editor already on that document is not reload evidence.
        await native('eval', 'window.__nativeCollectionPreviousDocument = true; true');
        await native('navigate', url, '--json');
        await ready(nativeCollectionDocumentReady(editor));
        await observeWrites();
      }
      async function readback() {
        const response = await request.get(`${process.env.VERIFY_TAURI_DEV_URL}/api/zero-harness/rest-query`, {
          params: { name: 'goals.detail', args: JSON.stringify({ workspaceId, goalId }) },
        });
        expect(response.ok()).toBe(true);
        const detail = (await response.json()).rows[0];
        expect(isWorkOnEverything(detail), 'Generic native fixture must use the generic goal-data presentation').toBe(false);
        const data = detail.goalData.collections[property];
        expect(data.selection).toMatchObject({ ok: true, configured: true, collection: { policy: policyName } });
        evidence.push({ kind, policy: await policy(), collection: data });
        return data;
      }
      const checkbox = (label: string) => `${editor} [role="checkbox"][aria-label=${JSON.stringify(`Include ${label}`)}]`;
      // Check the actual resolver declaration before spending a native readiness deadline.
      await readback();
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
      // Capture the independent HTTP snapshot before a renderer predicate can
      // time out. This distinguishes persistence/resolver failures from native
      // query-cache or renderer state using the same saved owner revision.
      const reloaded = await readback();
      const nativeReadbackUrl = `/api/zero-harness/rest-query?${new URLSearchParams({
        name: 'goals.detail', args: JSON.stringify({ workspaceId, goalId }),
      })}`;
      await native('eval', `(() => { window.__nativeCollectionReloadReadback = null;
        fetch(${JSON.stringify(nativeReadbackUrl)}).then(async response => {
          window.__nativeCollectionReloadReadback = { status: response.status, body: await response.json() };
        }).catch(error => { window.__nativeCollectionReloadReadback = { error: String(error) }; });
        return true; })()`);
      await ready('window.__nativeCollectionReloadReadback !== null');
      const nativeReadback = await measure('window.__nativeCollectionReloadReadback');
      evidence.push({ afterReorderReload: { kind, rows: reloaded.rows,
        nativeReadback,
        nativeRows: await measure(`Array.from(document.querySelectorAll(${JSON.stringify(`${editor} li`)})).map(row => row.textContent)`),
        nativeDocument: await measure('({ url: location.href, previous: window.__nativeCollectionPreviousDocument === true, ready: document.readyState })'),
      } });
      expect(reloaded.rows.map((row: { id: string }) => row.id)).toEqual(reorderedIds);
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
          provenance: 'agent-edit', actorId: 'native-fixture-agent', confirmShrink: true,
        }));
        expect(sourceWrite).toMatchObject({ ok: true });
        await reload();
        expect((await readback()).rows.map((row: { id: string }) => row.id)).not.toContain(ids[1]);
        expect((await policy())?.value.excluded).toEqual([dormant, ids[1]]);
        await setNativeCollectionPlanArchived(sql, { workspaceId, harness, slug: 'beta', archived: false });
        const [reactivated] = await sql`SELECT status,op_status,archived FROM harness_shared.harness_plans
          WHERE workspace_id=${workspaceId} AND harness_slug=${harness} AND plan_slug='beta'`;
        evidence.push({ reactivatedLifecycle: reactivated });
        expect(reactivated).toMatchObject({ status: 'active', archived: false });
        const rediscovered = await readback();
        expect(rediscovered.rows.map((row: { id: string }) => row.id)).toEqual(reorderedIds);
        expect(rediscovered.rows.find((row: { id: string }) => row.id === ids[1])).toMatchObject({ selected: false });
        await reload();
        await expect.poll(() => measure(`(() => { const control = document.querySelector(${JSON.stringify(checkbox(labels[1]))}); return { present: !!control, checked: control?.getAttribute('aria-checked') ?? null, labels: Array.from(document.querySelectorAll(${JSON.stringify(`${editor} [role="checkbox"]`)})).map(n => n.getAttribute('aria-label')) }; })()`),
          { timeout: 30_000, intervals: [200, 500, 1000] }).toMatchObject({ present: true, checked: 'false' });
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
});
