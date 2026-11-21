import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prepareVerifierSource } from '../../../scripts/source-preview.mjs';
import {
  adapterCoverageCase, applicationInputs, assertComparisonSelection, assertCompleteComparisonCoverage,
  definitionInputs, measureComparisonSources, originalAdapterResult, originalComparisonRow,
  readComparisonCoverage,
} from '../../../scripts/lib/plan-revision-native-comparison.mts';
import { git, write } from './source-preview.fixture';
import { diagnosticCitationCase, planFixtureIdentity, privatePlanUsername, profilePlanLivenessGuard, readPreparedPlanHarness, retainNativePlanFailure } from '../../../apps/operator/e2e/_plan-revision-edits';

const title = 'saves a citation in native Plans and correlates author reviewer and worker outcomes';
const file = 'plan-revision-amendment-native.spec.mts';

describe('the isolated native Plans comparison', () => {
  let scratch: string;
  let app: { root: string; commit: string; receipt: string };
  let driver: typeof app;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'native-plan-source-test-'));
    const repo = join(scratch, 'source');
    mkdirSync(repo);
    git(repo, ['init', '-q']);
    git(repo, ['commit', '--allow-empty', '-qm', 'parent of the frozen application']);
    async function freeze(name: string, inputs: readonly string[]) {
      for (const path of inputs) write(repo, path, name + ': ' + path + '\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', name]);
      const commit = git(repo, ['rev-parse', 'HEAD']);
      const root = join(scratch, name);
      const receipt = join(scratch, name + '.json');
      const manifest = await prepareVerifierSource({ repo, ref: commit, dest: root, inputs: [...inputs], gitCheckout: true });
      writeFileSync(receipt, JSON.stringify(manifest) + '\n', { flag: 'wx' });
      return { root, commit, receipt };
    }
    app = await freeze('application', applicationInputs);
    driver = await freeze('definition', definitionInputs);
  });
  afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

  it('generates distinct complete account names accepted by native signup', () => {
    const names = (['author', 'reviewer', 'worker'] as const).flatMap(role =>
      [privatePlanUsername(role), privatePlanUsername(role)]);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9_-]{2,32}$/);
  });

  it('lets a hermetic client read only the prepared harness from its own private run', () => {
    const directory = join(scratch, 'prepared-harness');
    mkdirSync(directory);
    const workspace = 'verify-tauri-isolated-73';
    const fingerprint = 'a'.repeat(64);
    const env = { PLAN_REVISION_EVIDENCE: directory, OPERATOR_SOURCE_ROOT: app.root, PAPERCUSP_WORKSPACE: workspace,
      VERIFY_TAURI_ISOLATED_DB: '1', PAPERCUSP_VERIFY_TAURI_ISOLATED: '1', PAPERCUSP_SKIP_PG_DISCOVERY: '1',
      VERIFY_TAURI_SOURCE_REF: app.commit, VERIFY_TAURI_TEST_SOURCE_REF: driver.commit,
      PAPERCUSP_TEST_RUN_GROUP: 'fixture-group', PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: 'fixture-task' };
    const writer = { ...env, PAPERCUSP_WORKSPACE_ID: workspace };
    const receipt = { ...planFixtureIdentity(workspace, fingerprint, writer), harness: 'e2e-fake-plan' };
    const path = join(directory, 'fixture.json');
    expect(() => readPreparedPlanHarness(workspace, fingerprint, env)).toThrow();
    writeFileSync(path, JSON.stringify(receipt));
    expect(readPreparedPlanHarness(workspace, fingerprint, env)).toBe('e2e-fake-plan');
    expect(env).not.toHaveProperty('PAPERCUSP_WORKSPACE_ID');
    for (const difference of [{ workspace: 'other' }, { fingerprint: 'b'.repeat(64) }, { group: 'other' },
      { taskId: 'other' }, { applicationCommit: driver.commit }, { definitionCommit: app.commit }, { harness: 'other' }]) {
      writeFileSync(path, JSON.stringify({ ...receipt, ...difference }));
      expect(() => readPreparedPlanHarness(workspace, fingerprint, env)).toThrow();
    }
  });

  it('binds both commits, roots and external receipt byte digests', () => {
    const measured = measureComparisonSources(app, driver);
    expect(measured).toEqual([app, driver].map(source => ({ ...source,
      receiptSha256: createHash('sha256').update(readFileSync(source.receipt)).digest('hex') })));
    const extraWhitespace = join(scratch, 'reserialized.json');
    writeFileSync(extraWhitespace, readFileSync(driver.receipt, 'utf8') + '\n');
    expect(measureComparisonSources(app, { ...driver, receipt: extraWhitespace })[1].receiptSha256)
      .not.toBe(measured[1].receiptSha256);
  });

  it('rejects missing, swapped or differently pinned source receipts', () => {
    expect(() => measureComparisonSources(app, { ...driver, receipt: join(scratch, 'missing') })).toThrow();
    expect(() => measureComparisonSources({ ...app, receipt: driver.receipt }, driver)).toThrow(/selected commit/);
    expect(() => measureComparisonSources(app, { ...driver, commit: app.commit })).toThrow(/selected commit/);
    expect(() => measureComparisonSources(driver, app)).toThrow(/input missing/);
  });

  it('rejects root aliases and receipts that share an inode', () => {
    const alias = join(scratch, 'alias');
    symlinkSync(app.root, alias);
    expect(() => measureComparisonSources(app, { ...driver, root: alias })).toThrow(/overlap/);
    const linked = join(scratch, 'link.json');
    linkSync(app.receipt, linked);
    expect(() => measureComparisonSources(app, { ...driver, receipt: linked })).toThrow(/independent/);
    expect(() => measureComparisonSources(app, { ...driver, receipt: join(driver.root, '.verifier-source.json') }))
      .toThrow(/outside/);
  });

  it('rejects a definition changed after the source was measured', () => {
    const path = join(driver.root, definitionInputs[0]);
    const original = readFileSync(path);
    try {
      writeFileSync(path, 'changed definition');
      expect(() => measureComparisonSources(app, driver)).toThrow();
    } finally { writeFileSync(path, original); }
  });

  it('requires one runnable top-level case in the pinned file and project', () => {
    const rootDir = join(driver.root, 'apps/operator/e2e');
    // These are the fields the Playwright JSON reporter emits during --list.
    const report = (titles: string[], selectedFile = file, expectedStatus = 'passed') => ({
      errors: [], config: { rootDir }, suites: [{ title: selectedFile, specs: titles.map(name => ({
        file: selectedFile, title: name, tests: [{ projectName: 'chromium', expectedStatus }],
      })) }],
    });
    expect(() => assertComparisonSelection(report([title]), driver.root)).not.toThrow();
    expect(() => assertComparisonSelection(report([diagnosticCitationCase]), driver.root, true)).not.toThrow();
    expect(() => assertComparisonSelection(report([diagnosticCitationCase]), driver.root)).toThrow();
    expect(() => assertComparisonSelection(report([title]), driver.root, true)).toThrow();
    for (const invalid of [report([]), report([title, title]), report(['only the author']),
      report([title], 'other.spec.mts'), report([title], file, 'skipped')])
      expect(() => assertComparisonSelection(invalid, driver.root)).toThrow();
  });

  it('correlates exactly one clean reporter row with the private runtime and both commits', () => {
    const request = { workspace: 'test-workspace', harness: 'papercusp', group: 'comparison-group',
      applicationRef: app.commit, definitionRef: driver.commit };
    const runtime = { fingerprint: 'b'.repeat(64), units: ['verify-tauri-headless:43184'] };
    const details = { root: driver.root, testLayer: 'e2e', passed: 1, failed: 0, skipped: 0,
      collectionFailed: false, passedCaseTitles: [title], runtimeEnvironmentBefore: runtime, runtimeEnvironmentAfter: runtime };
    const row = { id: '317', framework: 'playwright', file_path: 'apps/operator/e2e/' + file,
      workspace_id: request.workspace, harness_slug: request.harness, run_group_id: request.group,
      status: 'pass', finished_at: new Date(), worktree_dirty: false, commit_sha: driver.commit,
      output_tail: '[native sources] application=' + app.commit + ' verifier=' + driver.commit, execution_details: details };
    expect(originalComparisonRow([row], request, driver.root, runtime)).toMatchObject({ id: '317', group: request.group });
    for (const invalid of [[], [row, row], [{ ...row, run_group_id: 'other' }], [{ ...row, output_tail: null }],
      [{ ...row, commit_sha: app.commit }], [{ ...row, worktree_dirty: true }], [{ ...row, harness_slug: 'other' }],
      [{ ...row, execution_details: { ...details, passedCaseTitles: ['only the author'] } }],
      [{ ...row, execution_details: { ...details, runtimeEnvironmentAfter: { ...runtime, fingerprint: 'changed' } } }]])
      expect(() => originalComparisonRow(invalid, request, driver.root, runtime)).toThrow();
  });

  it('replays the two failed historical attempts and all of their omissions from the saved trace bytes', () => {
    type Capture = {
      request: Omit<Parameters<typeof readComparisonCoverage>[1], 'privateWorkspace'> & { taskId: string };
      terminalExit: number; observationStatus: string; privateWorkspace: string;
      coverage: ReturnType<typeof readComparisonCoverage>; coverageSha256: string;
      runtimeBefore: Parameters<typeof readComparisonCoverage>[2]; runtimeAfter: Parameters<typeof readComparisonCoverage>[2];
      traceFiles: { file: string; sha256: string; ending: string; data: unknown }[];
      originalReporterRows: { id: string; status: string; run_group: string }[];
      fixture: { taskId: string; fingerprint: string; group: string } | null; fixtureSha256: string | null;
    };
    const path = new URL('../test/fixtures/plan-revision-baseline.json', import.meta.url);
    const captures: Capture[] = JSON.parse(readFileSync(path, 'utf8')).native.observations;
    for (const [task, ids, measured] of [
      ['0mwpy6v7uzdy9dc1mzf', ['24176471', '24176472'], 0],
      ['0mwq3m07ufkjbij18d8', ['24187728', '24187729'], 15],
    ] as const) {
      const matches = captures.filter(r => r.request.taskId === task);
      expect(matches).toHaveLength(1);
      const [run] = matches;
      expect([run.terminalExit, run.observationStatus]).toEqual([1, 'unverified']);
      expect(run.originalReporterRows.map(r => r.id)).toEqual(ids);
      expect(run.originalReporterRows.every(r => r.status === 'fail' && r.run_group === run.request.group)).toBe(true);
      expect(run.runtimeAfter.fingerprint).toBe(run.runtimeBefore.fingerprint);
      expect(run.runtimeAfter.units).toEqual(run.runtimeBefore.units);
      const dir = mkdtempSync(join(scratch, 'historical-traces-'));
      for (const trace of run.traceFiles) {
        expect(trace.file).toMatch(/^(?:draft-author-|(?:plan|citation)-role-views-)[\w.-]+\.json$/);
        const bytes = JSON.stringify(trace.data) + trace.ending;
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(trace.sha256);
        writeFileSync(join(dir, trace.file), bytes, { flag: 'wx' });
      }
      const coverage = readComparisonCoverage(dir, { ...run.request, privateWorkspace: run.privateWorkspace }, run.runtimeBefore);
      expect(coverage).toEqual(run.coverage);
      expect(createHash('sha256').update(JSON.stringify(coverage) + '\n').digest('hex')).toBe(run.coverageSha256);
      expect(coverage.cells).toHaveLength(45);
      const observed = coverage.cells.filter(cell => cell.observations.length);
      expect(observed).toHaveLength(measured);
      expect(observed.every(cell => cell.door === 'api')).toBe(true);
      expect(coverage.unmeasured).toHaveLength(45 - measured);
      if (measured) {
        expect(run.fixture).toMatchObject({ taskId: task, group: run.request.group, fingerprint: run.runtimeBefore.fingerprint });
        expect(createHash('sha256').update(JSON.stringify(run.fixture) + '\n').digest('hex')).toBe(run.fixtureSha256);
      } else { expect(run.fixture).toBeNull(); }
    }
  });

  it('profiles guard lines without retaining arguments, process output or converting a refusal to success', () => {
    const path = join(scratch, 'test-guard.sh');
    const canary = 'PRIVATE_ARGUMENT_AND_OUTPUT';
    const script = 'echo ' + canary + '\necho ' + canary + ' >&2\nexit 17\n';
    writeFileSync(path, script);
    const profile = profilePlanLivenessGuard(path);
    expect(profile.exitCode).toBe(17);
    expect(profile.scriptSha256).toBe(createHash('sha256').update(script).digest('hex'));
    expect(profile.marks).toEqual([1, 2, 3].map(line =>
      ({ line, epochSeconds: expect.stringMatching(/^\d+\.\d+$/) })));
    expect(JSON.stringify(profile)).not.toContain(canary);
  });

  it('retains the last entered guard line when its five-second deadline expires', () => {
    const path = join(scratch, 'stalled-guard.sh');
    writeFileSync(path, ':\nexec sleep 30\n');
    const result = profilePlanLivenessGuard(path);
    expect(result.marks.map(mark => mark.line)).toEqual([1, 2]);
    expect(result.errorCode).toBe('ETIMEDOUT');
    expect(result.exitCode).toBeNull();
  }, 15_000);

  it('keeps individual native failure locations and deadlines without retaining arguments or replacing earlier evidence', () => {
    const dir = mkdtempSync(join(scratch, 'scenario-failure-'));
    const request = { group: 'failure-group', taskId: 'original-task', applicationRef: app.commit, definitionRef: driver.commit };
    const canary = 'PRIVATE_TEST_ARGUMENT_MUST_STAY_OUT_OF_DIAGNOSTICS';
    writeFileSync(join(dir, 'request.json'), JSON.stringify({ ...request, extra: canary }));
    for (const [name, value] of Object.entries({ PLAN_REVISION_EVIDENCE: dir,
      PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: request.taskId, PAPERCUSP_TEST_RUN_GROUP: request.group,
      VERIFY_TAURI_SOURCE_REF: app.commit, VERIFY_TAURI_TEST_SOURCE_REF: driver.commit })) vi.stubEnv(name, value);
    try {
      const error = Object.assign(new Error(canary), { code: 'ETIMEDOUT',
        stack: 'Error: ' + canary + '\n    at check (/private/testing-native-runtime.ts:186:3)\n    at native (/private/plan-revision-amendment-native.spec.mts:55:5)' });
      const first = retainNativePlanFailure('ptool', 'preflight', 'native liveness and private origin', error, 5000);
      retainNativePlanFailure('desktop', 'citation', 'author sign-in / eval bridge', error, 1200);
      const files = readdirSync(dir).filter(path => path.startsWith('plan-failure-'));
      expect(files).toHaveLength(2);
      const observations = files.map(file => JSON.parse(readFileSync(join(dir, file), 'utf8')));
      expect(JSON.stringify(observations)).not.toContain(canary);
      expect(observations).toContainEqual({ ...request, failure: first });
      expect(first).toMatchObject({ door: 'ptool', scenario: 'preflight', code: 'ETIMEDOUT', elapsedMs: 5000,
        frames: ['testing-native-runtime.ts:186:3', 'plan-revision-amendment-native.spec.mts:55:5'] });
      vi.stubEnv('PAPERCUSP_TEST_RUN_GROUP', 'changed-group');
      expect(() => retainNativePlanFailure('api', 'preflight', 'native liveness', error, 1)).toThrow(/destination/);
      expect(readdirSync(dir).filter(path => path.startsWith('plan-failure-')).sort()).toEqual(files.sort());
    } finally { vi.unstubAllEnvs(); }
  });

  it('requires the original Vitest assertion and clean ledger row for a partial result', () => {
    const path = 'packages/operator-core/lib/plan-revision-amendment-native.e2e.test.ts';
    const suite = 'historical private Plans clients';
    const request = { group: 'adapter-group', harness: 'papercusp', workspace: 'ledger-workspace',
      applicationRef: app.commit, definitionRef: driver.commit };
    const runtime = { fingerprint: '3'.repeat(64), units: ['verify-tauri-headless:50'] };
    const missing = ['worker/ptool/resumed'];
    let originalError = '';
    try { assertCompleteComparisonCoverage(missing); } catch (err) { originalError = String(err); }
    expect(originalError).toContain('Required role/client observations still missing');
    expect(() => assertCompleteComparisonCoverage([])).not.toThrow();
    const titles = ['records old author payloads across edits, retry and resumption on api',
      'records old author payloads across edits, retry and resumption on ptool', adapterCoverageCase];
    const make = (failures: Record<string, string[]>, moduleError = '') => {
      const assertions = titles.map(title => ({ title, ancestorTitles: [suite],
        status: title in failures ? 'failed' : 'passed', failureMessages: failures[title] ?? [] }));
      const failed = assertions.filter(test => test.status === 'failed');
      const passed = assertions.filter(test => test.status === 'passed');
      const success = !failed.length && !moduleError;
      const diagnostic = moduleError || failed.flatMap(test => test.failureMessages.map(error =>
        suite + ' > ' + test.title + ': ' + error.split('\n', 1)[0].replace(/^Error: /, ''))).join('\n');
      const report = { success, numTotalTests: 3, numFailedTests: failed.length, numPassedTests: passed.length,
        numPendingTests: 0, numTodoTests: 0, testResults: [{ name: join(driver.root, path), message: moduleError,
          status: success ? 'passed' : 'failed', assertionResults: assertions }] };
      const row = { id: '411', workspace_id: request.workspace, harness_slug: request.harness, run_group_id: request.group,
        framework: 'vitest', file_path: path, status: success ? 'pass' : 'fail', finished_at: new Date(), worktree_dirty: false,
        commit_sha: driver.commit, output_tail: [diagnostic, '[native sources] application=' + app.commit + ' verifier=' + driver.commit]
          .filter(Boolean).join('\n'),
        execution_details: { root: driver.root, testLayer: 'e2e', collectionFailed: false, passed: passed.length,
          failed: failed.length, skipped: 0, passedCaseTitles: passed.map(test => suite + ' > ' + test.title),
          failedCaseTitles: failed.map(test => suite + ' > ' + test.title), runtimeEnvironmentBefore: runtime,
          runtimeEnvironmentAfter: runtime } };
      return { report, row, classify: (code: number, omissions: string[]) => originalAdapterResult([row], request, driver.root,
        runtime, Buffer.from(JSON.stringify(report)), code, omissions) };
    };
    const complete = make({});
    expect(complete.classify(0, [])).toMatchObject({ status: 'passed', originalStatus: 'pass', id: '411' });
    expect(complete.classify(0, missing).status).toBe('failed');
    const onlyCoverage = { [adapterCoverageCase]: [originalError + '\n    at original assertion'] };
    const partial = make(onlyCoverage);
    expect(partial.classify(1, missing)).toMatchObject({ status: 'partial', originalStatus: 'fail' });
    expect(partial.classify(1, ['reviewer/ptool/resumed']).status).toBe('failed');
    expect(partial.classify(3, missing).status).toBe('failed');
    expect(make({ ...onlyCoverage, [titles[0]]: ['API failed'] }).classify(1, missing).status).toBe('failed');
    expect(make({ [adapterCoverageCase]: ['another assertion'] }).classify(1, missing).status).toBe('failed');
    expect(make({ [adapterCoverageCase]: [originalError, 'teardown failed'] }).classify(1, missing).status).toBe('failed');
    expect(make(onlyCoverage, 'module teardown failed').classify(1, missing).status).toBe('failed');
    const additionalSuiteFailure = make(onlyCoverage);
    additionalSuiteFailure.row.output_tail = 'nested afterAll failed\n[native sources] application=' + app.commit + ' verifier=' + driver.commit;
    expect(additionalSuiteFailure.classify(1, missing).status).toBe('failed');
    partial.row.commit_sha = app.commit;
    expect(() => partial.classify(1, missing)).toThrow();
    complete.report.testResults[0].assertionResults.pop();
    expect(() => complete.classify(0, [])).toThrow();
  });

  it('keeps the full denominator and original observations when client roles are missing or repeated', () => {
    const dir = join(scratch, 'observations');
    mkdirSync(dir);
    const request = { workspace: 'ledger', privateWorkspace: 'test', harness: 'papercusp', group: 'run',
      applicationRef: app.commit, definitionRef: driver.commit };
    const runtime = { fingerprint: 'a'.repeat(64), units: ['test'] };
    const observation = { group: request.group, workspace: request.privateWorkspace, runtime, door: 'ptool',
      applicationCommit: app.commit, definitionCommit: driver.commit, roleReads: [],
      observations: [{ scenario: 'material', savedHash: 'hash', revisions: [{ author_id: 'author', id: '19', content_hash: 'hash' }] }] };
    expect(readComparisonCoverage(dir, request, runtime).unmeasured).toHaveLength(45);
    for (const name of ['second', 'first']) writeFileSync(join(dir, 'draft-author-' + name + '.json'), JSON.stringify(observation));
    const coverage = readComparisonCoverage(dir, request, runtime);
    expect(coverage.cells).toHaveLength(45);
    expect(coverage.unmeasured).toHaveLength(44);
    expect(coverage.status).toBe('partial');
    expect(coverage.cells.find(row => row.role === 'author' && row.door === 'ptool' && row.scenario === 'material')?.observations)
      .toHaveLength(2);
    const old = coverage.cells.find(row => row.role === 'author' && row.door === 'ptool' && row.scenario === 'material');
    expect(old?.observations[0]?.authorAttribution).toEqual({ actorSource: 'revision-writer', revisionWriter: 'author' });
    const signed = { ...observation, door: 'api', observations: observation.observations.map(save => ({
      ...save, clientActor: { kind: 'signed-in-user', id: 'private-account', workspace: request.privateWorkspace },
    })) };
    const signedFile = join(dir, 'draft-author-api.json');
    writeFileSync(signedFile, JSON.stringify(signed));
    const measured = readComparisonCoverage(dir, request, runtime).cells.find(row =>
      row.role === 'author' && row.door === 'api' && row.scenario === 'material');
    expect(measured?.observations[0]).toMatchObject({ actor: 'private-account',
      authorAttribution: { actorSource: 'signed-in-user', revisionWriter: 'author' } });
    writeFileSync(signedFile, JSON.stringify({ ...signed, roleReads: [{ role: 'reviewer', scenario: 'material',
      actorId: 'private-account', savedHash: 'hash', revisionId: '19' }] }));
    expect(() => readComparisonCoverage(dir, request, runtime)).toThrow(/independent/);
    writeFileSync(signedFile, JSON.stringify(signed));
    writeFileSync(join(dir, 'draft-author-foreign.json'), JSON.stringify({ ...observation, group: 'other' }));
    expect(() => readComparisonCoverage(dir, request, runtime)).toThrow();
  });

  it('retains a late observation and its exact source after a partial pass and a fresh read', () => {
    const dir = join(scratch, 'late-cell');
    mkdirSync(dir);
    const request = { workspace: 'ledger', privateWorkspace: 'test', harness: 'papercusp', group: 'run',
      applicationRef: app.commit, definitionRef: driver.commit };
    const runtime = { fingerprint: 'c'.repeat(64), units: ['test'] };
    const base = { group: request.group, workspace: request.privateWorkspace,
      applicationCommit: app.commit, definitionCommit: driver.commit };
    const scenarios = ['material', 'resumed', 'retry', 'citation', 'cosmetic'];
    for (const door of ['ptool', 'api']) {
      const observations = scenarios.map((scenario, i) => ({ scenario, savedHash: 'h' + i,
        revisions: [{ author_id: 'author', id: String(i + 1), content_hash: 'h' + i }] }));
      const reads = observations.flatMap((save, i) => ['reviewer', 'worker'].map(role => ({
        role, actorId: role, scenario: save.scenario, savedHash: save.savedHash, revisionId: String(i + 1),
      })));
      writeFileSync(join(dir, 'draft-author-' + door + '.json'), JSON.stringify({ ...base, runtime, door,
        observations, roleReads: reads }));
    }
    expect(readComparisonCoverage(dir, request, runtime).unmeasured).toHaveLength(15);
    const desktop = { ...base, runtimeBefore: runtime, revision: { rows: [{ id: '4' }] },
      roleViews: { reviewer: { userId: 'reviewer', workspace: 'test', revisionId: '4' } } };
    const path = join(dir, 'citation-role-views-late.json');
    writeFileSync(path, JSON.stringify(desktop));
    const recovered = readComparisonCoverage(dir, request, runtime);
    expect(recovered.unmeasured).toHaveLength(14);
    expect(recovered.cells.find(row => row.role === 'reviewer' && row.door === 'desktop' && row.scenario === 'citation')?.observations)
      .toEqual([{ actor: 'reviewer', revision: '4', file: 'citation-role-views-late.json',
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), reference: 'roleViews.reviewer' }]);
    for (const scenario of scenarios) {
      const roles = scenario === 'resumed' ? ['author', 'reviewer'] : ['author', 'reviewer', 'worker'];
      const roleViews = Object.fromEntries(roles.map(role => [role, { userId: role, workspace: 'test', revisionId: '4' }]));
      writeFileSync(join(dir, 'citation-role-views-' + scenario + '.json'), JSON.stringify({ ...desktop, scenario, roleViews }));
    }
    expect(readComparisonCoverage(dir, request, runtime).unmeasured).toEqual([
      'author/desktop/retry', 'reviewer/desktop/retry', 'worker/desktop/retry', 'worker/desktop/resumed',
    ]);
    const before = { version: 6, contentHash: 'a'.repeat(64) };
    const saved = { version: 7, contentHash: 'b'.repeat(64) };
    const sent = { expectedVersion: before.version, expectedHash: before.contentHash, requestHash: 'f'.repeat(64) };
    const retry = { before, afterFirst: saved, afterRetry: saved, editorObservedLoss: true, editorAfterRetry: 'conflict',
      attempts: [{ ...sent, httpStatus: 200, result: 'accepted', acknowledgement: 'withheld' },
        { ...sent, httpStatus: 409, result: 'stale', acknowledgement: 'returned' }] };
    const retryViews = Object.fromEntries(['author', 'reviewer', 'worker'].map(role =>
      [role, { userId: role, workspace: 'test', revisionId: '4' }]));
    const retryFile = join(dir, 'plan-role-views-observed-retry.json');
    const observedRetry = { ...desktop, scenario: 'retry', retry, roleViews: retryViews,
      revision: { rows: [{ id: '3', content_hash: before.contentHash }, { id: '4', content_hash: saved.contentHash }] } };
    writeFileSync(retryFile, JSON.stringify({ ...observedRetry,
      revision: { rows: [{ id: '3', content_hash: before.contentHash }, { id: '4', content_hash: before.contentHash }] } }));
    expect(() => readComparisonCoverage(dir, request, runtime)).toThrow();
    writeFileSync(retryFile, JSON.stringify(observedRetry));
    expect(readComparisonCoverage(dir, request, runtime).unmeasured).toEqual(['worker/desktop/resumed']);
    const last = { ...desktop, scenario: 'resumed', roleViews: { worker: { userId: 'worker', workspace: 'test', revisionId: '4' } } };
    writeFileSync(join(dir, 'plan-role-views-final.json'), JSON.stringify(last));
    expect(readComparisonCoverage(dir, request, runtime)).toMatchObject({ status: 'covered', unmeasured: [] });
    writeFileSync(join(dir, 'plan-role-views-final-repeat.json'), JSON.stringify(last));
    const repeated = readComparisonCoverage(dir, request, runtime);
    expect(repeated.cells).toHaveLength(45);
    expect(repeated.cells.find(row => row.role === 'worker' && row.door === 'desktop' && row.scenario === 'resumed')?.observations)
      .toHaveLength(2);
  });
});
