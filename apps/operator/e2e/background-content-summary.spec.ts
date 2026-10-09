import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, test } from './_egress';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

test('background summary completes through a real managed task and the normal documents tool', async ({ request, baseURL }, testInfo) => {
  test.setTimeout(210_000);
  const workspace = process.env.PAPERCUSP_WORKSPACE;
  const client = process.env.PAPERCUSP_SID;
  // A live task needs an explicitly held lane; there is no shared default item
  // that a test may borrow or an implicit choice among the caller's claims.
  const workItem = process.env.PAPERCUSP_TEST_RUN_WORK_ITEM_ID;
  const home = process.env.PAPERCUSP_HOME || join(homedir(), '.papercusp');
  test.skip(!workspace || !client || !workItem || !existsSync(join(home, 'superuser-token')),
    'This live local-model journey requires the workspace, current session identity, installed credential and PAPERCUSP_TEST_RUN_WORK_ITEM_ID naming a held item.');
  const origin = new URL(baseURL!);
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(origin.hostname);
  const port = origin.port || '80';
  const state = mkdtempSync(join(tmpdir(), 'content-summary-e2e-'));
  let sequence = 0;
  let taskId: string | undefined;
  let terminal = false;
  const observations: Record<string, unknown> = { workspace, client, workItem, origin: origin.origin };
  const invoke = async (name: string, args: unknown) => {
    const payload = join(state, `call-${sequence++}.json`);
    writeFileSync(payload, JSON.stringify(args));
    const { stdout } = await exec(process.execPath, ['scripts/mcp-call.mjs', name, '--json-file', payload,
      '--client', client!, '--workspace', workspace!, '--harness', 'papercusp', '--port', port],
    { cwd: root, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    let result = JSON.parse(stdout);
    if (result.structuredContent) result = result.structuredContent;
    else if (Array.isArray(result.content)) result = JSON.parse(result.content.find((part: { type: string }) => part.type === 'text').text);
    expect(result.ok).not.toBe(false);
    return result;
  };
  try {
    const healthBefore = await (await request.get(origin.origin + '/api/health')).json();
    expect(healthBefore.ok).toBe(true);
    observations.buildBefore = healthBefore.sha;
    const claim = await invoke('work_items:get', { id: workItem, harness: 'papercusp', payloadTier: 'full',
      projection: { pick: ['results[].workItem.id', 'results[].workItem.assignee', 'results[].workItem.state'] } });
    expect(claim.results).toHaveLength(1);
    expect(claim.results[0].workItem).toMatchObject({ id: workItem, assignee: client });
    expect(['open', 'wip']).toContain(claim.results[0].workItem.state);
    const inventory = await invoke('gateway:local_backend_list', { workspace });
    const models = inventory.backends.filter((backend: { enabled: boolean }) => backend.enabled)
      .flatMap((backend: { models: string[] }) => backend.models);
    test.skip(models.length === 0, 'The live local-model fixture is unavailable; no cloud substitute is permitted.');
    const model = models.includes('ornith:fast') ? 'ornith:fast' : models[0];
    observations.model = model;
    const source = 'Public fixture: North reports 12 units and South reports 34 units.';
    const args = { operation: 'summarize', content: { kind: 'text', text: source, ref: 'fixture:background-public-report' },
      summary: { model, allowCloud: false, cache: false, maxCalls: 1, maxOutputTokens: 128,
        length: 'short', focus: 'State both region names and their exact unit counts.', timeoutMs: 120_000 } };
    const command = [process.execPath, 'scripts/mcp-call.mjs', 'documents:read', '--json', '-', '--client', client!,
      '--workspace', workspace!, '--harness', 'papercusp', '--port', port].map(quote).join(' ') +
      " <<'CONTENT_SUMMARY_JSON'\n" + JSON.stringify(args) + '\nCONTENT_SUMMARY_JSON';
    const launch = await invoke('capability:bash', { command, cwd: root, work_item_id: workItem,
      run_in_background: true, timeout: 180_000 });
    taskId = launch.task_id;
    observations.launch = launch;
    expect(taskId).toBeTruthy();
    expect(launch.bash_id).toBeTruthy();
    let output = String(launch.output ?? '');
    let final = launch;
    const deadline = Date.now() + 180_000;
    while (final.status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      final = await invoke('capability:bash_output', { task_id: taskId, bash_id: launch.bash_id });
      output += String(final.output ?? '');
    }
    terminal = final.status !== 'running';
    observations.final = final;
    observations.output = output;
    expect(final.status, output).toBe('completed');
    expect(final.exit_code, output).toBe(0);
    // Parse the child CLI's real JSON result, independently of the task's exit.
    const receipt = JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1));
    expect(receipt).toMatchObject({ ok: true, operation: 'summarize', model, cached: false,
      sourceRefs: ['fixture:background-public-report'], coverage: { complete: true, characters: source.length, chunks: 1 },
      usage: { calls: 1, costUsd: 0 }, servedAccounts: [] });
    expect(receipt.summary).toMatch(/North/i);
    expect(receipt.summary).toMatch(/South/i);
    expect(receipt.summary).toMatch(/\b12\b/);
    expect(receipt.summary).toMatch(/\b34\b/);
    const healthAfter = await (await request.get(origin.origin + '/api/health')).json();
    expect(healthAfter.sha).toBe(healthBefore.sha);
    await testInfo.attach('managed-summary-receipt', { contentType: 'application/json',
      body: JSON.stringify({ buildSha: healthBefore.sha, taskId, bashId: launch.bash_id, final, receipt }) });
  } finally {
    await testInfo.attach('managed-summary-execution', { contentType: 'application/json', body: JSON.stringify(observations) });
    if (taskId && !terminal) await invoke('processes:kill', { taskId }).catch(() => {});
    rmSync(state, { recursive: true, force: true });
  }
});
