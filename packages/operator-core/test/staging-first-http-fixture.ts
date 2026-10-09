/** Private current-build request fixture; launched only by its integration suite. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { loadHarnessRegistry, saveHarnessRegistry } from '../lib/harness-registry';
import { readProcessIdentity } from '../lib/process-identity';

let host: ChildProcess | undefined;
let hostIdentity: ReturnType<typeof readProcessIdentity>;
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
  const harness = `${workspace}-guard`;
  const registry = await loadHarnessRegistry(workspace, { fresh: true });
  const home = registry.projects.find(project => project.slug === workspace);
  assert.ok(home, 'private operator home must exist');
  await saveHarnessRegistry({ ...registry, projects: [...registry.projects,
    { slug: harness, path: home.path, hive_slug: workspace }] }, workspace);
  const sourcePath = 'packages/operator-core/lib/agent-tools/plans/staging-first-activation-guard.ts';
  const sourceSha256 = createHash('sha256').update(readFileSync(join(root, sourcePath))).digest('hex');
  const bundle = join(evidenceDir, 'hono-host.mjs');
  console.log('STAGING_FIRST_HTTP_PHASE bundle-start');
  try {
    const output = execFileSync('bash', [join(root, 'apps/operator/bin/bundle-host.sh'), 'bin/hono-host.ts', bundle],
      { cwd: root, env: e, encoding: 'utf8', timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
    writeFileSync(join(evidenceDir, 'build.log'), output);
  } catch (error: any) {
    writeFileSync(join(evidenceDir, 'build.log'), String(error.stdout ?? '') + String(error.stderr ?? ''));
    throw error;
  }
  const bundleBytes = readFileSync(bundle);
  assert.ok(bundleBytes.includes(Buffer.from('staging-first-activation-guard.ts')), 'guard must be in the executed bundle');
  const bundleSha256 = createHash('sha256').update(bundleBytes).digest('hex');
  host = spawn(process.execPath, [bundle], { cwd: root, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout!.on('data', chunk => process.stdout.write(chunk));
  host.stderr!.on('data', chunk => process.stderr.write(chunk));
  hostIdentity = readProcessIdentity(host.pid!);
  assert.ok(hostIdentity, 'private host kernel identity required');
  let health: any;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    assert.equal(host.exitCode, null, 'private host exited before readiness');
    assert.equal(host.signalCode, null, 'private host was signaled before readiness');
    try {
      const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(2_000) });
      if (response.ok) { health = await response.json(); break; }
    } catch { /* bounded readiness convergence; request assertions never retry */ }
    await new Promise(done => setTimeout(done, 250));
  }
  assert.equal(health?.service, 'papercusp-operator', 'private operator never became ready');
  console.log('STAGING_FIRST_HTTP_PHASE request-ready');
  const requests: Array<Record<string, unknown>> = [];
  const preparation = ['Finalize', 'Define', 'Specify', 'Select', 'Choose', 'Design'];
  const releasePlanes = ['main promotion', 'the deployed host', 'green-checkpoint'];
  for (const [index, action] of [...preparation, ...releasePlanes].entries()) {
    const release = index >= preparation.length;
    const slug = `private-guard-${index}`;
    const content = '## Items\n\n'
      + `- **P-003** \`todo\` ${release ? 'Finalize' : action} the pilot scope, threat/deployment/data contract, and implementation estimates.${release ? ` Then verify ${action}.` : ''}\n`
      + '- **P-007** `todo` Implement the data-governance contract on current-build. blocked-by: P-003\n'
      + '- **P-011** `todo` Deliver the selected connector and exercise separate write authorization on current-build. blocked-by: P-003, P-007\n';
    const created = await fetch(base + '/api/admin/plans/new', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ harness, slug, title: 'Private staging-first request fixture', status: 'draft', content }),
      signal: AbortSignal.timeout(30_000) });
    const creation = await created.json() as any;
    assert.equal(created.status, 200, JSON.stringify(creation));
    assert.equal(creation.ok, true, JSON.stringify(creation));
    // A deliberately invalid source ref is a downstream control: preparation
    // must reach source validation, while actual release waits fail earlier.
    // This does not manufacture a valid owner conversation or activation.
    const args = { harness, slug, phase: 'activation', dryRun: true,
      classRef: 'plan-class-feature-ship',
      sourceRanges: [{ sourceKind: 'codex', sessionId: 'private-guard-source', fromTurn: 1, toTurn: 1 }],
      mappings: [{ id: 'M-001', sourceRefs: ['private-fixture-invalid-source'],
        requirement: 'Private guard control', planTargets: ['P-003'], disposition: 'covered' }] };
    const response = await fetch(base + '/api/agent-mcp/run-tool', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
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
  const { sql } = getOrgPg();
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
  console.error('STAGING_FIRST_HTTP_FAILURE', error);
  process.exitCode = 1;
} finally {
  await stopHost();
  await getOrgPg().sql.end({ timeout: 1 });
}
