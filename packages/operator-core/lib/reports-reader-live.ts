/** Admission and terminal-evidence guards for the owning live Reports browser journey. */
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';

const execute = promisify(execFile);

/** Keep child diagnostics even when startup fails before Playwright writes its report. */
export async function runReportBrowser(command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; directory: string; timeoutMs?: number;
}) {
  const startedAt = new Date().toISOString();
  let stdout = '', stderr = '', failure: unknown;
  try {
    ({ stdout, stderr } = await execute(command, args, {
      cwd: options.cwd, env: options.env, encoding: 'utf8',
      timeout: options.timeoutMs ?? 180_000, maxBuffer: 8_000_000,
    }));
  } catch (error) {
    failure = error;
    const result = record(error);
    stdout = typeof result.stdout === 'string' ? result.stdout : '';
    stderr = typeof result.stderr === 'string' ? result.stderr : '';
  }
  const result = record(failure);
  await Promise.all([
    writeFile(join(options.directory, 'child.stdout.log'), stdout),
    writeFile(join(options.directory, 'child.stderr.log'), stderr),
    writeFile(join(options.directory, 'child.terminal.json'), JSON.stringify({
      startedAt, finishedAt: new Date().toISOString(), command, args,
      code: failure ? result.code ?? null : 0, signal: result.signal ?? null,
      killed: result.killed === true, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
    }, null, 2)),
  ]);
  if (failure) throw failure;
}

export const REPORT_READER_SPEC = 'apps/operator/e2e/reports-reader.spec.ts';
export const REPORT_READER_CASES = [
  'published report text and standalone HTML stay identical',
  'published report session keeps credentials off a redirected foreign origin',
  'report proof rejects a successful HTTP response with an unrelated route',
] as const;
export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
function required(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export const markdownHash = (body: string) => createHash('sha256').update(body).digest('hex');

export function liveReportInput(env: NodeJS.ProcessEnv, receipt: unknown) {
  required(env.OPERATOR_REPORT_PROOF_JSON && isAbsolute(env.OPERATOR_REPORT_PROOF_JSON), 'Absolute OPERATOR_REPORT_PROOF_JSON is required; fixture mode is forbidden');
  required(env.OPERATOR_E2E_BASE_URL, 'OPERATOR_E2E_BASE_URL is required');
  const url = new URL(env.OPERATOR_E2E_BASE_URL);
  required(['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'An explicit local operator origin is required');
  required(env.OPERATOR_REPORT_BUILD_SHA && /^[a-f0-9]{7,40}$/.test(env.OPERATOR_REPORT_BUILD_SHA), 'OPERATOR_REPORT_BUILD_SHA is required');
  required(env.OPERATOR_REPORT_MARKER && env.OPERATOR_REPORT_MARKER.trim(), 'A unique stored OPERATOR_REPORT_MARKER is required');
  required(env.OPERATOR_REPORT_LIVE_OUTPUT_DIR && isAbsolute(env.OPERATOR_REPORT_LIVE_OUTPUT_DIR), 'An absolute owned OPERATOR_REPORT_LIVE_OUTPUT_DIR is required');
  const envelope = record(receipt), results = list(envelope.results), result = record(results[0]), report = record(result.report);
  required(envelope.ok === true && results.length === 1 && result.ok === true
    && ['report_id', 'title', 'body_md', 'workspace_id'].every(key => typeof report[key] === 'string' && report[key]), 'One complete successful reports:get receipt is required');
  required(report.path === '/reports?sel=' + encodeURIComponent(String(report.report_id)), 'The receipt must select its exact report');
  required(String(report.body_md).includes(env.OPERATOR_REPORT_MARKER), 'The stored report must contain the unique marker');
  required(report.body_sha256 === markdownHash(String(report.body_md)), 'The stored body hash must match the complete readback');
  return { origin: url.origin, buildSha: env.OPERATOR_REPORT_BUILD_SHA, outputDir: env.OPERATOR_REPORT_LIVE_OUTPUT_DIR,
    reportId: String(report.report_id), bodyHash: String(report.body_sha256), selector: String(report.path) };
}

export interface ReportRuntimeSnapshot { origin: string; sha: string; generation: string; asset: string; assetSha256: string }
export function assertStableReportRuntime(before: ReportRuntimeSnapshot, after: ReportRuntimeSnapshot, input: ReturnType<typeof liveReportInput>) {
  required(before.origin === input.origin && after.origin === input.origin, 'Report runtime origin changed');
  required(before.sha.length >= 7 && (input.buildSha.startsWith(before.sha) || before.sha.startsWith(input.buildSha)), 'The selected serving build does not match');
  required(before.generation.startsWith('serving-generation-v1:') && /^[a-f0-9]{64}$/.test(before.assetSha256), 'Measured generation and artifact digest are required');
  for (const key of ['sha', 'generation', 'asset', 'assetSha256'] as const) required(before[key] === after[key], `Report runtime ${key} changed during the browser journey`);
}

export function assertReportBrowserTerminal(report: unknown, browserProof: unknown, receipts: unknown[], input: ReturnType<typeof liveReportInput>, sourceCommit: string) {
  const payload = record(report), stats = record(payload.stats), proof = record(browserProof);
  required(stats.expected === 3 && stats.skipped === 0 && stats.unexpected === 0 && stats.flaky === 0, 'Exactly three non-skipped, non-flaky browser cases must pass');
  const specs: Record<string, unknown>[] = [];
  const visit = (suite: unknown) => { const node = record(suite); specs.push(...list(node.specs).map(record)); list(node.suites).forEach(visit); };
  list(payload.suites).forEach(visit);
  required(specs.length === 3 && REPORT_READER_CASES.every(title => specs.some(spec => spec.title === title)), 'The exact published-report and negative-control cases are required');
  for (const spec of specs) {
    const tests = list(spec.tests).map(record);
    required(tests.length === 1 && tests[0].expectedStatus === 'passed' && tests[0].status === 'expected', 'A browser case was skipped or had an unexpected outcome');
    const results = list(tests[0].results).map(record);
    required(results.length === 1 && results[0].status === 'passed', 'Terminal Playwright execution is missing or retried');
  }
  required(proof.reportId === input.reportId && proof.sourceMarkdownSha256 === input.bodyHash
    && /^[a-f0-9]{64}$/.test(String(proof.exportSha256)) && Array.isArray(proof.externalRequests) && proof.externalRequests.length === 0,
  'The browser must prove the selected stored report and complete offline export');
  const inserted = receipts.map(record).filter(row => row.outcome === 'inserted' && row.filePath === REPORT_READER_SPEC);
  required(inserted.length === 1 && /^\d+$/.test(String(inserted[0].id)), 'A unique inserted Playwright test-run receipt is required');
  const ledger = record(inserted[0].row);
  required(inserted[0].status === 'pass' && ledger.status === 'pass' && ledger.commitSha === sourceCommit
    && ledger.worktreeDirty === false && ledger.isScratchConfig === false, 'The recorded browser run must pass at the exact clean committed source');
  return String(inserted[0].id);
}
