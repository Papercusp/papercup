/** Synthetic retained originals shared by consumer tests; never native-run evidence. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { baselineClientEntryPaths, baselineLockDelta, readBaselinePacket,
  retainBaselineProducerPacket } from '../lib/task-artifacts-baseline-custody';
import { nativeProofFingerprint, type NativeProofInput, type NativeProofRun } from '../lib/testing-run-store';

// Original source bytes captured before product edits, independent of candidate
// imports. Runtime paths stay in the immutable PG capture, outside release source.
// This portable fixture is a distinct edition; its manifest is only a projection.
export const CAPTURE_SHA = '4b9fe3800168b16a3e842d04de33faa906779dcf6254b26c0fb59f6044434a5f';
export const FIXTURE_SHA = '9c7e72bff652470ac294d0aa927e859989c0a3dfc47e56b1143acde4b8e1a7ea';
export const SOURCE_SHA = '729986dd35171f1e0cb11bd1505295917f2d946f';
export const bytes = readFileSync(new URL('./fixtures/task-artifacts/baseline-729986dd35.json', import.meta.url));
export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
// Read the immutable historical object, never the executing checkout's ptool.
export const historicalPtool = execFileSync('git', ['show', SOURCE_SHA + ':' + baselineClientEntryPaths['ptool-http']],
  { cwd: resolve(import.meta.dirname, '../../..'), maxBuffer: 1024 * 1024 });

/** Deliberately synthetic consumer fixture, not evidence of a native run.
 * Native execution remains owned by the separately admitted integration test. */
export function qualifierFixture(root: string, ptool = historicalPtool,
  scope: NativeProofInput['scope'] = { workspaceId: 'synthetic-workspace', harnessSlug: 'synthetic-harness', planSlug: 'synthetic-plan' }) {
  const runRoot = join(root, 'run'), originals = new Map<string, Buffer>();
  const put = (path: string, value: unknown) => originals.set(path,
    Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
  const fixture = readFrozenBaseline(bytes), frozen = fixture.files.map(({ path, sha256 }) => ({ path, sha256 }));
  const originalLock = Buffer.from(JSON.stringify({ packages: { '': { name: 'original' } } }));
  const repaired = Buffer.from(JSON.stringify({ packages: { '': { name: 'repaired' } } }));
  const delta = Buffer.from(JSON.stringify(baselineLockDelta(originalLock, repaired)));
  const mcp = Buffer.from('independently pinned synthetic MCP original');
  const input: NativeProofInput = { schemaVersion: 1,
    scope,
    original: { sourceSha: SOURCE_SHA, fixtureSha256: FIXTURE_SHA, captureSha256: CAPTURE_SHA,
      sourceDigests: { ...Object.fromEntries(frozen.map(file => [file.path, file.sha256])),
        [baselineClientEntryPaths['ptool-http']]: sha256(ptool) }, dependenciesReconstructed: false },
    prerequisiteSources: { [baselineClientEntryPaths['mcp-http']]: sha256(mcp),
      'packages/operator-core/test/task-artifacts-baseline-http-fixture.ts': sha256('synthetic child') },
    method: { sha256: sha256('synthetic method'), configurationSha256: sha256('synthetic configuration'),
      clientMatrix: Object.keys(baselineClientEntryPaths).flatMap(adapter =>
        ['budget.save', 'budget.append', 'budget.read'].map(scenario => adapter + ':' + scenario)) },
    selectedInputs: { 'package-lock.json': sha256(originalLock), '.npmrc': null },
    plannedRepair: { lockSha256: sha256(repaired), packageDeltaSha256: sha256(delta),
      candidateGraphSha256: sha256(JSON.stringify(JSON.parse(repaired.toString()).packages)) },
    toolchain: { npmSha256: sha256('synthetic npm'), npmVersion: '11.0.0', nodeVersion: 'v24.0.0', nativeAbi: '137' } };
  const { fingerprint } = nativeProofFingerprint(input);
  const run: NativeProofRun = { runId: 'native-proof-' + fingerprint, fingerprint, input,
    admission: { reviewedFingerprint: fingerprint, reviewRef: 'synthetic-independent-review',
      preflightRefs: { numericFold: 'synthetic-fold', physicalInstall: 'synthetic-install', priorFailureAudit: 'synthetic-audit' } },
    events: ['reserved', 'started'].map(kind => ({ kind: kind as 'reserved' | 'started', fingerprint })),
    childLaunch: { fingerprint, entryPoint: 'packages/operator-core/test/task-artifacts-baseline-http-fixture.ts',
      entryPointSha256: input.prerequisiteSources['packages/operator-core/test/task-artifacts-baseline-http-fixture.ts'], state: 'started' } };
  put('prepare/native-proof-intent.json', { ...run, childLaunch: null });
  const boundary = (changedPaths: string[]) => ({ sourceSha: SOURCE_SHA, tree: 'synthetic-original-tree', submodules: 'synthetic-submodules', changedPaths });
  put('prepare/baseline-fixture.json', bytes);
  put('prepare/baseline-source.json', { sourceSha: SOURCE_SHA, fixtureSha256: FIXTURE_SHA, files: frozen,
    originalCapture: fixture.originalCapture, originalLoadedRuntime: fixture.loadedRuntime,
    edition: 'source-frozen-dependency-repaired-v1', originalDependenciesReconstructed: false });
  put('prepare/dependency-repair-inputs.json', { beforeProductBoundary: boundary([]), inputs: [
    { path: 'package-lock.json', base64: originalLock.toString('base64'), sha256: sha256(originalLock) },
    { path: '.npmrc', base64: null, sha256: null }] });
  put('prepare/dependency-lock-original.json', originalLock); put('prepare/dependency-lock-repaired.json', repaired);
  put('prepare/dependency-repair-delta.json', delta);
  put('prepare/dependency-candidate-graph.json', JSON.stringify(JSON.parse(repaired.toString()).packages));
  const edition = { edition: 'source-frozen-dependency-repaired-v1', originalSourceSha: SOURCE_SHA,
    originalDependenciesReconstructed: false, originalLockSha256: sha256(originalLock), repairedLockSha256: sha256(repaired),
    beforeSources: frozen, afterSources: frozen, changedInputs: ['package-lock.json'],
    beforeProductBoundary: boundary([]), afterProductBoundary: boundary(['package-lock.json']) };
  put('prepare/dependency-edition.json', edition);
  put('prepare/dependency-install.log', 'synthetic guarded ci log');
  const tree = { schemaVersion: 1, trees: ['node_modules'], audit: { defects: [] }, entries: [] };
  const treeSha256 = sha256(JSON.stringify(tree));
  put('prepare/dependency-installed-tree.json', { ...tree, sha256: treeSha256 });
  const treeBytesSha256 = sha256(originals.get('prepare/dependency-installed-tree.json')!);
  put('prepare/dependency-installed.json', { sourceSha: SOURCE_SHA, repairedLockSha256: sha256(repaired),
    afterInstallSources: frozen, afterInstallProductBoundary: boundary(['package-lock.json']),
    installLogSha256: sha256(originals.get('prepare/dependency-install.log')!),
    installedTreeSha256: treeSha256, installedTreeManifestSha256: treeBytesSha256 });
  const bundle = Buffer.from('synthetic served bundle'); put('prepare/hono-host.mjs', bundle);
  put('prepare/operator-api-preflight.json', { path: join(runRoot, 'phases/prepare/hono-host.mjs'), sha256: sha256(bundle) });
  put('prepare/dependency-edition-after-build.json', { ...edition, afterInstallSources: frozen, afterBuildSources: frozen,
    afterBuildProductBoundary: boundary(['package-lock.json']), rebuiltBundleSha256: sha256(bundle),
    installedTreeSha256: treeSha256, receiptSha256: sha256(originals.get('prepare/operator-api-preflight.json')!) });
  const custody = { installedTreeSha256: treeSha256, installedTreeManifestSha256: treeBytesSha256, toolchain: input.toolchain };
  put('execute/baseline-runtime-custody-before.json', custody); put('execute/baseline-runtime-custody-after.json', custody);
  const custodySha256 = sha256(originals.get('execute/baseline-runtime-custody-before.json')!);
  put('execute/baseline-runtime.json', { sourceSha: SOURCE_SHA, edition: edition.edition,
    originalDependenciesReconstructed: false, repairedLockSha256: sha256(repaired),
    bundleSha256: sha256(bundle), custodyBeforeSha256: custodySha256, health: { sha: SOURCE_SHA } });
  const entries = Object.fromEntries(Object.entries(baselineClientEntryPaths).map(([adapter, path]) => {
    const originalRef = 'client-entrypoints/' + adapter + '.source', source = adapter === 'mcp-http' ? mcp : ptool;
    put('execute/' + originalRef, source); return [adapter, { path, originalRef, sha256: sha256(source) }];
  }));
  put('execute/baseline-client-entrypoints.json', entries);
  const wire: unknown[] = [], traces: unknown[] = [];
  for (const adapter of Object.keys(entries)) for (const [scenario, methods] of Object.entries({
    'budget.save': ['save', 'load'], 'budget.append': ['save', 'append', 'append', 'load'], 'budget.read': ['load'] })) {
    const requests = methods.map((method, order) => {
      const id = adapter + '-' + scenario + '-' + order, args = { synthetic: id };
      const result = { ok: true, results: [{ content: 'synthetic exact result 🧪' }] };
      const handlerPath = 'packages/agent-mcp/src/tools/artifacts/' + method + '.ts';
      const request = { id, method: 'artifacts:' + method, order, argsSha256: sha256(JSON.stringify(args)),
        entryPointSha256: entries[adapter].sha256, handlerSource: { path: handlerPath, sha256: input.original.sourceDigests[handlerPath] },
        resultSha256: sha256(JSON.stringify(result)), retry: false, page: false, fallback: false,
        wireRequests: [{ id, method: 'artifacts:' + method, argsSha256: sha256(JSON.stringify(args)) }] };
      wire.push({ id, method: 'tools/call', transport: 'http', endpointPath: '/api/mcp', tool: request.method,
        logicalId: id, argsSha256: request.argsSha256 });
      put('execute/' + id + '.json', { request, args, result });
      if (adapter === 'ptool-http') put('execute/' + id + '.stderr.log', 'synthetic CLI diagnostics');
      return request;
    });
    traces.push({ adapter, scenario, requests, helperWakes: [], count: requests.length, outcomeSha256: sha256('synthetic exact result 🧪') });
  }
  put('execute/wire-errors.ndjson', ''); put('execute/wire-requests.ndjson', wire.map(row => JSON.stringify(row)).join('\n') + '\n');
  put('execute/client-traces.json', { sourceSha: SOURCE_SHA, fixtureSha256: FIXTURE_SHA, bundleSha256: sha256(bundle),
    entryPoints: entries, custodyBeforeSha256: custodySha256, custodyAfterSha256: custodySha256, completedMatrix: false, traces });
  const packet = () => {
    // Rebind observation digests so negatives must defeat tuple qualification,
    // not merely a stale outer digest. The reviewed input remains independent.
    run.events.splice(2, run.events.length, ...([
      ['installed', 'prepare/dependency-installed.json'], ['built', 'prepare/dependency-edition-after-build.json'],
      ['runtime', 'execute/baseline-runtime.json'], ['trace', 'execute/client-traces.json'],
    ] as const).map(([kind, path]) => ({ kind, fingerprint, receiptRef: join(runRoot, 'phases', path), receiptSha256: sha256(originals.get(path)!) })));
    for (const [path, value] of originals) {
      mkdirSync(dirname(join(runRoot, 'phases', path)), { recursive: true }); writeFileSync(join(runRoot, 'phases', path), value);
    }
    const seal = retainBaselineProducerPacket(runRoot, join(root, 'archive'), fingerprint);
    return { seal, packet: readBaselinePacket(seal, sha256(seal), fingerprint) };
  };
  const change = (path: string, edit: (value: any) => void) => { const value = JSON.parse(originals.get(path)!.toString()); edit(value); put(path, value); };
  return { runRoot, run, originals, put, packet, change };
}

export function readFrozenBaseline(raw: Uint8Array) {
  if (sha256(raw) !== FIXTURE_SHA) throw new Error('baseline_fixture_changed');
  return JSON.parse(Buffer.from(raw).toString('utf8')) as {
    sourceSha: string;
    traceStatus: string;
    files: Array<{ path: string; bytes: number; sha256: string; content: string }>;
    originalCapture: { harness: string; relPath: string; sha256: string; bytes: number };
    loadedRuntime: { manifestFileSha256: string; bundleSha256: string;
      manifestProjection: { headSha: string; artifact: { sourceSha: string; bundleSha256: string } } };
  };
}

