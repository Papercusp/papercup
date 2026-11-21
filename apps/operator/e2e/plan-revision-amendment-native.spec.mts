import { test, expect, type APIRequestContext, type TestInfo } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { assertFixtureApiSuccess, seedFakeLlmHarness } from './_fake-llm-fixture';
import { decodeNativeBridgeJson } from './_native-bridge-json';
import { citationEdit, nativePlanComparisonTimeoutMs, nativePlanEdits, privatePlanUsername, readPreparedPlanHarness, retainNativePlanFailure,
  type NativePlanEdit } from './_plan-revision-edits';
import { assertNativePlanRetry, installPlanRetryExpression, lostAcknowledgement, type NativePlanRetryTrace } from './_plan-revision-retry';

const run = promisify(execFile);

type UiAction = { operation: 'navigate' | 'click' | 'edit'; target: string; outcome: 'unknown' | 'completed' | 'refused' };

test.describe.configure({ mode: 'default' });

async function captureNativeEdit(request: APIRequestContext, info: TestInfo, editCase: NativePlanEdit, compareRoles = false,
  mark: (step: string) => void = () => {}) {
  mark('initial private workspace and native liveness');
  const { scenario, originalText, replacementText } = editCase;
  const { assertNativeIsolatedWorkspace, assertNativeRuntimeLiveness } = await import('@papercusp/operator-core/lib/testing-native-runtime');
  const workspace = assertNativeIsolatedWorkspace();
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  const appRoot = process.env.OPERATOR_SOURCE_ROOT!;
  const appCommit = process.env.VERIFY_TAURI_SOURCE_REF!;
  const runtimeBefore = assertNativeRuntimeLiveness(appRoot, appCommit);
  const origin = new URL(process.env.VERIFY_TAURI_DEV_URL!);
  expect(['127.0.0.1', 'localhost']).toContain(origin.hostname);
  expect(origin.port).toBe(process.env.VERIFY_TAURI_PORT);
  expect(['', '3070', '3170', '3270', '3271']).not.toContain(origin.port);
  const database = new URL(process.env.HARNESS_ADMIN_DATABASE_URL!);
  expect(['127.0.0.1', 'localhost']).toContain(database.hostname);
  expect(database.port).toBe(process.env.PAPERCUSP_PG_PORT);
  expect(['', '5432']).not.toContain(database.port);
  const sql = postgres(database.href, { max: 1, onnotice: () => {} });
  const slug = 'revision-' + scenario + '-' + randomUUID() + '-' + new Date().toISOString().slice(0, 10);
  const headers = { 'x-papercusp-workspace': workspace };
  const editor = '.pc-plan-editor .vditor-ir [contenteditable="true"]';
  const edit = 'button[aria-label="Edit the raw markdown"]';
  const save = '.pc-editbar__btn--primary';
  const detail = '[aria-label="Plan ' + slug + '"]';
  const handles = { author: privatePlanUsername('author'), reviewer: privatePlanUsername('reviewer'), worker: privatePlanUsername('worker') };
  let activeRole: keyof typeof handles | undefined;
  const roleViews: Record<string, { userId: string; workspace: string; action: string; revisionId?: string; uiActions: UiAction[] }> = {};

  function beginAction(operation: UiAction['operation'], target: string) {
    if (!activeRole) return;
    const action: UiAction = { operation, target, outcome: 'unknown' };
    roleViews[activeRole]!.uiActions.push(action);
    return action;
  }

  let purpose = 'open Plans';
  async function native(command: 'navigate' | 'click' | 'eval', ...args: string[]) {
    mark(purpose + ' / ' + command + ' liveness');
    await run('bash', [process.env.VERIFY_TAURI_LIVENESS_CHECK!], { timeout: 15_000 });
    mark(purpose + ' / ' + command + ' bridge');
    const action = command === 'navigate' || command === 'click' ? beginAction(command, args[0]!) : undefined;
    const { stdout } = await run(process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!,
      [command, '--pid', process.env.VERIFY_TAURI_PID!, ...(command === 'eval' ? ['--json'] : []), ...args],
      { timeout: 25_000 });
    const value = decodeNativeBridgeJson(stdout, command);
    if (action) action.outcome = 'completed';
    return value;
  }
  const measure = (expression: string) => native('eval', expression);
  const visible = (expression: string) => expect.poll(() => measure(expression),
    { timeout: 60_000, intervals: [300, 750, 1500] }).toBe(true);
  const trace: Record<string, unknown> = { workspace, slug, scenario, applicationCommit: appCommit, runtimeBefore,
    definitionCommit: process.env.VERIFY_TAURI_TEST_SOURCE_REF, group: process.env.PAPERCUSP_TEST_RUN_GROUP };
  // Each account belongs only to the disposable workspace. The webview creates
  // and consumes the password locally and returns only the authenticated identity.
  async function enterRole(role: keyof typeof handles, action: string) {
    purpose = role + ' sign-in';
    activeRole = undefined;
    const identity = await measure(`(async () => {
      if (location.origin !== ${JSON.stringify(origin.origin)}) throw new Error('Unexpected native origin');
      const username = ${JSON.stringify(handles[role])};
      const password = crypto.randomUUID();
      const workspace = ${JSON.stringify(workspace)};
      const headers = {'content-type':'application/json','x-papercusp-workspace':workspace};
      async function post(path, data) {
        const response = await fetch(path, { method:'POST', headers, credentials:'include', redirect:'error',
          body:JSON.stringify(data) });
        if (!response.ok) throw new Error(path + ' refused: ' + response.status);
        return response.json();
      }
      const signup = await post('/api/auth/signup', { username, display_name:username, password, auto_login:false });
      const login = await post('/api/auth/login', { username, password });
      const me = await fetch('/api/auth/me', { headers, credentials:'include', redirect:'error' });
      const current = await me.json();
      if (!me.ok || !signup.user?.id || signup.user.id !== login.user?.id || login.user.id !== current.user?.id
        || current.user.workspace_id !== workspace || current.autoLogin !== false)
        throw new Error('Private role session was not established');
      return { userId:current.user.id, workspace };
    })()`);
    expect(identity.workspace).toBe(workspace);
    expect(identity.userId).toBeTruthy();
    roleViews[role] = { userId: identity.userId, workspace, action, uiActions: [] };
    activeRole = role;
    purpose = role + ' ' + action;
  }
  try {
    mark('private harness registration');
    // Only the registry setup is used. The plan and both writes go through the real operator.
    const harness = compareRoles ? readPreparedPlanHarness(workspace, runtimeBefore.fingerprint)
      : await seedFakeLlmHarness({ hive: true });
    trace.harness = harness;
    async function readPlan() {
      mark('fixture Plans get request');
      const response = await request.get(new URL('/api/admin/plans/get', origin).href, {
        params: { slug, harness, mode: 'full', includeEnrichments: 'false' }, headers, maxRedirects: 0,
      });
      mark('fixture Plans get HTTP ' + response.status());
      expect(response.ok()).toBe(true);
      const plan = await response.json();
      assertFixtureApiSuccess('get', plan);
      expect(plan.slug).toBe(slug);
      expect(typeof plan.raw).toBe('string');
      return plan as typeof plan & { raw: string; contentHash: string; version: number };
    }
    async function writePlan(verb: string, args: Record<string, unknown>) {
      mark('fixture Plans ' + verb + ' request');
      const response = await request.post(new URL('/api/admin/plans/' + verb, origin).href, {
        data: { ...args, slug, harness }, headers, maxRedirects: 0,
      });
      mark('fixture Plans ' + verb + ' HTTP ' + response.status());
      expect(response.ok()).toBe(true);
      assertFixtureApiSuccess(verb, await response.json());
    }
    await writePlan('new', { title: 'Native plan ' + scenario, status: 'draft' });
    const workerTask = 'Read the saved ' + editCase.heading + ' for ' + handles.worker;
    if (compareRoles) {
      await writePlan('add-item', { phase: 'Phase 1 — Reference check', importance: 'normal', text: workerTask });
    }
    const draft = await readPlan();
    const roles = compareRoles ? '\nReview the saved change for ' + handles.reviewer + '\n' : '';
    await writePlan('set-content', { content: draft.raw.trimEnd() + '\n\n## ' + editCase.heading + '\n\n' + originalText + '\n' + roles,
      expectedVersion: draft.version, expectedHash: draft.contentHash });
    const before = await readPlan();
    expect(before.raw.split(originalText)).toHaveLength(2);
    const view = new URL('/adv', origin);
    view.search = new URLSearchParams({ tab: 'plans', view: 'plans', scope: 'all', welcome: '0', ws: workspace, plan: slug }).toString();
    await native('navigate', view.href, '--json');
    await visible(`location.origin === ${JSON.stringify(origin.origin)} && new URL(location.href).searchParams.get('plan') === ${JSON.stringify(slug)}`);
    if (compareRoles) {
      await enterRole('author', 'save the ' + scenario + ' edit');
      await native('navigate', view.href, '--json');
    }
    await visible(`!!document.querySelector(${JSON.stringify(detail + ' ' + edit + ':enabled')})`);
    if (scenario === 'resumed') {
      const initialDocument = await measure('performance.timeOrigin');
      const inbox = new URL('/adv', origin);
      inbox.search = new URLSearchParams({ tab: 'inbox', ws: workspace, welcome: '0' }).toString();
      await native('navigate', inbox.href, '--json');
      await visible(`location.origin === ${JSON.stringify(origin.origin)} && new URL(location.href).searchParams.get('tab') === 'inbox' && !document.querySelector(${JSON.stringify(detail)})`);
      await native('navigate', view.href, '--json');
      await visible(`!!document.querySelector(${JSON.stringify(detail + ' ' + edit + ':enabled')})`);
      const resumed = await measure(`(async () => {
        const response = await fetch('/api/auth/me', { credentials: 'same-origin', redirect: 'error' });
        if (!response.ok) throw new Error('Could not read the resumed account');
        const account = await response.json();
        return { userId: account.user?.id, workspace: account.user?.workspace_id, autoLogin: account.autoLogin,
          documentStartedAt: performance.timeOrigin };
      })()`);
      expect(resumed).toMatchObject({ userId: roleViews.author!.userId, workspace, autoLogin: false });
      expect(resumed.documentStartedAt).toBeGreaterThan(initialDocument);
      trace.resumption = { initialDocument, resumed, version: before.version, contentHash: before.contentHash };
    }
    await native('click', detail + ' ' + edit, '--json');
    await visible(`document.querySelector(${JSON.stringify(editor)})?.textContent.includes(${JSON.stringify(originalText)}) === true`);
    trace.requiredFields = await measure(`Array.from(document.querySelectorAll(${JSON.stringify(detail + ' [required], ' + detail + ' [aria-required="true"]')}), e => e.getAttribute('name') || e.getAttribute('aria-label') || e.tagName)`);
    // The resource observer counts completed requests independently of the retry fixture.
    await native('eval', `(() => {
      const requests = [];
      const collect = entries => { for (const e of entries) {
        const url = new URL(e.name);
        if (url.origin === location.origin && url.pathname.startsWith('/api/admin/plans/'))
          requests.push({ path: url.pathname, startTime: e.startTime, duration: e.duration });
      }};
      const observer = new PerformanceObserver(list => collect(list.getEntries()));
      observer.observe({ entryTypes: ['resource'] });
      window.__planCitationRequests = () => { collect(observer.takeRecords()); observer.disconnect(); return requests };
      return true;
    })()`);
    const textEdit = beginAction('edit', editCase.heading);
    const edited = await measure(`(() => {
      const element = document.querySelector(${JSON.stringify(editor)});
      element.focus();
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const oldText = ${JSON.stringify(originalText)};
      let node;
      while ((node = walker.nextNode())) {
        const offset = node.data.indexOf(oldText);
        if (offset < 0) continue;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + oldText.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return document.execCommand('insertText', false, ${JSON.stringify(replacementText)});
      }
      return false;
    })()`);
    if (textEdit) textEdit.outcome = edited === true ? 'completed' : 'refused';
    expect(edited).toBe(true);
    await visible(`!!document.querySelector(${JSON.stringify(detail + ' ' + save + ':enabled')})`);
    if (scenario === 'retry') {
      const point = (plan: { version: number; contentHash: string }) => ({ version: plan.version, contentHash: plan.contentHash });
      const savedText = before.raw.replace(originalText, replacementText);
      const partial: Record<string, unknown> = { before: point(before), editorObservedLoss: false };
      trace.retry = partial;
      await measure(installPlanRetryExpression({ origin: origin.origin, workspace, harness, slug }));
      try {
        await native('click', detail + ' ' + save, '--json');
        await visible(`document.querySelector(${JSON.stringify(detail + ' .pc-editbar__error')})?.textContent.includes(${JSON.stringify(lostAcknowledgement)}) === true &&
          !!document.querySelector(${JSON.stringify(detail + ' ' + save + ':enabled')})`);
        partial.editorObservedLoss = true;
        const firstCommit = await readPlan();
        partial.afterFirst = point(firstCommit);
        expect(firstCommit.raw).toBe(savedText);
        await native('click', detail + ' ' + save, '--json');
        await visible(`(() => {
          const reply = window.__planRevisionRetry.attempts[1];
          if (reply?.acknowledgement !== 'returned') return false;
          if (reply.result === 'stale')
            return document.querySelector('.pc-conflict__current')?.textContent.includes(${JSON.stringify(replacementText)}) === true ||
              /stale/i.test(document.querySelector(${JSON.stringify(detail + ' .pc-editbar__error')})?.textContent ?? '');
          if (reply.result !== 'accepted') throw new Error('Unexpected plan retry response');
          return !document.querySelector(${JSON.stringify(detail + ' .pc-editbar')}) &&
            document.querySelector(${JSON.stringify(detail)})?.innerText.includes(${JSON.stringify(replacementText)}) === true;
        })()`);
        const attempts = await measure('window.__planRevisionRetry.attempts');
        const recovered = await readPlan();
        const retry: NativePlanRetryTrace = {
          before: point(before), afterFirst: point(firstCommit), afterRetry: point(recovered), attempts,
          editorObservedLoss: true, editorAfterRetry: attempts[1].result === 'stale' ? 'conflict' : 'saved',
        };
        trace.retry = retry;
        expect(recovered.raw).toBe(savedText);
        assertNativePlanRetry(retry);
      } finally {
        // An unsuccessful attempt is still evidence. The next participant gets the normal transport.
        partial.attempts = await measure('window.__planRevisionRetry.finish()');
      }
    } else {
      await native('click', detail + ' ' + save, '--json');
      await visible(`!!document.querySelector(${JSON.stringify(detail + ' ' + edit)}) && document.querySelector(${JSON.stringify(detail)})?.innerText.includes(${JSON.stringify(replacementText)})`);
    }
    trace.requests = await measure('window.__planCitationRequests()');
    const requests = trace.requests as Array<{ path: string }>;
    expect(requests.filter(row => row.path === '/api/admin/plans/set-content')).toHaveLength(scenario === 'retry' ? 2 : 1);
    const after = await readPlan();
    expect(after.raw).toBe(before.raw.replace(originalText, replacementText));
    expect(after.contentHash).toBe(createHash('sha256').update(after.raw).digest('hex'));
    const revision = await sql.begin('isolation level repeatable read read only', async tx => {
      const rows = await tx`SELECT id::text, seq, content_hash, author_kind, author_id, created_at::text
        FROM harness_shared.plan_revisions WHERE workspace_id=${workspace} AND harness_slug=${harness}
        AND plan_slug=${slug} AND content_hash IN (${before.contentHash}, ${after.contentHash}) ORDER BY seq`;
      const audits = await tx`SELECT audit_seq, audit_kind, audited_plan_revision_id::text AS revision_id
        FROM harness_shared.plan_audits WHERE workspace_id=${workspace} AND harness_slug=${harness}
        AND plan_slug=${slug} ORDER BY audit_seq`;
      const runs = await tx`SELECT id::text, plan_content_hash, status FROM harness_shared.plan_runs
        WHERE workspace_id=${workspace} AND harness_slug=${harness} AND plan_slug=${slug} ORDER BY id`;
      const calls = await tx`SELECT id::text, tool_name, role, status, invoked_at FROM harness_shared.tool_invocations
        WHERE workspace_id=${workspace} AND harness_slug=${harness} AND args_json->>'slug'=${slug} ORDER BY id`;
      return { rows, audits, planRuns: runs, callsWithTopLevelPlanSlug: calls };
    });
    trace.revision = revision;
    expect(revision.rows.map(row => row.content_hash)).toEqual([before.contentHash, after.contentHash]);
    expect(revision.rows[1]!.seq).toBe(revision.rows[0]!.seq + 1);
    expect(revision.rows[1]!.author_id).toBeTruthy();
    if (compareRoles) {
      const saved = revision.rows[1]!;
      roleViews.author!.revisionId = saved.id;
      await enterRole('reviewer', 'inspect the saved ' + scenario + ' diff');
      const review = new URL(view);
      review.searchParams.set('ptab', 'revisions');
      await native('navigate', review.href, '--json');
      const diffButton = '[aria-label="Show diff for revision #' + saved.seq + '"]';
      await visible(`!!document.querySelector(${JSON.stringify(diffButton)})`);
      await native('click', diffButton, '--json');
      await visible(`new URL(location.href).searchParams.get('rev') === ${JSON.stringify(saved.id)}
        && document.querySelector('.pc-git-diff__body')?.textContent.includes(${JSON.stringify(replacementText)}) === true`);
      roleViews.reviewer!.revisionId = saved.id;
      await enterRole('worker', 'read the named plan item and its updated text');
      await native('navigate', view.href, '--json');
      await visible(`(() => { const selected = document.querySelector(${JSON.stringify(detail)});
        return !!selected && selected.innerText.includes(${JSON.stringify(workerTask)})
          && selected.innerText.includes(${JSON.stringify(replacementText)});
      })()`);
      expect((await readPlan()).contentHash).toBe(after.contentHash);
      roleViews.worker!.revisionId = saved.id;
      expect(new Set(Object.values(roleViews).map(row => row.userId)).size).toBe(3);
    }
    mark('final native liveness');
    const runtimeAfter = assertNativeRuntimeLiveness(appRoot, appCommit);
    expect(runtimeAfter.fingerprint).toBe(runtimeBefore.fingerprint);
    trace.runtimeAfter = runtimeAfter;
    return trace;
  } finally {
    try {
      if (compareRoles) trace.roleViews = roleViews;
      const body = JSON.stringify(trace);
      await info.attach(compareRoles ? 'native-' + scenario + '-role-views' : 'native-author-citation',
        { body, contentType: 'application/json' });
      if (compareRoles && process.env.PLAN_REVISION_EVIDENCE)
        await writeFile(join(process.env.PLAN_REVISION_EVIDENCE, 'plan-role-views-' + slug + '.json'), body, { flag: 'wx', mode: 0o600 });
    }
    finally { await sql.end({ timeout: 5 }); }
  }
}

test('records the native author citation edit and reads the exact saved revision', async ({ request }, info) => {
  test.skip(!process.env.VERIFY_TAURI_PID, 'Requires the isolated native Plans runner');
  test.setTimeout(240_000);
  await captureNativeEdit(request, info, citationEdit);
});

test('saves a citation in native Plans and correlates author reviewer and worker outcomes', async ({ request }, info) => {
  test.skip(!process.env.VERIFY_TAURI_PID || !process.env.VERIFY_TAURI_TEST_SOURCE_REF, 'Requires the pinned native comparison');
  test.setTimeout(nativePlanComparisonTimeoutMs);
  const failures: string[] = [];
  for (const editCase of nativePlanEdits) {
    const started = Date.now();
    let stage = 'start';
    try {
      await test.step(editCase.scenario, () => captureNativeEdit(request, info, editCase, true, step => { stage = step; }));
    } catch (error) {
      const failure = retainNativePlanFailure('desktop', editCase.scenario, stage, error, Date.now() - started);
      failures.push([failure.scenario, failure.stage, failure.code ?? failure.kind, ...failure.frames].join(' / '));
    }
  }
  if (failures.length) throw new Error('Native Plans edits failed\n' + failures.join('\n'));
});
