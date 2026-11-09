import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureConfigurationSnapshot } from '@papercusp/test-config/configuration-snapshot';
import { linuxProcessIdentityFromStat } from '../lib/process-identity';
import { verifierSourceFiles } from '../lib/verifier-source';
import { preparePrivateOperatorApiBundle, produceCommittedReaderPrivateApiBundle, qualifyCommittedReaderSource,
  resolvePreparedCommittedReaderSource, resolvePreparedPrivateApiBundle, preparePrivateWorkerSources,
  observeCommittedReaderLoadedSources, privateBundleRuntimeEnv,
  assertCooperativeComparisonBoundary,
  type CommittedReaderClosure, type CommittedReaderPreparationInputs } from './private-http-workspace-preflight';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const temporary: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('cooperative observer comparison controls', () => {
  const boundary = () => {
    const expected = { epoch: '11111111-1111-4111-8111-111111111111',
      loaded: { observer: 'a'.repeat(64), runtime: 'b'.repeat(64), configuration: 'c'.repeat(64) },
      entry: { id: 'original-task-entry', atMs: 100 }, result: { id: 'original-business-result', atMs: 200 },
      observerIntervalIds: ['setup', 'observer-a', 'observer-b', 'hold'] };
    return { expected, observed: { epoch: expected.epoch, loaded: { ...expected.loaded },
      entry: { ...expected.entry }, result: { ...expected.result }, elapsedMs: 100, observerDeductionMs: 0,
      intervals: [{ id: 'setup', startMs: 50, endMs: 100 }, { id: 'observer-a', startMs: 110, endMs: 150 },
        { id: 'observer-b', startMs: 130, endMs: 170 }, { id: 'hold', startMs: 200, endMs: 350 }]
        .map(row => ({ ...row, parentAnchorRef: 'd'.repeat(64) })),
      exclusions: [{ intervalId: 'setup', kind: 'setup' as const }, { intervalId: 'hold', kind: 'post-result-hold' as const }],
      sourceEligibility: { preCaptureInstalled: true,
        supportedViews: ['cjs-node', 'cjs-bare', 'esm-named-node', 'esm-named-bare', 'esm-default-node', 'esm-default-bare'],
        unsupportedPaths: [] as string[] } } };
  };
  it('observer-runtime-config-hash-mismatch rejects actual drift even with identical requested settings', () => {
    for (const role of ['observer', 'runtime', 'configuration'] as const) {
      const f = boundary(); f.observed.loaded[role] = 'e'.repeat(64);
      expect(() => assertCooperativeComparisonBoundary(f)).toThrow(`Actually loaded ${role} differs`);
    }
    for (const field of ['preCaptureInstalled', 'supportedViews', 'unsupportedPaths'] as const) {
      const f = boundary();
      if (field === 'preCaptureInstalled') f.observed.sourceEligibility[field] = false;
      if (field === 'supportedViews') f.observed.sourceEligibility[field].pop();
      if (field === 'unsupportedPaths') f.observed.sourceEligibility[field].push('captured-native-addon-constructor');
      expect(() => assertCooperativeComparisonBoundary(f)).toThrow();
    }
  });
  it('task-clock-retains-in-interval-observer-work including overlap, wait and verification', () => {
    const f = boundary();
    expect(assertCooperativeComparisonBoundary(f)).toEqual({ scope: 'parent-observed-comparison-boundaries',
      instrumented: true, taskElapsedMs: 100, observerInTaskMs: 60, fullRuntimeQualification: 'unknown' });
    f.observed.elapsedMs = 40;
    expect(() => assertCooperativeComparisonBoundary(f)).toThrow('Task clock must retain');
    f.observed.elapsedMs = 100; f.observed.observerDeductionMs = 60;
    expect(() => assertCooperativeComparisonBoundary(f)).toThrow('No observer work may be subtracted');
    f.observed.observerDeductionMs = 0; f.observed.entry.atMs = 160;
    expect(() => assertCooperativeComparisonBoundary(f)).toThrow('Original task entry endpoint changed');
  });
  it('setup-and-post-result-hold-boundary-proof rejects missing, shifted and in-interval exclusions', () => {
    const f = boundary();
    f.observed.intervals[0].endMs = 101;
    expect(() => assertCooperativeComparisonBoundary(f)).toThrow('exclusion overlaps');
    f.observed.intervals[0].endMs = 100; f.observed.intervals[3].startMs = 199;
    expect(() => assertCooperativeComparisonBoundary(f)).toThrow('exclusion overlaps');
    f.observed.intervals[3].startMs = 200; f.observed.intervals[1].parentAnchorRef = '';
    expect(() => assertCooperativeComparisonBoundary(f)).toThrow('Independent parent clock anchor required');
    f.observed.intervals[1].parentAnchorRef = 'd'.repeat(64); f.observed.intervals.pop();
    expect(() => assertCooperativeComparisonBoundary(f)).toThrow('Missing or duplicate observer boundary receipt');
  });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'reader-source-preflight-')); temporary.push(dir);
  const root = join(dir, 'source'); const prepared = join(dir, 'prepare');
  mkdirSync(root); mkdirSync(prepared);
  for (const name of ['reader.test.ts', 'helper.ts', 'config.ts', 'import.ts', 'asset.sql']) writeFileSync(join(root, name), name);
  const source = { schemaVersion: 'verifier-source-v1', sourceCommit: 'a'.repeat(40),
    testedInputs: [{ path: 'reader.test.ts', sha256: digest('reader.test.ts') }], files: verifierSourceFiles(root) };
  writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(source));
  const sourceReceiptPath = join(dir, 'source-receipt.json'); writeFileSync(sourceReceiptPath, JSON.stringify(source));
  const modules = join(root, 'node_modules'); mkdirSync(modules);
  mkdirSync(join(modules, 'example'));
  writeFileSync(join(modules, 'example', 'package.json'), JSON.stringify({ name: 'example', main: 'index.js' }));
  writeFileSync(join(modules, 'example', 'index.js'), 'module.exports = 1');
  symlinkSync('../helper.ts', join(modules, 'workspace-helper'));
  // Match the private worker's maintained dependency resolution from its bundle.
  symlinkSync(modules, join(dir, 'node_modules'), 'dir');
  const bundle = join(prepared, 'hono-host.mjs'); writeFileSync(bundle, 'export const host = 1;');
  const copiedAsset = join(prepared, 'asset.sql'); writeFileSync(copiedAsset, 'asset.sql');
  const graph = { inputs: {
    'helper.ts': { imports: [{ path: 'import.ts' }, { path: 'example', external: true }, { path: 'node:fs', external: true }] },
    'import.ts': { imports: [] },
  }, outputs: { 'hono-host.mjs': { imports: [{ path: 'example', external: true }] } } };
  writeFileSync(`${bundle}.meta.json`, JSON.stringify(graph));
  const closure: CommittedReaderClosure = { sourceCommit: source.sourceCommit, sha256: digest(readFileSync(bundle)),
    metafileSha256: digest(readFileSync(`${bundle}.meta.json`)), testPaths: ['reader.test.ts'],
    helperPaths: ['helper.ts'], configPaths: ['config.ts'], executedImports: ['helper.ts', 'import.ts'],
    dependencyFiles: verifierSourceFiles(modules, { symlinkRoot: root }), externalResolutions: { example: 'node_modules/example/index.js' },
    copiedSources: ['asset.sql'], artifacts: [
      ...[bundle, `${bundle}.meta.json`].map(path => ({ path, sha256: digest(readFileSync(path)) })),
      { path: copiedAsset, sha256: digest('asset.sql'), sourcePath: 'asset.sql' },
    ],
    schema: { 'harness_shared.tool_invocations.args_json': digest('jsonb:not-null') },
    environment: { PAPERCUSP_BACKGROUND_WORKERS: digest('0') }, omitted: [], opaque: [] };
  const receiptPath = join(dir, 'operator-api-preflight.json');
  const save = () => writeFileSync(receiptPath, JSON.stringify(closure)); save();
  vi.stubEnv('VERIFY_TAURI_SOURCE_REF', source.sourceCommit);
  return { dir, root, bundle, closure, save, options: { root, bundle, receiptPath, sourceReceiptPath,
    selectedCommit: source.sourceCommit, schema: { ...closure.schema }, environment: { PAPERCUSP_BACKGROUND_WORKERS: '0' } } };
}

function prepareBuilder(f: ReturnType<typeof fixture>, script = 'test -f "$2"\n') {
  const bin = join(f.root, 'apps/operator/bin'); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'bundle-host.sh'), script);
  const source = JSON.parse(readFileSync(f.options.sourceReceiptPath, 'utf8'));
  source.files = verifierSourceFiles(f.root, { runtimeArtifacts: true });
  writeFileSync(join(f.root, '.verifier-source.json'), JSON.stringify(source));
  writeFileSync(f.options.sourceReceiptPath, JSON.stringify(source));
}

function producerFixture(extraScript = '') {
  const f = fixture();
  writeFileSync(join(f.root, 'builder-graph.json'), readFileSync(`${f.bundle}.meta.json`));
  prepareBuilder(f, 'printf "build\\n" >> "$2.builds"\nprintf "%s" "export const host = 1;" > "$2"\n'
    + 'cp builder-graph.json "$2.meta.json"\ncp asset.sql "$(dirname "$2")/asset.sql"\n'
    + 'ln -s "$PWD/node_modules" "$(dirname "$2")/node_modules"\n' + extraScript);
  for (const name of ['hono-host.mjs', 'hono-host.mjs.meta.json', 'asset.sql']) rmSync(join(f.dir, 'prepare', name));
  const { sha256: _bundle, metafileSha256: _graph, artifacts: _artifacts, ...pins } = f.closure;
  const inputs: CommittedReaderPreparationInputs = { ...pins, phase: 'planned',
    copiedArtifacts: [{ path: 'asset.sql', sourcePath: 'asset.sql' }] };
  const inputReceiptPath = join(f.dir, 'operator-api-preflight.json');
  const saveInputs = () => writeFileSync(inputReceiptPath, JSON.stringify(inputs)); saveInputs();
  const selected = { inputReceiptPath, sourceReceiptPath: f.options.sourceReceiptPath,
    selectedCommit: f.options.selectedCommit };
  const produce = () => produceCommittedReaderPrivateApiBundle(f.root, join(f.dir, 'prepare'), selected);
  const consume = () => preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'), { committedReader: {
    receiptPath: join(f.dir, 'prepare/operator-api-preflight.json'),
    sourceReceiptPath: join(f.dir, 'prepare/verifier-source.json'), selectedCommit: selected.selectedCommit,
  } });
  return { ...f, inputs, saveInputs, selected, produce, consume };
}

function observedBuildFixture(extraScript = '') {
  const f = producerFixture('test -f "$(dirname "$2")/operator-api-inputs.json"\n' + extraScript);
  const observedSource = { sourceReceiptPath: f.selected.sourceReceiptPath,
    sourceReceiptSha256: digest(readFileSync(f.selected.sourceReceiptPath)), selectedCommit: f.selected.selectedCommit };
  const produceObserved = () => preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'), { observedSource });
  return { ...f, observedSource, produceObserved };
}

function loadedFixture(source?: string, admit = true, buildObservationOnly = false, duplicatePreload = false,
  schema?: Record<string, string>, loaderCensus?: { events: number; bytes: number } | { batches: number; bytes: number },
  termination?: 'SIGKILL') {
  let f: ReturnType<typeof fixture>;
  if (buildObservationOnly) {
    const observed = observedBuildFixture(source === undefined ? '' : 'cp host-source.mjs "$2"\n');
    if (source !== undefined) {
      writeFileSync(join(observed.root, 'host-source.mjs'), source);
      prepareBuilder(observed, readFileSync(join(observed.root, 'apps/operator/bin/bundle-host.sh'), 'utf8'));
      observed.observedSource.sourceReceiptSha256 = digest(readFileSync(observed.selected.sourceReceiptPath));
    }
    observed.produceObserved(); f = observed;
  } else f = fixture();
  if (schema) { f.closure.schema = schema; f.options.schema = { ...schema }; f.save(); }
  const traceOut = join(f.dir, 'host-source.json');
  if (source !== undefined) {
    writeFileSync(f.bundle, source);
    f.closure.sha256 = digest(source);
    f.closure.artifacts.find(artifact => artifact.path === f.bundle)!.sha256 = f.closure.sha256;
    f.save();
  }
  const traceRoot = traceOut + '.native-processes';
  const startedAtMs = Date.now();
  const environment = privateBundleRuntimeEnv({ ...process.env, NODE_OPTIONS: '', NODE_PATH: '',
    PAPERCUSP_TEST_RUN_GROUP: 'reader-host-observed-run',
    PAPERCUSP_TEST_CONFIGURATION_SECRET: 'private-entry-value' }, {
    traceOut, loaderCensus, pinnedSources: admit ? [{ path: f.bundle, sha256: f.closure.sha256,
      byteLength: readFileSync(f.bundle).length }] : [],
  });
  // privateBundleRuntimeEnv already installs the tracer through NODE_OPTIONS.
  // Keep the explicit second preload only for the cache-gap refusal control.
  const child = spawnSync(process.execPath, [...(duplicatePreload ? ['--import', pathToFileURL(resolve(import.meta.dirname,
    '../../../scripts/lib/vitest-startup-trace.mjs')).href] : []), f.bundle], {
    cwd: f.root, env: environment,
    encoding: 'utf8', timeout: 15_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(termination ? null : 0);
  if (termination) expect(child.signal).toBe(termination);
  const terminalKernel = termination ? readdirSync(traceRoot).filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(traceRoot, name), 'utf8')))
    .find(row => row.event === 'node-entry')?.kernelProcessIdentity : undefined;
  const options = { ...f.options, traceOut, pid: child.pid, startedAtMs, finishedAtMs: Date.now(),
    runId: environment.PAPERCUSP_TEST_RUN_GROUP,
    configuration: captureConfigurationSnapshot(environment), loaderCensus,
    ...(termination ? { termination: { code: child.status, signal: child.signal }, kernelProcessIdentity: terminalKernel } : {}),
    ...(buildObservationOnly ? { preparationOnly: true as const, buildObservationOnly,
      receiptPath: join(f.dir, 'prepare/operator-api-preflight.json') } : {}) };
  if (admit && !duplicatePreload) {
    // Mutated negative controls must start from independently bound evidence.
    const baseline = observeCommittedReaderLoadedSources(options);
    expect(baseline).toMatchObject({ status: 'bound', gaps: [] });
    // Build-only receipts have no planned external-resolution contract. Their
    // actual returned edges are tested separately against retained source and
    // dependency bytes, without qualifying preparation or import closure.
    if (!buildObservationOnly && !termination) expect(baseline.resolutions).toMatchObject({ status: 'bound', gaps: [] });
  }
  const rows = readdirSync(traceRoot).filter(name => name.endsWith('.json'))
    .map(name => ({ name, row: JSON.parse(readFileSync(join(traceRoot, name), 'utf8')) }));
  const kernelProcessIdentity: string | undefined = rows.find(({ row }) => row.event === 'node-entry')?.row.kernelProcessIdentity;
  const replace = (event: string, mutate: (row: any) => void) => {
    const entry = rows.find(({ row }) => row.event === event)!;
    rmSync(join(traceRoot, entry.name)); mutate(entry.row);
    const bytes = JSON.stringify(entry.row);
    writeFileSync(join(traceRoot, digest(bytes) + '.json'), bytes);
  };
  const replaceAll = (mutate: (row: any) => void) => {
    for (const entry of rows) {
      rmSync(join(traceRoot, entry.name)); mutate(entry.row);
      const bytes = JSON.stringify(entry.row);
      entry.name = digest(bytes) + '.json';
      writeFileSync(join(traceRoot, entry.name), bytes);
    }
  };
  return { ...f, traceRoot, options, rows, replace, replaceAll, environment, nativeOutput: child.stdout,
    kernelProcessIdentity,
    observe: () => observeCommittedReaderLoadedSources(options) };
}

describe('committed reader loader-return source binding', () => {
  it('binds a self-kill census using a separate parent result while retaining shutdown qualification gaps', () => {
    const census = { batches: 128, bytes: 16 * 1024 ** 2 };
    const f = loadedFixture("process.kill(process.pid, 'SIGKILL');", true, false, false,
      undefined, census, 'SIGKILL');
    expect(f.observe()).toMatchObject({ status: 'bound', exitObserved: false,
      engineExecution: { status: 'observed' }, resolutions: { status: 'unknown' },
      configurationReads: { status: 'unknown' } });
    expect(observeCommittedReaderLoadedSources({ ...f.options, termination: undefined }))
      .toMatchObject({ status: 'unknown', gaps: ['native trace population incomplete'] });
    expect(observeCommittedReaderLoadedSources({ ...f.options, kernelProcessIdentity: 'other-kernel' }))
      .toMatchObject({ status: 'unknown', gaps: ['native trace population incomplete'] });
    expect(observeCommittedReaderLoadedSources({ ...f.options, termination: { code: null, signal: 'SIGTERM' } }))
      .toMatchObject({ status: 'unknown', gaps: ['native trace population incomplete'] });
  });

  it('binds independently enrolled census batches and rejects a missing terminal seal', () => {
    const loaderCensus = { batches: 128, bytes: 16 * 1024 ** 2 };
    const f = loadedFixture(undefined, true, false, false, undefined, loaderCensus);
    expect(f.observe()).toMatchObject({ status: 'bound', limits: { loaderCensus, resolves: 16384, loads: 16388 },
      resolutions: { status: 'bound', gaps: [] } });
    expect(observeCommittedReaderLoadedSources({ ...f.options, loaderCensus: { batches: 127, bytes: loaderCensus.bytes } }))
      .toMatchObject({ status: 'unknown', gaps: [expect.stringContaining('host loader census differs')] });
    const terminal = f.rows.find(({ row }) => row.event === 'module-census-end')!;
    rmSync(join(f.traceRoot, terminal.name));
    expect(f.observe()).toMatchObject({ status: 'unknown', gaps: ['native trace population incomplete'] });
  });

  it('binds the independently enrolled loader census and refuses altered or missing enrollment', () => {
    const loaderCensus = { events: 2048, bytes: 2 * 1024 ** 2 };
    const f = loadedFixture(undefined, true, false, false, undefined, loaderCensus);
    expect(f.observe()).toMatchObject({ status: 'bound', limits: { loaderCensus, resolves: 2048, loads: 2052 },
      resolutions: { status: 'bound', gaps: [] } });
    expect(observeCommittedReaderLoadedSources({ ...f.options, loaderCensus: undefined }))
      .toMatchObject({ status: 'unknown', gaps: [expect.stringContaining('Invalid bounded native loader census')] });
    f.replace('node-entry', row => { row.loaderCensus.events++; });
    expect(f.observe()).toMatchObject({ status: 'unknown',
      gaps: [expect.stringContaining('host loader census differs from independent enrollment')] });
  });

  it('keeps a duplicate preload cache hit without original loader bytes unknown', () => {
    const baseline = loadedFixture();
    expect(baseline.observe().resolutions).toMatchObject({ status: 'bound', gaps: [] });
    const duplicate = loadedFixture(undefined, true, false, true);
    const observed = duplicate.observe();
    expect(observed.resolutions.status).toBe('unknown');
    expect(observed.resolutions.gaps).toEqual(expect.arrayContaining([
      expect.stringContaining(pathToFileURL(resolve(import.meta.dirname,
        '../../../scripts/lib/vitest-startup-trace.mjs')).href),
    ]));
  });

  it('binds actual native external resolver returns to independently pinned loaded bytes', () => {
    const f = loadedFixture('import value from "example"; console.log(value);');
    const result = f.observe();
    expect(result.resolutions).toMatchObject({ status: 'bound', gaps: [] });
    expect(result.resolutions.edges).toContainEqual(expect.objectContaining({ specifier: 'example',
      parentURL: pathToFileURL(f.bundle).href,
      url: pathToFileURL(join(f.root, 'node_modules/example/index.js')).href }));
    expect(result.pending).toContain('runtime-config');
    expect(result.pending).toContain('complete-runtime-closure');
  });

  it('binds build-only resolver observations to retained dependency bytes without qualifying imports', () => {
    const f = loadedFixture('import value from "example"; console.log(value);', true, true);
    const result = f.observe();
    expect(result.resolutions).toMatchObject({ status: 'bound', gaps: [] });
    expect(result.resolutions.edges).toContainEqual(expect.objectContaining({ specifier: 'example',
      parentURL: pathToFileURL(f.bundle).href,
      url: pathToFileURL(join(f.root, 'node_modules/example/index.js')).href }));
    expect(result.pending).toEqual(expect.arrayContaining([
      'preparation-qualification', 'build-imports', 'observed-imports', 'complete-runtime-closure']));
    expect(() => qualifyCommittedReaderSource({ ...f.options, preparationOnly: true })).toThrow();
  });

  function resolverFailureFixture() {
    return loadedFixture(`try { await import('missing-reader-optional-dependency'); }
      catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
      const { default: value } = await import('example'); console.log(value);`);
  }

  it('accounts for caught resolver errors without inventing successful dependency edges', () => {
    const f = resolverFailureFixture(), observed = f.observe();
    const failure = f.rows.find(({ row }) => row.event === 'module-resolve-error')!;
    expect(f.nativeOutput.trim()).toBe('1');
    expect(observed.resolutions).toMatchObject({ status: 'bound', gaps: [], failures: [{
      resolveId: failure.row.resolveId, specifier: 'missing-reader-optional-dependency',
      errorCode: 'ERR_MODULE_NOT_FOUND', receiptSha256: failure.name.slice(0, 64),
    }] });
    expect(observed.resolutions.edges.some(edge => edge.specifier === 'missing-reader-optional-dependency')).toBe(false);
    expect(observed.resolutions.edges.some(edge => edge.specifier === 'example')).toBe(true);
    expect(observed.resolutions.edges.length + observed.resolutions.failures.length)
      .toBe(f.rows.filter(({ row }) => row.event === 'module-resolve-start').length);
    expect(observed.pending).toContain('complete-runtime-closure');
  });

  it.each(['missing', 'orphan', 'identity', 'isolate', 'timestamp', 'code', 'balanced-duplicate'] as const)(
    'keeps %s resolver error evidence unknown', mode => {
      const f = resolverFailureFixture();
      const failed = f.rows.find(({ row }) => row.event === 'module-resolve-error')!;
      if (mode === 'missing') rmSync(join(f.traceRoot, failed.name));
      else if (mode === 'balanced-duplicate') {
        const success = f.rows.find(({ row }) => row.event === 'module-resolve-return')!;
        rmSync(join(f.traceRoot, success.name));
        const duplicate = JSON.stringify({ ...failed.row, atMs: failed.row.atMs + 1 });
        writeFileSync(join(f.traceRoot, digest(duplicate) + '.json'), duplicate);
      } else f.replace('module-resolve-error', row => {
        if (mode === 'orphan') row.resolveId += 10_000;
        if (mode === 'identity') row.specifier += '-changed';
        if (mode === 'isolate') row.threadId++;
        if (mode === 'timestamp') {
          const start = f.rows.find(({ row: start }) => start.event === 'module-resolve-start'
            && start.resolveId === row.resolveId)!;
          row.atMs = start.row.atMs - 1;
        }
        if (mode === 'code') row.errorCode = 42;
      });
      expect(f.observe().resolutions).toMatchObject({ status: 'unknown', gaps: [expect.any(String)] });
    });

  it.each(['missing-return', 'unloaded', 'dependency-bytes', 'identity'] as const)(
    'refuses %s build-only resolver evidence without a planned resolution map', mode => {
      const f = loadedFixture('import value from "example"; console.log(value);', true, true);
      expect(f.observe().resolutions).toMatchObject({ status: 'bound', gaps: [] });
      const returned = f.rows.find(({ row }) => row.event === 'module-resolve-return'
        && row.specifier === 'example')!;
      if (mode === 'missing-return') rmSync(join(f.traceRoot, returned.name));
      else if (mode === 'dependency-bytes') writeFileSync(join(f.root, 'node_modules/example/index.js'), 'module.exports = 2');
      else {
        rmSync(join(f.traceRoot, returned.name));
        if (mode === 'unloaded') returned.row.url = pathToFileURL(join(f.root, 'helper.ts')).href;
        if (mode === 'identity') returned.row.specifier = 'other-package';
        const bytes = JSON.stringify(returned.row);
        writeFileSync(join(f.traceRoot, digest(bytes) + '.json'), bytes);
      }
      if (mode === 'dependency-bytes') expect(() => f.observe()).toThrow(/dependency census changed/);
      else expect(f.observe().resolutions.status).toBe('unknown');
    });

  it.each(['missing', 'pending', 'duplicate', 'identity', 'isolate', 'opaque', 'unloaded', 'limit',
    'terminal', 'external-pin'] as const)('keeps %s resolver evidence unknown', mode => {
    const f = loadedFixture('import value from "example"; console.log(value);');
    if (mode === 'missing' || mode === 'pending') {
      for (const item of f.rows) if (item.row.event === 'module-resolve-return' ||
          mode === 'missing' && item.row.event === 'module-resolve-start') rmSync(join(f.traceRoot, item.name));
    } else if (mode === 'terminal') {
      f.replace('node-exit', row => { row.exitListenersComplete = false; });
    } else if (mode === 'external-pin') {
      f.closure.externalResolutions.example = 'helper.ts'; f.save();
    } else {
      f.replace('module-resolve-return', row => {
        if (mode === 'duplicate') row.resolveId = 128;
        if (mode === 'identity') row.specifier += '-changed';
        if (mode === 'isolate') row.threadId = 99;
        if (mode === 'opaque') row.url = 'data:text/javascript,export default 1';
        if (mode === 'unloaded') row.url = pathToFileURL(join(f.root, 'helper.ts')).href;
        if (mode === 'limit') row.event = 'module-resolve-limit';
      });
    }
    // The independent closure validator may reject a changed planned external
    // before observation; neither route admits a substituted resolution.
    if (mode === 'external-pin') expect(() => f.observe()).toThrow(/resolution|external|mismatch/i);
    else {
      const result = f.observe();
      expect(result.resolutions.status).toBe('unknown');
      expect(result.resolutions.gaps.length).toBeGreaterThan(0);
    }
  });

  it('binds native pinned engine outer execution while an uncalled function stays unobserved', () => {
    const f = loadedFixture('export function uncalled() { return 4; } export const host = "🌱";');
    const observed = f.observe();
    expect(observed.engineExecution).toMatchObject({ status: 'observed', gaps: [],
      sourceTextSha256: f.closure.sha256 });
    expect(observed.engineExecution.coverageRanges).toContainEqual(expect.objectContaining({ functionName: 'uncalled', count: 0 }));
    expect(observed.pending).toContain('module-evaluation');
  });

  it('binds complete attached engine ranges without promoting them to full module closure', () => {
    const f = loadedFixture(Array.from({ length: 2000 }, (_, i) => `export function uncalled${i}() { return ${i}; }`).join('\n'));
    const observed = f.observe();
    expect(observed.engineExecution).toMatchObject({ status: 'observed', coverageRangesComplete: true });
    expect(observed.engineExecution.coverageRanges.length).toBeGreaterThan(2000);
    expect(observed.engineExecution.coverageRanges).toContainEqual(expect.objectContaining({ functionName: 'uncalled1999', count: 0 }));
    expect(observed.pending).toContain('module-evaluation');
  });

  it.each(['missing', 'digest', 'zero', 'offset', 'duplicate', 'isolate'] as const)(
    'keeps %s engine evidence unknown without weakening loader binding', mode => {
      const f = loadedFixture();
      if (mode === 'missing') rmSync(join(f.traceRoot, f.rows.find(({ row }) => row.event === 'engine-script-execution')!.name));
      else f.replace('engine-script-execution', row => {
        const script = row.observation.scripts[0];
        if (mode === 'digest') script.sourceTextSha256 = '0'.repeat(64);
        if (mode === 'zero') for (const range of script.coverageRanges) range.count = 0;
        if (mode === 'offset') script.coverageRanges[0].endOffset = script.sourceTextLength + 1;
        if (mode === 'duplicate') row.observation.scripts.push(script);
        if (mode === 'isolate') row.threadId = 1;
      });
      expect(f.observe()).toMatchObject({ status: 'bound', engineExecution: { status: 'unknown' } });
      expect(f.observe().engineExecution.gaps.length).toBeGreaterThan(0);
    });

  it.skipIf(process.platform !== 'linux')('binds a kernel process identity independently of the trace UUID', () => {
    const f = loadedFixture(`import { readFileSync } from 'node:fs';
      console.log(JSON.stringify({ boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'),
        stat: readFileSync('/proc/self/stat', 'utf8') }));`);
    const raw = JSON.parse(f.nativeOutput);
    const expected = linuxProcessIdentityFromStat(raw.boot, raw.stat);
    expect(expected).toMatch(/^linux:/);
    const observed = observeCommittedReaderLoadedSources({ ...f.options, kernelProcessIdentity: expected! });
    expect(observed).toMatchObject({ status: 'bound', gaps: [], kernelProcessIdentity: expected });
    expect(observed.processIdentity).toBe(f.rows.find(({ row }) => row.event === 'node-entry')!.row.processIdentity);
    expect(observed.processIdentity).not.toBe(expected);
    expect(observeCommittedReaderLoadedSources({ ...f.options,
      kernelProcessIdentity: observed.processIdentity! }).status).toBe('unknown');
  });

  it.each(['missing', 'wrong-pin', 'reused', 'mixed'] as const)(
    'keeps %s kernel process identity evidence unknown', control => {
      const f = loadedFixture();
      const expected = f.kernelProcessIdentity;
      expect(expected).toEqual(expect.any(String));
      if (control === 'missing') f.replace('node-entry', row => { delete row.kernelProcessIdentity; });
      if (control === 'reused') f.replaceAll(row => { row.kernelProcessIdentity = expected + '-reused'; });
      if (control === 'mixed') f.replace('module-load-return', row => { row.kernelProcessIdentity = expected + '-reused'; });
      const observed = observeCommittedReaderLoadedSources({ ...f.options,
        kernelProcessIdentity: control === 'wrong-pin' ? expected + '-wrong' : expected });
      expect(observed.status).toBe('unknown');
      expect(observed.gaps).toEqual(expect.arrayContaining([expect.stringContaining('kernel')]));
      expect(observed.pending).toContain('complete-runtime-closure');
    });

  it('binds original host entry inputs without retaining raw secret values or qualifying resolved config', () => {
    const f = loadedFixture("process.env.PAPERCUSP_TEST_CONFIGURATION_SECRET = 'changed-after-entry';");
    const observed = f.observe();
    expect(observed).toMatchObject({ status: 'bound', configurationInputs: {
      scope: 'native-node-entry-configuration-inputs', status: 'matched', gaps: [],
      snapshot: { envSha256: { PAPERCUSP_TEST_CONFIGURATION_SECRET: digest('private-entry-value') } },
    } });
    expect(observed.pending).toContain('runtime-config');
    expect(JSON.stringify(f.rows)).not.toContain('private-entry-value');
  });

  it('joins the actual loader entry to the independently selected run', () => {
    const f = loadedFixture();
    expect(f.observe()).toMatchObject({ status: 'bound', runId: 'reader-host-observed-run',
      configurationInputs: { status: 'matched' } });
  });

  it('retains the original run on every host event after the program changes its environment', () => {
    const f = loadedFixture("process.env.PAPERCUSP_TEST_RUN_GROUP = 'changed-after-entry';");
    expect(f.rows.length).toBeGreaterThan(0);
    expect(f.rows.every(({ row }) => row.runGroupId === f.options.runId)).toBe(true);
    expect(f.observe()).toMatchObject({ status: 'bound', gaps: [], runId: f.options.runId });
  });

  describe.each([false, true])('host event run custody (build observation: %s)', buildOnly => {
    it('preserves an optional independent run pin while requiring a valid event run identity', () => {
      const f = loadedFixture(undefined, true, buildOnly);
      const observe = () => observeCommittedReaderLoadedSources({ ...f.options, runId: undefined });
      expect(observe()).toMatchObject({ status: 'bound', gaps: [], runId: null });
      f.replaceAll(row => { row.runGroupId = null; });
      expect(observe()).toMatchObject({ status: 'bound', gaps: [], runId: null });
      expect(f.observe()).toMatchObject({ status: 'unknown', gaps: [expect.stringContaining('run')] });
      for (const invalid of [undefined, '', 42]) {
        f.replaceAll(row => { row.runGroupId = invalid; });
        expect(observe()).toMatchObject({ status: 'unknown', gaps: [expect.stringContaining('run')] });
      }
    });

    it.each(['module-load-start', 'module-load-return', 'module-resolve-start',
      'module-resolve-return', 'engine-script-execution', 'node-exit'] as const)(
      'refuses changed or missing run identity on %s', event => {
        const f = loadedFixture(undefined, true, buildOnly);
        expect(f.observe()).toMatchObject({ status: 'bound', gaps: [] });
        f.replaceAll(row => { if (row.event === event) row.runGroupId = 'other-run'; });
        expect(f.observe()).toMatchObject({ status: 'unknown',
          gaps: [expect.stringContaining('run')], pending: expect.arrayContaining(['complete-runtime-closure']) });
        f.replaceAll(row => { if (row.event === event) delete row.runGroupId; });
        expect(f.observe()).toMatchObject({ status: 'unknown', gaps: [expect.stringContaining('run')] });
      });
  });

  function loadedSqlFixture(change = '') {
    return loadedFixture(`import { channel } from 'node:diagnostics_channel';
      const observation = channel('papercusp:migration-transaction');
      const message = { attemptId: '11111111-1111-4111-8111-111111111111',
        file: 'asset.sql', migrationPath: new URL('./asset.sql', import.meta.url).pathname,
        rawSource: 'asset.sql', rawSourceSha256: '${digest('asset.sql')}',
        query: 'BEGIN; SELECT 1; COMMIT;', chunkIndex: 0, chunkCount: 1, attempt: 1, isFinalChunk: true };
      // Source pin is the independently archived asset, not the publication.
      message.migrationPath = new URL('../source/asset.sql', import.meta.url).pathname;
      ${change || "observation.publish({ ...message, phase: 'planned' }); observation.publish({ ...message, phase: 'returned' });"}`);
  }

  it('retains the actual planned and returned SQL bytes with independent raw-source pins', () => {
    const f = loadedSqlFixture(), observed = f.observe();
    expect(observed.appliedSql).toMatchObject({ status: 'observed', gaps: [], attempts: [{
      outcome: 'returned', rawSource: { sha256: digest('asset.sql') },
      query: { sha256: digest('BEGIN; SELECT 1; COMMIT;') } }] });
    const attempt = observed.appliedSql.attempts[0];
    expect(readFileSync(join(f.traceRoot, attempt.query.ref), 'utf8')).toBe('BEGIN; SELECT 1; COMMIT;');
    expect(observed.pending).toContain('private-pg');
  });

  it('retains a failed attempt followed by a successful retry without treating failure as application', () => {
    const f = loadedSqlFixture(`observation.publish({ ...message, phase: 'planned' });
      observation.publish({ ...message, phase: 'failed' });
      message.attemptId = '22222222-2222-4222-8222-222222222222'; message.attempt = 2;
      observation.publish({ ...message, phase: 'planned' }); observation.publish({ ...message, phase: 'returned' });`);
    expect(f.observe().appliedSql).toMatchObject({ status: 'observed', gaps: [],
      attempts: [{ outcome: 'failed', attempt: 1 }, { outcome: 'returned', attempt: 2 }] });
  });

  it('requires every transaction chunk to return before accepting the SQL observation', () => {
    const f = loadedSqlFixture(`message.chunkCount = 2; message.isFinalChunk = false;
      observation.publish({ ...message, phase: 'planned' }); observation.publish({ ...message, phase: 'returned' });
      message.chunkIndex = 1; message.isFinalChunk = true;
      message.attemptId = '22222222-2222-4222-8222-222222222222'; message.query = 'BEGIN; SELECT 2; COMMIT;';
      observation.publish({ ...message, phase: 'planned' }); observation.publish({ ...message, phase: 'returned' });`);
    expect(f.observe().appliedSql).toMatchObject({ status: 'observed', gaps: [],
      attempts: [{ chunkIndex: 0, outcome: 'returned' }, { chunkIndex: 1, outcome: 'returned' }] });
  });

  it('refuses valid retained SQL bytes whose original source differs from the independent pin', () => {
    expect(loadedSqlFixture().observe().appliedSql.status).toBe('observed');
    const f = loadedSqlFixture(`message.rawSource = 'changed'; message.rawSourceSha256 = '${digest('changed')}';
      observation.publish({ ...message, phase: 'planned' }); observation.publish({ ...message, phase: 'returned' });`);
    expect(f.observe().appliedSql).toMatchObject({ status: 'unknown',
      gaps: ['host SQL raw source lacks matching independent pin'] });
  });

  it.each(['missing', 'duplicate', 'unterminated', 'nonzero', 'run', 'process', 'kernel', 'isolate', 'late',
    'sequence', 'scope', 'pin', 'query', 'limited', 'bytes'] as const)(
    'keeps %s SQL evidence unknown', control => {
      const f = loadedSqlFixture();
      expect(f.observe().appliedSql.status).toBe('observed');
      const terminal = f.rows.find(({ row }) => row.event === 'migration-transaction' && row.phase === 'returned')!;
      const mutate = (fn: (row: any) => void) => {
        rmSync(join(f.traceRoot, terminal.name)); fn(terminal.row);
        const bytes = JSON.stringify(terminal.row); writeFileSync(join(f.traceRoot, digest(bytes) + '.json'), bytes);
      };
      if (control === 'missing') rmSync(join(f.traceRoot, terminal.name));
      else if (control === 'duplicate') {
        const bytes = JSON.stringify({ ...terminal.row, duplicate: true });
        writeFileSync(join(f.traceRoot, digest(bytes) + '.json'), bytes);
      } else if (control === 'unterminated') f.replace('node-exit', row => { row.exitListenersComplete = false; });
      else if (control === 'nonzero') f.replace('node-exit', row => { row.code = 1; });
      else if (control === 'bytes') writeFileSync(join(f.traceRoot, terminal.row.query.ref), 'changed');
      else mutate(row => {
        if (control === 'run') row.runGroupId = 'other-run';
        else if (control === 'process') row.processIdentity = 'other-process';
        else if (control === 'kernel') row.kernelProcessIdentity = 'other-kernel';
        else if (control === 'isolate') row.threadId++;
        else if (control === 'late') row.atMs = f.options.finishedAtMs + 1;
        else if (control === 'sequence') row.sequence++;
        else if (control === 'scope') row.scope = 'parent-planned-query';
        else if (control === 'pin') row.rawSource.sha256 = digest('other');
        else if (control === 'query') row.query = row.rawSource;
        else row.query.byteLength = 8 * 1024 * 1024 + 1;
      });
      expect(f.observe().appliedSql).toMatchObject({ status: 'unknown', gaps: [expect.any(String)] });
      expect(f.observe().pending).toContain('private-pg');
    });

  it.each([
    "observation.publish({ ...message, phase: 'planned' });",
    "observation.publish({ ...message, phase: 'returned' });",
    "observation.publish({ ...message, phase: 'planned' }); observation.publish({ ...message, phase: 'failed' });",
    "message.chunkCount = 2; message.isFinalChunk = false; observation.publish({ ...message, phase: 'planned' }); observation.publish({ ...message, phase: 'returned' });",
    "message.attempt = 2; observation.publish({ ...message, phase: 'planned' }); observation.publish({ ...message, phase: 'returned' });",
    "message.rawSource = 'changed'; message.rawSourceSha256 = 'x'; observation.publish({ ...message, phase: 'planned' });",
    "message.query = 'x'.repeat(8 * 1024 * 1024 + 1); observation.publish({ ...message, phase: 'planned' });",
  ])('refuses incomplete or invalid SQL publication %s', change => {
    expect(loadedSqlFixture().observe().appliedSql.status).toBe('observed');
    expect(loadedSqlFixture(change).observe().appliedSql).toMatchObject({ status: 'unknown', gaps: [expect.any(String)] });
  });

  function loadedSchemaFixture(messageChange = '', buildObservationOnly = false) {
    const column = { table_schema: 'harness_shared', table_name: 'tool_invocations', column_name: 'args_json',
      data_type: 'jsonb', udt_name: 'jsonb', is_nullable: 'NO', column_default: 'private-schema-default', ordinal_position: 1 };
    return loadedFixture(`import { channel } from 'node:diagnostics_channel';
      const row = ${JSON.stringify(column)};
      const message = { query: 'SELECT catalogue fixture', backendPid: 512, rows: [row] };
      ${messageChange}
      channel('papercusp:api-worker-schema').publish(message);`, true, buildObservationOnly, false,
    { 'harness_shared.tool_invocations.args_json': digest(JSON.stringify(column)) });
  }

  it('binds the same worker catalogue bytes while keeping applied SQL and private PG pending', () => {
    // This child publishes controlled catalogue rows. The real API/PG journey
    // remains separate; these controls verify only native retention and binding.
    const f = loadedSchemaFixture();
    const observed = f.observe();
    expect(observed.privateSchema).toMatchObject({ status: 'observed', gaps: [], backendPid: 512,
      schema: f.closure.schema, querySha256: digest('SELECT catalogue fixture'),
      receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(observed.pending).toContain('private-pg');
    expect(JSON.stringify(f.rows)).not.toContain('private-schema-default');
  });

  it('retains actual build-only worker schema without claiming prepared-schema agreement', () => {
    const f = loadedSchemaFixture('row.data_type = "text";', true);
    const observed = f.observe();
    expect(observed.privateSchema).toMatchObject({ status: 'observed', gaps: [], backendPid: 512,
      receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(observed.privateSchema.schema).not.toEqual(f.closure.schema);
    expect(observed.pending).toEqual(expect.arrayContaining(['preparation-qualification', 'private-pg']));
    expect(JSON.parse(readFileSync(f.options.receiptPath, 'utf8'))).toMatchObject({
      phase: 'build-observation', qualification: { status: 'pending' } });
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow();
  });

  it.each(['missing', 'bytes', 'invalid'] as const)(
    'refuses %s build-only worker schema evidence', control => {
      const f = loadedSchemaFixture('', true);
      expect(f.observe().privateSchema.status).toBe('observed');
      const entry = f.rows.find(({ row }) => row.event === 'api-worker-schema')!;
      if (control === 'missing') rmSync(join(f.traceRoot, entry.name));
      else if (control === 'bytes') writeFileSync(join(f.traceRoot, entry.row.artifact.ref), 'changed');
      else f.replace('api-worker-schema', row => { row.columns += 1; });
      expect(f.observe().privateSchema).toMatchObject({ status: 'unknown', schema: null,
        receiptSha256: null, gaps: [expect.any(String)] });
      expect(f.observe().pending).toEqual(expect.arrayContaining(['preparation-qualification', 'private-pg']));
    });

  it.each(['unexpected.schema', `${digest('opaque')}.catalogue`])(
    'refuses an unexpected trace artifact beside valid schema evidence: %s', name => {
      const f = loadedSchemaFixture();
      expect(f.observe().privateSchema.status).toBe('observed');
      writeFileSync(join(f.traceRoot, name), 'opaque');
      expect(f.observe()).toMatchObject({ status: 'unknown', gaps: ['unexpected native process artifact'],
        privateSchema: { status: 'unknown', schema: null } });
    });

  it.each(['missing', 'duplicate', 'unavailable', 'unterminated', 'run', 'process', 'kernel', 'isolate',
    'late', 'scope', 'backend', 'query', 'columns', 'reference', 'limited', 'bytes'] as const)(
    'keeps %s worker schema evidence unknown', control => {
      const f = loadedSchemaFixture();
      expect(f.observe().privateSchema.status).toBe('observed');
      const entry = f.rows.find(({ row }) => row.event === 'api-worker-schema')!;
      if (control === 'missing') rmSync(join(f.traceRoot, entry.name));
      else if (control === 'duplicate') {
        const bytes = JSON.stringify({ ...entry.row, duplicate: true });
        writeFileSync(join(f.traceRoot, digest(bytes) + '.json'), bytes);
      } else if (control === 'unterminated') f.replace('node-exit', row => { row.exitListenersComplete = false; });
      else if (control === 'bytes') writeFileSync(join(f.traceRoot, entry.row.artifact.ref), 'changed');
      else f.replace('api-worker-schema', row => {
        if (control === 'unavailable') row.event = 'api-worker-schema-unavailable';
        else if (control === 'run') row.runGroupId = 'another-run';
        else if (control === 'process') row.processIdentity = 'another-process';
        else if (control === 'kernel') row.kernelProcessIdentity = 'another-kernel';
        else if (control === 'isolate') row.threadId += 1;
        else if (control === 'late') row.atMs = f.options.finishedAtMs + 1;
        else if (control === 'scope') row.scope = 'parent-catalogue';
        else if (control === 'backend') row.backendPid = null;
        else if (control === 'query') row.querySha256 = null;
        else if (control === 'columns') row.columns += 1;
        else if (control === 'reference') row.artifact.ref = '../schema';
        else row.artifact.byteLength = 8 * 1024 * 1024 + 1;
      });
      expect(f.observe().privateSchema).toMatchObject({ status: 'unknown', schema: null,
        receiptSha256: null, gaps: [expect.any(String)] });
      expect(f.observe().pending).toContain('private-pg');
    });

  it.each(['message.unavailable = true;', 'message.rows = [];', 'message.rows = Array(32769).fill(row);',
    'message.rows.push(row);', 'row.ordinal_position = 0;', 'row.table_schema = "other";',
    'message.backendPid = 0;', 'row.column_default = "x".repeat(65537);'])(
    'refuses invalid or limited worker catalogue publication: %s', change => {
      expect(loadedSchemaFixture().observe().privateSchema.status).toBe('observed');
      const f = loadedSchemaFixture(change);
      expect(f.observe().privateSchema).toMatchObject({ status: 'unknown',
        gaps: ['host schema capture incomplete'] });
    });

  it('refuses changed catalogue values without filling from the parent prediction', () => {
    expect(loadedSchemaFixture().observe().privateSchema.status).toBe('observed');
    const observed = loadedSchemaFixture('row.data_type = "text";').observe();
    expect(observed.privateSchema).toMatchObject({ status: 'unknown', schema: null,
      gaps: ['actual API worker schema differs from preparation'] });
  });

  it('retains actual configuration gets through exit listeners, mutations and unset values', () => {
    const f = loadedFixture(`
      void process.env.PAPERCUSP_TEST_CONFIGURATION_SECRET;
      process.env.PAPERCUSP_TEST_CONFIGURATION_SECRET = 'mutated-private-value';
      void process.env.PAPERCUSP_TEST_CONFIGURATION_SECRET;
      process.on('exit', () => {
        delete process.env.PAPERCUSP_TEST_CONFIGURATION_SECRET;
        void process.env.PAPERCUSP_TEST_CONFIGURATION_SECRET;
      });
    `);
    const observed = f.observe();
    expect(observed.configurationReads).toMatchObject({ status: 'observed', gaps: [],
      receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/), observation: {
        scope: 'javascript-configuration-property-gets', populationStatus: 'unknown',
        captureComplete: true, activeAtTermination: true,
      } });
    expect(observed.configurationReads.observation!.reads.filter(row =>
      row.key === 'PAPERCUSP_TEST_CONFIGURATION_SECRET')).toEqual([
      { key: 'PAPERCUSP_TEST_CONFIGURATION_SECRET', sha256: digest('private-entry-value') },
      { key: 'PAPERCUSP_TEST_CONFIGURATION_SECRET', sha256: digest('mutated-private-value') },
      { key: 'PAPERCUSP_TEST_CONFIGURATION_SECRET', sha256: null },
    ]);
    expect(JSON.stringify(f.rows)).not.toContain('mutated-private-value');
    expect(observed.pending).toContain('runtime-config');
  });

  it.each(['missing', 'duplicate', 'invalid', 'limited', 'replaced', 'unterminated',
    'isolate', 'before-exit', 'terminal-order'] as const)('keeps %s configuration read evidence unknown', control => {
    const f = loadedFixture();
    expect(f.observe().configurationReads).toMatchObject({ status: 'observed', gaps: [] });
    if (control === 'missing') {
      rmSync(join(f.traceRoot, f.rows.find(({ row }) => row.event === 'configuration-reads')!.name));
    } else if (control === 'duplicate') {
      const receipt = f.rows.find(({ row }) => row.event === 'configuration-reads')!.row;
      const bytes = JSON.stringify({ ...receipt, duplicate: true });
      writeFileSync(join(f.traceRoot, digest(bytes) + '.json'), bytes);
    } else if (control === 'unterminated') {
      f.replace('node-exit', row => { row.exitListenersComplete = false; });
    } else f.replace('configuration-reads', row => {
      if (control === 'invalid') row.observation.reads = [{ key: 'NODE_ENV', sha256: 'invalid' }];
      else if (control === 'limited') row.observation.captureComplete = false;
      else if (control === 'replaced') row.observation.activeAtTermination = false;
      else if (control === 'isolate') row.threadId += 1;
      else if (control === 'before-exit') row.atMs = f.rows.find(({ row }) => row.event === 'node-exit-start')!.row.atMs - 1;
      else row.atMs = f.options.finishedAtMs + 1;
    });
    expect(f.observe().configurationReads).toMatchObject({ status: 'unknown', observation: null,
      receiptSha256: null, gaps: [expect.any(String)] });
    expect(f.observe().pending).toContain('runtime-config');
  });

  it.each(['process', 'kernel', 'run'] as const)('refuses cross-%s configuration receipt identity', control => {
    const f = loadedFixture();
    expect(f.observe().configurationReads.status).toBe('observed');
    f.replace('configuration-reads', row => {
      if (control === 'process') row.processIdentity = 'another-process';
      else if (control === 'kernel') row.kernelProcessIdentity = 'another-kernel-process';
      else row.runGroupId = 'another-api-run';
    });
    // The run is selected by the authenticated entry; a per-receipt run field
    // cannot override it or substitute another cohort.
    const observed = f.observe();
    expect(observed.configurationReads.status).toBe('unknown');
  });

  it('keeps actual read overflow unknown without changing native return values', () => {
    const f = loadedFixture(`for (let i = 0; i < 513; i++) {
      if (process.env.PAPERCUSP_TEST_CONFIGURATION_SECRET !== 'private-entry-value') throw Error('changed return');
    }`);
    expect(f.observe().configurationReads).toMatchObject({ status: 'unknown',
      gaps: ['host configuration read capture limited or replaced'] });
  });

  it.each(['missing', 'different', 'empty-selection'] as const)(
    'refuses a %s run identity instead of stitching another entry', control => {
      const f = loadedFixture();
      if (control === 'empty-selection') f.options.runId = '';
      else f.replace('node-entry', row => {
        if (control === 'missing') delete row.runGroupId;
        else row.runGroupId = 'another-api-run';
      });
      const observed = f.observe();
      expect(observed).toMatchObject({ status: 'unknown', runId: null });
      expect(observed.gaps).toEqual(expect.arrayContaining([expect.stringContaining('run')]));
      expect(observed.pending).toContain('runtime-config');
      expect(observed.pending).toContain('private-pg');
    });

  it('keeps a differing prelaunch configuration unknown without confusing it with source binding', () => {
    const f = loadedFixture();
    f.options.configuration = captureConfigurationSnapshot({ ...f.environment,
      PAPERCUSP_TEST_CONFIGURATION_SECRET: 'different-launch-input' });
    expect(f.observe()).toMatchObject({ status: 'bound', configurationInputs: {
      status: 'unknown', gaps: [expect.stringContaining('configuration inputs differ')],
    } });
  });

  it.each(['missing', 'altered'] as const)('keeps %s entry configuration unknown instead of using parent inputs', mode => {
    const f = loadedFixture();
    f.replace('node-entry', row => {
      if (mode === 'missing') delete row.configuration;
      else row.configuration.envSha256.PAPERCUSP_TEST_CONFIGURATION_SECRET = digest('altered');
    });
    expect(f.observe()).toMatchObject({ status: 'bound', configurationInputs: {
      status: 'unknown', snapshot: null, gaps: ['host entry configuration snapshot missing or invalid'],
    } });
  });

  it('cannot infer independent launch pins from a valid host entry snapshot', () => {
    const f = loadedFixture();
    expect(observeCommittedReaderLoadedSources({ ...f.options, configuration: undefined }))
      .toMatchObject({ status: 'bound', configurationInputs: { status: 'unknown',
        gaps: ['independent prelaunch configuration snapshot missing or invalid'] } });
  });

  it('binds original build observations while preserving missing preparation and runtime qualification', () => {
    const f = loadedFixture(undefined, true, true);
    expect(f.observe()).toMatchObject({ status: 'bound', gaps: [],
      sources: [{ sha256: f.closure.sha256 }], pending: expect.arrayContaining([
        'preparation-qualification', 'observed-imports', 'module-evaluation', 'runtime-config',
        'private-pg', 'sidecars', 'complete-runtime-closure']) });
    expect(() => qualifyCommittedReaderSource({ ...f.options, preparationOnly: true })).toThrow();
  });

  it('binds an independently pinned product-sized bundle above both generic byte ceilings', () => {
    // The measured private operator bundle was 81,830,447 bytes. Keep this
    // regression large enough to exercise both the old 16MiB and 64MiB limits.
    const source = '/*' + ' '.repeat(81_830_447) + '*/export const host = 1;';
    const f = loadedFixture(source);
    const observed = f.observe();
    expect(observed).toMatchObject({ status: 'bound', gaps: [],
      sources: [{ sha256: digest(source), byteLength: Buffer.byteLength(source) }] });
    expect(observed.pending).toContain('complete-runtime-closure');
    // Existing files must not backfill altered loader artifacts.
    const load = f.rows.find(({ row }) => row.event === 'module-load-return')!.row;
    writeFileSync(join(f.traceRoot, load.source.ref), 'altered retained bytes');
    expect(f.observe().status).toBe('unknown');
  });

  it('keeps an unadmitted large source unknown with the original generic limits', () => {
    const f = loadedFixture('/*' + ' '.repeat(16 * 1024 ** 2) + '*/', false);
    expect(f.observe()).toMatchObject({ status: 'unknown',
      limits: { sourceBytes: 16 * 1024 ** 2, processBytes: 64 * 1024 ** 2 } });
    expect(f.rows.find(({ row }) => row.event === 'module-load-return')!.row.source.status).toBe('limit');
  });

  it('binds real Node returned bundle bytes and preserves all broader runtime gaps', () => {
    const f = loadedFixture();
    const observed = f.observe();
    expect(observed).toMatchObject({ status: 'bound', scope: 'node-loader-returned-source', gaps: [],
      sourceCommit: f.options.selectedCommit, population: { complete: true }, exitObserved: true,
      sources: [{ url: pathToFileURL(f.bundle).href, sha256: f.closure.sha256,
        byteLength: readFileSync(f.bundle).length }] });
    expect(observed.processIdentity).toBe(f.rows.find(({ row }) => row.event === 'node-entry')!.row.processIdentity);
    expect(observed.pending).toEqual(['module-evaluation', 'runtime-config', 'private-pg', 'sidecars',
      'descendant-imports', 'complete-runtime-closure']);
    expect(observeCommittedReaderLoadedSources({ ...f.options, kernelProcessIdentity: 'another-process' }).status).toBe('unknown');
  });

  it.each(['bytes', 'artifact', 'limit', 'load-limit', 'pending', 'entry', 'identity', 'cwd', 'unpinned', 'event-hash'] as const)(
    'keeps %s evidence unknown instead of substituting the current file', control => {
      const f = loadedFixture();
      const load = f.rows.find(({ row }) => row.event === 'module-load-return')!.row;
      if (control === 'bytes') f.replace('module-load-return', row => {
        const bytes = 'different loader return'; const sha256 = digest(bytes);
        writeFileSync(join(f.traceRoot, sha256 + '.source'), bytes);
        row.source = { ...row.source, sha256, ref: sha256 + '.source', byteLength: Buffer.byteLength(bytes) };
      });
      if (control === 'artifact') rmSync(join(f.traceRoot, load.source.ref));
      if (control === 'limit') f.replace('module-load-return', row => { row.source.status = 'limit'; });
      if (control === 'load-limit') {
        const entry = f.rows.find(({ row }) => row.event === 'node-entry')!.row;
        const bytes = JSON.stringify({ ...entry, event: 'module-load-limit', limit: 128 });
        writeFileSync(join(f.traceRoot, digest(bytes) + '.json'), bytes);
      }
      if (control === 'entry') rmSync(join(f.traceRoot, f.rows.find(({ row }) => row.event === 'node-entry')!.name));
      if (control === 'pending') {
        const entry = f.rows.find(({ row }) => row.event === 'module-load-return')!;
        rmSync(join(f.traceRoot, entry.name));
      }
      if (control === 'identity') f.replace('module-load-return', row => { row.processIdentity = 'reused-pid'; });
      if (control === 'cwd') f.replace('node-entry', row => { row.cwd = f.dir; });
      if (control === 'unpinned') {
        const url = pathToFileURL(join(f.root, 'unobserved.mjs')).href;
        f.replace('module-load-start', row => { row.url = url; });
        f.replace('module-load-return', row => { row.url = url; });
      }
      if (control === 'event-hash') {
        const entry = f.rows.find(({ row }) => row.event === 'node-entry')!;
        writeFileSync(join(f.traceRoot, entry.name), JSON.stringify({ ...entry.row, cwd: f.dir }));
      }
      const observed = f.observe();
      expect(observed.status).toBe('unknown');
      expect(observed.gaps.length).toBeGreaterThan(0);
      expect(observed.pending).toContain('complete-runtime-closure');
      expect(readFileSync(f.bundle, 'utf8')).toBe('export const host = 1;');
    });

  it('refuses drifted independent preparation rather than qualifying a loader claim', () => {
    const f = loadedFixture();
    writeFileSync(f.bundle, 'changed artifact');
    expect(() => f.observe()).toThrow(/Prepared artifact changed/);
  });
});

describe('private worker source selection before allocation', () => {
  const committedEnv = { NODE_OPTIONS: '--import=/repo/scripts/lib/committed-source-loader.mjs' };
  it('refuses mutable private proof even when named HEAD bytes match', () => {
    const f = fixture();
    rmSync(join(f.root, '.verifier-source.json'));
    const reader = vi.fn(() => Buffer.from('helper.ts'));
    expect(() => preparePrivateWorkerSources(f.root, ['helper.ts'], committedEnv, reader))
      .toThrow(/independent verifier source receipt/);
    expect(reader).not.toHaveBeenCalled();
  });
  it('refuses a frozen private proof without its independent receipt before any HEAD read', () => {
    const f = fixture(); const reader = vi.fn(() => Buffer.from('helper.ts'));
    expect(() => preparePrivateWorkerSources(f.root, ['helper.ts'], {}, reader))
      .toThrow(/independent verifier source receipt/);
    expect(reader).not.toHaveBeenCalled();
  });
  it('rejects a changed worker helper that the inherited loader would replace with HEAD', () => {
    const f = fixture();
    expect(() => preparePrivateWorkerSources(f.root, ['helper.ts'],
      { ...committedEnv, VERIFY_TAURI_SOURCE_RECEIPT: f.options.sourceReceiptPath },
      () => Buffer.from('older helper'))).toThrow(/different HEAD bytes: helper.ts/);
  });
  it('records exact matching committed inputs and fails closed when their HEAD read fails', () => {
    const f = fixture();
    const env = { ...committedEnv, VERIFY_TAURI_SOURCE_RECEIPT: f.options.sourceReceiptPath };
    expect(preparePrivateWorkerSources(f.root, ['helper.ts'], env,
      () => Buffer.from('helper.ts'))).toMatchObject({ loader: 'committed-source',
      files: [{ path: 'helper.ts', sha256: digest('helper.ts') }] });
    expect(() => preparePrivateWorkerSources(f.root, ['helper.ts'], env,
      () => { throw new Error('HEAD unreadable'); })).toThrow('HEAD unreadable');
  });
  it('pins the frozen receipt without a HEAD loader and refuses selected source drift', () => {
    const f = fixture(); const reader = vi.fn(() => { throw new Error('must not read HEAD'); });
    const env = { VERIFY_TAURI_SOURCE_RECEIPT: f.options.sourceReceiptPath,
      VERIFY_TAURI_SOURCE_REF: f.options.selectedCommit };
    expect(preparePrivateWorkerSources(f.root, ['helper.ts'], env, reader)).toMatchObject({
      loader: 'verifier-source', files: [{ path: 'helper.ts', sha256: digest('helper.ts') }],
      frozenSource: { sourceCommit: f.options.selectedCommit, receiptPath: f.options.sourceReceiptPath,
        receiptSha256: digest(readFileSync(f.options.sourceReceiptPath)) },
    });
    expect(reader).not.toHaveBeenCalled();
    expect(() => preparePrivateWorkerSources(f.root, ['helper.ts'], { ...env, VERIFY_TAURI_SOURCE_REF: 'b'.repeat(40) }))
      .toThrow(/selected source differs/);
    writeFileSync(join(f.root, 'helper.ts'), 'peer drift');
    expect(() => preparePrivateWorkerSources(f.root, ['helper.ts'], env, reader))
      .toThrow(/tampered verification source archive: changed helper.ts/);
    expect(reader).not.toHaveBeenCalled();
  });
  it('preserves working-source execution without invoking a committed reader when no loader selects HEAD', () => {
    const f = fixture(); const reader = vi.fn(() => { throw new Error('must not read HEAD'); });
    rmSync(join(f.root, '.verifier-source.json'));
    expect(preparePrivateWorkerSources(f.root, ['helper.ts'], {}, reader).loader).toBe('working-source');
    expect(reader).not.toHaveBeenCalled();
  });
});

describe('original build observations without runtime qualification', () => {
  it('admits the builder dependency link only to the independently pinned source dependencies', () => {
    const f = observedBuildFixture();
    const built = f.produceObserved();
    const receipt = JSON.parse(readFileSync(join(f.dir, 'prepare/operator-api-preflight.json'), 'utf8'));
    expect(built.qualification).toEqual({ status: 'pending' });
    expect(receipt.artifactCensus.some((file: { path: string }) => file.path === 'node_modules')).toBe(false);
    expect(receipt.artifactCensus.every((file: { kind: string }) => file.kind === 'file')).toBe(true);
    expect(receipt.dependencyFiles).toEqual(f.closure.dependencyFiles);
    expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
  });

  it.each(['foreign', 'dangling', 'directory', 'missing'] as const)(
    'refuses an unpinned %s runtime dependency binding after compilation', dimension => {
      const script = 'rm "$(dirname "$2")/node_modules"\n' + (dimension === 'missing' ? ''
        : dimension === 'directory' ? 'mkdir "$(dirname "$2")/node_modules"\n'
        : (dimension === 'foreign' ? 'mkdir "$(dirname "$2")/foreign"\n' : '')
          + `ln -s "$(dirname "$2")/${dimension}" "$(dirname "$2")/node_modules"\n`);
      const f = observedBuildFixture(script);
      expect(() => f.produceObserved()).toThrow(/Prepared runtime dependency binding differs/);
      expect(existsSync(join(f.dir, 'prepare/operator-api-preflight.json'))).toBe(false);
      expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
    });

  it('admits archive workspace links through preparation and dependency recheck', () => {
    const f = observedBuildFixture();
    const built = f.produceObserved();
    const inputs = JSON.parse(readFileSync(join(f.dir, 'prepare/operator-api-inputs.json'), 'utf8'));
    expect(inputs.dependencyFiles).toContainEqual({ path: 'workspace-helper', kind: 'symlink',
      executable: true, sha256: digest('../helper.ts') });
    expect(built.qualification).toEqual({ status: 'pending' });
    expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
  });

  it('refuses an escaping workspace link before invoking the compiler', () => {
    const f = observedBuildFixture();
    writeFileSync(join(f.dir, 'external.ts'), 'external');
    const link = join(f.root, 'node_modules/workspace-helper');
    rmSync(link); symlinkSync('../../external.ts', link);
    expect(() => f.produceObserved()).toThrow(/archive symlink escapes source root/);
    expect(existsSync(`${f.bundle}.builds`)).toBe(false);
  });

  it('refuses workspace link retargeting during compilation', () => {
    const f = observedBuildFixture('rm node_modules/workspace-helper\nln -s ../import.ts node_modules/workspace-helper\n');
    expect(() => f.produceObserved()).toThrow(/Materialized dependencies changed during build/);
    expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
    expect(existsSync(join(f.dir, 'prepare/operator-api-preflight.json'))).toBe(false);
  });

  it('retains independent inputs before compilation and refuses them at the qualified consumer', () => {
    const f = observedBuildFixture();
    const built = f.produceObserved();
    const inputs = JSON.parse(readFileSync(join(f.dir, 'prepare/operator-api-inputs.json'), 'utf8'));
    expect(inputs).toEqual({ phase: 'build-observation', sourceCommit: f.selected.selectedCommit,
      dependencyFiles: f.closure.dependencyFiles });
    expect(built).toMatchObject({ path: f.bundle, qualification: { status: 'pending' },
      receiptSha256: digest(readFileSync(join(f.dir, 'prepare/operator-api-preflight.json'))) });
    expect(() => f.consume()).toThrow();
    expect(() => resolvePreparedCommittedReaderSource(['--prepared-api-sha=' + built.sha256,
      '--prepared-receipt-sha=' + built.receiptSha256], join(f.dir, 'execute'))).toThrow();
    expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
    expect(() => f.produceObserved()).toThrow(/archive symlink escapes source root/);
    rmSync(join(f.dir, 'prepare/node_modules'));
    expect(() => f.produceObserved()).toThrow(/fresh preparation directory/);
  });

  it('hands original build observations to the explicit private fixture without promoting qualification', () => {
    const f = observedBuildFixture(), built = f.produceObserved();
    const argv = ['--prepared-api-sha=' + built.sha256, '--prepared-receipt-sha=' + built.receiptSha256];
    const selection = resolvePreparedCommittedReaderSource(argv, join(f.dir, 'execute'),
      { buildObservationOnly: true, root: f.root });
    expect(selection).toEqual({ sourceReceiptPath: join(f.dir, 'prepare/verifier-source.json'),
      selectedCommit: f.selected.selectedCommit, sourceReceiptSha256: f.observedSource.sourceReceiptSha256,
      receiptSha256: built.receiptSha256 });
    expect(JSON.parse(readFileSync(join(f.dir, 'prepare/operator-api-preflight.json'), 'utf8')).qualification)
      .toEqual({ status: 'pending' });
    expect(() => resolvePreparedCommittedReaderSource(argv, join(f.dir, 'execute'))).toThrow();
    expect(() => f.consume()).toThrow();
    expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
  });

  it.each(['source', 'dependencies', 'inputs', 'artifact', 'bundle', 'receipt'] as const)(
    'refuses changed %s at the explicit observation handoff', dimension => {
      const f = observedBuildFixture(), built = f.produceObserved();
      const path = dimension === 'source' ? join(f.dir, 'prepare/verifier-source.json')
        : dimension === 'dependencies' ? join(f.root, 'node_modules/example/index.js')
        : dimension === 'inputs' ? join(f.dir, 'prepare/operator-api-inputs.json')
        : dimension === 'artifact' ? join(f.dir, 'prepare/asset.sql')
        : dimension === 'bundle' ? f.bundle : join(f.dir, 'prepare/operator-api-preflight.json');
      writeFileSync(path, readFileSync(path, 'utf8') + '\n');
      expect(() => resolvePreparedCommittedReaderSource(['--prepared-api-sha=' + built.sha256,
        '--prepared-receipt-sha=' + built.receiptSha256], join(f.dir, 'execute'),
      { buildObservationOnly: true, root: f.root })).toThrow();
      expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
    });

  it('refuses a re-pinned observation receipt claiming preparation qualification', () => {
    const f = observedBuildFixture(), built = f.produceObserved();
    const path = join(f.dir, 'prepare/operator-api-preflight.json');
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    receipt.qualification.status = 'preparation-qualified';
    writeFileSync(path, JSON.stringify(receipt));
    expect(() => resolvePreparedCommittedReaderSource(['--prepared-api-sha=' + built.sha256,
      '--prepared-receipt-sha=' + digest(readFileSync(path))], join(f.dir, 'execute'),
    { buildObservationOnly: true, root: f.root })).toThrow(/cannot qualify preparation/);
  });

  it.each(['source', 'dependencies', 'inputs'] as const)(
    'retains original inputs and refuses %s drift during compilation', dimension => {
      const script = dimension === 'source' ? 'printf changed > helper.ts\n'
        : dimension === 'dependencies' ? 'printf changed > node_modules/example/index.js\n'
        : 'printf changed > "$(dirname "$2")/operator-api-inputs.json"\n';
      const f = observedBuildFixture(script);
      expect(() => f.produceObserved()).toThrow();
      expect(existsSync(join(f.dir, 'prepare/verifier-source.json'))).toBe(true);
      expect(existsSync(join(f.dir, 'prepare/operator-api-preflight.json'))).toBe(false);
      expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
    });

  it('refuses a changed selected receipt before invoking the compiler', () => {
    const f = observedBuildFixture();
    writeFileSync(f.selected.sourceReceiptPath, readFileSync(f.selected.sourceReceiptPath, 'utf8') + '\n');
    expect(() => f.produceObserved()).toThrow(/Pinned selected source receipt changed/);
    expect(existsSync(`${f.bundle}.builds`)).toBe(false);
  });

  it('uses the same retained inputs with the maintained asynchronous builder', async () => {
    const f = observedBuildFixture();
    const built = await preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'), {
      observedSource: f.observedSource, builder: { timeoutMs: 2000, maxMs: 5000 },
    });
    expect(built.qualification).toEqual({ status: 'pending' });
    expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
    expect(() => f.consume()).toThrow();
  });
});

describe('retained committed reader producer and consumer', () => {
  it.each(['retargeted', 'removed'] as const)('refuses a %s runtime dependency binding when consuming produced artifacts', dimension => {
    const f = producerFixture();
    const produced = f.produce();
    expect(f.consume()).toEqual(produced);
    const link = join(f.dir, 'prepare/node_modules');
    rmSync(link);
    if (dimension === 'retargeted') symlinkSync(join(f.dir, 'node_modules'), link, 'dir');
    // Even a redirect to the same final tree must retain the exact source binding.
    expect(() => f.consume()).toThrow(/Prepared runtime dependency binding differs/);
  });

  it('still refuses other artifact symlinks beside a pinned runtime dependency binding', () => {
    const f = producerFixture('ln -s asset.sql "$(dirname "$2")/redirect.sql"\n');
    expect(() => f.produce()).toThrow(/symlink artifacts require independent qualification/);
  });

  it('builds once at the allocated path and consumes the original pinned artifacts without rebuilding', () => {
    const f = producerFixture();
    expect(f.inputs).not.toHaveProperty('sha256');
    expect(f.inputs).not.toHaveProperty('metafileSha256');
    const produced = f.produce();
    const original = readFileSync(join(f.dir, 'prepare/operator-api-preflight.json'));
    expect(f.consume()).toEqual(produced);
    expect(readFileSync(join(f.dir, 'prepare/operator-api-preflight.json'))).toEqual(original);
    expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
    expect(produced.path).toBe(f.bundle);
    const receipt = JSON.parse(String(original));
    expect(receipt).toMatchObject({ phase: 'produced', inputReceipt: {
      path: join(f.dir, 'prepare/operator-api-inputs.json'), sha256: digest(readFileSync(f.selected.inputReceiptPath)),
    }, qualification: { status: 'preparation-qualified',
      pending: ['actual-private-schema', 'actual-private-environment', 'loaded-host'] } });
    expect(receipt.artifactCensus.map((file: { path: string }) => file.path)).toEqual([
      'asset.sql', 'hono-host.mjs', 'hono-host.mjs.builds', 'hono-host.mjs.meta.json',
      'operator-api-build-result.json', 'operator-api-build.log',
    ]);
    expect(() => f.produce()).toThrow(/archive symlink escapes source root/);
    rmSync(join(f.dir, 'prepare/node_modules'));
    expect(() => f.produce()).toThrow(/fresh allocated/);
    expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
  });

  it.each(['testPaths', 'helperPaths', 'configPaths', 'executedImports', 'dependencyFiles',
    'externalResolutions', 'schema', 'environment', 'copiedArtifacts'] as const)(
    'refuses missing independent %s before builder or runtime allocation', dimension => {
      const f = producerFixture(); delete (f.inputs as Partial<CommittedReaderPreparationInputs>)[dimension]; f.saveInputs();
      const allocateRuntime = vi.fn();
      expect(() => { f.produce(); allocateRuntime(); }).toThrow();
      expect(allocateRuntime).not.toHaveBeenCalled();
      expect(existsSync(`${f.bundle}.builds`)).toBe(false);
      expect(existsSync(join(f.dir, 'prepare/operator-api-preflight.json'))).toBe(false);
    });

  it.each(['omitted', 'opaque'] as const)('refuses unresolved independent %s before compiling', dimension => {
    const f = producerFixture(); f.inputs[dimension] = ['unobserved child imports']; f.saveInputs();
    expect(() => f.produce()).toThrow(new RegExp(dimension));
    expect(existsSync(`${f.bundle}.builds`)).toBe(false);
  });

  it.each(['../asset.sql', 'operator-api-inputs.json', 'hono-host.mjs'])('refuses invalid or reserved copy output %s', path => {
    const f = producerFixture(); f.inputs.copiedArtifacts[0].path = path; f.saveInputs();
    expect(() => f.produce()).toThrow(/artifact path|reserved preparation path/);
    expect(existsSync(`${f.bundle}.builds`)).toBe(false);
  });

  it.each(['hono-host.mjs', 'hono-host.mjs.meta.json', 'asset.sql', 'operator-api-inputs.json',
    'verifier-source.json'])( 'refuses retained %s drift without a consumer rebuild', path => {
      const f = producerFixture(); f.produce();
      writeFileSync(join(f.dir, 'prepare', path), readFileSync(join(f.dir, 'prepare', path), 'utf8') + '\n');
      const allocateRuntime = vi.fn();
      expect(() => { f.consume(); allocateRuntime(); }).toThrow();
      expect(allocateRuntime).not.toHaveBeenCalled();
      expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
    });

  it('refuses a valid-looking partial output receipt at both consumer and sanitized worker handoffs', () => {
    const f = producerFixture(); f.produce();
    const path = join(f.dir, 'prepare/operator-api-preflight.json');
    const receipt = JSON.parse(readFileSync(path, 'utf8')); receipt.qualification = { status: 'pending' };
    writeFileSync(path, JSON.stringify(receipt));
    expect(() => f.consume()).toThrow(/Partial produced preparation/);
    expect(() => resolvePreparedCommittedReaderSource(['--prepared-api-sha=' + receipt.sha256,
      '--prepared-receipt-sha=' + digest(readFileSync(path))], join(f.dir, 'execute')))
      .toThrow(/Partial produced preparation/);
    expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
  });

  it('retains pending output after a graph gap and refuses it instead of falling back to a generic build', () => {
    const f = producerFixture(); f.inputs.executedImports = ['helper.ts']; f.saveInputs();
    expect(() => f.produce()).toThrow(/absent from observed import closure/);
    const path = join(f.dir, 'prepare/operator-api-preflight.json');
    expect(JSON.parse(readFileSync(path, 'utf8')).qualification).toEqual({ status: 'pending' });
    expect(() => f.consume()).toThrow(/Partial produced preparation/);
    expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
  });

  it.each(['consumer', 'worker'] as const)('refuses downgraded producer phase at the %s handoff', handoff => {
    for (const phase of [undefined, 'planned', 'legacy']) {
      const f = producerFixture(); f.produce();
      const path = join(f.dir, 'prepare/operator-api-preflight.json');
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      receipt.phase = phase; receipt.qualification = { status: 'pending' };
      writeFileSync(path, JSON.stringify(receipt));
      const allocateRuntime = vi.fn();
      const consume = () => handoff === 'consumer' ? f.consume()
        : resolvePreparedCommittedReaderSource(['--prepared-api-sha=' + receipt.sha256,
          '--prepared-receipt-sha=' + digest(readFileSync(path))], join(f.dir, 'execute'));
      expect(() => { consume(); allocateRuntime(); }).toThrow(/Produced preparation phase is required/);
      expect(allocateRuntime).not.toHaveBeenCalled();
      expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
    }
  });

  it.each(['inputReceipt', 'artifactCensus', 'qualification'] as const)(
    'refuses a legacy-looking receipt carrying producer %s without a producer phase', dimension => {
      const f = fixture();
      const selected = { receiptPath: f.options.receiptPath, sourceReceiptPath: f.options.sourceReceiptPath,
        selectedCommit: f.options.selectedCommit };
      preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'), { committedReader: selected });
      const path = join(f.dir, 'prepare/operator-api-preflight.json');
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      delete receipt.qualification;
      receipt[dimension] = dimension === 'qualification' ? { status: 'pending' } : null;
      writeFileSync(path, JSON.stringify(receipt));
      expect(() => preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'), { committedReader: {
        ...selected, receiptPath: path, sourceReceiptPath: join(f.dir, 'prepare/verifier-source.json'),
      } })).toThrow(/Produced preparation phase is required/);
      expect(() => resolvePreparedCommittedReaderSource(['--prepared-api-sha=' + receipt.sha256,
        '--prepared-receipt-sha=' + digest(readFileSync(path))], join(f.dir, 'execute')))
        .toThrow(/Produced preparation phase is required/);
    });

  it('rejects an independently digested input receipt whose required pins disagree with produced claims', () => {
    const f = producerFixture(); f.produce();
    const inputPath = join(f.dir, 'prepare/operator-api-inputs.json');
    const path = join(f.dir, 'prepare/operator-api-preflight.json');
    const inputs = JSON.parse(readFileSync(inputPath, 'utf8')); inputs.executedImports = ['helper.ts'];
    writeFileSync(inputPath, JSON.stringify(inputs));
    const receipt = JSON.parse(readFileSync(path, 'utf8')); receipt.inputReceipt.sha256 = digest(readFileSync(inputPath));
    writeFileSync(path, JSON.stringify(receipt));
    expect(() => f.consume()).toThrow(/Produced input pin differs: executedImports/);
  });
});

describe('selected committed reader preparation closure', () => {
  it('qualifies preparation without claiming actual private schema, environment or loaded-host proof', () => {
    const f = fixture();
    const receipt = qualifyCommittedReaderSource({ ...f.options, preparationOnly: true });
    expect(receipt.pending).toEqual(['actual-private-schema', 'actual-private-environment', 'loaded-host']);
    expect(receipt.checked).not.toContain('required-private-schema');
    expect(receipt.checked).not.toContain('required-environment');
    expect(() => qualifyCommittedReaderSource({ ...f.options, environment: {} })).toThrow(/environment missing/);
  });

  it('refuses missing independent selection before invoking a bundle builder', () => {
    const f = fixture();
    expect(() => preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'), { committedReader: {
      sourceReceiptPath: f.options.sourceReceiptPath, receiptPath: join(f.dir, 'missing-closure.json'),
      selectedCommit: f.options.selectedCommit,
    } })).toThrow(/missing-closure.json/);
    expect(readFileSync(f.bundle, 'utf8')).toBe('export const host = 1;');
  });

  it.each(['testPaths', 'helperPaths', 'configPaths', 'executedImports', 'dependencyFiles',
    'externalResolutions', 'artifacts', 'schema', 'environment', 'sha256', 'metafileSha256'] as const)(
    'refuses a missing %s pin before the builder has side effects', dimension => {
      const f = fixture();
      prepareBuilder(f, 'touch "$2.builder-started"\n');
      delete (f.closure as Partial<CommittedReaderClosure>)[dimension]; f.save();
      expect(() => preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'), { committedReader: {
        receiptPath: f.options.receiptPath, sourceReceiptPath: f.options.sourceReceiptPath,
        selectedCommit: f.options.selectedCommit,
      } })).toThrow();
      expect(existsSync(`${f.bundle}.builder-started`)).toBe(false);
      expect(existsSync(join(f.dir, 'prepare/operator-api-preflight.json'))).toBe(false);
    });

  it.each(['schema', 'environment'] as const)('refuses empty required %s before compilation', dimension => {
    const f = fixture(); prepareBuilder(f, 'touch "$2.builder-started"\n');
    f.closure[dimension] = {}; f.save();
    expect(() => preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'), { committedReader: {
      receiptPath: f.options.receiptPath, sourceReceiptPath: f.options.sourceReceiptPath,
      selectedCommit: f.options.selectedCommit,
    } })).toThrow();
    expect(existsSync(`${f.bundle}.builder-started`)).toBe(false);
  });

  it.each(['sha256', 'metafileSha256'] as const)('refuses malformed %s before compilation', dimension => {
    const f = fixture(); prepareBuilder(f, 'touch "$2.builder-started"\n');
    f.closure[dimension] = 'unknown'; f.save();
    expect(() => preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'), { committedReader: {
      receiptPath: f.options.receiptPath, sourceReceiptPath: f.options.sourceReceiptPath,
      selectedCommit: f.options.selectedCommit,
    } })).toThrow();
    expect(existsSync(`${f.bundle}.builder-started`)).toBe(false);
  });

  it('retains independent preparation pins across the sanitized worker boundary and rejects receipt drift', () => {
    const f = fixture();
    // Preparation-only builder fixture: preserve the already pinned artifacts.
    prepareBuilder(f);
    const source = JSON.parse(readFileSync(f.options.sourceReceiptPath, 'utf8'));
    const prepared = preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'), { committedReader: {
      receiptPath: f.options.receiptPath, sourceReceiptPath: f.options.sourceReceiptPath, selectedCommit: source.sourceCommit,
    } });
    const execute = join(f.dir, 'execute'); mkdirSync(execute);
    const argv = ['--prepared-api-sha=' + prepared.sha256, '--prepared-receipt-sha=' + prepared.receiptSha256];
    const selection = resolvePreparedCommittedReaderSource(argv, execute);
    expect(selection).toEqual({ sourceReceiptPath: join(f.dir, 'prepare/verifier-source.json'), selectedCommit: source.sourceCommit,
      sourceReceiptSha256: digest(readFileSync(f.options.sourceReceiptPath)), receiptSha256: prepared.receiptSha256 });
    const retained = JSON.parse(readFileSync(join(f.dir, 'prepare/operator-api-preflight.json'), 'utf8'));
    expect(retained).toMatchObject({ ...f.closure, selectedSource: prepared.selectedSource,
      qualification: { pending: ['actual-private-schema', 'actual-private-environment', 'loaded-host'] } });
    writeFileSync(join(f.dir, 'prepare/operator-api-preflight.json'), JSON.stringify({ ...retained, sourceCommit: 'b'.repeat(40) }));
    expect(() => resolvePreparedCommittedReaderSource(argv, execute)).toThrow(/receipt changed/);
    expect(() => qualifyCommittedReaderSource({ ...f.options, ...selection,
      receiptPath: join(f.dir, 'prepare/operator-api-preflight.json') })).toThrow(/Pinned preparation receipt changed/);
    writeFileSync(join(f.dir, 'prepare/operator-api-preflight.json'), JSON.stringify(retained));
    writeFileSync(selection.sourceReceiptPath, readFileSync(selection.sourceReceiptPath, 'utf8') + '\n');
    expect(() => qualifyCommittedReaderSource({ ...f.options, ...selection,
      receiptPath: join(f.dir, 'prepare/operator-api-preflight.json') })).toThrow(/Pinned selected source receipt changed/);
  });

  it.each(['source-receipt.json', 'operator-api-preflight.json'])('refuses %s drift during preparation before publishing the handoff', name => {
    const f = producerFixture(`printf '\\n' >> "$(dirname "$2")/../${name}"\n`);
    expect(() => f.produce()).toThrow(/receipt changed during preparation/);
    expect(() => readFileSync(join(f.dir, 'prepare/operator-api-preflight.json'))).toThrow(/ENOENT/);
  });

  it('preserves the generic preparation and digest-only worker handoff without a committed-reader selection', () => {
    const f = fixture(); prepareBuilder(f);
    const prepared = preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'));
    expect(JSON.parse(readFileSync(join(f.dir, 'prepare/operator-api-preflight.json'), 'utf8')))
      .toEqual({ path: f.bundle, sha256: digest(readFileSync(f.bundle)) });
    expect(resolvePreparedPrivateApiBundle(['--prepared-api-sha=' + prepared.sha256], join(f.dir, 'execute')))
      .toBe(f.bundle);
    expect(() => resolvePreparedCommittedReaderSource(['--prepared-api-sha=' + prepared.sha256], join(f.dir, 'execute')))
      .toThrow(/pinned preparation receipt/);
  });

  it('accepts matching independent source, build, external, dependency, schema and environment pins as preparation only', () => {
    const f = fixture();
    expect(qualifyCommittedReaderSource(f.options)).toMatchObject({ sourceCommit: 'a'.repeat(40),
      sha256: f.closure.sha256, omitted: [], opaque: [], hostStarted: false, httpStarted: false });
  });

  it.each(['helper.ts', 'config.ts', 'import.ts', 'asset.sql'])('refuses changed required %s before host startup', path => {
    const f = fixture(); writeFileSync(join(f.root, path), 'changed');
    const startHost = vi.fn();
    expect(() => { qualifyCommittedReaderSource(f.options); startHost(); }).toThrow(/tampered verification source archive/);
    expect(startHost).not.toHaveBeenCalled();
  });

  it('refuses a missing required source member', () => {
    const f = fixture(); rmSync(join(f.root, 'import.ts'));
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/missing import.ts/);
  });

  it.each(['omitted', 'opaque'] as const)('refuses unresolved required %s without starting a host', dimension => {
    const f = fixture(); f.closure[dimension] = ['subprocess imports']; f.save();
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(new RegExp(dimension));
  });

  it('refuses a missing config dimension instead of treating it as an empty census', () => {
    const f = fixture(); delete (f.closure as Partial<CommittedReaderClosure>).configPaths; f.save();
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/dimension missing: configPaths/);
  });

  it('refuses a build input outside the independently recorded import closure', () => {
    const f = fixture(); f.closure.executedImports = ['helper.ts']; f.save();
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/absent from observed import closure: import.ts/);
  });

  it('refuses dependency bytes changed after independent preparation', () => {
    const f = fixture(); writeFileSync(join(f.root, 'node_modules/example/index.js'), 'module.exports = 2');
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/Materialized dependency census differs/);
  });

  it('refuses an omitted external resolution pin', () => {
    const f = fixture(); f.closure.externalResolutions = {}; f.save();
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/External resolution census differs/);
  });

  it.each(['bundle', 'graph'] as const)('refuses changed prepared %s bytes', artifact => {
    const f = fixture(); writeFileSync(artifact === 'bundle' ? f.bundle : `${f.bundle}.meta.json`, 'changed');
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/changed/);
  });

  it('refuses a schema mismatch rather than using migration source presence', () => {
    const f = fixture(); f.options.schema['harness_shared.tool_invocations.args_json'] = digest('text:nullable');
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/Applied required private schema differs/);
  });

  it('refuses an omitted copied-source artifact mapping', () => {
    const f = fixture(); f.closure.artifacts = f.closure.artifacts.filter(artifact => !artifact.sourcePath); f.save();
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/Copied source lacks retained artifact mapping/);
  });

  it('refuses a changed required environment setting', () => {
    const f = fixture(); f.options.environment.PAPERCUSP_BACKGROUND_WORKERS = '1';
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/environment differs/);
  });

  it('refuses a sibling selected commit', () => {
    const f = fixture(); f.options.selectedCommit = 'b'.repeat(40);
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/differs from selected committed source/);
  });

  it('refuses a closure receipt inside the archive', () => {
    const f = fixture(); f.options.receiptPath = join(f.root, '.verifier-source.json');
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/must be independent/);
  });
});
