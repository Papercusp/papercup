/** R22: real CLI completion with actual history, tests and per-file coverage. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Inner assertions read the private operator ledger; the outer test retains its own sink. */
export function privateReuseTestEnvironment(env: NodeJS.ProcessEnv, workspace: string, root: string) {
  assert(workspace.startsWith('test-runtime-'), 'Private reuse workspace required');
  const url = new URL(env.HARNESS_ADMIN_DATABASE_URL ?? '');
  assert(['postgres:', 'postgresql:'].includes(url.protocol)
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    && Number(url.port) > 0 && url.port === env.PAPERCUSP_PG_PORT,
  'Inner reporter must use the private product database');
  return { PAPERCUSP_TEST_RUNS_DB_URL: url.toString(), PAPERCUSP_TEST_RUN_WORKSPACE: workspace,
    PAPERCUSP_TEST_RUN_HARNESS: workspace, PAPERCUSP_TEST_RUN_RECEIPT_FILE: join(root, 'reports/inner-test-receipt.jsonl'),
    PAPERCUSP_TEST_RUN_SOURCE: 'local' };
}

export async function runNativeReuseJourney({ call, workspace, root, owner, repo, handlerHash, claimOnly = false }: {
  call: (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>;
  workspace: string; root: string; owner: string; repo: string; handlerHash: string; claimOnly?: boolean;
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
  // D026: a real persisted planning timestamp and one explicitly controlled CLI
  // session qualify provenance. This does not represent a model-session census.
  const planSlug = `p010-controlled-claim-${new Date().toISOString().slice(0, 10)}`;
  let planItem: string | undefined;
  if (claimOnly) {
    const planned = await call('plans:new', { harness: workspace, slug: planSlug,
      title: 'Controlled private P010 claim fixture',
      content: '## Product shaping\nControlled CLI composition proof; no model pickup or live user cohort.\n\n'
        + '## Phase 1 — Fixture\n',
      projection: { pick: ['ok', 'results[].ok', 'results[].slug', 'slug'] } });
    assert.notEqual(planned.ok, false, JSON.stringify(planned));
    const added = await call('plans:add-item', { harness: workspace, slug: planSlug, phase: 'Phase 1 — Fixture',
      text: 'Inspect src/target.ts controlled reuse consequences', importance: 'normal',
      projection: { pick: ['ok', 'results[].ok', 'results[].itemId'] } });
    planItem = added.results?.[0]?.itemId;
    assert.equal(added.results?.[0]?.ok, true, JSON.stringify(added));
    assert(planItem, 'Maintained plan-item writer must persist the controlled anchor: ' + JSON.stringify(added));
    // Read the same indexed boundary that work_items:create validates, before
    // spending the rest of the native journey on an unusable anchor.
    const { getPlanItemRow } = await import('../../agent-tools/plans/source.ts');
    const persisted = await getPlanItemRow(planSlug, { workspaceId: workspace, harnessSlug: workspace });
    assert(persisted?.items.some(item => item.id === planItem),
      'Controlled plan anchor must survive persisted index readback: ' + JSON.stringify({
        workspace, planSlug, planItem, added, persisted,
      }));
  }
  const created = await call('work_items:create', { harness: workspace, kind: 'change',
    title: claimOnly ? 'Controlled CLI P010 claim composition' : 'Private native P010 completion consequences',
    assign_to: 'self', state: 'wip',
    changeKinds: ['logic'], changeKindReason: 'Private source fixture validated through an actual complete test population.',
    ...(claimOnly ? { plan_item: { slug: planSlug, item: planItem! } } : {}),
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
  const edited = '// touched clone sibling in this private task\n' + before + (claimOnly ? '' : aggregate('plantedCopy'));
  let controlledSession: { id: number; session: string; editedAt: string } | undefined;
  if (claimOnly) {
    const { recordAdvSession } = await import('../../adv-sessions.ts');
    const session = `controlled-cli-${randomUUID()}`;
    const sessionRow = await recordAdvSession({ workspaceId: workspace, planSlug, mode: 'console',
      label: 'Controlled P010 CLI fixture; no model invoked', cwd: root, coordOwnerId: owner, sessionId: session });
    assert(sessionRow, 'Maintained controlled CLI session writer must persist its actual start');
    // The CLI shell performs the real write. Its subsequent Write report names
    // that exact operation/session; no direct session-less Edit is fabricated.
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const script = 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])';
    const written = await call('capability:bash', { cwd: root, work_item_id: id,
      command: [process.execPath, '-e', script, join(root, 'src/target.ts'), edited].map(quote).join(' '),
      timeout: 10_000 });
    assert.equal(written.exit_code, 0, JSON.stringify(written));
    assert.equal(await readFile(join(root, 'src/target.ts'), 'utf8'), edited);
    const editedAt = new Date().toISOString();
    await call('activity:report', { owner, session_id: session, adv_session_id: sessionRow,
      harness_slug: workspace, kind: 'tool', tool_name: 'Write', phase: 'post', status: 'ok', cwd: root,
      tool_use_id: `controlled-write-${randomUUID()}`, summary: 'Actual controlled CLI fixture write; no model invocation',
      tool_input: { file_path: join(root, 'src/target.ts'), content: edited } });
    controlledSession = { id: sessionRow, session, editedAt };
  } else {
    await call('capability:edit', { file_path: join(root, 'src/target.ts'), old_string: before, new_string: edited });
  }
  // with-test-pg preserves the parent's durable evidence destination on purpose.
  // This nested run instead feeds the private operator's completion reader.
  Object.assign(process.env, privateReuseTestEnvironment(process.env, workspace, root));
  delete process.env.PAPERCUSP_TEST_RUN_COMMIT;
  delete process.env.PAPERCUSP_TEST_RUN_CASE_TITLE_PATTERN;
  delete process.env.PC_TEST_FILE_COVERAGE_SCOPE;
  const { resolveTestRunsPgUrl, resolveTestRunWorkspaceId } = await import('@papercusp/test-config/admin-test-runs-reporter');
  assert.equal(resolveTestRunsPgUrl(), process.env.HARNESS_ADMIN_DATABASE_URL);
  assert.equal(resolveTestRunWorkspaceId(), workspace);
  const run = await call('testing:run', { harness: workspace, work_item_id: id, files: ['src/target.test.ts'],
    timeoutMs: 30_000 });
  console.log('NATIVE_REUSE_TEST_RUN=' + JSON.stringify(run));
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.passed, 1, JSON.stringify(run));
  assert.equal(run.failed, 0, JSON.stringify(run));
  assert.equal(run.skipped, 0, JSON.stringify(run));
  assert.equal(run.testRunIds?.length, 1, JSON.stringify(run));
  assert.equal(typeof run.runId, 'string', JSON.stringify(run));
  // Preserve the real telemetry clock and ledger receipt outside PG teardown.
  // invoked_at is the dispatch-settle time, not when testing:run began.
  const bindingRows = await getOrgPg().sql<{ invoked_at: Date; duration_ms: number | null }[]>`
    SELECT invoked_at, duration_ms FROM harness_shared.tool_invocations
    WHERE workspace_id = ${workspace} AND coord_owner_id = ${owner}
      AND tool_name = 'testing:run' AND args_json->>'work_item_id' = ${id}
    ORDER BY invoked_at DESC LIMIT 1`;
  const testRows = await getOrgPg().sql<{ file_path: string; finished_at: Date; run_group_id: string }[]>`
    SELECT file_path, finished_at, run_group_id FROM harness_shared.test_runs
    WHERE run_group_id = ${run.runId} AND file_path = 'src/target.test.ts'`;
  console.log('NATIVE_REUSE_BINDING_DIAGNOSTIC=' + JSON.stringify({ workspace, workItem: id,
    runGroupId: run.runId, testRunIds: run.testRunIds, invocations: bindingRows, tests: testRows }));
  assert.equal(bindingRows.length, 1, 'Actual attributed testing:run must be durably recorded before completion');
  assert.equal(testRows.length, 1, 'Actual test-file receipt must be retained for the same run group');
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
  if (!coverage) {
    // Keep the actual writer scope/run in the primary error: private teardown
    // and bounded child tails must not erase why the completion preflight failed.
    const stored = await getOrgPg().sql`SELECT workspace_id, harness_slug, root_path, run_group_id,
      test_file, jsonb_array_length(snapshot->'sources') AS source_count
      FROM harness_shared.test_coverage_maps WHERE root_path = ${root} LIMIT 5`;
    assert.fail('Actual attributed run must have source-bound per-file coverage: ' + JSON.stringify({
      expected: { workspace, harness: workspace, root, runGroup: run.runId }, stored,
      run: { ok: run.ok, passed: run.passed, failed: run.failed, skipped: run.skipped, testRunIds: run.testRunIds },
    }));
  }
  if (claimOnly) {
    const { getClaimTimeTaskBrief } = await import('../task-brief.ts');
    const itemRead = await call('work_items:get', { id, harness: workspace, payloadTier: 'full',
      projection: { pick: ['results[].workItem'] } });
    const item = itemRead.results?.[0]?.workItem;
    assert(item && item.sourcePlanSlug === planSlug, JSON.stringify(itemRead));
    // Match the complete production claim reader, including engineering evidence
    // and compaction. Omitting reuse identity keeps only the mandatory baseline.
    const baselineRead = await getClaimTimeTaskBrief({ workItem: item, workspaceId: workspace, harness: workspace });
    assert(baselineRead, 'Controlled anchored claim must produce its mandatory baseline');
    const base = baselineRead.taskBrief;
    assert.equal(base.status, 'current', JSON.stringify(base));
    const response = await call('work_items:claim', { row: `${id},self,${workspace}`, payloadTier: 'full',
      projection: { pick: ['results[].ok', 'results[].taskBrief'] } });
    const brief = response.results?.[0]?.taskBrief;
    assert(brief && brief.status === 'current', JSON.stringify(response));
    assert.deepEqual({ ...brief, graph: { ...brief.graph,
      relationships: brief.graph.relationships.slice(0, base.graph.relationships.length) } }, base);
    const contributions = brief.graph.relationships.flatMap((line: string) => {
      try { const row = JSON.parse(line); return row.provider ? [row] : []; } catch { return []; }
    });
    const { REUSE_PROVIDER_POLICY, briefCodePoints } = await import('../reuse-brief-providers.ts');
    const expected = ['clones', 'cochange', 'provenance', 'sql', 'coverage'];
    assert.deepEqual(contributions.map((row: { provider: string }) => row.provider), expected, JSON.stringify(response));
    for (const row of contributions) {
      const policy = REUSE_PROVIDER_POLICY[row.provider as keyof typeof REUSE_PROVIDER_POLICY];
      assert(briefCodePoints(row.text) <= policy.cap && row.sourceVersion === brief.sourceFingerprint && row.indexVersion);
    }
    assert(briefCodePoints(JSON.stringify(brief)) <= 3_000, JSON.stringify(brief));
    const issued = await getOrgPg().sql<{ subject: string; chars: number }[]>`SELECT subject, chars
      FROM harness_shared.code_intel_pushes WHERE workspace_id = ${workspace} AND owner_id = ${owner}
        AND subject::jsonb->>'workItem' = ${id} AND subject::jsonb->>'surface' = 'claim'`;
    const finalInvocation = issued.map(row => JSON.parse(row.subject)).find(row => row.provider === 'provenance')?.invocation;
    const finalIssued = issued.filter(row => JSON.parse(row.subject).invocation === finalInvocation);
    assert(finalInvocation, JSON.stringify(issued));
    assert.deepEqual(finalIssued.map(row => JSON.parse(row.subject).provider).sort(), [...expected].sort());
    assert(finalIssued.every(row => JSON.parse(row.subject).sourceVersion === brief.sourceFingerprint
      && JSON.parse(row.subject).indexVersion && row.chars > 0));
    console.log('NATIVE_REUSE_CLAIM_API_PROOF=' + JSON.stringify({ workspace, fixtureWorkItem: id,
      planSlug, baseline, handlerHash, sourceFingerprint: brief.sourceFingerprint, controlledSession,
      transport: 'real-cli-http', expectedProviders: expected, response, base, issued: finalIssued,
      testRunIds: run.testRunIds, runGroupId: run.runId,
      scope: 'controlled private current-source CLI fixture; no model invocation, live user census or final shipment' }));
    return;
  }
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
  console.log('NATIVE_REUSE_COMPLETION_DIAGNOSTIC=' + JSON.stringify({ completionSignals,
    tests: receipt.completionBrief.tests, limitations: receipt.completionBrief.limitations }));
  assert(Object.values(completionSignals).every(Boolean), JSON.stringify({ completionSignals,
    tests: receipt.completionBrief.tests, limitations: receipt.completionBrief.limitations }));
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
