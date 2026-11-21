import { test, expect, type APIRequestContext, type TestInfo } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { assertFixtureApiSuccess, seedFakeLlmHarness } from './_fake-llm-fixture';
import { decodeNativeBridgeJson } from './_native-bridge-json';

const run = promisify(execFile);
const previousCitation = 'packages/operator-core/lib/plan-efficiency.ts:1';
const correctedCitation = 'packages/operator-core/lib/plan-efficiency.ts:2';

test.describe.configure({ mode: 'default' });

async function captureNativeCitation(request: APIRequestContext, info: TestInfo, compareRoles = false) {
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
  const slug = 'revision-citation-' + randomUUID() + '-' + new Date().toISOString().slice(0, 10);
  const headers = { 'x-papercusp-workspace': workspace };
  const editor = '.pc-plan-editor .vditor-ir [contenteditable="true"]';
  const edit = 'button[aria-label="Edit the raw markdown"]';
  const save = '.pc-editbar__btn--primary';
  const detail = '[aria-label="Plan ' + slug + '"]';

  async function native(command: string, ...args: string[]) {
    await run('bash', [process.env.VERIFY_TAURI_LIVENESS_CHECK!], { timeout: 15_000 });
    const { stdout } = await run(process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!,
      [command, '--pid', process.env.VERIFY_TAURI_PID!, ...(command === 'eval' ? ['--json'] : []), ...args],
      { timeout: 25_000 });
    return decodeNativeBridgeJson(stdout, command);
  }
  const measure = (expression: string) => native('eval', expression);
  const visible = (expression: string) => expect.poll(() => measure(expression),
    { timeout: 60_000, intervals: [300, 750, 1500] }).toBe(true);
  const trace: Record<string, unknown> = { workspace, slug, applicationCommit: appCommit, runtimeBefore,
    definitionCommit: process.env.VERIFY_TAURI_TEST_SOURCE_REF, group: process.env.PAPERCUSP_TEST_RUN_GROUP };
  const handles = { author: 'author-' + randomUUID(), reviewer: 'reviewer-' + randomUUID(), worker: 'worker-' + randomUUID() };
  const roleViews: Record<string, { userId: string; workspace: string; action: string; revisionId?: string }> = {};
  // Each account belongs only to the disposable workspace. The webview creates
  // and consumes the password locally and returns only the authenticated identity.
  async function enterRole(role: keyof typeof handles, action: string) {
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
    roleViews[role] = { userId: identity.userId, workspace, action };
  }
  try {
    // Only the registry setup is used. The plan and both writes go through the real operator.
    const harness = await seedFakeLlmHarness({ hive: true });
    trace.harness = harness;
    async function readPlan() {
      const response = await request.get(new URL('/api/admin/plans/get', origin).href, {
        params: { slug, harness, mode: 'full', includeEnrichments: 'false' }, headers, maxRedirects: 0,
      });
      expect(response.ok()).toBe(true);
      const plan = await response.json();
      assertFixtureApiSuccess('get', plan);
      expect(plan.slug).toBe(slug);
      expect(typeof plan.raw).toBe('string');
      return plan as typeof plan & { raw: string; contentHash: string; version: number };
    }
    async function writePlan(verb: string, args: Record<string, unknown>) {
      const response = await request.post(new URL('/api/admin/plans/' + verb, origin).href, {
        data: { ...args, slug, harness }, headers, maxRedirects: 0,
      });
      expect(response.ok()).toBe(true);
      assertFixtureApiSuccess(verb, await response.json());
    }
    await writePlan('new', { title: 'Native plan citation', status: 'draft' });
    const workerTask = 'Apply the saved Reference for ' + handles.worker;
    if (compareRoles) {
      await writePlan('add-item', { phase: 'Phase 1 — Reference check', importance: 'normal', text: workerTask });
    }
    const draft = await readPlan();
    const roles = compareRoles ? '\nReview the Reference change: ' + handles.reviewer + '\n' : '';
    await writePlan('set-content', { content: draft.raw.trimEnd() + '\n\n## Reference\n\n' + previousCitation + '\n' + roles,
      expectedVersion: draft.version, expectedHash: draft.contentHash });
    const before = await readPlan();
    expect(before.raw.split(previousCitation)).toHaveLength(2);
    const view = new URL('/adv', origin);
    view.search = new URLSearchParams({ tab: 'plans', view: 'plans', scope: 'all', welcome: '0', ws: workspace, plan: slug }).toString();
    await native('navigate', view.href, '--json');
    await visible(`location.origin === ${JSON.stringify(origin.origin)} && new URL(location.href).searchParams.get('plan') === ${JSON.stringify(slug)}`);
    if (compareRoles) {
      await enterRole('author', 'save citation');
      await native('navigate', view.href, '--json');
    }
    await visible(`!!document.querySelector(${JSON.stringify(detail + ' ' + edit + ':enabled')})`);
    await native('click', detail + ' ' + edit, '--json');
    await visible(`document.querySelector(${JSON.stringify(editor)})?.textContent.includes(${JSON.stringify(previousCitation)}) === true`);
    trace.requiredFields = await measure(`Array.from(document.querySelectorAll(${JSON.stringify(detail + ' [required], ' + detail + ' [aria-required="true"]')}), e => e.getAttribute('name') || e.getAttribute('aria-label') || e.tagName)`);
    // Observe completed requests without modifying fetch, response bodies, or the editor's save handler.
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
    const edited = await measure(`(() => {
      const element = document.querySelector(${JSON.stringify(editor)});
      element.focus();
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const oldText = ${JSON.stringify(previousCitation)};
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
        return document.execCommand('insertText', false, ${JSON.stringify(correctedCitation)});
      }
      return false;
    })()`);
    expect(edited).toBe(true);
    await visible(`!!document.querySelector(${JSON.stringify(detail + ' ' + save + ':enabled')})`);
    await native('click', detail + ' ' + save, '--json');
    await visible(`!!document.querySelector(${JSON.stringify(detail + ' ' + edit)}) && document.querySelector(${JSON.stringify(detail)})?.innerText.includes(${JSON.stringify(correctedCitation)})`);
    trace.requests = await measure('window.__planCitationRequests()');
    const requests = trace.requests as Array<{ path: string }>;
    expect(requests.filter(row => row.path === '/api/admin/plans/set-content')).toHaveLength(1);
    const after = await readPlan();
    expect(after.raw).toBe(before.raw.replace(previousCitation, correctedCitation));
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
      await enterRole('reviewer', 'inspect the saved citation diff');
      const review = new URL(view);
      review.searchParams.set('ptab', 'revisions');
      await native('navigate', review.href, '--json');
      const diffButton = '[aria-label="Show diff for revision #' + saved.seq + '"]';
      await visible(`!!document.querySelector(${JSON.stringify(diffButton)})`);
      await native('click', diffButton, '--json');
      await visible(`new URL(location.href).searchParams.get('rev') === ${JSON.stringify(saved.id)}
        && document.querySelector('.pc-git-diff__body')?.textContent.includes(${JSON.stringify(correctedCitation)}) === true`);
      roleViews.reviewer!.revisionId = saved.id;
      await enterRole('worker', 'read the assigned item and updated reference');
      await native('navigate', view.href, '--json');
      await visible(`(() => { const selected = document.querySelector(${JSON.stringify(detail)});
        return !!selected && selected.innerText.includes(${JSON.stringify(workerTask)})
          && selected.innerText.includes(${JSON.stringify(correctedCitation)});
      })()`);
      expect((await readPlan()).contentHash).toBe(after.contentHash);
      roleViews.worker!.revisionId = saved.id;
      expect(new Set(Object.values(roleViews).map(row => row.userId)).size).toBe(3);
    }
    const runtimeAfter = assertNativeRuntimeLiveness(appRoot, appCommit);
    expect(runtimeAfter.fingerprint).toBe(runtimeBefore.fingerprint);
    trace.runtimeAfter = runtimeAfter;
    return trace;
  } finally {
    try {
      if (compareRoles) trace.roleViews = roleViews;
      const body = JSON.stringify(trace);
      await info.attach(compareRoles ? 'native-citation-role-views' : 'native-author-citation',
        { body, contentType: 'application/json' });
      if (compareRoles && process.env.PLAN_REVISION_EVIDENCE)
        await writeFile(join(process.env.PLAN_REVISION_EVIDENCE, 'citation-role-views-' + slug + '.json'), body, { flag: 'wx', mode: 0o600 });
    }
    finally { await sql.end({ timeout: 5 }); }
  }
}

test('records the native author citation edit and reads the exact saved revision', async ({ request }, info) => {
  test.skip(!process.env.VERIFY_TAURI_PID, 'Requires the isolated native Plans runner');
  test.setTimeout(240_000);
  await captureNativeCitation(request, info);
});

test('saves a citation in native Plans and correlates author reviewer and worker outcomes', async ({ request }, info) => {
  test.skip(!process.env.VERIFY_TAURI_PID || !process.env.VERIFY_TAURI_TEST_SOURCE_REF, 'Requires the pinned native comparison');
  test.setTimeout(360_000);
  await captureNativeCitation(request, info, true);
});
