import { test, expect, type TestInfo } from '@playwright/test';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { decodeNativeBridgeJson } from './_native-bridge-json';

// P-012c, D-028/D-031. Run through verify-tauri-headless.sh with
// VERIFY_TAURI_ISOLATED_DB=1 VERIFY_TAURI_ISOLATED_SEED=ready. This spec uses
// the owned native webview, never a Playwright browser or mocked API responses.
// P012_NATIVE_SELECTION_FILE may name a real isolated fixture's selection:
// {workspaceId,harnessSlug,operationId,supportCaseId,query,documentTitle}.
// It supplies input, not authorization, receipt state or business acceptance.
type Verdict = { step: string; status: 'PASS' | 'FAIL' | 'ABSENT'; detail: string; source: string };
type Selection = { workspaceId: string; harnessSlug: string; operationId: string;
  supportCaseId: string; query: string; documentTitle: string };
const run = promisify(execFile);
const form = 'section[aria-label="Prepare support handoff"]';
const receipt = 'section[aria-label="Operation result"]';

async function retain(info: TestInfo, name: string, value: unknown) {
  const path = info.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(value, null, 2));
  await info.attach(name, { path, contentType: 'application/json' });
}

async function native(command: string, ...args: string[]) {
  const pid = process.env.VERIFY_TAURI_PID!;
  const executable = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!;
  expect(executable, 'The owned verifier must supply the bridge executable').toBeTruthy();
  await run('bash', [process.env.VERIFY_TAURI_LIVENESS_CHECK!], { timeout: 10_000 });
  const result = await run(executable, [command, '--pid', pid,
    ...(command === 'eval' ? ['--json'] : []), ...args], { timeout: 20_000 });
  return decodeNativeBridgeJson(result.stdout, command);
}
const measure = (expression: string) => native('eval', expression);
async function check(expression: string) {
  await expect.poll(() => measure(expression), { timeout: 45_000, intervals: [500, 1500] }).toBe(true);
  await native('check', '--eval', expression, '--json');
}
async function navigate(params: Record<string, string> = {}) {
  const url = new URL('/adv', process.env.VERIFY_TAURI_DEV_URL!);
  url.search = new URLSearchParams({ tab: 'workflows', welcome: '0',
    ws: process.env.PAPERCUSP_WORKSPACE_ID ?? process.env.PAPERCUSP_WORKSPACE!, ...params }).toString();
  await native('navigate', url.toString(), '--json');
  await check('!!document.querySelector(".pc-wf") && document.body.innerText.includes("Workflows")');
}

test.describe('P-012 current-build native acceptance', () => {
  test.beforeEach(() => {
    test.skip(!process.env.VERIFY_TAURI_PID, 'Requires the maintained owned Tauri rig');
    expect(process.env.VERIFY_TAURI_ISOLATED_DB, 'Write paths require the throwaway database').toBe('1');
    expect(process.env.PAPERCUSP_WORKSPACE_ID ?? process.env.PAPERCUSP_WORKSPACE).toMatch(/^verify-tauri-isolated-/);
  });

  test('owned Workflows frame and falsifiable missing-control guard', async ({}, info) => {
    test.setTimeout(180_000);
    try {
      await navigate();
      await check('!!document.querySelector("[aria-label=\"Workflow inspector\"]") && Array.from(document.querySelectorAll("button")).some(b => b.textContent?.includes("New workflow"))');
      // The check command must reject a missing subject. eval/probe success
      // alone cannot establish either a positive or a negative UI assertion.
      const negative = await native('check', '--selector', '#p012-deliberately-absent-control', '--json')
        .then(() => null, error => error as { code?: number; stdout?: string });
      expect(negative?.code).toBe(1);
      await retain(info, 'p012-native-frame', { status: 'PASS',
        url: await measure('location.href'), negativeControl: negative?.stdout,
        sourceReceipt: process.env.VERIFY_TAURI_SOURCE_RECEIPT
          ? JSON.parse(await readFile(process.env.VERIFY_TAURI_SOURCE_RECEIPT, 'utf8')) : null });
    } finally {
      await retain(info, 'p012-native-frame-dom', await measure('({url:location.href,text:document.body.innerText.slice(0,12000)})'));
    }
  });

  test('employee selection submits a canonical receipt; incomplete business journey fails closed', async ({}, info) => {
    test.setTimeout(240_000);
    const matrix: Verdict[] = [
      { step: 'employee-submit', status: 'ABSENT', detail: 'No authenticated isolated desktop selection fixture supplied',
        source: 'apps/operator-vite/src/components/adv/WorkflowSupportForm.tsx' },
      { step: 'reviewer-accept-reject-rework', status: 'ABSENT',
        detail: 'Requires three actual distinct-reviewer decisions and durable readback; a review checkbox is not an identity switch',
        source: 'apps/operator-vite/src/components/adv/WorkflowOperationResult.tsx' },
      { step: 'reviewer-live-corpus-negative-control', status: 'ABSENT',
        detail: 'Requires allowlisted reviewer denied without live corpus grant/source ACL, then allowed with both actors authorized (D-031)',
        source: 'packages/operator-core/lib/blueprint/support-workflow-case.ts' },
      { step: 'admin-version-approval-cost-promote-rollback', status: 'ABSENT',
        detail: 'Requires measured version/approval/cost receipts and promote/rollback controls with durable readback',
        source: 'packages/operator-core/lib/blueprint/operation-service.ts' },
    ];
    try {
      await navigate();
      const inputPath = process.env.P012_NATIVE_SELECTION_FILE;
      expect(inputPath, 'ABSENT: P012_NATIVE_SELECTION_FILE must identify a real authenticated isolated fixture').toBeTruthy();
      const selection: Selection = JSON.parse(await readFile(inputPath!, 'utf8'));
      expect(selection.workspaceId).toBe(process.env.PAPERCUSP_WORKSPACE_ID ?? process.env.PAPERCUSP_WORKSPACE);
      for (const key of ['harnessSlug', 'operationId', 'supportCaseId', 'query', 'documentTitle'] as const) {
        expect(typeof selection[key]).toBe('string');
        expect(selection[key].trim()).not.toBe('');
      }
      matrix[0].status = 'FAIL';
      matrix[0].detail = 'Real selection supplied; employee submission has not passed';
      await navigate({ wfSelId: `operation:${selection.harnessSlug}:${selection.operationId}` });
      await check(`!!document.querySelector(${JSON.stringify(form)}) && document.querySelector(${JSON.stringify(form)})?.getAttribute('aria-busy') !== 'true'`);
      await check(`(() => { const s=document.querySelector(${JSON.stringify(form)}); return !!s && s.textContent.includes('Approved revision') && s.textContent.includes('Maximum per run:') && s.textContent.includes('Accountable owner:'); })()`);
      // Name real label-associated controls locally without modifying product
      // code, then dispatch type/click separately from the assertion round-trip.
      await measure(`(() => { const s=document.querySelector(${JSON.stringify(form)}); for (const [label,id] of [['Support case reference','p012-case'],['Find case evidence','p012-query']]) { const input=Array.from(s.querySelectorAll('label')).find(l=>l.textContent.includes(label))?.querySelector('input'); if (!input) throw new Error('Missing '+label); input.id=id; } return true; })()`);
      await native('type', '#p012-case', selection.supportCaseId, '--json');
      await native('type', '#p012-query', selection.query, '--json');
      await measure(`(() => { const b=Array.from(document.querySelectorAll(${JSON.stringify(`${form} button`)})).find(b=>b.textContent==='Search allowed sources'); if (!b || b.disabled) throw new Error('Search unavailable'); b.click(); return true; })()`);
      await check(`(() => { const s=document.querySelector(${JSON.stringify(form)}); return s?.getAttribute('aria-busy')==='false' && Array.from(s.querySelectorAll('label')).some(l=>l.textContent.includes(${JSON.stringify(selection.documentTitle)}) && l.querySelector('[role=checkbox]')); })()`);
      await measure(`(() => { const l=Array.from(document.querySelectorAll(${JSON.stringify(`${form} label`)})).find(l=>l.textContent.includes(${JSON.stringify(selection.documentTitle)}) && l.querySelector('[role=checkbox]')); l.querySelector('[role=checkbox]').click(); return true; })()`);
      await check(`Array.from(document.querySelectorAll(${JSON.stringify(`${form} button`)})).some(b=>b.textContent==='Prepare handoff' && !b.disabled)`);
      await measure(`(() => { Array.from(document.querySelectorAll(${JSON.stringify(`${form} button`)})).find(b=>b.textContent==='Prepare handoff').click(); return true; })()`);
      await check(`!!new URL(location.href).searchParams.get('wfRun') && !!document.querySelector(${JSON.stringify(receipt)})`);
      const handle = await measure('JSON.parse(new URL(location.href).searchParams.get("wfRun"))');
      expect(handle).toMatchObject({ workspaceId: selection.workspaceId, harnessSlug: selection.harnessSlug,
        operationId: selection.operationId, specificationRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
        receiptId: expect.any(Number) });
      expect(handle.receiptId).toBeGreaterThan(0);
      matrix[0] = { ...matrix[0], status: 'PASS', detail: 'Native form returned a server-issued revision-pinned operation receipt; business acceptance remains separate' };
      await retain(info, 'p012-employee-receipt', handle);
      // Submission is only the employee leg. Never turn a missing reviewer or
      // admin exercise into a green full-journey result.
      expect(matrix.filter(row => row.status !== 'PASS'), 'P012 business journey still has unexecuted legs').toEqual([]);
    } finally {
      await retain(info, 'p012-journey-matrix', matrix);
      await retain(info, 'p012-journey-dom', await measure('({url:location.href,text:document.body.innerText.slice(0,12000)})'));
    }
  });
});
