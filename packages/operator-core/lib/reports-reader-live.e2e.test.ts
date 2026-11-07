/** Original R12 owning Vitest boundary: execute real Playwright, never grade a supplied success summary. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, inject, it } from 'vitest';
import { assertReportBrowserTerminal, assertStableReportRuntime, liveReportInput, record, REPORT_READER_CASES, type ReportRuntimeSnapshot } from './reports-reader-live';

const execute = promisify(execFile), require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const operator = join(root, 'apps/operator');
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
async function response(url: string) {
  const result = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!result.ok) throw new Error(`Report runtime read failed: ${result.status}`);
  return result;
}
async function snapshot(origin: string): Promise<ReportRuntimeSnapshot> {
  const health = record(await (await response(origin + '/api/health')).json());
  if (health.ok !== true || typeof health.sha !== 'string' || health.bundleStale) throw new Error('Current serving build is unavailable or stale');
  const html = await (await response(origin + '/reports')).text();
  const asset = html.match(/<script[^>]+src="(\/assets\/[^"?#]+\.js)"/)?.[1];
  if (!asset) throw new Error('Serving entry asset is unavailable');
  const bytes = Buffer.from(await (await response(origin + asset)).arrayBuffer());
  const catalog = await execute(process.execPath, [join(root, 'apps/operator/scripts/ptool.mjs'), 'tools:find',
    '--url=' + origin, '--json', JSON.stringify({ query: 'reports:get', limit: 1 })], { cwd: root, env: process.env, timeout: 30_000, maxBuffer: 2_000_000 });
  const generation = record(JSON.parse(catalog.stdout)).servingGeneration;
  if (typeof generation !== 'string') throw new Error('Measured serving generation is unavailable');
  return { origin, sha: health.sha, generation, asset, assetSha256: createHash('sha256').update(bytes).digest('hex') };
}

describe.skipIf(inject('papercuspTestLayer') !== 'e2e')('live published Reports reader', () => {
  it('runs the real receipt-selected Playwright journey with stable serving identity and terminal ledger proof', async () => {
    const receiptPath = process.env.OPERATOR_REPORT_PROOF_JSON;
    // Validate before any authenticated child or network action. Missing input is a failure, never fixture fallback.
    const input = liveReportInput(process.env, receiptPath ? await json(receiptPath) : null);
    const directory = join(input.outputDir, randomUUID());
    await mkdir(directory, { recursive: true });
    const reportPath = join(directory, 'playwright.json'), ledgerPath = join(directory, 'test-runs.jsonl');
    const before = await snapshot(input.origin), group = randomUUID();
    assertStableReportRuntime(before, before, input);
    const sourceCommit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 10_000 })).stdout.trim();
    const cli = require.resolve('@playwright/test/cli');
    await execute(process.execPath, [cli, 'test', 'e2e/reports-reader.spec.ts', '--config=playwright.config.mts',
      '--grep', REPORT_READER_CASES.join('|'), '--workers=1', '--retries=0',
      '--reporter=list,json,./test/reporters/admin-test-runs-reporter-playwright.ts', '--output=' + join(directory, 'browser')],
    { cwd: operator, timeout: 180_000, maxBuffer: 8_000_000, env: { ...process.env,
      OPERATOR_E2E_REUSE_SERVER: '1', OPERATOR_E2E_BASE_URL: input.origin, PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
      PAPERCUSP_TEST_RUN_GROUP: group, PAPERCUSP_TEST_RUN_RECEIPT_FILE: ledgerPath,
      PAPERCUSP_DISABLE_TEST_RUNS_REPORTER: '0' } });
    const after = await snapshot(input.origin);
    assertStableReportRuntime(before, after, input);
    const browser = await json(reportPath);
    const attachments: Record<string, unknown>[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const item = record(value);
      if (item.name === 'published-report-proof') attachments.push(item);
      Object.values(item).forEach(entry => { if (entry && typeof entry === 'object') visit(entry); });
    };
    visit(browser);
    expect(attachments).toHaveLength(1);
    const receipts = (await readFile(ledgerPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const attachment = attachments[0];
    const browserProof = typeof attachment.body === 'string' ? JSON.parse(Buffer.from(attachment.body, 'base64').toString('utf8'))
      : typeof attachment.path === 'string' ? await json(attachment.path) : null;
    const testRunId = assertReportBrowserTerminal(browser, browserProof, receipts, input, sourceCommit);
    const evidence = { input, sourceCommit, testRunId, runGroupId: group, before, after, reportPath, ledgerPath };
    await writeFile(join(directory, 'terminal.json'), JSON.stringify(evidence, null, 2));
    console.log('REPORTS_READER_LIVE_TERMINAL=' + JSON.stringify(evidence));
  }, 270_000);
});
