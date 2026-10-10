import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { decodeNativeBridgeJson } from './_native-bridge-json';

// Read-only acceptance against existing review packets. The maintained native
// rig supplies an owned bridge and frozen source; no cleanup action is invoked.
test('native cleanup review selector opens an older packet with its actual findings', async ({ request }, info) => {
  test.skip(!process.env.VERIFY_TAURI_PID, 'Requires the maintained owned native rig');
  test.setTimeout(180_000);
  const origin = process.env.VERIFY_TAURI_DEV_URL!;
  const workspace = process.env.PLAN_CLEANUP_NATIVE_WORKSPACE ?? process.env.PAPERCUSP_WORKSPACE_ID ?? process.env.PAPERCUSP_WORKSPACE;
  expect(workspace, 'Use an explicit workspace containing existing cleanup review packets').toBeTruthy();
  const bridge = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!;
  expect(bridge).toBeTruthy();
  const run = promisify(execFile);
  const source = process.env.VERIFY_TAURI_SOURCE_RECEIPT
    ? JSON.parse(await readFile(process.env.VERIFY_TAURI_SOURCE_RECEIPT, 'utf8'))
    : { kind: 'current-tree-snapshot', sourceRoot: process.env.OPERATOR_SOURCE_ROOT,
      files: await Promise.all(['PlansCleanupStrip.tsx', 'PlanCleanupReport.tsx', 'use-plan-cleanup-run.ts'].map(async (path) => ({
        path: `apps/operator/app/_components/plans/${path}`,
        sha256: createHash('sha256').update(await readFile(new URL(`../app/_components/plans/${path}`, import.meta.url))).digest('hex'),
      }))) };
  await info.attach('native-source', { body: JSON.stringify(source), contentType: 'application/json' });

  async function native(command: string, ...args: string[]) {
    await run('bash', [process.env.VERIFY_TAURI_LIVENESS_CHECK!], { timeout: 10_000 });
    const result = await run(bridge, [command, '--pid', process.env.VERIFY_TAURI_PID!, ...args], { timeout: 20_000 });
    return decodeNativeBridgeJson(result.stdout);
  }
  const measure = (expression: string) => native('eval', `JSON.stringify(${expression})`);
  async function ready(expression: string) {
    await expect.poll(() => measure(expression), { timeout: 45_000, intervals: [500, 1500] }).toBe(true);
  }
  async function snapshot(runId?: string) {
    const response = await request.get(`${origin}/api/zero-harness/rest-query`, {
      params: { name: 'plans.cleanupRun', args: JSON.stringify(runId ? { runId } : {}) },
      headers: { 'x-papercusp-workspace': workspace! },
      timeout: 30_000,
    });
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.rows).toHaveLength(1);
    return body.rows[0];
  }

  try {
    const initial = await snapshot();
    expect(initial.reviewInventory.error).toBeFalsy();
    expect(initial.reviewInventory.runs.length, 'Older-review selection requires at least two existing review packets').toBeGreaterThan(1);
    const inventory = initial.reviewInventory.runs;
    const older = inventory.at(-1);
    const selected = await snapshot(older.runId);
    expect(selected.run.runId).toBe(older.runId);
    expect(selected.findings.length).toBeGreaterThan(0);
    const applied = selected.findings.filter((row: { outcome: string }) => ['auto_applied', 'accepted'].includes(row.outcome)).length;
    await info.attach('selected-review-receipt', {
      body: JSON.stringify({ runId: older.runId, phase: selected.run.phase, findings: selected.findings.length, applied,
        reviewInventory: inventory.map((row: { runId: string; unresolved: number }) => ({ runId: row.runId, unresolved: row.unresolved })) }),
      contentType: 'application/json',
    });
    await native('navigate', `${origin}/adv?tab=plans&scope=all&welcome=0&ws=${encodeURIComponent(workspace!)}`, '--json');
    const selector = '[aria-label="Unresolved cleanup reviews"]';
    await ready(`!!document.querySelector(${JSON.stringify(selector)})`);
    await native('click', selector, '--json');
    await ready(`document.querySelectorAll('[role="option"]').length === ${inventory.length}`);
    const optionId = await measure(`document.querySelectorAll('[role="option"]')[${inventory.length - 1}].id`);
    expect(typeof optionId).toBe('string');
    expect(optionId).not.toBe('');
    await native('click', `[id=${JSON.stringify(optionId)}]`, '--json');
    await ready(`new URL(location.href).searchParams.get('opcln') === ${JSON.stringify(older.runId)} && !!document.querySelector('[data-testid="plan-cleanup-report-footer"]')`);
    const subtitle = await measure(`document.querySelector('.plan-cleanup-report__subtitle')?.textContent`);
    expect(subtitle).toContain(`${selected.findings.length} assessed across`);
    expect(subtitle).toContain(`${applied} auto-applied`);
    await native('eval', 'window.__cleanupPreviousDocument = true; location.reload(); true');
    await ready(`window.__cleanupPreviousDocument !== true && new URL(location.href).searchParams.get('opcln') === ${JSON.stringify(older.runId)} && !!document.querySelector('[data-testid="plan-cleanup-report-footer"]')`);
    expect(await measure(`document.querySelector('.plan-cleanup-report__subtitle')?.textContent`)).toContain(`${selected.findings.length} assessed across`);
  } catch (error) {
    try {
      await info.attach('native-failure-state', { body: JSON.stringify(await measure(`({ url: location.href, body: document.body.innerText.slice(0, 6000), sync: window.__sync_metrics__ ?? null })`)), contentType: 'application/json' });
    } catch (diagnosticError) {
      await info.attach('native-diagnostic-error', { body: String(diagnosticError), contentType: 'text/plain' });
    }
    throw error;
  }
});
