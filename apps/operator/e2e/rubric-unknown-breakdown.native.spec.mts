import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { decodeNativeBridgeJson } from './_native-bridge-json';

const exec = promisify(execFile);

test('rubric unknown reasons match the current native trend window', async ({}, info) => {
  test.setTimeout(180_000);
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  expect(process.env.VERIFY_TAURI_SEED).toBe('ready');
  const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
  expect(workspace).toMatch(/^verify-tauri-isolated-/);
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
  const rubricRef = 'grading-integrity';
  const list = await evaluate(`fetch('/api/zero-harness/rest-query?name=rubrics.list&args=%7B%7D', {
    headers: {'x-papercusp-workspace': ${JSON.stringify(workspace)}}
  }).then(async response => ({status: response.status, body: await response.json(), url: location.href}))`);
  await info.attach('native rubric list precondition', { body: JSON.stringify(list), contentType: 'application/json' });
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
      await info.attach('failed native rubric DOM', { body: stdout, contentType: 'application/json' });
    })(),
    (async () => {
      const path = info.outputPath('rubric-unknown-breakdown-failure.png');
      await exec(tool, ['screenshot', '--pid', pid, '--output', path], { timeout: 30_000 });
      await info.attach('failed native rubric screenshot', { path, contentType: 'image/png' });
    })(),
  ]);
  await info.attach('native rubric diagnostic capture results', {
    body: JSON.stringify(captures.map(result => result.status === 'fulfilled'
      ? { status: result.status } : { status: result.status, error: String(result.reason) })),
    contentType: 'application/json',
  });
});
