/** Private current-build request fixture; launched only by its integration suite. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { loadHarnessRegistry, saveHarnessRegistry } from '../lib/harness-registry';
import { readProcessIdentity } from '../lib/process-identity';
import { resolvePlanScope } from '../lib/agent-tools/plans/source';
import { buildPrivateOperatorApiBundle, privateBundleRuntimeEnv, waitForPrivateOperator, qualifyCommittedReaderSource, resolvePreparedCommittedReaderSource, resolvePreparedPrivateApiBundle } from './private-http-workspace-preflight';

let host: ChildProcess | undefined;
let hostIdentity: ReturnType<typeof readProcessIdentity>;
let disposeScenario: (() => Promise<void>) | undefined;
async function stopHost() {
  if (!host) return;
  if (host.exitCode === null && host.signalCode === null) {
    const closed = new Promise<void>(done => host!.once('close', () => done()));
    host.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([closed, new Promise<void>(done => { timer = setTimeout(done, 5_000); })]);
    clearTimeout(timer);
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
    await closed;
  }
  assert.notEqual(readProcessIdentity(host.pid!), hostIdentity, 'private host survived cleanup');
}

async function main() {
  const e = process.env;
  const workspace = e.PAPERCUSP_WORKSPACE_ID!;
  const base = e.PAPERCUSP_OPERATOR_URL!;
  assert.match(workspace, /^test-runtime-/);
  assert.equal(e.PAPERCUSP_POT_HOME_SLUG, workspace);
  assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(e.PAPERCUSP_DBOS_ENABLE, '0');
  assert.equal(e.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
  assert.notEqual(e.PAPERCUSP_PG_PORT, '5432');
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(![3070, 3170, 3271].includes(Number(new URL(base).port)));
  const root = resolve(import.meta.dirname, '../../..');
  const evidenceDir = e.STAGING_FIRST_HTTP_EVIDENCE_DIR!;
  assert.ok(evidenceDir, 'retained evidence directory required');
  if (e.STAGING_FIRST_HTTP_SCENARIO === 'report-journal') e.PAPERCUSP_FLAG_PAPERCUSP_REPORTS_LIBRARY = '1';
  const harness = `${workspace}-guard`;
  const registry = await loadHarnessRegistry(workspace, { fresh: true });
  const home = registry.projects.find(project => project.slug === workspace);
  assert.ok(home, 'private operator home must exist');
  await saveHarnessRegistry({ ...registry, projects: [...registry.projects,
    { slug: harness, path: home.path, hive_slug: workspace }] }, workspace);
  const scope = await resolvePlanScope({ harnessSlug: harness, workspaceId: workspace });
  assert.deepEqual(scope, { workspaceId: workspace, harnessSlug: workspace });
  const headers = { 'content-type': 'application/json', origin: base, 'x-papercusp-workspace': workspace };
  const { sql } = getOrgPg();
  if (e.STAGING_FIRST_HTTP_SCENARIO === 'current-su-native-setup') {
    await (await import('./current-su-native-http-scenario')).prepareCurrentSuNativeScenario(workspace);
    console.log('CURRENT_SU_NATIVE_SETUP_RECEIPT ' + JSON.stringify({ workspace,
      accountId: 'private-current-su', provider: 'codex', providerForwarding: false,
      launcherPath: process.env.PAPERCUSP_PSU_LAUNCHER ?? null }));
    return;
  }
  if (['committed-reader-setup', 'committed-reader-setup-exception'].includes(e.STAGING_FIRST_HTTP_SCENARIO ?? '')) {
    const receipt = await (await import('./committed-reader-http-scenario')).measureCommittedReaderSetup({
      workspace, harness, evidenceDir,
    });
    console.log('COMMITTED_READER_SETUP_RECEIPT ' + JSON.stringify(receipt));
    if (e.STAGING_FIRST_HTTP_SCENARIO === 'committed-reader-setup-exception')
      throw new Error('private preparation exception control');
    return;
  }
  const sourcePath = 'packages/operator-core/lib/agent-tools/plans/staging-first-activation-guard.ts';
  const sourceSha256 = createHash('sha256').update(readFileSync(join(root, sourcePath))).digest('hex');
  const isCommittedReader = e.STAGING_FIRST_HTTP_SCENARIO === 'committed-reader';
  const isBlueprintRoute = e.STAGING_FIRST_HTTP_SCENARIO === 'blueprint-account-route';
  const prepared = isCommittedReader || isBlueprintRoute
    ? resolvePreparedPrivateApiBundle(process.argv.slice(2), evidenceDir) : undefined;
  assert.ok(!(isCommittedReader || isBlueprintRoute) || prepared,
    'Selected request scenario requires its prepared pinned API');
  const bundle = prepared ?? join(evidenceDir, 'hono-host.mjs');
  if (!prepared) {
    console.log('STAGING_FIRST_HTTP_PHASE bundle-start');
    try {
      buildPrivateOperatorApiBundle(root, evidenceDir);
    } finally {
      writeFileSync(join(evidenceDir, 'build.log'), readFileSync(join(evidenceDir, 'operator-api-build.log')));
    }
  }
  const bundleBytes = readFileSync(bundle);
  assert.ok(bundleBytes.includes(Buffer.from('staging-first-activation-guard.ts')), 'guard must be in the executed bundle');
  if (isCommittedReader) assert.ok(bundleBytes.includes(Buffer.from('committed-tree-reader.ts')),
    'committed reader must be in the executed bundle');
  const bundleSha256 = createHash('sha256').update(bundleBytes).digest('hex');
  let qualifySource: (() => ReturnType<typeof qualifyCommittedReaderSource>) | undefined;
  if (isCommittedReader) {
    const selection = resolvePreparedCommittedReaderSource(process.argv.slice(2), evidenceDir);
    // Compare the actual required private column/type/nullability/default
    // catalogue, rather than inferring applied schema from migration filenames.
    const columns = await sql`SELECT table_schema, table_name, column_name, data_type, udt_name,
      is_nullable, column_default, ordinal_position FROM information_schema.columns
      WHERE table_schema = 'harness_shared' ORDER BY table_name, ordinal_position`;
    const schema = Object.fromEntries(columns.map(row => [
      `${row.table_schema}.${row.table_name}.${row.column_name}`,
      createHash('sha256').update(JSON.stringify({ ...row })).digest('hex'),
    ]));
    qualifySource = () => qualifyCommittedReaderSource({ root, bundle,
      receiptPath: join(dirname(evidenceDir), 'prepare', 'operator-api-preflight.json'),
      ...selection, schema, environment: e });
    writeFileSync(join(evidenceDir, 'committed-reader-source-preflight.json'), JSON.stringify(qualifySource()));
  }
  // The required source guard runs before preparation opens its private sidecar.
  const committedReader = isCommittedReader
    ? await (await import('./committed-reader-http-scenario')).prepareCommittedReaderScenario({
      workspace, harness, base, headers, evidenceDir,
    }) : undefined;
  const blueprintRoute = e.STAGING_FIRST_HTTP_SCENARIO === 'blueprint-account-route'
    ? await (await import('./blueprint-account-route-http-scenario')).prepareBlueprintAccountRouteScenario({ workspace, evidenceDir })
    : undefined;
  disposeScenario = blueprintRoute?.dispose ?? committedReader?.dispose;
  if (e.STAGING_FIRST_HTTP_SCENARIO === 'current-su-native')
    await (await import('./current-su-native-http-scenario')).prepareCurrentSuNativeScenario(workspace);
  // Preparation changes socket/tmp settings; compare the final host environment
  // again. A refused pin still follows the same finally/dispose path.
  if (qualifySource) qualifySource();
  // The real native request fixture grants writes only to its disposable state.
  // Apply the mount boundary to the whole operator/invoke/native lineage.
  const privateRoot = dirname(e.HOME!);
  const hostEnv = privateBundleRuntimeEnv(e);
  // Use the maintained installed shim's explicit launcher override; its
  // default release checkout cannot certify this current-build candidate.
  hostEnv.PAPERCUSP_PSU_LAUNCHER = join(root, 'apps/operator/scripts/psu-launcher.mjs');
  host = blueprintRoute
    ? spawn('bwrap', ['--die-with-parent', '--ro-bind', '/', '/', '--bind', privateRoot, privateRoot,
      '--bind', evidenceDir, evidenceDir, '--dev', '/dev', '--proc', '/proc', '--', process.execPath, bundle],
    { cwd: root, env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, [bundle], { cwd: root, env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout!.on('data', chunk => process.stdout.write(chunk));
  host.stderr!.on('data', chunk => process.stderr.write(chunk));
  hostIdentity = readProcessIdentity(host.pid!);
  assert.ok(hostIdentity, 'private host kernel identity required');
  const health = await waitForPrivateOperator({ host, base, headers, evidenceDir, hostIdentity, environment: hostEnv });
  console.log('STAGING_FIRST_HTTP_PHASE request-ready');
  if (blueprintRoute) {
    const receipt = await blueprintRoute.execute(stopHost);
    await stopHost();
    await blueprintRoute.dispose();
    disposeScenario = undefined;
    await sql.end();
    const finalReceipt = { ...receipt, hostStopped: true, hostPid: host.pid, bundleSha256, sourceSha256, health };
    writeFileSync(join(evidenceDir, 'account-route.json'), JSON.stringify(finalReceipt));
    console.log('BLUEPRINT_ACCOUNT_ROUTE_RECEIPT ' + JSON.stringify(finalReceipt));
    return;
  }
  if (e.STAGING_FIRST_HTTP_SCENARIO === 'current-su-native') {
    const receipt = await (await import('./current-su-native-http-scenario')).measureCurrentSuNativeScenario({
      workspace, base, evidenceDir,
    });
    await stopHost();
    await sql.end();
    console.log('CURRENT_SU_NATIVE_RECEIPT ' + JSON.stringify({ ...receipt, hostStopped: true, bundleSha256, health }));
    return;
  }
  if (e.STAGING_FIRST_HTTP_SCENARIO === 'compaction-warm') {
    const receipt = await (await import('./compaction-warm-http-scenario')).measureCompactionWarmScenario({
      workspace, harness, base, headers, evidenceDir,
    });
    await stopHost();
    await sql.end();
    console.log('COMPACTION_WARM_HTTP_RECEIPT ' + JSON.stringify({ ...receipt, hostPid: host.pid,
      hostStopped: true, bundleSha256, health }));
    return;
  }
  if (e.STAGING_FIRST_HTTP_SCENARIO === 'report-journal') {
    const receipt = await (await import('./report-journal-http-scenario')).measureReportJournalScenario({
      workspace, harness, base, headers, evidenceDir,
    });
    await stopHost();
    await sql.end();
    console.log('REPORT_JOURNAL_HTTP_RECEIPT ' + JSON.stringify({ ...receipt, hostPid: host.pid,
      hostStopped: true, bundleSha256, health }));
    return;
  }
  if (committedReader) {
    const readerReceipt = await committedReader.execute(host.pid!);
    await stopHost();
    await committedReader.dispose();
    disposeScenario = undefined;
    await sql.end();
    console.log('COMMITTED_READER_HTTP_RECEIPT ' + JSON.stringify({ workspace, hostPid: host.pid,
      hostStopped: true, sourceSha256, bundleSha256, health, ...readerReceipt }));
    return;
  }
  const requests: Array<Record<string, unknown>> = [];
  const preparation = ['Finalize', 'Define', 'Specify', 'Select', 'Choose', 'Design'];
  const releasePlanes = ['main promotion', 'the deployed host', 'green-checkpoint'];
  for (const [index, action] of [...preparation, ...releasePlanes].entries()) {
    const release = index >= preparation.length;
    const requestedSlug = `private-guard-${index}`;
    const content = '## Items\n\n'
      + `- **P-003** \`todo\` ${release ? 'Finalize' : action} the pilot scope, threat/deployment/data contract, and implementation estimates.${release ? ` Then verify ${action}.` : ''}\n`
      + '- **P-007** `todo` Implement the data-governance contract on current-build. blocked-by: P-003\n'
      + '- **P-011** `todo` Deliver the selected connector and exercise separate write authorization on current-build. blocked-by: P-003, P-007\n';
    const created = await fetch(base + '/api/admin/plans/new', { method: 'POST',
      headers,
      // Each case is a distinct private subject with intentionally shared topic
      // tokens. Acknowledge that fixture duplication through the supported API.
      body: JSON.stringify({ harness, workspaceId: workspace, slug: requestedSlug, title: 'Private staging-first request fixture', status: 'draft', content, force: true }),
      signal: AbortSignal.timeout(30_000) });
    const creation = await created.json() as any;
    assert.equal(created.status, 200, JSON.stringify(creation));
    assert.equal(creation.ok, true, JSON.stringify(creation));
    const slug = creation.slug;
    assert.equal(typeof slug, 'string', 'plans:new must return its canonical dated slug');
    const stored = await sql`SELECT workspace_id, harness_slug FROM harness_shared.harness_plans WHERE plan_slug = ${slug}`;
    assert.deepEqual(stored.map(row => ({ ...row })), [{ workspace_id: scope.workspaceId, harness_slug: scope.harnessSlug }]);
    const readback = await fetch(`${base}/api/admin/plans/get?harness=${harness}&slug=${slug}`,
      { headers, signal: AbortSignal.timeout(30_000) });
    const plan = await readback.json() as any;
    assert.equal(readback.status, 200, JSON.stringify(plan));
    assert.equal(plan.ok, true, JSON.stringify(plan));
    const preparationItem = plan.items?.find((item: any) => item.id === 'P-003');
    assert.ok(preparationItem?.text?.includes('threat/deployment/data contract'),
      JSON.stringify({ slug: plan.slug, preparationItem }));
    // A deliberately invalid source ref is a downstream control: preparation
    // must reach source validation, while actual release waits fail earlier.
    // This does not manufacture a valid owner conversation or activation.
    const args = { harness, slug, phase: 'activation', dryRun: true,
      classRef: 'plan-class-feature-ship',
      sourceRanges: [{ sourceKind: 'codex', sessionId: 'private-guard-source', fromTurn: 1, toTurn: 1 }],
      mappings: [{ id: 'M-001', sourceRefs: ['private-fixture-invalid-source'],
        requirement: 'Private guard control', planTargets: ['P-003'], disposition: 'covered' }] };
    const response = await fetch(base + '/api/agent-mcp/run-tool', { method: 'POST',
      headers,
      body: JSON.stringify({ name: 'plans:audit', args, harness }), signal: AbortSignal.timeout(30_000) });
    const envelope = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(envelope));
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    assert.notEqual(envelope.result?.isError, true, JSON.stringify(envelope));
    const serialized = envelope.result?.content?.find((item: any) => item.type === 'text' && item.text.trim().startsWith('{'));
    const result = envelope.result?.structuredContent ?? (serialized ? JSON.parse(serialized.text) : envelope.result?.data ?? envelope.result);
    writeFileSync(join(evidenceDir, `request-${index}.json`), JSON.stringify({ base, args, status: response.status, envelope }));
    if (release) {
      assert.equal(result.error, 'staging_first_guard_failed', JSON.stringify(result));
      assert.ok(result.problems.some((problem: any) => problem.itemId === 'P-007'
        && problem.code === 'non_final_deployed_main_wait'), JSON.stringify(result));
    } else {
      assert.equal(result.error, 'activation_audit_invalid', JSON.stringify(result));
      assert.ok(result.problems.some((problem: any) => problem.code === 'invalid_session_turn_ref'), JSON.stringify(result));
    }
    requests.push({ action, release, status: response.status, error: result.error,
      problemCodes: result.problems.map((problem: any) => problem.code) });
  }
  const rows = await sql`SELECT workspace_id FROM harness_shared.harness_plans WHERE plan_slug LIKE 'private-guard-%'`;
  assert.equal(rows.length, preparation.length + releasePlanes.length);
  assert.ok(rows.every(row => row.workspace_id === workspace), 'fixture plans escaped private workspace');
  await sql.end();
  await stopHost();
  console.log('STAGING_FIRST_HTTP_RECEIPT ' + JSON.stringify({ workspace, hostPid: host.pid,
    hostStopped: true, sourcePath, sourceSha256, bundleSha256, health, requests }));
}

try { await main(); }
catch (error) {
  const assertion = error as { message?: string; stack?: string; actual?: unknown; expected?: unknown };
  console.error('STAGING_FIRST_HTTP_FAILURE ' + JSON.stringify({ message: assertion.message ?? String(error),
    stack: assertion.stack, actual: assertion.actual, expected: assertion.expected }));
  process.exitCode = 1;
} finally {
  await stopHost();
  await disposeScenario?.();
  await getOrgPg().sql.end({ timeout: 1 });
}
