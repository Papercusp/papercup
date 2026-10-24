/** R22: real CLI completion with actual history, tests and per-file coverage. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function runNativeReuseJourney({ call, workspace, root, owner, repo, handlerHash }: {
  call: (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>;
  workspace: string; root: string; owner: string; repo: string; handlerHash: string;
}) {
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const { getOrgPg } = await import('@papercusp/db-org');
  const { pgHookTurnStore } = await import('../../agent-identities/sync-hook-rules.ts');
  // This is the real private fixture's turn. Use its maintained writer; never
  // insert issued rows or pretend that a production user received this replay.
  await pgHookTurnStore().begin(owner, workspace);
  await mkdir(join(root, 'src'), { recursive: true });
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
  const body = 'let total = 0; for (const value of values) { if (value > 0) total += value; else total -= value; } '
    + 'total += values.length; '.repeat(20) + 'return total;';
  const aggregate = (name: string) => `export function ${name}(values: number[]) {\n  ${body.replaceAll('; ', ';\n  ')}\n}\n`;
  const target = "import { sql } from './partner';\n" + aggregate('aggregatePositive')
    + 'export function updateValue() { return sql`UPDATE public.p010_replay SET value = 1 WHERE id = 1`; }\n';
  const files: Record<string, string> = {
    'src/target.ts': target,
    'src/sibling.ts': aggregate('aggregateSibling'),
    'src/partner.ts': "export function sql(parts: TemplateStringsArray) { return parts.join(''); }\nexport const revision = 0;\n",
    // A real static consumer brings the SQL reader into compiler-captured
    // supporting scope. The test never imports or executes this consumer.
    'src/reader.ts': "import { sql } from './partner';\nimport { aggregatePositive } from './target';\n"
      + "export function readValue() { aggregatePositive([1]); return sql`SELECT value FROM public.p010_replay WHERE id = 1`; }\n",
    'src/target.test.ts': `import { test, expect } from ${JSON.stringify(join(repo, 'node_modules/vitest/dist/index.js'))};\n`
      + "import { aggregatePositive, updateValue } from './target';\n"
      + "test('native reuse positive branch and writer', () => { expect(aggregatePositive([2])).toBe(22); expect(updateValue()).toContain('UPDATE'); });\n",
    'package.json': JSON.stringify({ name: 'private-native-reuse', private: true, type: 'module',
      scripts: { 'test:file': 'vitest run --config vitest.config.ts' } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['src/**/*.ts'] }),
    '.gitignore': 'node_modules\nreports\n.papercusp\n',
    'vitest.config.ts': `import { defineConfig } from ${JSON.stringify(join(repo, 'node_modules/vitest/dist/config.js'))};\n`
      + `import { executedSourceOriginalsPlugin } from ${JSON.stringify(join(repo, 'libs/test-config/src/vitest-config.ts'))};\n`
      + `import AdminTestRunsReporter from ${JSON.stringify(join(repo, 'libs/test-config/src/admin-test-runs-reporter.ts'))};\n`
      + 'export default defineConfig({plugins:[executedSourceOriginalsPlugin()],test:{include:["src/target.test.ts"],maxWorkers:1,'
      + 'reporters:["default",new AdminTestRunsReporter()],coverage:{enabled:true,provider:"custom",'
      + `customProviderModule:${JSON.stringify(join(repo, 'libs/test-config/src/test-coverage-provider.ts'))},`
      + 'include:["src/*.ts"],reporter:["json"],reportsDirectory:"./reports"}}});\n',
  };
  for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text);
  git('init', '-q'); git('config', 'user.name', 'native reuse fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'private fixture baseline');
  for (let revision = 1; revision <= 3; revision++) {
    await writeFile(join(root, 'src/target.ts'), target + `// coordinated revision ${revision}\n`);
    await writeFile(join(root, 'src/partner.ts'), files['src/partner.ts']!.replace('revision = 0', `revision = ${revision}`));
    git('add', 'src/target.ts', 'src/partner.ts');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', `private coordinated revision ${revision}`);
  }
  const baseline = git('rev-parse', 'HEAD');
  // Publish an actual parser-produced clone inventory, with this repository's
  // real historical identity, to the same fixture snapshot seam as other replays.
  const { buildCloneIndex } = await import('../clone-index.ts');
  const { prepareCloneAdvisories } = await import('../clone-advisory.ts');
  const cloneFiles = prepareCloneAdvisories(buildCloneIndex([
    { path: 'src/target.ts', source: await readFile(join(root, 'src/target.ts'), 'utf8') },
    { path: 'src/sibling.ts', source: files['src/sibling.ts']! },
  ]));
  const snapshotPath = join(homedir(), '.papercusp/graph-snapshot', workspace, 'dependency-snapshot.json');
  await mkdir(join(snapshotPath, '..'), { recursive: true });
  await writeFile(snapshotPath, JSON.stringify({ schema: 'graph-dependency-snapshot-v1', generatedAt: new Date().toISOString(),
    index: { backend: 'first-party-imports', lastCommit: baseline }, edges: [],
    clones: { schema: 'clone-advisory-v1', files: cloneFiles } }));
  const created = await call('work_items:create', { harness: workspace, kind: 'change',
    title: 'Private native P010 completion consequences', assign_to: 'self', state: 'wip',
    changeKinds: ['logic'], changeKindReason: 'Private source fixture validated through an actual complete test population.',
    payload: { paths: ['src/target.ts'] }, projection: { pick: ['results[].id', 'results[].item.id'] } });
  const id = created.results?.[0]?.id ?? created.results?.[0]?.item?.id;
  assert(id, JSON.stringify(created));
  // The real claim primes the cooperative snapshot loader before tests run.
  // Keep the complete response as fixture evidence without certifying R20's
  // separate provenance/planning cohort from this completion-only scenario.
  const claimed = await call('work_items:claim', { row: `${id},self,${workspace}`,
    projection: { pick: ['results[].ok', 'results[].taskBrief'] } });
  assert.equal(claimed.results?.[0]?.ok, true, JSON.stringify(claimed));
  console.log('NATIVE_INCIDENT_API_STAGE=reuse-fixture-owned');
  const before = await readFile(join(root, 'src/target.ts'), 'utf8');
  await call('capability:edit', { file_path: join(root, 'src/target.ts'), old_string: before,
    new_string: '// touched clone sibling in this private task\n' + before + aggregate('plantedCopy') });
  const run = await call('testing:run', { harness: workspace, work_item_id: id, files: ['src/target.test.ts'],
    timeoutMs: 30_000 });
  console.log('NATIVE_REUSE_TEST_RUN=' + JSON.stringify(run));
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.passed, 1, JSON.stringify(run));
  assert.equal(run.failed, 0, JSON.stringify(run));
  assert.equal(run.skipped, 0, JSON.stringify(run));
  assert.equal(run.testRunIds?.length, 1, JSON.stringify(run));
  assert.equal(typeof run.runId, 'string', JSON.stringify(run));
  // Refuse a completion replay whose telemetry cannot support a negative
  // execution claim. This reads the real run's coverage, without seeding it.
  const { readNativeCoverageScope, queryTestCoverage } = await import('../test-coverage-map.ts');
  const sourceFiles = await Promise.all(['src/target.ts', 'src/reader.ts', 'src/partner.ts', 'src/target.test.ts']
    .map(async path => ({ path, sha256: hash(await readFile(join(root, path), 'utf8')) })));
  const coverage = await readNativeCoverageScope({ surface: 'completion', workspaceId: workspace,
    owner, invocation: 'native-fixture-precondition', workItem: id, paths: ['src/target.ts'],
    sourceVersion: hash(JSON.stringify(sourceFiles.map(source => [source.path, source.sha256]))), commit: baseline,
    repository: { workspaceId: workspace, rootPath: root, harness: workspace }, sourceFiles },
  new AbortController().signal, { runGroupId: run.runId, testFiles: ['src/target.test.ts'] });
  assert(coverage, 'Actual attributed run must have source-bound per-file coverage');
  const current = await readFile(join(root, 'src/target.ts'), 'utf8');
  const copyStart = current.slice(0, current.indexOf('export function plantedCopy')).split('\n').length;
  const uncovered = queryTestCoverage({ root, question: { path: 'src/target.ts',
    changedLines: Array.from({ length: current.split('\n').length - copyStart }, (_, i) => copyStart + i) },
    snapshots: coverage.snapshots, currentHashes: coverage.currentHashes, currentPopulation: coverage.population });
  assert(uncovered.uncoveredChangedLines.length > 0, JSON.stringify({ uncovered, snapshots: coverage.snapshots }));
  const { readPostgresLineage } = await import('../postgres-lineage-query.ts');
  const lineage = await readPostgresLineage(root, sourceFiles.map(source => source.path));
  assert(lineage.sites.some(site => site.path === 'src/reader.ts' && site.access === 'read'
    && site.table === 'public.p010_replay'), JSON.stringify(lineage));
  const closed = await call('work_items:complete', { id, harness: workspace, state: 'done', assumptions: 'none',
    completion: { summary: 'Changed the private aggregate and planted a copy; verified the positive branch and writer.',
      testsRun: 'testing:run src/target.test.ts with complete per-file V8 coverage', testResult: '1 passed, 0 failed',
      verifiedHow: 'Actual native CLI test and completion on private current source.', filesChanged: ['src/target.ts'] },
    projection: { pick: ['ok', 'results[].ok', 'results[].error', 'results[].completionBrief', 'results[].workItem.state'] } });
  const receipt = closed.results?.[0];
  assert.equal(receipt?.ok, true, JSON.stringify(closed));
  const text = JSON.stringify(receipt.completionBrief);
  const completionSignals = { sibling: /Untouched sibling.*sibling/.test(text), newCopy: /New copy.*plantedCopy/.test(text),
    cochange: /Untouched src\/partner/.test(text), sql: /SQL reader left unchecked[^\"]*reader\.ts/.test(text),
    coverage: /no recorded test executed changed lines/.test(text) };
  assert(Object.values(completionSignals).every(Boolean), JSON.stringify({ completionSignals, closed }));
  const issued = await getOrgPg().sql<{ subject: string; chars: number }[]>`SELECT subject, chars
    FROM harness_shared.code_intel_pushes WHERE workspace_id = ${workspace} AND owner_id = ${owner}
      AND subject::jsonb->>'workItem' = ${id} AND subject::jsonb->>'surface' = 'completion'`;
  assert(issued.length >= 3, JSON.stringify(issued));
  assert(issued.every(row => JSON.parse(row.subject).invocation && JSON.parse(row.subject).sourceVersion
    && JSON.parse(row.subject).indexVersion && row.chars > 0));
  const { REUSE_PROVIDER_POLICY, briefCodePoints } = await import('../reuse-brief-providers.ts');
  for (const row of issued) {
    const provider = JSON.parse(row.subject).provider as keyof typeof REUSE_PROVIDER_POLICY;
    assert(row.chars <= REUSE_PROVIDER_POLICY[provider].cap, JSON.stringify(row));
  }
  assert(briefCodePoints(JSON.stringify(receipt.completionBrief)) <= 3_000);
  const settled = await call('work_items:get', { id, harness: workspace, projection: { pick: ['results[].workItem.state'] } });
  assert.equal(settled.results?.[0]?.workItem.state, 'done');
  console.log('NATIVE_REUSE_API_PROOF=' + JSON.stringify({ workspace, fixtureWorkItem: id, baseline, handlerHash,
    sourceFingerprint: hash(await readFile(join(root, 'src/target.ts'), 'utf8')), transport: 'real-cli-http',
    completionSignals, issued, claimed, completion: receipt.completionBrief, terminal: true,
    scope: 'private current-source compiled operator and actual CLI actions; no production receipt or final shipment' }));
}
