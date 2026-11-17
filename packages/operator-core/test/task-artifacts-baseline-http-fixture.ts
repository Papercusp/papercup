/** Runs only inside with-test-pg's private operator-api profile. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import postgres from 'postgres';
// eslint-disable-next-line import/no-relative-packages -- same raw SQL contract as the org client
import { restoreRawJsonbSerializer } from '../../../libs/papercusp/libs/db/src/raw-serializers';
import { connectAgentMcp } from '../lib/agent-mcp-client';
import { readProcessIdentity } from '../lib/process-identity';
import { superuserTokenPath } from '../lib/superuser-token';
import { appendNativeProofEvent, enterNativeProofChild, readNativeProofRun,
  type NativeProofChildHandoff, type NativeProofRun } from '../lib/testing-run-store';
import { assertBaselineRuntimeCustody, baselineClientEntryPaths,
  retainBaselineClientOriginals } from './task-artifacts-baseline-repair';
import type { NativeProofRecorder } from './isolated-integration-proof';
import { privateBundleRuntimeEnv, resolvePreparedPrivateApiBundle,
  stopPrivateOperatorHost, waitForPrivateOperator } from './private-http-workspace-preflight';

const sourceSha = '729986dd35171f1e0cb11bd1505295917f2d946f';
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Request = { id: string; method: string; order: number; argsSha256: string;
  entryPointSha256: string; handlerSource: { path: string; sha256: string };
  resultSha256?: string; failed?: boolean; retry: boolean; page: boolean; fallback: boolean;
  wireRequests: Array<{ id: string | number; method: string; argsSha256: string }> };
type Trace = { scenario: string; adapter: string; requests: Request[]; helperWakes: string[];
  outcomeSha256?: string; count?: number };
let host: ChildProcess | undefined;
let client: Awaited<ReturnType<typeof connectAgentMcp>>['client'] | undefined;
let proxy: Server | undefined;
let activeEntry: Request | undefined;
let productRuntimeEntered = false;

function decode(result: any): any {
  assert.notEqual(result?.isError, true, JSON.stringify(result));
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((part: any) => part.type === 'text' && part.text.trim().startsWith('{'));
  return text ? JSON.parse(text.text) : result?.data ?? result;
}

async function main(native: NativeProofRecorder, intent: NativeProofRun) {
  const env = process.env;
  const workspace = env.PAPERCUSP_WORKSPACE_ID!;
  const base = env.PAPERCUSP_OPERATOR_URL!;
  const evidenceDir = env.TASK_ARTIFACT_BASELINE_EVIDENCE_DIR!;
  const sourceRoot = process.argv.find(arg => arg.startsWith('--baseline-root='))?.slice('--baseline-root='.length);
  assert.ok(sourceRoot, 'original source clone required');
  assert.match(workspace, /^test-runtime-/);
  assert.equal(env.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(env.PAPERCUSP_DBOS_ENABLE, '0');
  assert.equal(env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
  assert.notEqual(env.PAPERCUSP_PG_PORT, '5432');
  assert.ok(![3070, 3170, 3271].includes(Number(new URL(base).port)));
  const preparedDir = join(evidenceDir, '../prepare');
  const bundle = resolvePreparedPrivateApiBundle(process.argv.slice(2), preparedDir);
  assert.ok(bundle);
  const bundleSha256 = digest(readFileSync(bundle));
  const source = JSON.parse(readFileSync(join(preparedDir, 'baseline-source.json'), 'utf8'));
  assert.equal(source.sourceSha, sourceSha);
  assert.equal(source.edition, 'source-frozen-dependency-repaired-v1');
  assert.equal(source.originalDependenciesReconstructed, false);
  const dependencyEdition = JSON.parse(readFileSync(join(preparedDir, 'dependency-edition-after-build.json'), 'utf8'));
  assert.equal(dependencyEdition.edition, source.edition);
  assert.equal(dependencyEdition.rebuiltBundleSha256, bundleSha256);
  assert.equal(digest(readFileSync(join(sourceRoot, 'package-lock.json'))), dependencyEdition.repairedLockSha256);
  for (const file of source.files) assert.equal(digest(readFileSync(join(sourceRoot, file.path))), file.sha256);
  const beforeCustody = await assertBaselineRuntimeCustody(sourceRoot, preparedDir, intent);
  const entryPoints = retainBaselineClientOriginals(evidenceDir, {
    'mcp-http': { root: resolve(import.meta.dirname, '../../..'),
      expectedSha256: intent.input.prerequisiteSources[baselineClientEntryPaths['mcp-http']] },
    'ptool-http': { root: sourceRoot,
      expectedSha256: intent.input.original.sourceDigests[baselineClientEntryPaths['ptool-http']] },
  });
  writeFileSync(join(evidenceDir, 'baseline-client-entrypoints.json'), JSON.stringify(entryPoints), { flag: 'wx' });
  const beforeCustodyPath = join(evidenceDir, 'baseline-runtime-custody-before.json');
  writeFileSync(beforeCustodyPath, JSON.stringify(beforeCustody), { flag: 'wx' });
  mkdirSync(env.PAPERCUSP_HOME!, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  writeFileSync(superuserTokenPath(), token, { mode: 0o600, flag: 'wx' });
  const hostEnv = privateBundleRuntimeEnv(env);
  host = spawn(process.execPath, [bundle], { cwd: sourceRoot, env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout!.on('data', chunk => process.stdout.write(chunk));
  host.stderr!.on('data', chunk => process.stderr.write(chunk));
  const hostIdentity = readProcessIdentity(host.pid!);
  assert.ok(hostIdentity);
  const health = await waitForPrivateOperator({ host, base, evidenceDir, hostIdentity, environment: hostEnv,
    requireBuildIdentity: true });
  assert.ok(sourceSha.startsWith(health.sha), 'runtime must serve the original source');
  writeFileSync(join(evidenceDir, 'wire-errors.ndjson'), '', { flag: 'wx' });
  writeFileSync(join(evidenceDir, 'baseline-runtime.json'), JSON.stringify({ sourceSha, bundleSha256,
    hostIdentity, health, qualification: source.qualification, edition: source.edition,
    custodyBeforeSha256: digest(readFileSync(beforeCustodyPath)),
    originalDependenciesReconstructed: false, repairedLockSha256: dependencyEdition.repairedLockSha256 }), { flag: 'wx' });
  await native.observe('runtime', join(evidenceDir, 'baseline-runtime.json'));
  // Observe both clients at their actual HTTP boundary. A logical UUID cannot
  // stand in for JSON-RPC IDs or reveal an adapter's automatic retries.
  proxy = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const message = body.length ? JSON.parse(body.toString()) : undefined;
      const wire = { id: message?.id ?? null, method: message?.method ?? incoming.method,
        transport: 'http', endpointPath: new URL(incoming.url!, base).pathname,
        tool: message?.params?.name ?? null, logicalId: activeEntry?.id ?? null,
        argsSha256: digest(JSON.stringify(message?.params?.arguments ?? null)) };
      appendFileSync(join(evidenceDir, 'wire-requests.ndjson'), JSON.stringify(wire) + '\n');
      if (message?.method === 'tools/call') {
        assert.ok(activeEntry, 'Unattributed tool call observed');
        assert.ok(typeof message.id === 'string' || typeof message.id === 'number', 'Actual RPC ID required');
        assert.equal(wire.tool, activeEntry.method);
        assert.equal(wire.argsSha256, activeEntry.argsSha256);
        activeEntry.wireRequests.push({ id: message.id, method: wire.tool, argsSha256: wire.argsSha256 });
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers))
        if (value !== undefined && !['host', 'connection', 'content-length'].includes(key))
          headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const response = await fetch(new URL(incoming.url!, base), { method: incoming.method,
        headers, ...(body.length ? { body } : {}) });
      outgoing.writeHead(response.status, Object.fromEntries([...response.headers]
        .filter(([key]) => !['connection', 'transfer-encoding', 'content-encoding', 'content-length'].includes(key))));
      if (response.body) Readable.fromWeb(response.body as any).pipe(outgoing);
      else outgoing.end();
    } catch (error) {
      appendFileSync(join(evidenceDir, 'wire-errors.ndjson'), JSON.stringify({ message: String(error) }) + '\n');
      outgoing.writeHead(502); outgoing.end();
    }
  });
  await new Promise<void>(resolve => proxy!.listen(0, '127.0.0.1', resolve));
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress !== 'string');
  const clientBase = 'http://127.0.0.1:' + proxyAddress.port;
  const url = new URL(clientBase + '/api/mcp');
  for (const [key, value] of Object.entries({ superuser: '1', workspace, harness: workspace,
    client: 'su-private-artifact-baseline-' + randomUUID(), structured: '1', format: 'json' }))
    url.searchParams.set(key, value);
  ({ client } = await connectAgentMcp({ url: url.href, mode: 'http', name: 'artifact-baseline',
    headers: { Authorization: `Bearer ${token}` } }));
  const traces: Trace[] = [];
  let custodyAfterSha256: string | null = null;
  const journal = () => writeFileSync(join(evidenceDir, 'client-traces.json'), JSON.stringify({
    schemaVersion: 1, sourceSha, fixtureSha256: source.fixtureSha256, bundleSha256,
    entryPoints,
    custodyBeforeSha256: digest(readFileSync(beforeCustodyPath)), custodyAfterSha256,
    completedMatrix: false, traces,
    unmeasured: ['shell', 'native Codex', 'native Claude', 'native OMP', 'test runner', 'computer',
      'claim/resume/handoff', 'candidate comparison', 'helper-wake ledger'],
  }, null, 2));
  const request = async (trace: Trace, method: string, args: Record<string, unknown>) => {
    assert.ok(trace.adapter === 'mcp-http' || trace.adapter === 'ptool-http', 'baseline_client_route');
    assert.ok(['artifacts:save', 'artifacts:append', 'artifacts:load'].includes(method), 'baseline_handler_route');
    const path = 'packages/agent-mcp/src/tools/artifacts/' + method.split(':')[1] + '.ts';
    const handlerSource = { path, sha256: digest(readFileSync(join(sourceRoot, path))) };
    assert.equal(handlerSource.sha256, intent.input.original.sourceDigests[path], 'baseline_handler_source_changed');
    const entry: Request = { id: randomUUID(), method, order: trace.requests.length,
      entryPointSha256: entryPoints[trace.adapter].sha256, handlerSource,
      argsSha256: digest(JSON.stringify(args)), retry: false, page: false, fallback: false, wireRequests: [] };
    activeEntry = entry;
    trace.requests.push(entry); journal();
    try {
      let result: any;
      if (trace.adapter === 'mcp-http') {
        result = decode(await client!.callTool({ name: method, arguments: args,
          _meta: { idempotencyKey: entry.id } }, undefined, { timeout: 30_000 }));
      } else {
        const child = spawn(process.execPath, [join(sourceRoot, 'apps/operator/scripts/ptool.mjs'), method,
          '--url=' + clientBase, '--workspace=' + workspace, '--harness=' + workspace, '--json', '-'],
        { cwd: sourceRoot, env: { ...hostEnv, PAPERCUSP_SID: 'su-private-artifact-ptool',
          PAPERCUSP_CONTEXT_TIER: 'full' }, stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [], errors: Buffer[] = [];
        child.stdout!.on('data', chunk => chunks.push(Buffer.from(chunk)));
        child.stderr!.on('data', chunk => errors.push(Buffer.from(chunk)));
        const closed = new Promise<number | null>((resolve, reject) => {
          child.once('error', reject); child.once('close', code => resolve(code));
        });
        child.stdin!.end(JSON.stringify(args));
        const code = await closed;
        writeFileSync(join(evidenceDir, entry.id + '.stderr.log'), Buffer.concat(errors));
        assert.equal(code, 0, Buffer.concat(errors).toString().slice(-3000));
        result = JSON.parse(Buffer.concat(chunks).toString());
      }
      entry.resultSha256 = digest(JSON.stringify(result));
      writeFileSync(join(evidenceDir, entry.id + '.json'), JSON.stringify({ request: entry, args, result }));
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(entry.wireRequests.length, 1, 'Unexpected automatic tool replay/retry at HTTP boundary');
      return result.results[0];
    } catch (error) { entry.failed = true; throw error; }
    finally { activeEntry = undefined; journal(); }
  };
  for (const adapter of ['mcp-http', 'ptool-http']) {
    const start = (scenario: string): Trace => {
      const trace: Trace = { scenario, adapter, requests: [], helperWakes: [] }; traces.push(trace); return trace;
    };
    const savedText = 'original client bytes 🧪\n';
    const savePath = 'baseline/' + adapter + '-save.txt';
    const save = start('budget.save');
    await request(save, 'artifacts:save', { slug: workspace, rel_path: savePath, content: savedText });
    const saved = await request(save, 'artifacts:load', { slug: workspace, rel_path: savePath });
    assert.equal(saved.content, savedText); save.outcomeSha256 = digest(saved.content);
    const append = start('budget.append');
    const appendPath = 'baseline/' + adapter + '-append.txt';
    await request(append, 'artifacts:save', { slug: workspace, rel_path: appendPath, content: 'A' });
    for (const suffix of ['B', 'C']) await request(append, 'artifacts:append', { slug: workspace, rel_path: appendPath, suffix });
    const appended = await request(append, 'artifacts:load', { slug: workspace, rel_path: appendPath });
    assert.equal(appended.content, 'ABC'); append.outcomeSha256 = digest(appended.content);
    const read = start('budget.read');
    const loaded = await request(read, 'artifacts:load', { slug: workspace, rel_path: savePath });
    assert.equal(loaded.content, savedText); read.outcomeSha256 = digest(loaded.content);
    for (const trace of [save, append, read]) trace.count = trace.requests.length;
    assert.deepEqual([save.count, append.count, read.count], [2, 4, 1]);
  }
  journal();
  await client.close(); client = undefined;
  proxy.closeAllConnections();
  await new Promise<void>((resolve, reject) => proxy!.close(error => error ? reject(error) : resolve()));
  proxy = undefined;
  await stopPrivateOperatorHost(host); host = undefined;
  assert.equal(digest(readFileSync(join(import.meta.dirname, '../lib/agent-mcp-client.ts'))),
    entryPoints['mcp-http'].sha256, 'baseline_client_entry_changed');
  assert.equal(digest(readFileSync(join(sourceRoot, entryPoints['ptool-http'].path))),
    entryPoints['ptool-http'].sha256, 'baseline_client_entry_changed');
  const afterCustody = await assertBaselineRuntimeCustody(sourceRoot, preparedDir, intent);
  assert.deepEqual(afterCustody, beforeCustody, 'baseline_runtime_custody_changed');
  const afterCustodyPath = join(evidenceDir, 'baseline-runtime-custody-after.json');
  writeFileSync(afterCustodyPath, JSON.stringify(afterCustody), { flag: 'wx' });
  custodyAfterSha256 = digest(readFileSync(afterCustodyPath));
  journal();
  await native.observe('trace', join(evidenceDir, 'client-traces.json'));
  console.log('TASK_ARTIFACT_CLIENT_BASELINE_RECEIPT ' + JSON.stringify({ sourceSha, bundleSha256,
    ...afterCustody,
    hostStopped: true, completedMatrix: false, adapters: ['mcp-http', 'ptool-http'],
    traces: traces.map(({ scenario, adapter, count, outcomeSha256 }) => ({ scenario, adapter, count, outcomeSha256 })) }));
}
try {
  const handoffPath = process.argv.find(arg => arg.startsWith('--native-proof-child='))
    ?.slice('--native-proof-child='.length);
  assert.ok(handoffPath, 'Original durable native child handoff required before private runtime creation');
  const handoff: NativeProofChildHandoff = JSON.parse(readFileSync(handoffPath, 'utf8'));
  // As in native-proof-successor.mts, the child owns a raw shared-ledger pool.
  // Do not import the Vitest proof driver into this ordinary Node process.
  const url = process.env.PAPERCUSP_TEST_RUNS_DB_URL?.trim();
  assert.ok(url, 'Explicit durable test-run ledger URL required');
  const pool = postgres(url, { max: 2, connect_timeout: 5 });
  restoreRawJsonbSerializer(pool);
  const sql = pool as unknown as Parameters<typeof enterNativeProofChild>[0];
  try {
    await enterNativeProofChild(sql, handoff,
      'packages/operator-core/test/task-artifacts-baseline-http-fixture.ts',
      digest(readFileSync(new URL(import.meta.url))), intent => {
        productRuntimeEntered = true;
        return main({ input: intent.input,
        observe: async (kind, receiptPath) => {
          const current = await readNativeProofRun(sql, intent.runId);
          assert.equal(current?.fingerprint, intent.fingerprint, 'Original native proof intent changed');
          await appendNativeProofEvent(sql, intent.runId, intent.fingerprint, current!.events.length,
            { kind, receiptRef: receiptPath, receiptSha256: digest(readFileSync(receiptPath)) });
        },
        }, intent);
      });
  } finally { await pool.end({ timeout: 5 }); }
}
catch (error) { console.error('TASK_ARTIFACT_CLIENT_BASELINE_FAILURE', error); process.exitCode = 1; }
finally {
  await client?.close();
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy!.close(() => resolve()));
  }
  if (host) await stopPrivateOperatorHost(host);
  if (productRuntimeEntered) await getOrgPg().sql.end({ timeout: 1 });
}
