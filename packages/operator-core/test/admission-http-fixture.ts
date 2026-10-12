/** Private request/response acceptance for the immutable gitlink inventory guard. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { readProcessIdentity } from '../lib/process-identity';
import { preparePrivateHttpWorkspaces, preparePrivateOperatorApiBundle } from './private-http-workspace-preflight';

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
  assert.notEqual(readProcessIdentity(host.pid!), hostIdentity, 'private admission host survived cleanup');
}

async function main() {
  const e = process.env;
  const { workspace } = preparePrivateHttpWorkspaces();
  const base = e.PAPERCUSP_OPERATOR_URL!;
  assert.equal(e.PAPERCUSP_POT_HOME_SLUG, workspace);
  assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(e.PAPERCUSP_DBOS_ENABLE, '0');
  assert.notEqual(e.PAPERCUSP_PG_PORT, '5432');
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(![3070, 3170, 3271].includes(Number(new URL(base).port)));
  const root = resolve(import.meta.dirname, '../../..');
  const evidenceDir = e.ADMISSION_HTTP_EVIDENCE_DIR!;
  assert.ok(evidenceDir, 'retained evidence directory required');
  const sources = ['packages/operator-core/lib/agent-tools/release/repair-queue.ts',
    'packages/operator-core/lib/release/admission-jobs.ts',
    'packages/operator-core/lib/release/admission-offthread.ts',
    'packages/operator-core/lib/release/admission-jobs.worker.ts',
    'packages/operator-core/lib/release/admission-fix-precheck.ts',
    'packages/operator-core/lib/release/admission-import-completeness.ts',
    'scripts/lib/related-tests.mjs'];
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const fingerprint = () => Object.fromEntries(sources.map(path => [path, digest(join(root, path))]));
  const sourceBefore = fingerprint();

  // Repositories and commits below are disposable fixture data in the supervisor's
  // private TMPDIR. The shared source checkout and its Git index are never written.
  const fixture = mkdtempSync(join(e.TMPDIR!, 'admission-http-'));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const init = (cwd: string) => {
    git(cwd, 'init', '-q', '-b', 'staging');
    git(cwd, 'config', 'user.email', 'test@example.invalid');
    git(cwd, 'config', 'user.name', 'Private admission fixture');
  };
  init(fixture);
  const child = join(fixture, 'component');
  mkdirSync(child);
  init(child);
  writeFileSync(join(child, 'api.mjs'), 'export const value = 1;\n');
  writeFileSync(join(child, 'native.test.rs'), '#[test] fn paired_native_test() { assert!(true); }\n');
  git(child, 'add', '.');
  git(child, 'commit', '-q', '-m', 'initial private component');
  const oldPin = git(child, 'rev-parse', 'HEAD');
  writeFileSync(join(fixture, 'parent.test.mjs'), "import './component/api.mjs';\n");
  git(fixture, 'add', 'parent.test.mjs');
  git(fixture, 'update-index', '--add', '--cacheinfo', `160000,${oldPin},component`);
  git(fixture, 'commit', '-q', '-m', 'private frozen candidate');
  const candidate = git(fixture, 'rev-parse', 'HEAD');
  const lineageRef = 'refs/papercusp/frozen/' + candidate;
  git(fixture, 'update-ref', lineageRef, candidate);
  writeFileSync(join(child, 'api.mjs'), 'export const value = 2;\n');
  git(child, 'add', 'api.mjs');
  git(child, 'commit', '-q', '-m', 'private gitlink update');
  git(fixture, 'update-index', '--cacheinfo', `160000,${git(child, 'rev-parse', 'HEAD')},component`);
  git(fixture, 'commit', '-q', '-m', 'private integration source');
  const sourceCommit = git(fixture, 'rev-parse', 'HEAD');
  const queue = { schemaVersion: 4, phase: 'ready-to-verify', candidate, base: candidate, repairHead: candidate,
    worktreePath: fixture, attempts: 1, openedAtMs: Date.now(), updatedAtMs: Date.now(), fixerSpawnId: null,
    failingTests: ['component::test'], signature: [{ kind: 'workspace-task', id: 'component::test',
      recipe: 'native component test', admittedRound: 1, measuredHead: candidate }], admissions: [] };
  const { sql } = getOrgPg();
  // Only initial private fixture data is seeded directly. The tested operation
  // itself crosses the real HTTP dispatcher and admission worker.
  await sql`INSERT INTO harness_shared.routines
    (id, install_slug, name, trigger_kind, trigger_config, target_role, active, metadata, workspace_id)
    VALUES ('private-admission-gate', ${workspace}, 'Private admission gate', 'interval', '{}'::jsonb,
      'system:green-checkpoint', false, ${JSON.stringify({ repair_queue: queue })}::jsonb, ${workspace})`;
  const readQueue = async () => {
    const rows = await sql`SELECT metadata->'repair_queue' AS queue FROM harness_shared.routines
      WHERE workspace_id = ${workspace} AND id = 'private-admission-gate'`;
    assert.equal(rows.length, 1);
    return rows[0].queue;
  };
  const before = await readQueue();
  console.log('ADMISSION_HTTP_PHASE bundle-start');
  const prepared = preparePrivateOperatorApiBundle(root, evidenceDir);
  const worker = join(evidenceDir, 'admission-jobs.worker.mjs');
  try {
    const output = execFileSync('bash', [join(root, 'apps/operator/bin/bundle-host.sh'),
      '../../packages/operator-core/lib/release/admission-jobs.worker.ts', worker],
    { cwd: root, env: e, encoding: 'utf8', timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
    writeFileSync(join(evidenceDir, 'admission-worker-build.log'), output);
  } catch (error) {
    const failure = error as { stdout?: unknown; stderr?: unknown };
    writeFileSync(join(evidenceDir, 'admission-worker-build.log'), String(failure.stdout ?? '') + String(failure.stderr ?? ''));
    throw error;
  }
  const bundleBytes = readFileSync(prepared.path);
  assert.ok(bundleBytes.includes(Buffer.from('precheck-population')), 'inventory dispatch missing from host bundle');
  assert.ok(readFileSync(worker).includes(Buffer.from('no discoverable test files')),
    'inventory guard missing from admission worker bundle');
  assert.deepEqual(fingerprint(), sourceBefore, 'source moved during preparation');
  host = spawn(process.execPath, [prepared.path], { cwd: root,
    env: { ...e, PAPERCUSP_INTEGRATION_ROOT: fixture, PAPERCUSP_INTEGRATION_BRANCH: 'staging' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout!.on('data', chunk => process.stdout.write(chunk));
  host.stderr!.on('data', chunk => process.stderr.write(chunk));
  hostIdentity = readProcessIdentity(host.pid!);
  assert.ok(hostIdentity, 'private host kernel identity required');
  const headers = { 'content-type': 'application/json', origin: base, 'x-papercusp-workspace': workspace };
  let health: { service?: string } | undefined;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    assert.equal(host.exitCode, null, 'private host exited before readiness');
    assert.equal(host.signalCode, null, 'private host was signaled before readiness');
    try {
      const response = await fetch(base + '/api/health', { headers, signal: AbortSignal.timeout(2_000) });
      if (response.ok) { health = await response.json(); break; }
    } catch { /* Only bounded readiness convergence retries. */ }
    await new Promise(done => setTimeout(done, 250));
  }
  assert.equal(health?.service, 'papercusp-operator', 'private operator never became ready');
  console.log('ADMISSION_HTTP_PHASE request-ready');
  const args = { op: 'admit', paths: ['component'], wholeBlob: true, sourceCommit, confirm: true,
    reason: 'Private current-build immutable gitlink inventory acceptance',
    expectedCandidate: candidate, expectedRepairHead: candidate, expectedUpdatedAtMs: queue.updatedAtMs };
  const request = await fetch(base + '/api/agent-mcp/run-tool', { method: 'POST', headers,
    body: JSON.stringify({ name: 'release:repair-queue', args, harness: workspace,
      callerSid: 'private-admission-http-fixture', confirmed: true }), signal: AbortSignal.timeout(120_000) });
  const envelope = await request.json() as any;
  writeFileSync(join(evidenceDir, 'admission-request.json'), JSON.stringify({ args, status: request.status, envelope }));
  assert.equal(request.status, 200, JSON.stringify(envelope));
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.notEqual(envelope.result?.isError, true, JSON.stringify(envelope));
  const serialized = envelope.result?.content?.find((item: { type: string; text?: string }) =>
    item.type === 'text' && item.text?.trim().startsWith('{'));
  const response = envelope.result?.structuredContent ?? (serialized ? JSON.parse(serialized.text) : envelope.result?.data ?? envelope.result);
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal(response.admitted, false, JSON.stringify(response));
  assert.equal(response.reason, 'admission-precheck-unavailable', JSON.stringify(response));
  assert.match(response.detail, /no discoverable test files/);
  assert.match(response.builtCommit, /^[a-f0-9]{40}$/);
  assert.deepEqual(await readQueue(), before, 'refused inventory changed the private queue');
  assert.equal(git(fixture, 'rev-parse', lineageRef), candidate, 'refused inventory published the private lineage');
  assert.deepEqual(fingerprint(), sourceBefore, 'source changed during acceptance');
  await stopHost();
  console.log('ADMISSION_HTTP_RECEIPT ' + JSON.stringify({ workspace, hostStopped: true, health, response,
    queueUnchanged: true, lineageUnchanged: true, sourceUnchanged: true, sourceBefore,
    bundleSha256: digest(prepared.path), workerSha256: digest(worker) }));
}

try { await main(); }
catch (error) {
  const assertion = error as { message?: string; stack?: string; actual?: unknown; expected?: unknown };
  console.error('ADMISSION_HTTP_FAILURE ' + JSON.stringify({ message: assertion.message ?? String(error),
    stack: assertion.stack, actual: assertion.actual, expected: assertion.expected }));
  process.exitCode = 1;
} finally {
  await stopHost();
  await getOrgPg().sql.end({ timeout: 1 });
}
