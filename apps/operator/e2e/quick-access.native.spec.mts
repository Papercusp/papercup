import { test, expect } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname } from 'node:os';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { publishReport } from '../../../packages/operator-core/lib/report-library';
import { insertNativeCollectionPlan } from './_ongoing-work-native-fixture';
import { decodeNativeBridgeJson } from './_native-bridge-json';

const exec = promisify(execFile);

test('Quick Access opens as an independent native launcher with reports and exact conversations', async ({}, info) => {
  test.setTimeout(240_000);
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  expect(process.env.VERIFY_TAURI_ISOLATED_SEED).toBe('ready');
  const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
  expect(workspace).toMatch(/^verify-tauri-isolated-/);
  const database = new URL(process.env.HARNESS_ADMIN_DATABASE_URL!);
  expect(['localhost', '127.0.0.1']).toContain(database.hostname);
  expect(database.port).not.toBe('5432');
  expect(database.port).not.toBe('');
  const pid = process.env.VERIFY_TAURI_PID!;
  const tool = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!;
  expect(pid).toBeTruthy(); expect(tool).toBeTruthy();
  const displayEnv = { ...process.env, DISPLAY: process.env.VERIFY_TAURI_DISPLAY!, WAYLAND_DISPLAY: '' };
  const sql = postgres(database.toString(), { max: 1, onnotice: () => {} });
  const label = 'docs-search-palette';
  const owner = 'su-native-quick-access';
  const terminal = spawn('xterm', ['-T', 'Quick Access exact fixture', '-e', 'sleep', '240'], { env: displayEnv, stdio: 'ignore' });
  async function evaluate(expression: string, window = label) {
    await exec('bash', [process.env.VERIFY_TAURI_LIVENESS_CHECK!], { timeout: 15_000 });
    const { stdout } = await exec(tool, ['eval', '--pid', pid, '--window-label', window, expression, '--json'], { timeout: 30_000 });
    return decodeNativeBridgeJson(stdout, 'eval');
  }
  const wait = (expression: string) => expect.poll(() => evaluate(expression), { timeout: 60_000 }).toBe(true);
  const click = (selector: string) => evaluate('document.querySelector(' + JSON.stringify(selector) + ')?.click()');
  const escape = () => evaluate('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true,cancelable:true}))');
  const visible = () => evaluate('window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", {label:"docs-search-palette"})');
  async function open() {
    await evaluate('window.__TAURI_INTERNALS__.invoke("open_docs_search_palette")', 'main');
    await wait('!!document.querySelector("[aria-label=\\"Quick Access launcher\\"]")');
  }
  try {
    // xdotool exits 1 before the new X window is mapped; --sync waits for it
    // instead of rejecting the first expect.poll callback before it can retry.
    const { stdout: fixtureWindows } = await exec('xdotool',
      ['search', '--sync', '--onlyvisible', '--pid', String(terminal.pid)],
      { env: displayEnv, timeout: 15_000 });
    const windowId = fixtureWindows.trim().split('\n')[0];
    expect(windowId).toMatch(/^\d+$/);
    await insertNativeCollectionPlan(sql, { workspaceId: workspace, harness: 'papercusp', slug: 'native-quick-access', title: 'Native launcher plan', status: 'active' });
    await sql.unsafe('INSERT INTO harness_shared.coord_presence (workspace_id,owner_id,owner_label,source,host,pid,intent,heartbeat_at,last_active_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())',
      [workspace, owner, 'Native launcher agent', 'isolated-native-assertion', hostname(), process.pid, 'Native launcher verification']);
    await sql.unsafe('INSERT INTO harness_shared.adv_sessions (workspace_id,mode,agent,coord_owner_id,plan_slug,label,window_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [workspace, 'omp', 'codex', owner, 'native-quick-access', 'Native launcher agent', windowId]);
    const report = await publishReport(sql, { workspaceId: workspace, title: 'Native launcher report',
      bodyMd: '# Verified report\n\nQuick Access native body.', visibility: 'owner', requestKey: 'quick-access-native-report' });
    await open();
    expect(await evaluate('({ path:location.pathname, native:window.__PAPERCUSP_QUICK_PANEL_WINDOW__, width:innerWidth, height:innerHeight })'))
      .toMatchObject({ path: '/quick-panel', native: true, width: 1000, height: 665 });
    await wait('document.querySelector(".pc-qa__results")?.textContent.includes("Native launcher plan") === true');
    await wait('document.querySelector(".pc-qa__preview")?.textContent.includes("Native launcher agent") === true');
    await click('[aria-label="Talk to Native launcher agent"]');
    await wait('!!document.querySelector("[aria-label=\\"Close conversation\\"]")');
    await escape();
    await wait('!document.querySelector("[aria-label=\\"Close conversation\\"]")');
    expect(await visible()).toBe(true);
    await click('[aria-label="Search scope"] button:nth-child(4)');
    await wait('document.querySelector(".pc-qa__preview")?.textContent.includes("Quick Access native body.") === true');
    expect(await evaluate('location.pathname === "/quick-panel" && !!document.querySelector(".pc-qa__report")')).toBe(true);
    await click('.pc-qa__preview button');
    await wait('!!document.querySelector("[role=\\"dialog\\"]")');
    await escape();
    await wait('!document.querySelector("[role=\\"dialog\\"]")');
    expect(await visible()).toBe(true);
    await evaluate('(() => { const input=document.querySelector(".pc-qa__search input"); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set; setter.call(input,"nonexistent-native-query"); input.dispatchEvent(new Event("input",{bubbles:true})); input.focus(); })()');
    await wait('document.querySelector(".pc-qa__results")?.textContent.includes("No matching") === true');
    await escape();
    await wait('document.querySelector(".pc-qa__search input")?.value === ""');
    expect(await visible()).toBe(true);
    const popupWindows = (await exec('xdotool', ['search', '--onlyvisible', '--pid', pid, '--name', '^Quick Access$'], { env: displayEnv })).stdout.trim().split('\n');
    expect(popupWindows).toHaveLength(1);
    const screenshot = info.outputPath('quick-access-native.png');
    await exec(tool, ['screenshot', '--pid', pid, '--window-id', popupWindows[0], '--output', screenshot], { env: displayEnv, timeout: 30_000 });
    await info.attach('Quick Access native popup', { path: screenshot, contentType: 'image/png' });
    await click('[aria-label="Search scope"] button:nth-child(3)');
    await wait('!!document.querySelector("[aria-label=\\"Focus Native launcher agent window\\"]:not(:disabled)")');
    await click('[aria-label="Focus Native launcher agent window"]');
    await expect.poll(async () => (await exec('xdotool', ['getwindowfocus'], { env: displayEnv })).stdout.trim(), { timeout: 15_000 }).toBe(windowId);
    await open();
    await escape();
    await expect.poll(visible).toBe(false);
    if (process.env.VERIFY_TAURI_SOURCE_RECEIPT) await info.attach('source receipt', {
      body: await readFile(process.env.VERIFY_TAURI_SOURCE_RECEIPT), contentType: 'application/json',
    });
    await info.attach('fixture identities', { body: JSON.stringify({ owner, windowId, reportId: report.reportId, workspace }), contentType: 'application/json' });
  } finally {
    terminal.kill();
    await sql.end({ timeout: 5 });
  }
});
