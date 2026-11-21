import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareVerifierSource } from '../../../scripts/source-preview.mjs';
import {
  applicationInputs, assertComparisonSelection, definitionInputs, measureComparisonSources, originalComparisonRow,
  readComparisonCoverage,
} from '../../../scripts/lib/plan-revision-native-comparison.mts';
import { git, write } from './source-preview.fixture';

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
