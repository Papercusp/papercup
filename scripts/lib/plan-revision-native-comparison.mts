import assert from 'node:assert/strict';
import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isCliEntry } from '../../packages/operator-core/lib/util/cli-entry.ts';
import { validateVerifierInputsFromGit } from '../verifier-source-preflight.mjs';
import { committedWorkRootDependencyDonor, verifyCommittedWorkRoot } from '../lint-as-committed.mjs';
import { runVerifierCommand, verifyVerifierSourceSync } from '../source-preview.mjs';
import { readTaskDeadlineEpochMs } from './task-deadline.mjs';
import { resolveExecutedMapPgUrl } from './executed-source-map.mjs';
import { assertNativePlanRetry, type NativePlanRetryTrace } from '../../apps/operator/e2e/_plan-revision-retry.ts';
import { diagnosticCitationCase, planFixtureIdentity } from '../../apps/operator/e2e/_plan-revision-edits.ts';
import { seedFakeLlmHarness } from '../../apps/operator/e2e/_fake-llm-fixture.ts';

const exec = promisify(execFile);
const here = fileURLToPath(import.meta.url);
const root = resolve(dirname(here), '../..');
const entry = 'scripts/lib/plan-revision-native-comparison.mts';
const rig = 'scripts/verify-tauri-headless.sh';
const adapter = 'packages/operator-core/lib/plan-revision-amendment-native.e2e.test.ts';
const spec = 'apps/operator/e2e/plan-revision-amendment-native.spec.mts';
const caseTitle = 'saves a citation in native Plans and correlates author reviewer and worker outcomes';
export const adapterCoverageCase = 'captures the pre change role matrix through the real native Plans selector';
const adapterSuite = 'historical private Plans clients';
const adapterCases = ['records old author payloads across edits, retry and resumption on api',
  'records old author payloads across edits, retry and resumption on ptool', adapterCoverageCase];
const config = 'apps/operator/playwright.config.mts';
type SelectedSource = { root: string; commit: string; receipt: string };
type RuntimeIdentity = { fingerprint: string; units: string[] };
type ComparisonRequest = { workspace: string; harness: string; group: string; definitionRef: string; applicationRef: string };
type CollectedSuite = { title: string; specs?: { file: string; title: string;
  tests: { projectName: string; expectedStatus: string }[] }[]; suites?: CollectedSuite[] };
type ClientActor = { kind: 'signed-in-user' | 'cli-session'; id: string; workspace: string };
type AuthorAttribution = { actorSource: ClientActor['kind'] | 'revision-writer'; revisionWriter: string };
type CoverageCell = { role: string; door: string; scenario: string;
  observations: { file: string; sha256: string; reference: string; actor: string; revision: string; authorAttribution?: AuthorAttribution }[] };
type ReporterRow = { id: string; workspace_id: string; harness_slug: string; run_group_id: string; framework: string;
  file_path: string; status: string; finished_at: Date | string | null; worktree_dirty: boolean | null;
  commit_sha: string; output_tail: string | null; execution_details: { root: string; testLayer: string;
    collectionFailed: boolean; passed: number; failed: number; skipped: number; passedCaseTitlesTruncated?: boolean;
    passedCaseTitles: string[]; failedCaseTitles?: string[]; runtimeEnvironmentBefore: RuntimeIdentity; runtimeEnvironmentAfter: RuntimeIdentity } };
type CapturedSave = { scenario: string; savedHash: string; clientActor?: ClientActor;
  revisions: { id: string; author_id: string; session_id?: string | null; content_hash: string }[] };
type CapturedTrace = { group: string; applicationCommit: string; definitionCommit: string; workspace: string } & (
  { roleViews: Record<string, { userId: string; workspace: string; revisionId?: string }>; scenario?: string;
    runtimeBefore: RuntimeIdentity; retry?: NativePlanRetryTrace; revision: { rows: { id: string; content_hash?: string }[] } }
  | { runtime: RuntimeIdentity; door: string; observations: CapturedSave[];
    roleReads: { role: string; scenario: string; actorId: string; savedHash: string; revisionId: string }[] });
export const applicationInputs = Object.freeze(['apps/operator/app/admin/plans/PlansClient.tsx', 'apps/operator/scripts/ptool.mjs']);
export const definitionInputs = Object.freeze([entry, adapter, spec, config, 'packages/operator-core/test/plan-revision-ptool.ts',
  'packages/operator-core/vitest.e2e.config.ts', 'scripts/test-files.mjs',
  'apps/operator/e2e/_fake-llm-fixture.ts', 'apps/operator/e2e/_native-bridge-json.ts', 'apps/operator/e2e/_plan-revision-edits.ts',
  'apps/operator/e2e/_plan-revision-retry.ts',
  'apps/operator/test/reporters/admin-test-runs-reporter-playwright.ts',
  'packages/operator-core/lib/testing-playwright-reporter.ts', 'packages/operator-core/lib/testing-native-runtime.ts']);

function writeReceipt(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
}

function digest(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

function inside(parent: string, child: string) {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

/** Verify what Playwright actually collected before the native application boots. */
export function assertComparisonSelection(report: { config: { rootDir: string }; suites: CollectedSuite[]; errors: unknown[] },
  definitionRoot: string, diagnosis = false) {
  assert.deepEqual(report.errors, [], 'Playwright reported collection errors');
  const testRoot = realpathSync(report.config.rootDir);
  assert.equal(testRoot, realpathSync(join(definitionRoot, 'apps/operator/e2e')));
  const selected: { file: string; title: string[]; project: string }[] = [];
  function visit(suite: CollectedSuite, parents: string[]) {
    for (const testSpec of suite.specs ?? []) {
      for (const test of testSpec.tests) {
        assert.equal(test.expectedStatus, 'passed', 'the selected case must be runnable');
        selected.push({ file: resolve(testRoot, testSpec.file), title: [...parents, testSpec.title],
          project: test.projectName });
      }
    }
    for (const nested of suite.suites ?? []) visit(nested, [...parents, nested.title]);
  }
  for (const fileSuite of report.suites) visit(fileSuite, []);
  const expectedTitle = diagnosis ? diagnosticCitationCase : caseTitle;
  assert.deepEqual(selected, [{ file: join(definitionRoot, spec), title: [expectedTitle], project: 'chromium' }],
    'expected exactly the selected top-level Plans case');
}

/** Read the receipt bytes once and verify each immutable checkout against its own receipt. */
export function measureComparisonSources(application: SelectedSource, definition: SelectedSource) {
  const roots = [realpathSync(application.root), realpathSync(definition.root)];
  assert(!inside(roots[0], roots[1]) && !inside(roots[1], roots[0]), 'comparison roots overlap');
  const seen = new Set();
  return [application, definition].map((selection, i) => {
    assert.match(selection.commit, /^[0-9a-f]{40}$/);
    const path = realpathSync(selection.receipt);
    assert(roots.every(archive => !inside(archive, path)), 'source receipt must be outside both tested archives');
    const stat = statSync(path, { bigint: true });
    const inode = String(stat.dev) + '/' + String(stat.ino);
    assert(stat.isFile() && !seen.has(inode), 'expected two independent source receipt files');
    seen.add(inode);
    const bytes = readFileSync(path);
    const receipt: Parameters<typeof verifyVerifierSourceSync>[1] = JSON.parse(bytes.toString('utf8'));
    assert.equal(receipt.sourceCommit, selection.commit, 'source receipt differs from selected commit');
    assert(receipt.gitCheckout, 'comparison requires a verified Git checkout');
    verifyVerifierSourceSync(roots[i], receipt, { runtimeArtifacts: true });
    const tested = new Set(receipt.testedInputs.map(row => row.path));
    for (const required of i === 0 ? applicationInputs : definitionInputs)
      assert(tested.has(required), 'tested source input missing: ' + required);
    return { root: roots[i], commit: selection.commit, receipt: path, receiptSha256: digest(bytes) };
  });
}

function originalReporterRow(rows: ReporterRow[], request: ComparisonRequest, driverRoot: string, runtime: RuntimeIdentity,
  framework: 'playwright' | 'vitest', path: string) {
  assert.equal(rows.length, 1, 'expected exactly one original ' + framework + ' row for the comparison');
  const [row] = rows;
  assert.match(row.id, /^[1-9][0-9]*$/);
  assert.equal(row.workspace_id, request.workspace);
  assert.equal(row.harness_slug, request.harness);
  assert.equal(row.run_group_id, request.group);
  assert.equal(row.framework, framework);
  assert.equal(row.file_path, path);
  assert(row.finished_at && row.worktree_dirty === false, 'expected a finished clean-source ' + framework + ' row');
  assert.equal(row.commit_sha, request.definitionRef);
  assert(row.output_tail?.split('\n').includes('[native sources] application=' + request.applicationRef
    + ' verifier=' + request.definitionRef), 'reporter did not observe both selected sources');
  const details = row.execution_details;
  assert.equal(details.root, driverRoot);
  assert.equal(details.testLayer, 'e2e');
  assert.equal(details.collectionFailed, false);
  assert(!details.passedCaseTitlesTruncated);
  for (const observed of [details.runtimeEnvironmentBefore, details.runtimeEnvironmentAfter]) {
    assert.equal(observed.fingerprint, runtime.fingerprint);
    assert.deepEqual(observed.units, runtime.units);
  }
  return row;
}

/** The independent Playwright reporter is the authority for case execution. */
export function originalComparisonRow(rows: ReporterRow[], request: ComparisonRequest, driverRoot: string, runtime: RuntimeIdentity) {
  const row = originalReporterRow(rows, request, driverRoot, runtime, 'playwright', spec);
  assert.equal(row.status, 'pass');
  const details = row.execution_details;
  assert.deepEqual([details.passed, details.failed, details.skipped], [1, 0, 0]);
  assert.deepEqual(details.passedCaseTitles, [caseTitle]);
  return { id: row.id, group: row.run_group_id, applicationCommit: request.applicationRef,
    definitionCommit: row.commit_sha, caseTitle, fingerprint: runtime.fingerprint };
}

function coverageFailureMessage(missing: readonly string[]) {
  return 'Required role/client observations still missing (' + missing.length + ', sha256 '
    + digest(Buffer.from(JSON.stringify(missing))) + '). See coverage.json.';
}

export function assertCompleteComparisonCoverage(missing: readonly string[]) {
  if (missing.length) throw new Error(coverageFailureMessage(missing));
}

interface AdapterReport {
  success: boolean; numTotalTests: number; numPassedTests: number; numFailedTests: number; numPendingTests: number; numTodoTests: number;
  testResults: { name: string; status: string; message: string;
    assertionResults: { title: string; ancestorTitles: string[]; status: string; failureMessages: string[] }[] }[];
}

/** A partial result requires one original failed assertion for exactly the recorded omissions. */
export function originalAdapterResult(rows: ReporterRow[], request: ComparisonRequest, driverRoot: string, runtime: RuntimeIdentity,
  bytes: Buffer, exitCode: number, missing: readonly string[]) {
  const row = originalReporterRow(rows, request, driverRoot, runtime, 'vitest', adapter);
  const report: AdapterReport = JSON.parse(bytes.toString('utf8'));
  assert.equal(report.testResults.length, 1);
  const [file] = report.testResults;
  assert.equal(file.name, join(driverRoot, adapter));
  const cases = file.assertionResults;
  assert.deepEqual(cases.map(test => test.title).sort(), [...adapterCases].sort());
  assert(cases.every(test => test.ancestorTitles.at(-1) === adapterSuite && Array.isArray(test.failureMessages)));
  const passed = cases.filter(test => test.status === 'passed');
  const failed = cases.filter(test => test.status === 'failed');
  assert.equal(passed.length + failed.length, cases.length);
  assert.deepEqual([report.numTotalTests, report.numPassedTests, report.numFailedTests, report.numPendingTests, report.numTodoTests],
    [cases.length, passed.length, failed.length, 0, 0]);
  const details = row.execution_details;
  assert.deepEqual([details.passed, details.failed, details.skipped], [passed.length, failed.length, 0]);
  const titles = (tests: typeof cases) => tests.map(test => adapterSuite + ' > ' + test.title).sort();
  assert.deepEqual([...(details.passedCaseTitles ?? [])].sort(), titles(passed));
  assert.deepEqual([...(details.failedCaseTitles ?? [])].sort(), titles(failed));
  let status: 'passed' | 'partial' | 'failed' = 'failed';
  const noOtherErrors = file.message === '' && passed.every(test => test.failureMessages.length === 0);
  if (exitCode === 0 && !missing.length && noOtherErrors && !failed.length
    && report.success === true && file.status === 'passed' && row.status === 'pass') status = 'passed';
  if (exitCode === 1 && missing.length && noOtherErrors && failed.length === 1 && failed[0].title === adapterCoverageCase
    && report.success === false && file.status === 'failed' && row.status === 'fail' && failed[0].failureMessages.length === 1) {
    const message = failed[0].failureMessages[0].split(/\r?\n/, 1)[0];
    const expected = coverageFailureMessage(missing);
    // Module and nested suite errors take priority in the independent reporter's
    // diagnostic. A matching assertion plus a separate teardown failure stays failed.
    const expectedTail = adapterSuite + ' > ' + adapterCoverageCase + ': ' + expected
      + '\n[native sources] application=' + request.applicationRef + ' verifier=' + request.definitionRef;
    if ((message === expected || message === 'Error: ' + expected) && row.output_tail === expectedTail) status = 'partial';
  }
  return { id: row.id, group: row.run_group_id, originalStatus: row.status, status,
    reportSha256: digest(bytes), failedCaseTitles: titles(failed) };
}

async function readOriginalResults(ledger: string, request: ComparisonRequest, driverRoot: string, runtime: RuntimeIdentity,
  reportPath: string, exitCode: number, missing: string[]) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(ledger, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    const rows = await sql<ReporterRow[]>`SELECT id::text, workspace_id, harness_slug, run_group_id, framework,
        file_path, status, finished_at, worktree_dirty, commit_sha, output_tail, execution_details
      FROM harness_shared.test_runs WHERE workspace_id=${request.workspace} AND harness_slug=${request.harness}
        AND run_group_id=${request.group} AND ((framework='playwright' AND file_path=${spec})
          OR (framework='vitest' AND file_path=${adapter}))`;
    return {
      original: originalComparisonRow(rows.filter(row => row.framework === 'playwright'), request, driverRoot, runtime),
      originalAdapter: originalAdapterResult(rows.filter(row => row.framework === 'vitest'), request, driverRoot, runtime,
        readFileSync(reportPath), exitCode, missing),
    };
  } finally { await sql.end({ timeout: 5 }); }
}

/** Retain each original observation and explicitly enumerate unmeasured role/client/scenario cells. */
export function readComparisonCoverage(directory: string, request: ComparisonRequest & { privateWorkspace: string }, runtime: RuntimeIdentity) {
  const cells = new Map<string, CoverageCell>();
  for (const role of ['author', 'reviewer', 'worker'])
    for (const door of ['api', 'ptool', 'desktop'])
      for (const scenario of ['cosmetic', 'citation', 'retry', 'resumed', 'material'])
        cells.set([role, door, scenario].join('/'), { role, door, scenario, observations: [] });
  for (const file of readdirSync(directory).sort()) {
    const desktop = /^(?:citation|plan)-role-views-.*\.json$/.test(file);
    if (!desktop && !/^draft-author-.*\.json$/.test(file)) continue;
    const bytes = readFileSync(join(directory, file));
    const row: CapturedTrace = JSON.parse(bytes.toString('utf8'));
    assert.equal(row.group, request.group);
    assert.equal(row.applicationCommit, request.applicationRef);
    assert.equal(row.definitionCommit, request.definitionRef);
    assert.equal(row.workspace, request.privateWorkspace);
    assert.equal(desktop, 'roleViews' in row, 'capture kind differs from its source');
    assert.equal(('roleViews' in row ? row.runtimeBefore : row.runtime).fingerprint, runtime.fingerprint);
    const sha256 = digest(bytes);
    function record(role: string, door: string, scenario: string, reference: string, actor: string, revision: string,
      authorAttribution?: AuthorAttribution) {
      const cell = cells.get([role, door, scenario].join('/'));
      assert(cell && actor && revision, 'original role observation must name its actor, scenario and revision');
      cell.observations.push({ file, sha256, reference, actor, revision: String(revision),
        ...(authorAttribution ? { authorAttribution } : {}) });
    }
    if ('roleViews' in row) {
      const views = Object.entries(row.roleViews);
      if (row.scenario === 'retry') {
        if (!row.retry || !views.some(([, view]) => view.revisionId)) continue;
        assertNativePlanRetry(row.retry);
        assert.deepEqual(row.revision.rows.map(edition => edition.content_hash),
          [row.retry.before.contentHash, row.retry.afterRetry.contentHash], 'retry does not match the observed revisions');
        const edition = row.revision.rows[1]!;
        assert(views.every(([, view]) => !view.revisionId || view.revisionId === edition.id),
          'a participant observed a different retry revision');
      }
      const actors = views.map(([, view]) => view.userId);
      assert.equal(new Set(actors).size, actors.length, 'desktop roles share an identity');
      for (const [role, view] of views) {
        if (!view.revisionId) continue; // partial input captured before the role completed its operation
        assert.equal(view.workspace, row.workspace);
        assert(row.revision.rows.some(revision => revision.id === view.revisionId), 'unobserved desktop revision');
        record(role, 'desktop', row.scenario ?? 'citation', 'roleViews.' + role, view.userId, view.revisionId);
      }
    } else {
      assert(['api', 'ptool'].includes(row.door), 'unrecognized client');
      for (const [index, save] of row.observations.entries()) {
        const revision = save.revisions.at(-1);
        assert(revision && save.savedHash === revision.content_hash, 'client observation differs from the saved revision');
        const client = save.clientActor;
        if (client) {
          assert.equal(client.workspace, row.workspace);
          assert.equal(client.kind, row.door === 'api' ? 'signed-in-user' : 'cli-session');
          if (client.kind === 'cli-session')
            assert(revision.author_id === client.id || revision.session_id === client.id, 'CLI revision has a different session');
        }
        record('author', row.door, save.scenario, 'observations.' + index, client ? client.id : revision.author_id, revision.id,
          { actorSource: client?.kind ?? 'revision-writer', revisionWriter: revision.author_id });
      }
      for (const [index, read] of row.roleReads.entries()) {
        const save = row.observations.find(save => save.scenario === read.scenario && save.savedHash === read.savedHash);
        const edition = save?.revisions.find(revision => String(revision.id) === read.revisionId);
        assert(edition, 'role read has no matching saved revision');
        assert(['reviewer', 'worker'].includes(read.role) && read.actorId !== edition.author_id && read.actorId !== save?.clientActor?.id
          && !row.roleReads.some(other => other.scenario === read.scenario && other.role !== read.role && other.actorId === read.actorId),
        'client role reads must have independent authenticated identities');
        record(read.role, row.door, read.scenario, 'roleReads.' + index, read.actorId, read.revisionId);
      }
    }
  }
  const rows = [...cells.values()];
  const unmeasured = rows.filter(cell => !cell.observations.length).map(cell => [cell.role, cell.door, cell.scenario].join('/'));
  return { cells: rows, unmeasured, status: unmeasured.length ? 'partial' : 'covered' };
}

function runChild(program: string, args: string[], options: SpawnOptions) {
  return new Promise<number>((resolveExit, reject) => {
    const child = spawn(program, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(program + ' terminated by ' + signal));
      else resolveExit(code ?? 1);
    });
  });
}

async function runComparison(applicationRef: string, definitionRef: string, applicationReader: string, diagnosis: boolean) {
  assert.match(applicationRef, /^[0-9a-f]{40}$/, 'expected a full application commit');
  assert.match(definitionRef, /^[0-9a-f]{40}$/, 'expected a full definition commit');
  assert(isAbsolute(applicationReader), 'expected the prepared application reader path');
  const app = verifyCommittedWorkRoot(applicationReader, applicationRef, [rig]).root;
  const donor = committedWorkRootDependencyDonor(app, { sourceObjects: true });
  assert.equal(donor, committedWorkRootDependencyDonor(root, { sourceObjects: true }),
    'application and driver must come from the same repository');
  for (const name of ['VERIFY_TAURI_TEST_SOURCE_RECEIPT', 'VERIFY_TAURI_SOURCE_RECEIPT',
    'VERIFY_TAURI_SOURCE_SNAPSHOT_PATH', 'VERIFY_TAURI_PID', 'OPERATOR_SOURCE_ROOT'])
    assert(process.env[name] === undefined, 'comparison must start outside a prepared native runtime: ' + name);
  await validateVerifierInputsFromGit({ repo: app, ref: applicationRef, inputs: [...applicationInputs], tauriInputs: true });
  await validateVerifierInputsFromGit({ repo: root, ref: definitionRef, inputs: [...definitionInputs] });
  assert(readTaskDeadlineEpochMs(process.env) !== null && process.env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID,
    'native comparison requires the managed verifier task and its deadline');
  const ledger = resolveExecutedMapPgUrl().url;
  const workspace = process.env.PAPERCUSP_TEST_RUN_WORKSPACE ?? process.env.PAPERCUSP_WORKSPACE;
  const harness = process.env.PAPERCUSP_TEST_RUN_HARNESS ?? process.env.PAPERCUSP_HARNESS_SLUG ?? 'papercusp';
  assert(ledger && workspace && harness, 'the reporting database, workspace and harness are required');
  const out = mkdtempSync(join(tmpdir(), 'plan-revision-comparison-'));
  const group = (diagnosis ? 'revision-native-diagnosis-' : 'revision-native-') + randomUUID();
  const receiptPath = join(out, 'definition.json');
  const request = { applicationRef, definitionRef, group, workspace, harness, spec,
    caseTitle: diagnosis ? diagnosticCitationCase : caseTitle, ...(diagnosis ? { purpose: 'diagnosis' } : {}),
    taskId: process.env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID };
  writeReceipt(join(out, 'request.json'), request);
  console.log('Native Plans comparison evidence', out);
  const code = await runVerifierCommand({ repo: root, ref: definitionRef, inputs: [...definitionInputs], receiptPath,
    runtimeOutputs: 'preserve', command: [process.execPath, '--import', 'tsx', entry, 'boot'],
    prepareChildEnv: async ({ sourceRoot }) => {
      const collection = join(out, 'selection.json');
      await exec(process.execPath, [join(sourceRoot, 'node_modules/@playwright/test/cli.js'), 'test',
        '--config', join(sourceRoot, config), basename(spec), '--grep', request.caseTitle + '$', '--list', '--reporter=json'],
      { cwd: join(sourceRoot, 'apps/operator'), timeout: 60_000, env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: collection } });
      assertComparisonSelection(JSON.parse(readFileSync(collection, 'utf8')), sourceRoot, diagnosis);
      return { PAPERCUSP_REPO_DIR: donor, PLAN_REVISION_APPLICATION_READER: app, PLAN_REVISION_EVIDENCE: out,
        VERIFY_TAURI_TEST_SOURCE_REF: definitionRef, VERIFY_TAURI_TEST_SOURCE_RECEIPT: receiptPath,
        VERIFY_TAURI_SOURCE_REF: applicationRef, VERIFY_TAURI_SOURCE_RECEIPT: undefined,
        VERIFY_TAURI_SOURCE_INPUTS: applicationInputs.join(','), VERIFY_TAURI_SOURCE_INPUTS_FILE: undefined,
        VERIFY_TAURI_ISOLATED_DB: '1', VERIFY_TAURI_ISOLATED_SEED: 'ready', PAPERCUSP_FAKE_LLM: '1',
        PAPERCUSP_FLAG_PAPERCUSP_OPEN_SIGNUP: process.env.PAPERCUSP_FLAG_PAPERCUSP_OPEN_SIGNUP ?? '1',
        VERIFY_TAURI_EVIDENCE_ROOT: join(out, 'native-rig'), PAPERCUSP_DISABLE_TEST_RUNS_REPORTER: undefined,
        PAPERCUSP_TEST_RUN_GROUP: group, PAPERCUSP_TEST_RUNS_DB_URL: ledger,
        PAPERCUSP_TEST_RUN_HARNESS: harness, PAPERCUSP_TEST_RUN_WORKSPACE: workspace };
    } });
  if (diagnosis) return code;
  if (code !== 0 && (code !== 3 || !existsSync(join(out, 'observation.json')))) return code;
  const result = JSON.parse(readFileSync(join(out, 'observation.json'), 'utf8'));
  assert.deepEqual(result.request, request);
  assert.equal(result.status, code === 0 ? 'passed' : 'partial');
  for (const [i, file] of ['application.json', 'definition.json'].entries())
    assert.equal(digest(readFileSync(join(out, file))), result.sources[i].receiptSha256);
  const coverage = readComparisonCoverage(out, { ...request, privateWorkspace: result.privateWorkspace }, result.before);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'coverage.json'), 'utf8')), coverage);
  assert.deepEqual(result.coverage, coverage);
  const originals = await readOriginalResults(ledger, request, result.sources[1].root, result.before,
    join(out, 'vitest.json'), result.adapterExit, coverage.unmeasured);
  assert.deepEqual(originals, { original: result.original, originalAdapter: result.originalAdapter });
  assert.equal(result.status, originals.originalAdapter.status);
  writeReceipt(join(out, 'result.json'), { ...result, finalizedAt: new Date().toISOString() });
  return code;
}

async function observe() {
  const env = process.env;
  const out = env.PLAN_REVISION_EVIDENCE;
  assert(out && env.OPERATOR_SOURCE_ROOT && env.VERIFY_TAURI_SOURCE_RECEIPT && env.VERIFY_TAURI_TEST_SOURCE_RECEIPT,
    'the owned native comparison must supply both sources and its retained evidence directory');
  assert(env.HARNESS_ADMIN_DATABASE_URL && env.PAPERCUSP_TEST_RUNS_DB_URL, 'the private application and its ledger are required');
  const request = JSON.parse(readFileSync(join(out, 'request.json'), 'utf8'));
  assert.equal(request.group, env.PAPERCUSP_TEST_RUN_GROUP);
  assert.equal(request.taskId, env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID);
  assert.equal(request.definitionRef, env.VERIFY_TAURI_TEST_SOURCE_REF);
  assert.equal(request.applicationRef, env.VERIFY_TAURI_SOURCE_REF);
  assert.equal(env.VERIFY_TAURI_ISOLATED_DB, '1');
  const { assertNativeIsolatedWorkspace, assertNativeRuntimeLiveness } = await import('../../packages/operator-core/lib/testing-native-runtime.ts');
  const privateWorkspace = assertNativeIsolatedWorkspace();
  const database = new URL(env.HARNESS_ADMIN_DATABASE_URL);
  const ledger = new URL(env.PAPERCUSP_TEST_RUNS_DB_URL);
  const local = ['127.0.0.1', 'localhost', '[::1]'];
  assert(local.includes(database.hostname) && database.port === env.PAPERCUSP_PG_PORT
    && database.port && database.port !== '5432', 'application requires the private database endpoint');
  assert(!(local.includes(ledger.hostname) && (ledger.port || '5432') === database.port
    && decodeURIComponent(ledger.pathname) === decodeURIComponent(database.pathname)),
  'comparison evidence requires a ledger distinct from the private database');
  const app = { root: env.OPERATOR_SOURCE_ROOT, receipt: env.VERIFY_TAURI_SOURCE_RECEIPT, commit: request.applicationRef };
  const driver = { root, receipt: env.VERIFY_TAURI_TEST_SOURCE_RECEIPT, commit: request.definitionRef };
  const sources = measureComparisonSources(app, driver);
  copyFileSync(sources[0].receipt, join(out, 'application.json'), constants.COPYFILE_EXCL);
  const before = assertNativeRuntimeLiveness(app.root, app.commit);
  const witness = { request, privateWorkspace, sources, before };
  writeReceipt(join(out, 'before.json'), witness);
  // The maintained seed writer needs the real launcher's private workspace alias.
  // Vitest deliberately removes that alias from workers before collecting tests.
  assert.equal(env.PAPERCUSP_WORKSPACE_ID, privateWorkspace, 'private registry writer has no matching launcher workspace');
  const harness = await seedFakeLlmHarness({ hive: true });
  const { default: postgres } = await import('postgres');
  const privateDb = postgres(env.HARNESS_ADMIN_DATABASE_URL, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    const records = await privateDb<{ path: string; kind: string; self_repo: boolean }[]>`
      SELECT p->>'path' AS path, p->>'harness_kind' AS kind, (p->>'self_repo')::boolean AS self_repo
      FROM harness_shared.harness_registry r CROSS JOIN LATERAL jsonb_array_elements(r.payload->'projects') p
      WHERE r.workspace_id=${privateWorkspace} AND p->>'slug'=${harness}`;
    assert.equal(harness, 'e2e-fake-plan');
    assert.equal(records.length, 1, 'private harness registration missing or ambiguous');
    assert.equal(realpathSync(records[0].path), realpathSync(app.root));
    assert.deepEqual([records[0].kind, records[0].self_repo], ['hive', true]);
  } finally { await privateDb.end({ timeout: 5 }); }
  writeReceipt(join(out, 'fixture.json'), { ...planFixtureIdentity(privateWorkspace, before.fingerprint), harness });
  const reportPath = join(out, 'vitest.json');
  if (request.purpose === 'diagnosis') {
    assert.equal(request.caseTitle, diagnosticCitationCase);
    const cliExit = await runChild(process.execPath, ['scripts/test-files.mjs', adapter, '--',
      '-t', adapterCases[1] + '$', '--reporter=default', '--reporter=json', '--outputFile=' + reportPath], { cwd: root, env });
    const desktopExit = await runChild(process.execPath, [join(root, 'node_modules/@playwright/test/cli.js'),
      'test', '--config', join(root, config), basename(spec), '--grep', diagnosticCitationCase + '$',
      '--workers=1', '--retries=0', '--output=' + join(out, 'diagnostic-desktop')], { cwd: root, env });
    assert.deepEqual(measureComparisonSources(app, driver), sources, 'diagnostic source changed');
    const after = assertNativeRuntimeLiveness(app.root, app.commit);
    assert.deepEqual([after.fingerprint, after.units], [before.fingerprint, before.units]);
    writeReceipt(join(out, 'diagnosis.json'), { ...witness, after, cliExit, desktopExit });
    return cliExit || desktopExit;
  }
  const code = await runChild(process.execPath, ['scripts/test-files.mjs', adapter, '--', '--reporter=default',
    '--reporter=json', '--outputFile=' + reportPath], { cwd: root, env });
  assert.deepEqual(measureComparisonSources(app, driver), sources, 'tested source changed during the run');
  const after = assertNativeRuntimeLiveness(app.root, app.commit);
  assert.equal(after.fingerprint, before.fingerprint);
  assert.deepEqual(after.units, before.units);
  writeReceipt(join(out, 'after.json'), { ...witness, after, adapterExit: code });
  const coverage = readComparisonCoverage(out, { ...request, privateWorkspace }, before);
  writeReceipt(join(out, 'coverage.json'), coverage);
  let originals;
  try {
    originals = await readOriginalResults(ledger.href, request, root, before, reportPath, code, coverage.unmeasured);
  } catch (error) {
    writeReceipt(join(out, 'observation.json'), { ...witness, after, coverage, adapterExit: code,
      status: 'unverified', reason: 'Missing or ineligible independent reporter row' });
    throw error;
  }
  const status = originals.originalAdapter.status;
  writeReceipt(join(out, 'observation.json'), { ...witness, after, ...originals, coverage, adapterExit: code, status });
  return status === 'partial' ? 3 : status === 'passed' ? 0 : 1;
}

if (isCliEntry(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'run' && (args.length === 3 || (args.length === 4 && args[3] === '--diagnose')))
    process.exitCode = await runComparison(args[0], args[1], args[2], args[3] === '--diagnose');
  else if (action === 'boot' && !args.length) {
    assert(process.env.PLAN_REVISION_APPLICATION_READER, 'missing prepared application reader');
    const application = join(process.env.PLAN_REVISION_APPLICATION_READER, rig);
    process.exitCode = await runChild('bash', [application, '--', process.execPath, '--import', 'tsx', here, 'observe'],
      { cwd: root });
  } else if (action === 'observe' && !args.length) process.exitCode = await observe();
  else throw new Error('Usage: run-operator-e2e-isolated.sh --plan-revision-comparison APPLICATION_SHA DEFINITION_SHA PREPARED_APPLICATION_ROOT [--diagnose]');
}
