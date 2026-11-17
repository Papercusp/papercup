import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runHarness } from '@papercusp/verification-harness';
import { findBoxIdentityPaths, findIdentityLiterals, resolveIdentityLiterals } from '../../../scripts/lib/identity-leak-patterns.mjs';
import { assertBaselineInstalledTree, captureBaselineInstalledTree, assertBaselineRuntimeCustody,
  assertBaselineToolchain, captureBaselineToolchain,
  assertBaselinePlannedRepair, assertBaselineRepairInputs, assertFrozenBaselineSources, baselineLockDelta,
  baselineProductBoundary, baselineRepairFailureArtifacts,
  baselinePacketChunkBytes, readBaselinePacket, retainBaselinePacket,
  baselineClientEntryPaths, captureBaselineProducers, retainBaselineProducerPacket, retainBaselineClientOriginals,
  qualifyBaselinePacket, readBaselineQualification, sealBaselineQualification, originalBaselinePtoolSha256,
  retainBaselineRepairFailure } from '../test/task-artifacts-baseline-repair';
import { nativeProofFingerprint, type NativeProofInput, type NativeProofRun } from './testing-run-store';

// Original source bytes captured before product edits, independent of candidate
// imports. Runtime paths stay in the immutable PG capture, outside release source.
// This portable fixture is a distinct edition; its manifest is only a projection.
const CAPTURE_SHA = '4b9fe3800168b16a3e842d04de33faa906779dcf6254b26c0fb59f6044434a5f';
const FIXTURE_SHA = '9c7e72bff652470ac294d0aa927e859989c0a3dfc47e56b1143acde4b8e1a7ea';
const SOURCE_SHA = '729986dd35171f1e0cb11bd1505295917f2d946f';
const bytes = readFileSync(new URL('../test/fixtures/task-artifacts/baseline-729986dd35.json', import.meta.url));
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
// Read the immutable historical object, never the executing checkout's ptool.
const historicalPtool = execFileSync('git', ['show', SOURCE_SHA + ':' + baselineClientEntryPaths['ptool-http']],
  { cwd: resolve(import.meta.dirname, '../../..'), maxBuffer: 1024 * 1024 });

/** Deliberately synthetic consumer fixture, not evidence of a native run.
 * Native execution remains owned by the separately admitted integration test. */
function qualifierFixture(root: string, ptool = historicalPtool) {
  const runRoot = join(root, 'run'), originals = new Map<string, Buffer>();
  const put = (path: string, value: unknown) => originals.set(path,
    Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
  const fixture = readFrozenBaseline(bytes), frozen = fixture.files.map(({ path, sha256 }) => ({ path, sha256 }));
  const originalLock = Buffer.from(JSON.stringify({ packages: { '': { name: 'original' } } }));
  const repaired = Buffer.from(JSON.stringify({ packages: { '': { name: 'repaired' } } }));
  const delta = Buffer.from(JSON.stringify(baselineLockDelta(originalLock, repaired)));
  const mcp = Buffer.from('independently pinned synthetic MCP original');
  const input: NativeProofInput = { schemaVersion: 1,
    scope: { workspaceId: 'synthetic-workspace', harnessSlug: 'synthetic-harness', planSlug: 'synthetic-plan' },
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

describe('complete pinned baseline qualification from retained originals', () => {
  it('refuses a coherently rekeyed replacement for the historical ptool original', () => {
    expect(sha256(historicalPtool)).toBe(originalBaselinePtoolSha256);
    const root = mkdtempSync(join(tmpdir(), 'baseline-qualifier-ptool-'));
    try {
      // Every local digest, event, original intent and admission fingerprint
      // agrees with this replacement. Only the independent historical pin
      // distinguishes it from the actual fifteenth frozen source.
      const f = qualifierFixture(root, Buffer.from('coherently replaced ptool source'));
      const { packet } = f.packet();
      expect(() => qualifyBaselinePacket(packet, f.run, f.runRoot)).toThrow('baseline_qualifier_historical_ptool');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('seals and reads the same ledger tuple after original producers are removed', () => {
    const root = mkdtempSync(join(tmpdir(), 'baseline-qualifier-'));
    try {
      const f = qualifierFixture(root), { seal, packet } = f.packet();
      expect(qualifyBaselinePacket(packet, f.run, f.runRoot).measured).toHaveLength(6);
      const stored = sealBaselineQualification(seal, f.run, f.runRoot);
      expect(readFileSync(stored.path).equals(stored.bytes)).toBe(true);
      f.run.events.push({ kind: 'sealed', fingerprint: f.run.fingerprint, receiptRef: stored.path, receiptSha256: stored.sha256 },
        { kind: 'readback', fingerprint: f.run.fingerprint, receiptRef: stored.path, receiptSha256: stored.sha256 });
      rmSync(f.runRoot, { recursive: true });
      expect(readBaselineQualification(f.run).fingerprint).toBe(f.run.fingerprint);
      const changed = structuredClone(f.run); changed.events[7].receiptSha256 = sha256('substitution');
      expect(() => readBaselineQualification(changed)).toThrow('baseline_qualification_readback_digest');
      writeFileSync(stored.path, '{}');
      expect(() => readBaselineQualification(f.run)).toThrow('baseline_qualification_seal_changed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  const substitutions: Array<[string, (f: ReturnType<typeof qualifierFixture>) => void]> = [
    ['fixture', f => f.change('prepare/baseline-fixture.json', v => { v.files[0].content += 'replaced'; })],
    ['frozen source', f => f.change('prepare/dependency-edition.json', v => { v.afterSources[0].sha256 = sha256('replaced'); })],
    ['selected bytes', f => f.change('prepare/dependency-repair-inputs.json', v => { v.inputs[0].base64 = Buffer.from('{}').toString('base64'); v.inputs[0].sha256 = sha256('{}'); })],
    ['original lock', f => f.put('prepare/dependency-lock-original.json', '{}')],
    ['repaired lock', f => f.put('prepare/dependency-lock-repaired.json', '{}')],
    ['package delta', f => f.put('prepare/dependency-repair-delta.json', '{}')],
    ['candidate graph', f => f.put('prepare/dependency-candidate-graph.json', '{}')],
    ['installed manifest', f => f.change('prepare/dependency-installed-tree.json', v => { v.entries.push({ path: 'substitution' }); })],
    ['installed tree', f => f.change('prepare/dependency-installed.json', v => { v.installedTreeSha256 = sha256('substitution'); })],
    ['served bundle', f => f.put('prepare/hono-host.mjs', 'substitution')],
    ['served source', f => f.change('execute/baseline-runtime.json', v => { v.health.sha = '0000000'; })],
    ['entry original', f => f.put('execute/client-entrypoints/mcp-http.source', 'substitution')],
    ['handler only trace', f => f.put('execute/wire-requests.ndjson', '')],
    ['transport route', f => { const rows = f.originals.get('execute/wire-requests.ndjson')!.toString().trim().split('\n').map(line => JSON.parse(line)); rows[0].endpointPath = '/handler-only'; f.put('execute/wire-requests.ndjson', rows.map(row => JSON.stringify(row)).join('\n')); }],
    ['trace handler', f => f.change('execute/client-traces.json', v => { v.traces[0].requests[0].handlerSource.sha256 = sha256('substitution'); })],
    ['trace entry', f => f.change('execute/client-traces.json', v => { v.traces[0].requests[0].entryPointSha256 = sha256('substitution'); })],
    ['request result', f => f.change('execute/mcp-http-budget.save-0.json', v => { v.result.results[0].content = 'substitution'; })],
    ['extra client trace', f => f.change('execute/client-traces.json', v => { v.traces.push(v.traces[0]); })],
    ['native child', f => { f.run.childLaunch!.entryPointSha256 = sha256('substitution'); }],
    ...(['npmSha256', 'npmVersion', 'nodeVersion', 'nativeAbi'] as const).map(field => [field, (f: ReturnType<typeof qualifierFixture>) => {
      for (const path of ['execute/baseline-runtime-custody-before.json', 'execute/baseline-runtime-custody-after.json'])
        f.change(path, v => { v.toolchain[field] = 'substituted'; });
    }] as [string, (f: ReturnType<typeof qualifierFixture>) => void]),
  ];
  it.each(substitutions)('refuses independently re-archived %s substitution', (_name, substitute) => {
    const root = mkdtempSync(join(tmpdir(), 'baseline-qualifier-negative-'));
    try {
      const f = qualifierFixture(root); substitute(f); const { packet } = f.packet();
      expect(() => qualifyBaselinePacket(packet, f.run, f.runRoot)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses missing native links, changed review and post-seal packet originals', () => {
    const root = mkdtempSync(join(tmpdir(), 'baseline-qualifier-links-'));
    try {
      const f = qualifierFixture(root), { seal, packet } = f.packet();
      const incomplete = structuredClone(f.run); incomplete.events.pop();
      expect(() => qualifyBaselinePacket(packet, incomplete, f.runRoot)).toThrow('baseline_qualifier_incomplete_ledger');
      const unreviewed = structuredClone(f.run); unreviewed.admission.reviewedFingerprint = sha256('other edition');
      expect(() => qualifyBaselinePacket(packet, unreviewed, f.runRoot)).toThrow('baseline_qualifier_review');
      expect(() => readBaselineQualification(f.run)).toThrow('baseline_qualification_readback_missing');
      const stored = sealBaselineQualification(seal, f.run, f.runRoot);
      f.run.events.push({ kind: 'sealed', fingerprint: f.run.fingerprint, receiptRef: stored.path, receiptSha256: stored.sha256 },
        { kind: 'readback', fingerprint: f.run.fingerprint, receiptRef: stored.path, receiptSha256: stored.sha256 });
      const original = packet.manifest.files.find(file => file.path === 'phases/prepare/hono-host.mjs')!.blob.parts[0].artifact;
      writeFileSync(join(root, 'archive', original.ref), Buffer.alloc(original.byteLength, 0));
      expect(() => readBaselineQualification(f.run)).toThrow('baseline_packet_chunk_changed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

function readFrozenBaseline(raw: Uint8Array) {
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

describe('managed artifact pre-feature baseline custody', () => {
  it('refuses the actual fresh native fixture before runtime creation when its serialized handoff is missing', () => {
    const root = resolve(import.meta.dirname, '../../..');
    const result = spawnSync(process.execPath, ['--import', 'tsx',
      join(root, 'packages/operator-core/test/task-artifacts-baseline-http-fixture.ts')], {
      cwd: root, encoding: 'utf8', timeout: 30_000, env: { ...process.env,
        NODE_OPTIONS: '', PAPERCUSP_TEST_RUNS_DB_URL: '',
        TASK_ARTIFACT_BASELINE_EVIDENCE_DIR: '/must-not-create-native-runtime',
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Original durable native child handoff required before private runtime creation');
    expect(result.stderr).not.toContain('Vitest failed to access its internal state');
    expect(result.stdout).not.toContain('TASK_ARTIFACT_CLIENT_BASELINE_RECEIPT');
  }, 45_000);

  it('preserves original adapter bytes under the independently captured edition digest', () => {
    const baseline = readFrozenBaseline(bytes);
    expect(baseline.sourceSha).toBe(SOURCE_SHA);
    expect(baseline.files).toHaveLength(14);
    expect(new Set(baseline.files.map(file => file.path)).size).toBe(baseline.files.length);
    for (const file of baseline.files) {
      expect(Buffer.byteLength(file.content), file.path).toBe(file.bytes);
      expect(sha256(file.content), file.path).toBe(file.sha256);
    }
    // A source fixture is not a completed paired trace or adapter verdict.
    expect(baseline.traceStatus).toBe('not-yet-captured');
  });

  it('retains the immutable original capture reference and projected runtime identity', () => {
    const { loadedRuntime, originalCapture } = readFrozenBaseline(bytes);
    expect(originalCapture).toEqual({ harness: 'papercusp',
      relPath: `immutable/sha256/${CAPTURE_SHA}.json`, sha256: CAPTURE_SHA, bytes: 409696 });
    expect(loadedRuntime.manifestFileSha256).toBe('8e26f7e48d9230f095f3cd1c33945567abc66bb5dab95611ce25fe5d3520a49a');
    const manifest = loadedRuntime.manifestProjection;
    expect(manifest.headSha).toBe(SOURCE_SHA);
    expect(manifest.artifact.sourceSha).toBe(SOURCE_SHA);
    expect(manifest.artifact.bundleSha256).toBe(loadedRuntime.bundleSha256);
    expect(loadedRuntime.bundleSha256).toBe('5ab328c626de5c96cd1571f78f618de20b0772288d66e4e8301bb35107de5e11');
  });

  it('keeps source fixtures free of machine identity without exempting historical captures', () => {
    const source = bytes.toString('utf8');
    expect(findBoxIdentityPaths(source)).toEqual([]);
    expect(findIdentityLiterals(source, Object.entries(resolveIdentityLiterals()))).toEqual([]);
    expect(source).not.toContain('manifestOriginalBytes');
  });

  it('rejects a replacement even when its internal file digest was updated', () => {
    const replacement = structuredClone(readFrozenBaseline(bytes));
    replacement.files[0].content += '\n// candidate replacement\n';
    replacement.files[0].bytes = Buffer.byteLength(replacement.files[0].content);
    replacement.files[0].sha256 = sha256(replacement.files[0].content);
    expect(() => readFrozenBaseline(Buffer.from(JSON.stringify(replacement))))
      .toThrow('baseline_fixture_changed');
  });
});

describe('separately qualified baseline dependency repair custody', () => {
  it.each([255, 256, 257, 1025])('recovers the complete nested producer census after restart at population %s', count => {
    const root = mkdtempSync(join(tmpdir(), 'baseline-producer-population-'));
    try {
      const run = join(root, 'run'), archive = join(root, 'archive');
      const prepared = join(run, 'phases/prepare'), execute = join(run, 'phases/execute');
      mkdirSync(join(prepared, 'empty'), { recursive: true });
      mkdirSync(join(execute, 'client-entrypoints'), { recursive: true });
      const paths = Array.from({ length: count }, (_, n) => 'request-' + String(n).padStart(4, '0') + '.json');
      for (const path of [...paths].reverse()) writeFileSync(join(execute, 'client-entrypoints', path), path);
      mkdirSync(join(root, 'installed')); writeFileSync(join(root, 'installed/native.node'), 'native bytes');
      symlinkSync(join(root, 'installed'), join(prepared, 'node_modules'));
      const bindings = { 'phases/prepare/node_modules': join(root, 'installed') };
      const fingerprint = sha256('reviewed edition');
      const census = captureBaselineProducers(run, bindings);
      const seal = retainBaselineProducerPacket(run, archive, fingerprint, bindings);
      expect(retainBaselineProducerPacket(run, archive, fingerprint, bindings)).toEqual(seal);
      expect(census.filter(entry => entry.kind === 'file')).toHaveLength(count);
      expect(census.find(entry => entry.path === 'phases/prepare/empty')?.kind).toBe('directory');
      expect(census.find(entry => entry.path === 'phases/prepare/node_modules')).toMatchObject({
        kind: 'dependency-binding', resolved: join(root, 'installed') });
      rmSync(run, { recursive: true }); rmSync(join(root, 'installed'), { recursive: true });
      const recovered = readBaselinePacket(seal, sha256(seal), fingerprint);
      expect(recovered.manifest.producerCensus).toEqual(census);
      expect(recovered.manifest.files).toHaveLength(count);
      for (const path of paths)
        expect(recovered.read('phases/execute/client-entrypoints/' + path).toString()).toBe(path);
      const last = recovered.manifest.files.at(-1)!.blob.parts[0].artifact;
      writeFileSync(join(archive, last.ref), 'substituted final nested request');
      expect(() => readBaselinePacket(seal, sha256(seal), fingerprint)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['late-file', 'earlier-bytes', 'directory-mode', 'removed-file'])(
    'rejects a producer census changed during actual archive reads (%s)', mutation => {
      const root = mkdtempSync(join(tmpdir(), 'baseline-producer-changing-'));
      try {
        const run = join(root, 'run'), phase = join(run, 'phases/execute');
        mkdirSync(phase, { recursive: true });
        chmodSync(phase, 0o755);
        writeFileSync(join(phase, 'a.json'), 'first original');
        writeFileSync(join(phase, 'z.json'), 'last original');
        const original = fs.readSync;
        const lastInode = fs.statSync(join(phase, 'z.json')).ino;
        let mutated = false;
        vi.spyOn(fs, 'readSync').mockImplementation((...args) => {
          const result: number = Reflect.apply(original, fs, args);
          if (!mutated && result > 0 && fs.fstatSync(args[0]).ino === lastInode) {
            mutated = true;
            if (mutation === 'late-file') writeFileSync(join(phase, 'new.json'), 'late original');
            if (mutation === 'earlier-bytes') writeFileSync(join(phase, 'a.json'), 'replacement bytes');
            if (mutation === 'directory-mode') chmodSync(phase, 0o700);
            if (mutation === 'removed-file') rmSync(join(phase, 'a.json'));
          }
          return result;
        });
        syncBuiltinESMExports();
        expect(() => retainBaselineProducerPacket(run, join(root, 'archive'), sha256('reviewed')))
          .toThrow('baseline_producer_census_changed');
        expect(mutated).toBe(true);
      } finally { vi.restoreAllMocks(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
    });

  it('refuses unknown, wrongly bound and redirected producer links instead of omitting them', () => {
    const root = mkdtempSync(join(tmpdir(), 'baseline-producer-links-'));
    try {
      const run = join(root, 'run'), phase = join(run, 'phases/execute');
      mkdirSync(phase, { recursive: true }); mkdirSync(join(root, 'target'));
      writeFileSync(join(root, 'target', 'original.json'), 'nested bytes');
      symlinkSync(join(root, 'target'), join(phase, 'nested'));
      expect(() => retainBaselineProducerPacket(run, join(root, 'archive'), sha256('reviewed')))
        .toThrow('baseline_producer_unexpected_link');
      expect(() => captureBaselineProducers(run, { 'phases/execute/nested': root }))
        .toThrow('baseline_producer_unexpected_link');
      rmSync(join(phase, 'nested')); rmSync(phase, { recursive: true });
      symlinkSync(join(root, 'target'), phase);
      expect(() => captureBaselineProducers(run)).toThrow('baseline_producer_unexpected_link');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('retains exact independently pinned client entry originals through the producer archive', () => {
    const root = mkdtempSync(join(tmpdir(), 'baseline-client-originals-'));
    try {
      const run = join(root, 'run'), phase = join(run, 'phases/execute'), source = join(root, 'source');
      mkdirSync(phase, { recursive: true });
      const sources = Object.fromEntries(Object.entries(baselineClientEntryPaths).map(([adapter, path]) => {
        const file = join(source, path); mkdirSync(dirname(file), { recursive: true });
        const bytes = Buffer.from(adapter + '\ncomplete entry bytes 🧪'); writeFileSync(file, bytes);
        return [adapter, { root: source, expectedSha256: sha256(bytes) }];
      })) as Parameters<typeof retainBaselineClientOriginals>[1];
      const entries = retainBaselineClientOriginals(phase, sources);
      for (const [adapter, entry] of Object.entries(entries)) {
        expect(entry.path).toBe(baselineClientEntryPaths[adapter as keyof typeof baselineClientEntryPaths]);
        expect(sha256(readFileSync(join(phase, entry.originalRef)))).toBe(entry.sha256);
      }
      const fingerprint = sha256('reviewed'), seal = retainBaselineProducerPacket(run, join(root, 'archive'), fingerprint);
      rmSync(run, { recursive: true }); rmSync(source, { recursive: true });
      const recovered = readBaselinePacket(seal, sha256(seal), fingerprint);
      for (const entry of Object.values(entries))
        expect(sha256(recovered.read('phases/execute/' + entry.originalRef))).toBe(entry.sha256);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['substituted-bytes', 'source-link'])('refuses substituted client entry originals (%s)', mutation => {
    const root = mkdtempSync(join(tmpdir(), 'baseline-client-refusal-'));
    try {
      const phase = join(root, 'execute'); mkdirSync(phase);
      const sources = Object.fromEntries(Object.entries(baselineClientEntryPaths).map(([adapter, path]) => {
        const file = join(root, path); mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, adapter);
        return [adapter, { root, expectedSha256: sha256(adapter) }];
      })) as Parameters<typeof retainBaselineClientOriginals>[1];
      const file = join(root, baselineClientEntryPaths['mcp-http']);
      if (mutation === 'substituted-bytes') writeFileSync(file, 'changed entry');
      else { rmSync(file); symlinkSync('/etc/passwd', file); }
      expect(() => retainBaselineClientOriginals(phase, sources)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([-1, 0, 1])('recovers every byte across the native packet chunk boundary (%s)', delta => {
    const root = mkdtempSync(join(tmpdir(), 'baseline-packet-boundary-'));
    try {
      const run = join(root, 'run'), archive = join(root, 'archive'); mkdirSync(run);
      const original = Buffer.alloc(baselinePacketChunkBytes + delta, 97);
      original[original.length - 1] = 122;
      writeFileSync(join(run, 'tree.json'), original);
      writeFileSync(join(run, 'empty.log'), '');
      const fingerprint = sha256('reviewed edition');
      const seal = retainBaselinePacket(run, archive, fingerprint, ['tree.json', 'empty.log']);
      rmSync(run, { recursive: true });
      const recovered = readBaselinePacket(seal, sha256(seal), fingerprint);
      expect(recovered.read('tree.json').equals(original)).toBe(true);
      expect(recovered.read('empty.log').length).toBe(0);
      expect(recovered.manifest.files.find(file => file.path === 'tree.json')!.blob.parts)
        .toHaveLength(delta > 0 ? 2 : 1);
      expect(() => recovered.read('missing.json')).toThrow('baseline_packet_missing_original');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('recovers a packet beyond the harness aggregate limit after restart and rejects last-chunk and seal substitutions', () => {
    const root = mkdtempSync(join(tmpdir(), 'baseline-packet-large-'));
    try {
      const run = join(root, 'run'), archive = join(root, 'archive'); mkdirSync(run);
      const original = Buffer.alloc(64 * 1024 * 1024 + 1, 113);
      original[original.length - 1] = 122;
      writeFileSync(join(run, 'tree.json'), original);
      const fingerprint = sha256('reviewed edition');
      const seal = retainBaselinePacket(run, archive, fingerprint, ['tree.json']);
      const sealHash = sha256(seal);
      rmSync(run, { recursive: true });
      const recovered = readBaselinePacket(seal, sealHash, fingerprint);
      expect(recovered.read('tree.json').equals(original)).toBe(true);
      const parts = recovered.manifest.files[0].blob.parts;
      expect(parts.length).toBeGreaterThan(8);
      const last = parts.at(-1)!.artifact, lastPath = join(archive, last.ref);
      const bytes = readFileSync(lastPath);
      writeFileSync(lastPath, Buffer.alloc(bytes.length, 33));
      expect(() => readBaselinePacket(seal, sealHash, fingerprint)).toThrow('baseline_packet_chunk_changed');
      writeFileSync(lastPath, bytes);
      expect(readBaselinePacket(seal, sealHash, fingerprint).read('tree.json').equals(original)).toBe(true);
      expect(() => readBaselinePacket(Buffer.concat([seal, Buffer.from('\n')]), sealHash, fingerprint))
        .toThrow('baseline_packet_seal_changed');
      expect(() => readBaselinePacket(seal, sealHash, sha256('substituted edition'))).toThrow('baseline_packet_edition');
      rmSync(lastPath); symlinkSync('/etc/passwd', lastPath);
      expect(() => readBaselinePacket(seal, sealHash, fingerprint)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([255, 256, 257, 1025])('retains all packet originals through fresh consumers at population %s', count => {
    const root = mkdtempSync(join(tmpdir(), 'baseline-packet-population-'));
    try {
      const run = join(root, 'run'), archive = join(root, 'archive'); mkdirSync(run);
      const paths = Array.from({ length: count }, (_, n) => 'request-' + String(n).padStart(4, '0') + '.json');
      for (const path of [...paths].reverse()) writeFileSync(join(run, path), path);
      const fingerprint = sha256('reviewed edition');
      const seal = retainBaselinePacket(run, archive, fingerprint, [...paths].reverse());
      expect(retainBaselinePacket(run, archive, fingerprint, paths)).toEqual(seal);
      rmSync(run, { recursive: true });
      const recovered = readBaselinePacket(seal, sha256(seal), fingerprint);
      expect(recovered.manifest.files.map(file => file.path)).toEqual(paths);
      for (const path of paths) expect(recovered.read(path).toString()).toBe(path);
      const last = recovered.manifest.files.at(-1)!.blob.parts[0].artifact;
      writeFileSync(join(archive, last.ref), 'changed decisive last original');
      expect(() => readBaselinePacket(seal, sha256(seal), fingerprint)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses duplicate, escaping, absent and redirected packet originals without sealing a prefix', () => {
    const root = mkdtempSync(join(tmpdir(), 'baseline-packet-refusal-'));
    try {
      const run = join(root, 'run'), archive = join(root, 'archive'); mkdirSync(run);
      writeFileSync(join(run, 'original.json'), 'original');
      symlinkSync('original.json', join(run, 'redirected.json'));
      const fingerprint = sha256('reviewed edition');
      for (const paths of [['original.json', 'original.json'], ['../outside.json'],
        ['original.json', 'absent.json'], ['redirected.json']])
        expect(() => retainBaselinePacket(run, archive, fingerprint, paths)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  async function installedFixture(run: (root: string) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), 'artifact-baseline-installed-'));
    try {
      mkdirSync(join(root, 'node_modules', 'runtime'), { recursive: true });
      writeFileSync(join(root, 'package.json'), '{"name":"original","version":"1.0.0"}');
      writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
        '': { name: 'original', version: '1.0.0' },
        'node_modules/runtime': { version: '1.0.0' },
      } }));
      writeFileSync(join(root, 'node_modules/runtime/package.json'), '{"name":"runtime","version":"1.0.0"}');
      writeFileSync(join(root, 'node_modules/runtime/native.node'), 'original native bytes');
      await run(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  it('refuses each substituted reviewed npm/node/ABI identity using the selected executable', () => {
    const expected = captureBaselineToolchain();
    expect(expected).toMatchObject({ nodeVersion: process.version, nativeAbi: process.versions.modules });
    expect(assertBaselineToolchain(expected)).toEqual(expected);
    for (const field of ['npmSha256', 'npmVersion', 'nodeVersion', 'nativeAbi'] as const)
      expect(() => assertBaselineToolchain({ ...expected, [field]: 'substituted' }), field)
        .toThrow('baseline_reviewed_toolchain_changed');
  }, 45_000);

  it('checks runtime custody against ledger-bound receipts before start and after stop', async () => {
    await installedFixture(async root => {
      const prepared = join(root, 'evidence'); mkdirSync(prepared);
      const tree = await captureBaselineInstalledTree(root), manifest = JSON.stringify(tree);
      const installed = { installedTreeSha256: tree.sha256, installedTreeManifestSha256: sha256(manifest) };
      const built = { installedTreeSha256: tree.sha256 };
      const installedPath = join(prepared, 'dependency-installed.json');
      const builtPath = join(prepared, 'dependency-edition-after-build.json');
      const manifestPath = join(prepared, 'dependency-installed-tree.json');
      writeFileSync(manifestPath, manifest);
      writeFileSync(installedPath, JSON.stringify(installed)); writeFileSync(builtPath, JSON.stringify(built));
      const fingerprint = sha256('original reviewed intent');
      const intent = { fingerprint, input: { toolchain: captureBaselineToolchain() }, events: [
        { kind: 'installed' as const, fingerprint, receiptRef: installedPath,
          receiptSha256: sha256(readFileSync(installedPath)) },
        { kind: 'built' as const, fingerprint, receiptRef: builtPath,
          receiptSha256: sha256(readFileSync(builtPath)) },
      ] };
      const before = await assertBaselineRuntimeCustody(root, prepared, intent);
      expect(before).toEqual({ installedTreeSha256: tree.sha256,
        installedTreeManifestSha256: sha256(manifest), toolchain: intent.input.toolchain });
      for (const kind of ['installed', 'built'] as const) {
        const missing = structuredClone(intent); missing.events = missing.events.filter(event => event.kind !== kind);
        await expect(assertBaselineRuntimeCustody(root, prepared, missing)).rejects.toThrow('baseline_runtime_receipt_missing:' + kind);
        const changedEdition = structuredClone(intent);
        changedEdition.events.find(event => event.kind === kind)!.fingerprint = sha256('different edition');
        await expect(assertBaselineRuntimeCustody(root, prepared, changedEdition)).rejects.toThrow('baseline_runtime_receipt_edition:' + kind);
        const path = kind === 'installed' ? installedPath : builtPath, original = readFileSync(path);
        writeFileSync(path, original + '\n');
        await expect(assertBaselineRuntimeCustody(root, prepared, intent)).rejects.toThrow('baseline_runtime_receipt_changed:' + kind);
        writeFileSync(path, original);
        const changedPath = structuredClone(intent);
        changedPath.events.find(event => event.kind === kind)!.receiptRef += '.substituted';
        await expect(assertBaselineRuntimeCustody(root, prepared, changedPath)).rejects.toThrow('baseline_runtime_receipt_path:' + kind);
      }
      writeFileSync(manifestPath, manifest + '\n');
      await expect(assertBaselineRuntimeCustody(root, prepared, intent)).rejects.toThrow('baseline_runtime_manifest_changed');
      writeFileSync(manifestPath, manifest);
      const substituted = { ...built, installedTreeSha256: sha256('different installed tree') };
      writeFileSync(builtPath, JSON.stringify(substituted));
      const substitutedIntent = structuredClone(intent);
      substitutedIntent.events[1].receiptSha256 = sha256(readFileSync(builtPath));
      await expect(assertBaselineRuntimeCustody(root, prepared, substitutedIntent)).rejects.toThrow('baseline_runtime_built_tree_identity');
      writeFileSync(builtPath, JSON.stringify(built));
      writeFileSync(join(root, 'node_modules/runtime/native.node'), 'changed while the host ran');
      await expect(assertBaselineRuntimeCustody(root, prepared, intent)).rejects.toThrow('baseline_installed_tree_changed');
      writeFileSync(join(root, 'node_modules/runtime/native.node'), 'original native bytes');
      expect(await assertBaselineRuntimeCustody(root, prepared, intent)).toEqual(before);
      rmSync(manifestPath); symlinkSync('dependency-installed.json', manifestPath);
      await expect(assertBaselineRuntimeCustody(root, prepared, intent)).rejects.toThrow('baseline_runtime_manifest_type');
    });
  }, 60_000);

  it('rejects byte, mode, hidden-file, population and link-target substitutions in the actual installed tree', async () => {
    await installedFixture(async root => {
      mkdirSync(join(root, 'node_modules/.bin'));
      symlinkSync('../runtime/native.node', join(root, 'node_modules/.bin/runtime'));
      const original = await captureBaselineInstalledTree(root);
      expect(original.entries).toContainEqual(expect.objectContaining({ path: 'node_modules/runtime/native.node',
        kind: 'file', sha256: sha256('original native bytes') }));
      expect(original.entries).toContainEqual(expect.objectContaining({ path: 'node_modules/.bin/runtime',
        kind: 'link', target: '../runtime/native.node', resolved: 'node_modules/runtime/native.node' }));
      writeFileSync(join(root, 'node_modules/runtime/native.node'), 'tampered native bytes');
      await expect(assertBaselineInstalledTree(root, original)).rejects.toThrow('baseline_installed_tree_changed');
      writeFileSync(join(root, 'node_modules/runtime/native.node'), 'original native bytes');
      await expect(assertBaselineInstalledTree(root, original)).resolves.toBeUndefined();
      chmodSync(join(root, 'node_modules/runtime/native.node'), 0o755);
      await expect(assertBaselineInstalledTree(root, original)).rejects.toThrow('baseline_installed_tree_changed');
      chmodSync(join(root, 'node_modules/runtime/native.node'), 0o644);
      writeFileSync(join(root, 'node_modules/.injected'), 'hidden');
      await expect(assertBaselineInstalledTree(root, original)).rejects.toThrow('baseline_installed_tree_changed');
      rmSync(join(root, 'node_modules/.injected'));
      rmSync(join(root, 'node_modules/.bin/runtime'));
      symlinkSync('../runtime/package.json', join(root, 'node_modules/.bin/runtime'));
      await expect(assertBaselineInstalledTree(root, original)).rejects.toThrow('baseline_installed_tree_changed');
      rmSync(join(root, 'node_modules/.bin/runtime'));
      symlinkSync('/etc/passwd', join(root, 'node_modules/.bin/runtime'));
      await expect(captureBaselineInstalledTree(root)).rejects.toThrow('baseline_installed_path');
    });
  }, 60_000);

  it('hashes workspace link targets and retains the strict lock and native runtime audit', async () => {
    await installedFixture(async root => {
      mkdirSync(join(root, 'packages/local'), { recursive: true });
      writeFileSync(join(root, 'packages/local/package.json'), '{"name":"local","version":"1.0.0"}');
      writeFileSync(join(root, 'packages/local/index.js'), 'original linked bytes');
      symlinkSync('../packages/local', join(root, 'node_modules/local'));
      const lockPath = join(root, 'package-lock.json'), lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      lock.packages['node_modules/local'] = { link: true, resolved: 'packages/local' };
      lock.packages['packages/local'] = { version: '1.0.0' };
      writeFileSync(lockPath, JSON.stringify(lock));
      const original = await captureBaselineInstalledTree(root);
      expect(original.entries).toContainEqual(expect.objectContaining({ path: 'packages/local/index.js',
        sha256: sha256('original linked bytes') }));
      writeFileSync(join(root, 'packages/local/index.js'), 'tampered linked bytes');
      await expect(assertBaselineInstalledTree(root, original)).rejects.toThrow('baseline_installed_tree_changed');
      rmSync(join(root, 'node_modules/runtime/package.json'));
      await expect(captureBaselineInstalledTree(root)).rejects.toThrow('baseline_installed_lock_audit');
    });
  }, 60_000);

  it.each([255, 256, 257, 1025])('keeps every installed file across a %i-entry census and repeated reads', async count => {
    await installedFixture(async root => {
      // Reverse creation order must not change the complete, sorted receipt.
      for (let n = count - 1; n >= 0; n--)
        writeFileSync(join(root, 'node_modules/runtime/file-' + n.toString().padStart(5, '0')), String(n));
      const original = await captureBaselineInstalledTree(root);
      expect(original.entries.filter(entry => entry.path.includes('/file-'))).toHaveLength(count);
      await expect(captureBaselineInstalledTree(root)).resolves.toEqual(original);
      const decisive = 'node_modules/runtime/file-' + (count - 1).toString().padStart(5, '0');
      expect(original.entries).toContainEqual(expect.objectContaining({ path: decisive, sha256: sha256(String(count - 1)) }));
      writeFileSync(join(root, decisive), 'changed after the boundary');
      await expect(assertBaselineInstalledTree(root, original)).rejects.toThrow('baseline_installed_tree_changed');
    });
  }, 60_000);

  it('binds the complete prelaunch input population and actual repair bytes before install', () => {
    const snapshot = new Map<string, Buffer | null>([['package.json', Buffer.from('{"name":"original"}')],
      ['package-lock.json', Buffer.from('original lock')], ['.npmrc', null]]);
    const graph = { '': { name: 'original' }, 'node_modules/runtime': { version: '1.0.0' } };
    const repaired = Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: graph }));
    const delta = Buffer.from(JSON.stringify({ packages: [{ path: 'node_modules/runtime', before: null,
      after: graph['node_modules/runtime'] }] }));
    const input = { selectedInputs: Object.fromEntries([...snapshot].map(([path, bytes]) =>
      [path, bytes === null ? null : sha256(bytes)])), plannedRepair: {
      lockSha256: sha256(repaired), packageDeltaSha256: sha256(delta),
      candidateGraphSha256: sha256(JSON.stringify(graph)),
    } };
    expect(assertBaselinePlannedRepair(input, new Map([...snapshot].reverse()), repaired, delta))
      .toEqual(Buffer.from(JSON.stringify(graph)));
    const missing = new Map(snapshot); missing.delete('.npmrc');
    const introduced = new Map(snapshot); introduced.set('npm-shrinkwrap.json', null);
    const changed = new Map(snapshot); changed.set('.npmrc', Buffer.from('legacy-peer-deps=true'));
    for (const invalid of [missing, introduced, changed])
      expect(() => assertBaselinePlannedRepair(input, invalid, repaired, delta))
        .toThrow('baseline_prelaunch_selected_inputs_changed');
    for (const field of ['lockSha256', 'packageDeltaSha256', 'candidateGraphSha256'] as const) {
      const replaced = structuredClone(input); replaced.plannedRepair[field] = '0'.repeat(64);
      expect(() => assertBaselinePlannedRepair(replaced, snapshot, repaired, delta), field)
        .toThrow('baseline_prelaunch_repair_changed');
    }
    expect(() => assertBaselinePlannedRepair(input, snapshot, Buffer.from(repaired + '\n'), delta))
      .toThrow('baseline_prelaunch_repair_changed');
    expect(() => assertBaselinePlannedRepair(input, snapshot, repaired, Buffer.from(delta + '\n')))
      .toThrow('baseline_prelaunch_repair_changed');
  });

  it.each([true, false])('keeps failure diagnostics in the real retained packet after cleanup (candidate bytes: %s)', async hasBytes => {
    const root = mkdtempSync(join(tmpdir(), 'artifact-baseline-packet-'));
    vi.stubEnv('VH_EVIDENCE_ROOT_BASE', join(root, 'canonical'));
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(root, 'mutex'));
    vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', join(root, 'pins'));
    try {
      const bytes = hasBytes ? Buffer.from('{"rejected":true}') : null;
      const receipt = { cleanup: { removed: true } };
      const candidate = { path: 'package-lock.json', bytes, sha256: bytes && sha256(bytes),
        size: bytes?.length ?? null, omission: hasBytes ? null : 'absent' };
      const result = await runHarness({
        contract: { name: 'task-artifacts-repair-failure', phases: [
          { id: 'prepare' }, { id: 'execute', dependsOn: ['prepare'] }, { id: 'teardown' },
        ] }, evidenceRoot: join(root, 'runs'), retainedArtifacts: baselineRepairFailureArtifacts,
        guardRails: [], runPhase: async phase => {
          if (phase.phase === 'prepare') {
            retainBaselineRepairFailure(phase.evidenceDir, Object.assign(new Error('rejected'), {
              metadataRepairFailure: { schemaVersion: 1, stage: 'validate-graph', candidate,
                resolution: { exitCode: 0 }, receipt },
            }));
            return { ok: false, reasonCode: 'metadata-repair-graph-local-target' };
          }
          expect(phase.phase).toBe('teardown');
          return { ok: true };
        },
      });
      expect(result.verdict).toBe('fail');
      expect(result.firstFailure?.reasonCode).toBe('metadata-repair-graph-local-target');
      // Exercise finalization's actual retained copy, after disposable evidence
      // is gone, using the same selectors as the full client baseline.
      rmSync(result.evidenceDir, { recursive: true, force: true });
      const retained = join(root, 'runs', 'retained', result.runId);
      const manifest = JSON.parse(readFileSync(join(retained, 'retained-artifacts.json'), 'utf8'));
      expect(manifest.selectors).toEqual(baselineRepairFailureArtifacts);
      const evidencePath = baselineRepairFailureArtifacts[1];
      const evidenceBytes = readFileSync(join(retained, evidencePath));
      expect(JSON.parse(evidenceBytes.toString())).toMatchObject({ stage: 'validate-graph', receipt,
        candidate: { omission: candidate.omission,
          evidenceFile: hasBytes ? 'dependency-lock-rejected.json' : null } });
      expect(manifest.artifacts).toContainEqual(expect.objectContaining({ path: evidencePath,
        sha256: sha256(evidenceBytes), bytes: evidenceBytes.length }));
      if (bytes) expect(readFileSync(join(retained, baselineRepairFailureArtifacts[0]))).toEqual(bytes);
      else expect(() => readFileSync(join(retained, baselineRepairFailureArtifacts[0]))).toThrow();
      expect(() => readFileSync(join(retained, 'phases/prepare/dependency-edition.json'))).toThrow();
    } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  });

  it('retains rejected bytes and cleanup receipt without treating them as a repaired edition', () => {
    const root = mkdtempSync(join(tmpdir(), 'artifact-baseline-rejection-'));
    try {
      const bytes = Buffer.from('{"rejected":true}');
      const candidate = { path: 'package-lock.json', bytes, sha256: sha256(bytes),
        size: bytes.length, omission: null };
      const receipt = { cleanup: { removed: true } };
      const resolution = { exitCode: 0 };
      const error = Object.assign(new Error('metadata-repair-graph-local-target'), {
        metadataRepairFailure: { schemaVersion: 1, stage: 'validate-graph', candidate, resolution, receipt },
      });
      retainBaselineRepairFailure(root, error);
      expect(readFileSync(join(root, 'dependency-lock-rejected.json'))).toEqual(bytes);
      const evidence = JSON.parse(readFileSync(join(root, 'dependency-repair-failure.json'), 'utf8'));
      expect(evidence).toEqual({ schemaVersion: 1, stage: 'validate-graph', receipt, resolution,
        candidate: { path: candidate.path, sha256: candidate.sha256, size: bytes.length,
          omission: null, evidenceFile: 'dependency-lock-rejected.json' } });
      expect(() => readFileSync(join(root, 'dependency-edition.json'))).toThrow();
      expect(() => retainBaselineRepairFailure(root, error)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects a source replacement even when dependency metadata is otherwise valid', () => {
    const root = mkdtempSync(join(tmpdir(), 'artifact-baseline-freeze-'));
    try {
      const content = 'original source\n';
      const files = [{ path: 'adapter.ts', content, sha256: sha256(content) }];
      writeFileSync(join(root, 'adapter.ts'), content);
      expect(assertFrozenBaselineSources(root, files)).toEqual([{ path: 'adapter.ts', sha256: sha256(content) }]);
      writeFileSync(join(root, 'adapter.ts'), 'candidate source\n');
      expect(() => assertFrozenBaselineSources(root, files)).toThrow('baseline_source_changed:adapter.ts');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('permits only the selected repaired lock and rejects changed or newly introduced input', () => {
    const root = mkdtempSync(join(tmpdir(), 'artifact-baseline-inputs-'));
    try {
      const manifest = Buffer.from('{"name":"selected"}');
      const lock = Buffer.from('original lock');
      const repaired = Buffer.from('repaired lock');
      const snapshot = new Map([['package.json', manifest], ['package-lock.json', lock],
        ['npm-shrinkwrap.json', null], ['.npmrc', null]]);
      writeFileSync(join(root, 'package.json'), manifest);
      writeFileSync(join(root, 'package-lock.json'), repaired);
      const output = { path: 'package-lock.json', bytes: repaired };
      expect(() => assertBaselineRepairInputs(root, snapshot, output)).not.toThrow();
      writeFileSync(join(root, '.npmrc'), 'legacy-peer-deps=true');
      expect(() => assertBaselineRepairInputs(root, snapshot, output)).toThrow('baseline_repair_input_changed:.npmrc');
      rmSync(join(root, '.npmrc'));
      writeFileSync(join(root, 'package.json'), '{"name":"different"}');
      expect(() => assertBaselineRepairInputs(root, snapshot, output)).toThrow('baseline_repair_input_changed:package.json');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects a new workspace selected after installation or build', () => {
    const root = mkdtempSync(join(tmpdir(), 'artifact-baseline-population-'));
    try {
      const manifest = Buffer.from('{"name":"selected","workspaces":["packages/*"]}');
      const lock = Buffer.from('{"lockfileVersion":3,"packages":{}}');
      writeFileSync(join(root, 'package.json'), manifest);
      writeFileSync(join(root, 'package-lock.json'), lock);
      const snapshot = new Map([['package.json', manifest], ['package-lock.json', lock],
        ['npm-shrinkwrap.json', null], ['.npmrc', null]]);
      expect(() => assertBaselineRepairInputs(root, snapshot)).not.toThrow();
      mkdirSync(join(root, 'packages', 'introduced'), { recursive: true });
      writeFileSync(join(root, 'packages', 'introduced', 'package.json'), '{"name":"introduced"}');
      expect(() => assertBaselineRepairInputs(root, snapshot)).toThrow('baseline_repair_input_population_changed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects untracked source while allowing ignored build caches', () => {
    const root = mkdtempSync(join(tmpdir(), 'artifact-baseline-tree-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
      git('init', '-q');
      writeFileSync(join(root, 'adapter.ts'), 'export const original = true;');
      writeFileSync(join(root, '.gitignore'), 'cache/\n');
      git('add', '.');
      git('-c', 'user.name=Baseline fixture', '-c', 'user.email=baseline@example.invalid',
        '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'frozen test source');
      mkdirSync(join(root, 'cache'));
      writeFileSync(join(root, 'cache', 'build.bin'), 'build cache');
      expect(baselineProductBoundary(root, []).changedPaths).toEqual([]);
      writeFileSync(join(root, 'introduced.ts'), 'export const replacement = true;');
      expect(() => baselineProductBoundary(root, [])).toThrow('baseline_product_tree_changed');
      expect(baselineProductBoundary(root, ['introduced.ts']).changedPaths).toEqual(['introduced.ts']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('retains complete changed and removed package metadata rather than version-only deltas', () => {
    const old = { lockfileVersion: 3, packages: { 'node_modules/a': { version: '1', integrity: 'old' },
      'node_modules/removed': { version: '2', optional: true } } };
    const next = { lockfileVersion: 3, packages: { 'node_modules/a': { version: '1', integrity: 'different',
      dependencies: { b: '^2' } } } };
    const delta = baselineLockDelta(Buffer.from(JSON.stringify(old)), Buffer.from(JSON.stringify(next)));
    expect(delta.packages).toEqual([
      { path: 'node_modules/a', before: old.packages['node_modules/a'], after: next.packages['node_modules/a'] },
      { path: 'node_modules/removed', before: old.packages['node_modules/removed'], after: null },
    ]);
    expect(delta.metadataBefore).toEqual({ lockfileVersion: 3 });
    expect(delta.metadataAfter).toEqual({ lockfileVersion: 3 });
  });
});
