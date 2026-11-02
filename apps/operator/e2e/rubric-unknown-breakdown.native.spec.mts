import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { decodeNativeBridgeJson } from './_native-bridge-json';

const exec = promisify(execFile);

test('rubric unknown reasons match the current native trend window', async ({}, info) => {
  test.setTimeout(180_000);
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  expect(process.env.VERIFY_TAURI_SEED).toBe('ready');
  const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
  expect(workspace).toMatch(/^verify-tauri-isolated-/);
  const database = new URL(process.env.HARNESS_ADMIN_DATABASE_URL!);
  expect(['localhost', '127.0.0.1']).toContain(database.hostname);
  expect(database.port).not.toBe('5432');
  expect(database.port).not.toBe('');
  // The ready seed completes onboarding; production-authored grading-integrity
  // is not a bundled rubric. Use the same real plan-row fixture as the canonical
  // rubric integration tests, strictly inside this disposable database.
  const rubricRef = 'native-unknown-breakdown';
  const sql = postgres(database.toString(), { max: 1, onnotice: () => {} });
  try {
    await sql`INSERT INTO harness_shared.harness_plans
      (workspace_id,harness_slug,plan_slug,content,content_hash,version,title,status,
       created,updated,owner,archived,template,template_data,template_slug,origin)
      VALUES (${workspace},'papercusp',${rubricRef},'',md5(${rubricRef}),1,
        'Native unknown rating breakdown','active','2026-11-02','2026-11-02',
        'native-rubric-fixture',false,'rubric',${JSON.stringify({
          kind: 'standard', characteristic: 'native-breakdown-fixture',
          description: 'Isolated real-store fixture for the rubric trend UI.',
          ratingScale: ['pass', 'fail', 'unknown'], methodRef: null,
          criteria: [{ key: 'observed', title: 'Observed behavior', model: 'The observed behavior is correct.',
            method: 'Read the retained native result.', driftMarkers: 'The observed result differs.' }],
        })}::text::jsonb,null,'local')`;
    // Direct fixture writes do not send the production mutation's invalidation.
    // Remove only this private workspace's cached list so its real producer
    // reads the inserted rubric even if the shell warmed the empty list earlier.
    await sql`DELETE FROM harness_shared.derived_read_snapshots
      WHERE workspace_id=${workspace} AND key='rubrics.list'`;
    const fixture = await sql`SELECT plan_slug,workspace_id,template,current_database() AS database,
      inet_server_port() AS port FROM harness_shared.harness_plans
      WHERE workspace_id=${workspace} AND plan_slug=${rubricRef}`;
    expect(fixture).toMatchObject([{ plan_slug: rubricRef, workspace_id: workspace, template: 'rubric' }]);
    await writeFile(info.outputPath('rubric-fixture.json'), JSON.stringify(fixture, null, 2));
  } finally { await sql.end({ timeout: 5 }); }
  const pid = process.env.VERIFY_TAURI_PID!;
  const tool = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!;
  expect(pid).toBeTruthy();
  expect(tool).toBeTruthy();

  async function native(command: string, ...args: string[]) {
    await exec('bash', [process.env.VERIFY_TAURI_LIVENESS_CHECK!], { timeout: 15_000 });
    const { stdout } = await exec(tool, [command, '--pid', pid, ...args, '--json'], { timeout: 30_000 });
    return decodeNativeBridgeJson(stdout, command);
  }
  const evaluate = (expression: string) => native('eval', expression);
  const wait = (expression: string) => expect.poll(() => evaluate(expression), { timeout: 60_000 }).toBe(true);
  const origin = await evaluate('location.origin');
  const target = new URL('/rubrics', origin);
  target.searchParams.set('ws', workspace);
  target.searchParams.set('verify-tauri-isolated', '1');
  await native('navigate', target.href);
  // Native navigation must retain the disposable workspace, as the maintained
  // owner-question journey does. A missing row alone cannot prove that scope.
  await expect.poll(async () => evaluate(`({
    workspace: window.__PAPERCUSP_WS__ || new URL(location.href).searchParams.get('ws'),
    origin: location.origin
  })`), { timeout: 30_000 }).toEqual({ workspace, origin });
  const list = await evaluate(`fetch('/api/zero-harness/rest-query?name=rubrics.list&args=%7B%7D', {
    headers: {'x-papercusp-workspace': ${JSON.stringify(workspace)}}
  }).then(async response => ({status: response.status, body: await response.json(), url: location.href}))`);
  const listPath = info.outputPath('rubric-list-precondition.json');
  await writeFile(listPath, JSON.stringify(list, null, 2));
  await info.attach('native rubric list precondition', { path: listPath, contentType: 'application/json' });
  expect(list.status).toBe(200);
  expect(list.body.rows.some((row: { rubricId: string }) => row.rubricId === rubricRef),
    'The isolated rubric list must contain the selected fixture before waiting for its DOM row').toBe(true);
  await wait(`Array.from(document.querySelectorAll('.pc-rubrics tbody tr')).some(row => row.textContent.includes(${JSON.stringify(rubricRef)}))`);
  await evaluate(`Array.from(document.querySelectorAll('.pc-rubrics tbody tr')).find(row => row.textContent.includes(${JSON.stringify(rubricRef)})).click()`);
  const selector = '[aria-label="Unknown rating breakdown"]';
  await wait(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('data-evidence') === 'window'`);

  // Read the same persisted trend through the real browser endpoint. No query,
  // component, IPC or network interception supplies the expected counts.
  const query = `/api/zero-harness/rest-query?name=rubrics.trend&args=${encodeURIComponent(JSON.stringify({ rubricRef, limit: 500 }))}`;
  const current = await evaluate(`fetch(${JSON.stringify(query)}, {
    headers: {'x-papercusp-workspace': ${JSON.stringify(workspace)}}
  }).then(async response => ({status: response.status, body: await response.json()}))`);
  expect(current.status).toBe(200);
  const breakdown = current.body.rows[0].unknownBreakdown;
  expect(Number.isInteger(breakdown.graderIncomplete)).toBe(true);
  expect(Number.isInteger(breakdown.instrumentUnavailable)).toBe(true);
  const dom = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    const rect = element.getBoundingClientRect();
    return {text: element.textContent, evidence: element.dataset.evidence,
      width: rect.width, height: rect.height, url: location.href,
      browserWorkspace: window.__PAPERCUSP_WS__ || null};
  })()`);
  expect(dom.text).toContain(`Grader incomplete: ${breakdown.graderIncomplete}`);
  expect(dom.text).toContain(`Instrument unavailable: ${breakdown.instrumentUnavailable}`);
  expect(dom.text).toContain('Criterion ratings in this trend window');
  expect(dom.evidence).toBe('window');
  expect(dom.width).toBeGreaterThan(0);
  expect(dom.height).toBeGreaterThan(0);
  // Ready isolated state has no grading history: zeros must be visibly measured.
  expect(breakdown.graderIncomplete).toBe(0);
  expect(breakdown.instrumentUnavailable).toBe(0);

  const receipt = info.outputPath('rubric-unknown-breakdown.json');
  const source = process.env.VERIFY_TAURI_SOURCE_RECEIPT;
  expect(source).toBeTruthy();
  await writeFile(receipt, JSON.stringify({ current, dom, source: JSON.parse(await readFile(source!, 'utf8')) }, null, 2));
  await info.attach('native rubric unknown breakdown', { path: receipt, contentType: 'application/json' });
  const screenshot = info.outputPath('rubric-unknown-breakdown.png');
  await exec(tool, ['screenshot', '--pid', pid, '--output', screenshot], { timeout: 30_000 });
  await info.attach('native rubric unknown breakdown screenshot', { path: screenshot, contentType: 'image/png' });
});

test.afterEach(async ({}, info) => {
  if (info.status === info.expectedStatus) return;
  const tool = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN;
  const pid = process.env.VERIFY_TAURI_PID;
  if (!tool || !pid) return;
  const captures = await Promise.allSettled([
    (async () => {
      const { stdout } = await exec(tool, ['eval', '--pid', pid, `({
        url: location.href, workspace: window.__PAPERCUSP_WS__ || null,
        body: document.body.innerText.slice(0, 5000),
        rubricRows: Array.from(document.querySelectorAll('.pc-rubrics tbody tr')).map(row => row.textContent)
      })`, '--json'], { timeout: 30_000 });
      const path = info.outputPath('rubric-failure-dom.json');
      await writeFile(path, stdout);
      await info.attach('failed native rubric DOM', { path, contentType: 'application/json' });
    })(),
    (async () => {
      const path = info.outputPath('rubric-unknown-breakdown-failure.png');
      await exec(tool, ['screenshot', '--pid', pid, '--output', path], { timeout: 30_000 });
      await info.attach('failed native rubric screenshot', { path, contentType: 'image/png' });
    })(),
  ]);
  const path = info.outputPath('rubric-diagnostic-captures.json');
  await writeFile(path, JSON.stringify(captures.map(result => result.status === 'fulfilled'
    ? { status: result.status } : { status: result.status, error: String(result.reason) }), null, 2));
  await info.attach('native rubric diagnostic capture results', { path, contentType: 'application/json' });
});
