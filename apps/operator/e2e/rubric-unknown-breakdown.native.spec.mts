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
  await native('navigate', '/rubrics');
  const rubricRef = 'grading-integrity';
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
