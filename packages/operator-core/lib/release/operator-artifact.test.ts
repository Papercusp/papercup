import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { measureBootOperatorArtifact as measureArtifact, operatorArtifactSource, writeOperatorArtifactManifest,
  type OperatorArtifactParentExpectation } from './operator-artifact';
import { BG_INPUTS, makeBgCompilerCandidate, BG_R1_PARENT_CASES, BG_R1_PARENT_SELECTORS,
  BG_R1_COMPILER_CASES, BG_R1_COMPILER_POSITIVE_CASE, BG_R1_PARTITION_CASES } from '../source-preview.fixture';
import { captureVerifierDependencies, createBgVerifierCompilerCustody, verifyBgVerifierSource } from '../../../../scripts/source-preview.mjs';
import { verifierResourceInventory } from '../verifier-source';

// Fixtures represent files written before a fresh child would be launched.
const measureBootOperatorArtifact = (entry: string, sha: string | null) => measureArtifact(entry, sha, Date.now() + 1000);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'operator-artifact-')); roots.push(root);
  const sourceSha = 'a'.repeat(40), source = 'export const trace = true;';
  const rel = 'packages/operator-core/lib/observability/runtime.ts';
  const entry = join(root, 'apps/operator/dist-host/hono-host.mjs');
  mkdirSync(dirname(entry), { recursive: true }); mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), source); writeFileSync(entry, 'bundled tracing runtime');
  writeFileSync(entry + '.meta.json', JSON.stringify({ inputs: { [rel]: { bytes: source.length } } }));
  const sourceBlob = createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0${source}`).digest('hex');
  let dirty = '', head = sourceSha;
  const git = async (_root: string, args: string[]) => {
    if (args[0] === 'status') return dirty;
    if (args[0] === 'ls-tree') return `100644 blob ${sourceBlob}\t${rel}\0`;
    return head;
  };
  const write = () => writeOperatorArtifactManifest({ root, entry, sourceSha }, git);
  const manifest = async () => {
    const id = await write(); if (id.status !== 'measured') throw Error('fixture');
    return id.evidenceRef;
  };
  return { root, rel, entry, sourceSha, sourceBlob, write, manifest, git,
    dirty: () => { dirty = ' M ' + rel; }, move: () => { head = 'b'.repeat(40); } };
}

describe('operator release artifact provenance', () => {
  it('BG-TEARDOWN-RECONCILE refuses terminal sealing with owned survivors', async () => {
    for (const outcome of ['success', 'failure', 'cancellation', 'timeout', 'interruption-recovery'] as const) {
      const f = fixture();
      const manifest = await f.manifest();
      const original = readFileSync(manifest);
      const candidate = join(f.root, 'private-candidate');
      const binding = join(f.root, 'private-binding');
      mkdirSync(candidate); symlinkSync(candidate, binding);
      const custody = { originalEvidence: manifest, owner: 'artifact-cleanup-fixture' };
      const ledger = verifierResourceInventory({ path: join(f.root, 'cleanup.jsonl'),
        owner: custody.owner, custody, deadlineEpochMs: 200, now: () => 100 });
      ledger.record({ id: 'candidate', kind: 'root', path: candidate });
      ledger.record({ id: 'binding', kind: 'binding', path: binding });
      ledger.record({ id: 'original-evidence', kind: 'binding', path: manifest, retain: 'original boot evidence' });
      const pending = await ledger.reconcile({ outcome, custody });
      expect(pending).toMatchObject({ sealed: false, status: 'incomplete', survivors: ['candidate', 'binding'] });
      const prefix = readFileSync(join(f.root, 'cleanup.jsonl'), 'utf8');
      rmSync(candidate, { recursive: true });
      // A dangling temporary binding remains owned even after its target exits.
      expect(await ledger.reconcile({ outcome, custody })).toMatchObject({ sealed: false, survivors: ['binding'] });
      rmSync(binding);
      expect(await ledger.reconcile({ outcome, custody })).toMatchObject({ sealed: true, survivors: [],
        deadlineExceeded: false, status: outcome === 'success' ? 'completed' : 'failed' });
      expect(readFileSync(join(f.root, 'cleanup.jsonl'), 'utf8').startsWith(prefix)).toBe(true);
      expect(readFileSync(manifest)).toEqual(original);
      expect(measureBootOperatorArtifact(f.entry, f.sourceSha).status).toBe('measured');
    }
  });

  it('binds source blobs to real built bytes and measures the boot entry independently', async () => {
    const f = fixture(); const written = await f.write();
    expect(written).toMatchObject({ status: 'measured', sourceSha: f.sourceSha, sourceBlobs: { [f.rel]: f.sourceBlob } });
    expect(measureBootOperatorArtifact(f.entry, f.sourceSha.slice(0, 10))).toEqual(written);
    expect(await f.write()).toEqual(written); // same deterministic artifact is immutable and reusable
  });
  it('binds an external private artifact only under its explicit output root', async () => {
    const f = fixture();
    const artifactRoot = mkdtempSync(join(tmpdir(), 'operator-private-artifact-')); roots.push(artifactRoot);
    const entry = join(artifactRoot, 'hono-host.mjs');
    writeFileSync(entry, readFileSync(f.entry));
    writeFileSync(entry + '.meta.json', readFileSync(f.entry + '.meta.json'));
    const input = { root: f.root, entry, sourceSha: f.sourceSha };
    await expect(writeOperatorArtifactManifest(input, f.git)).rejects.toThrow('source-moved');
    const written = await writeOperatorArtifactManifest({ ...input, artifactRoot }, f.git);
    expect(written).toMatchObject({ status: 'measured', sourceSha: f.sourceSha,
      sourceBlobs: { [f.rel]: f.sourceBlob } });
    expect(measureBootOperatorArtifact(entry, f.sourceSha.slice(0, 10))).toEqual(written);
    expect(measureBootOperatorArtifact(f.entry, f.sourceSha).status).toBe('unknown');
    // Output relocation cannot make a changed compiler input attributable.
    writeFileSync(join(f.root, f.rel), 'changed after compilation');
    await expect(writeOperatorArtifactManifest({ ...input, artifactRoot }, f.git)).rejects.toThrow('input-mismatch');
  });
  it('refuses an external private artifact outside its root or through a symlink root', async () => {
    const f = fixture();
    const artifactRoot = mkdtempSync(join(tmpdir(), 'operator-private-artifact-')); roots.push(artifactRoot);
    await expect(writeOperatorArtifactManifest({ ...f, artifactRoot }, f.git)).rejects.toThrow('source-moved');
    const link = join(f.root, 'output-link'); symlinkSync(artifactRoot, link);
    await expect(writeOperatorArtifactManifest({ ...f, artifactRoot: link }, f.git)).rejects.toThrow('output-root-invalid');
  });
  it('keeps the event loop available while a Git read is pending', async () => {
    const f = fixture();
    let release!: () => void;
    let heldFirstRead = false;
    const git = async (root: string, args: string[]) => {
      if (args[0] === 'rev-parse' && !heldFirstRead) {
        heldFirstRead = true;
        await new Promise<void>(resolve => { release = resolve; });
      }
      return f.git(root, args);
    };
    let completed = false;
    const pending = writeOperatorArtifactManifest({ root: f.root, entry: f.entry, sourceSha: f.sourceSha }, git)
      .finally(() => { completed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(completed).toBe(false);
    release();
    await expect(pending).resolves.toMatchObject({ status: 'measured' });
  });
  it('refuses dirty source and movement across the release build boundary', async () => {
    const f = fixture(); expect(await operatorArtifactSource(f.root, f.git)).toBe(f.sourceSha);
    f.dirty(); await expect(f.write()).rejects.toThrow('source-unqualified');
    const moved = fixture(); moved.move(); await expect(moved.write()).rejects.toThrow('source-moved');
  });
  it('does not stamp a source input changed after the compiler read it', async () => {
    const f = fixture(); writeFileSync(join(f.root, f.rel), 'different source');
    await expect(f.write()).rejects.toThrow('input-mismatch');
  });
  it('does not turn the retained previous bundle into fresh release evidence', async () => {
    const f = fixture(); await f.write();
    writeFileSync(join(dirname(f.entry), '.bundle-stale.json'), JSON.stringify({ reason: 'compile-failed' }));
    await expect(f.write()).rejects.toThrow('stale-build');
    expect(measureBootOperatorArtifact(f.entry, f.sourceSha).status).toBe('unknown');
    rmSync(join(dirname(f.entry), '.bundle-stale.json'));
    expect(measureBootOperatorArtifact(f.entry, f.sourceSha).status).toBe('measured');
  });
  it('rejects an empty or escaped metafile source population', async () => {
    const f = fixture(); writeFileSync(f.entry + '.meta.json', JSON.stringify({ inputs: {} }));
    await expect(f.write()).rejects.toThrow('inputs-empty');
    writeFileSync(f.entry + '.meta.json', JSON.stringify({ inputs: { '../../../foreign.ts': {} } }));
    await expect(f.write()).rejects.toThrow('outside-source');
  });
  it('reads pinned submodule objects without treating the gitlink as a source blob', async () => {
    const f = fixture(); const rel = 'libs/tracing/runtime.ts';
    mkdirSync(dirname(join(f.root, rel)), { recursive: true });
    writeFileSync(join(f.root, rel), readFileSync(join(f.root, f.rel)));
    writeFileSync(f.entry + '.meta.json', JSON.stringify({ inputs: { [rel]: {} } }));
    const git = async (root: string, args: string[]) => args[0] !== 'ls-tree' ? f.git(root, args) :
      root === f.root ? `160000 commit ${'c'.repeat(40)}\tlibs/tracing\0` : `100644 blob ${f.sourceBlob}\truntime.ts\0`;
    await expect(writeOperatorArtifactManifest(f, git)).resolves.toMatchObject({ status: 'measured', sourceBlobs: { [rel]: f.sourceBlob } });
  });
  it('accounts for an explicitly derived generated input without inventing a source blob', async () => {
    const f = fixture(), name = '<define:__PAPERCUSP_TESTING_CORE_WITNESS__>';
    writeFileSync(f.entry + '.meta.json', JSON.stringify({ inputs: {
      [f.rel]: { bytes: 1 }, [name]: { bytes: 0, imports: [] },
    } }));
    await expect(writeOperatorArtifactManifest({ ...f, generatedInputs: [name] }, f.git))
      .resolves.toMatchObject({ status: 'measured', sourceBlobs: { [f.rel]: f.sourceBlob } });
  });
  it.each(['unknown', 'omitted', 'metadata', 'filesystem', 'duplicate'] as const)(
    'refuses %s generated input accounting', async defect => {
      const f = fixture(), name = '<define:__PAPERCUSP_TESTING_CORE_WITNESS__>';
      const inputs: Record<string, unknown> = { [f.rel]: { bytes: 1 }, [name]: { bytes: 0, imports: [] } };
      const generatedInputs = [name];
      if (defect === 'unknown') inputs['<unexplained-input>'] = { bytes: 0, imports: [] };
      if (defect === 'omitted') generatedInputs.pop();
      if (defect === 'metadata') inputs[name] = { bytes: 1, imports: [] };
      if (defect === 'filesystem') generatedInputs[0] = f.rel;
      if (defect === 'duplicate') generatedInputs.push(name);
      writeFileSync(f.entry + '.meta.json', JSON.stringify({ inputs }));
      await expect(writeOperatorArtifactManifest({ ...f, generatedInputs }, f.git))
        .rejects.toThrow('operator-artifact-generated-input-');
    });
  it('keeps a legacy, replaced, or foreign build unknown', async () => {
    const f = fixture(); expect(measureBootOperatorArtifact(f.entry, f.sourceSha).status).toBe('unknown');
    await f.write(); expect(measureBootOperatorArtifact(f.entry, 'b'.repeat(40)).status).toBe('unknown');
    expect(measureBootOperatorArtifact(f.entry, f.sourceSha).status).toBe('measured');
    writeFileSync(f.entry, 'replacement runtime');
    expect(measureBootOperatorArtifact(f.entry, f.sourceSha).status).toBe('unknown');
  });
  it.each(['bundle', 'source', 'blob', 'entry'] as const)('rejects a corrupted %s manifest with a healthy control', async field => {
    const f = fixture(); const file = await f.manifest(); const original = readFileSync(file, 'utf8'); const m = JSON.parse(original);
    if (field === 'bundle') m.bundleSha256 = 'd'.repeat(64);
    if (field === 'source') m.sourceSha = 'e'.repeat(40);
    if (field === 'blob') m.sourceBlobs[f.rel] = 'not-a-blob';
    if (field === 'entry') m.entry = '../hono-host.mjs';
    writeFileSync(file, JSON.stringify(m)); expect(measureBootOperatorArtifact(f.entry, f.sourceSha).status).toBe('unknown');
    writeFileSync(file, original); expect(measureBootOperatorArtifact(f.entry, f.sourceSha).status).toBe('measured');
  });
  it('rejects a symlinked boot entry instead of borrowing another artifact identity', async () => {
    const f = fixture(); await f.write(); const link = join(dirname(f.entry), 'other.mjs'); symlinkSync(f.entry, link);
    expect(measureBootOperatorArtifact(link, f.sourceSha).status).toBe('unknown');
  });
  it('rejects matching disk bytes and a valid manifest replaced after this process started', async () => {
    const f = fixture(); await f.write();
    expect(measureArtifact(f.entry, f.sourceSha).status).toBe('unknown');
    expect(measureBootOperatorArtifact(f.entry, f.sourceSha).status).toBe('measured');
    writeFileSync(f.entry, 'another bundle with the same baked source SHA'); await f.write();
    expect(measureArtifact(f.entry, f.sourceSha).status).toBe('unknown');
    expect(measureBootOperatorArtifact(f.entry, f.sourceSha).status).toBe('measured');
  });

  function inheritedParent(f: ReturnType<typeof fixture>): OperatorArtifactParentExpectation {
    const parentRoot = mkdtempSync(join(tmpdir(), 'operator-original-parent-')); roots.push(parentRoot);
    const path = join(parentRoot, 'accepted-manifest.json');
    const members = { [f.rel]: f.sourceBlob };
    const bytes = JSON.stringify({ schemaVersion: 1, sourceBlobs: members });
    writeFileSync(path, bytes);
    return { sourceRoot: f.root, acceptedManifest: { path, evidenceRef: 'fixture:original-parent-P002',
      schemaVersion: 1, sha256: createHash('sha256').update(bytes).digest('hex'), members } };
  }

  async function parentDefect(defect: typeof BG_R1_PARENT_CASES[number]['defect']) {
      const f = fixture(); const written = await f.write(); const parent = inheritedParent(f);
      const boot = (input: OperatorArtifactParentExpectation) => measureArtifact(f.entry, f.sourceSha, Date.now() + 1000, input);
      expect(boot(parent)).toEqual(written);
      const bad = structuredClone(parent), expected = bad.acceptedManifest!;
      if (defect === 'authority-absent') bad.acceptedManifest = null;
      if (defect === 'authority-unknown') expected.evidenceRef = 'UNKNOWN';
      if (defect === 'authority-candidate-substitution') {
        const path = join(f.root, 'candidate-parent.json');
        writeFileSync(path, readFileSync(expected.path)); expected.path = path;
      }
      if (defect === 'schema-mismatch') Object.assign(expected, { schemaVersion: 2 });
      if (defect === 'digest-mismatch') expected.sha256 = 'b'.repeat(64);
      if (defect.startsWith('literal-member-')) {
        const changed = JSON.parse(readFileSync(expected.path, 'utf8'));
        if (defect === 'literal-member-added') changed.sourceBlobs['packages/operator-core/lib/extra.ts'] = 'c'.repeat(40);
        if (defect === 'literal-member-omitted') delete changed.sourceBlobs[f.rel];
        if (defect === 'literal-member-changed') changed.sourceBlobs[f.rel] = 'd'.repeat(40);
        // Keep the original accepted map and digest. Separately exercise literal
        // equality below so a byte-digest refusal cannot mask a missing map fence.
        writeFileSync(expected.path, JSON.stringify(changed));
        expected.sha256 = createHash('sha256').update(JSON.stringify(changed)).digest('hex');
      }
      expect(boot(bad)).toMatchObject({ status: 'unknown' });
      if (defect.startsWith('literal-member-')) writeFileSync(parent.acceptedManifest!.path,
        JSON.stringify({ schemaVersion: 1, sourceBlobs: parent.acceptedManifest!.members }));
      expect(boot(parent)).toEqual(written);
  }
  for (const { defect, testName } of BG_R1_PARENT_CASES) {
    it(testName, () => parentDefect(defect));
  }
  // These source-level fixtures exercise the maintained boot artifact reader.
  // Full actual-service qualification still requires the independently retained
  // runtime packet; the selector's presence cannot confer that authority.
  it(BG_R1_PARENT_SELECTORS.authority.testName, async () => {
    for (const defect of ['authority-absent', 'authority-unknown', 'authority-candidate-substitution'] as const)
      await parentDefect(defect);
  });
  it(BG_R1_PARENT_SELECTORS.schemaDigest.testName, async () => {
    for (const defect of ['schema-mismatch', 'digest-mismatch'] as const) await parentDefect(defect);
  });
  it(BG_R1_PARENT_SELECTORS.literalMembers.testName, async () => {
    for (const defect of ['literal-member-added', 'literal-member-omitted', 'literal-member-changed'] as const)
      await parentDefect(defect);
  });

  it('refuses candidate artifact membership differing from the original inherited parent', async () => {
    const f = fixture(); const file = await f.manifest(); const parent = inheritedParent(f);
    const original = readFileSync(file, 'utf8'), candidate = JSON.parse(original);
    candidate.sourceBlobs[f.rel] = 'e'.repeat(40); writeFileSync(file, JSON.stringify(candidate));
    expect(measureArtifact(f.entry, f.sourceSha, Date.now() + 1000, parent).status).toBe('unknown');
    writeFileSync(file, original);
    expect(measureArtifact(f.entry, f.sourceSha, Date.now() + 1000, parent).status).toBe('measured');
  });

  it('refuses explicit source-only boot authority even when its complete member map matches', async () => {
    const f = fixture(), written = await f.write(), parent = inheritedParent(f);
    const original = readFileSync(parent.acceptedManifest!.path);
    const fullOutput = structuredClone(parent);
    fullOutput.acceptedManifest!.authorityKind = 'full-output';
    const sourceOnly = structuredClone(fullOutput);
    sourceOnly.acceptedManifest!.authorityKind = 'source-only';
    const boot = (input: OperatorArtifactParentExpectation) =>
      measureArtifact(f.entry, f.sourceSha, Date.now() + 1000, input);
    expect(boot(fullOutput)).toEqual(written);
    // Only the authority kind changes: equal bytes, digest, paths and membership
    // must not let historical source evidence authorize a new runtime.
    expect(boot(sourceOnly)).toMatchObject({ status: 'unknown' });
    expect(readFileSync(parent.acceptedManifest!.path)).toEqual(original);
    expect(boot(fullOutput)).toEqual(written);
    expect(boot(parent)).toEqual(written); // legacy full-population expectation
  });

  // Build immutable fixture bytes once; every case still writes its own artifact
  // and launches fresh runtime processes against its private parent manifest.
  const sourceRoot = resolve(import.meta.dirname, '../../../..');
  const sourceLoader = createRequire(import.meta.url).resolve('tsx');
  type BootBuild = Awaited<ReturnType<typeof import('esbuild').build>>;
  let bootBundle: { bytes: Uint8Array; metafile: NonNullable<BootBuild['metafile']> };
  beforeAll(async () => {
    const runtimePath = join(sourceRoot, 'packages/operator-core/lib/observability/runtime.ts');
    const { build } = await import('esbuild');
    const started = performance.now();
    const result = await build({ absWorkingDir: sourceRoot, bundle: true, platform: 'node', format: 'esm',
      outfile: 'boot-parent-runtime-boundary.mjs', write: false, metafile: true, logLevel: 'silent',
      external: [join(sourceRoot, 'packages/operator-core/lib/telemetry-flush'),
        join(sourceRoot, 'packages/operator-core/lib/auth/loopback-peer-trust'),
        '@opentelemetry/exporter-trace-otlp-proto', '@opentelemetry/exporter-logs-otlp-proto',
        '@opentelemetry/sdk-logs', '@opentelemetry/sdk-trace-base',
        'typescript', 'cpu-features', 'onnxruntime-node', 'ssh2'],
      banner: { js: "import { createRequire as createBootBoundaryRequire } from 'node:module'; const require = createBootBoundaryRequire("
        + JSON.stringify(join(sourceRoot, 'package.json')) + ");" },
      define: { __PAPERCUSP_BUNDLED_SIDECAR__: 'true', __PAPERCUSP_BUNDLED_SOURCE_SHA__: JSON.stringify('a'.repeat(40)) },
      stdin: { resolveDir: sourceRoot, sourcefile: 'boot-parent-runtime-boundary.ts', loader: 'ts', contents: `
        import { readFileSync } from 'node:fs';
        import { initializeRuntimeObservability, runtimeObservabilityHealth, shutdownRuntimeObservability } from ${JSON.stringify(runtimePath)};
        const { parent, legacy } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
        let ready = false, error = null;
        try {
          if (legacy) initializeRuntimeObservability();
          initializeRuntimeObservability(parent);
          ready = true;
        } catch (caught) { error = String(caught); }
        const health = runtimeObservabilityHealth();
        console.log('BOOT_PARENT_BOUNDARY ' + JSON.stringify({ ready, error,
          initialized: health.initialized, artifact: health.artifact, pid: process.pid }));
        await shutdownRuntimeObservability();
      ` } });
    bootBundle = { bytes: result.outputFiles![0]!.contents, metafile: result.metafile! };
    process.stderr.write('BOOT_PARENT_PHASE ' + JSON.stringify({ phase: 'suite-bundle',
      durationMs: Math.round(performance.now() - started) }) + '\n');
  }, 30_000);

  async function compiledBootRuntime() {
    const f = fixture();
    const timedPhase = <T>(phase: string, operation: () => T): T => {
      const started = performance.now();
      try { return operation(); }
      finally { process.stderr.write('BOOT_PARENT_PHASE ' + JSON.stringify({ phase,
        durationMs: Math.round(performance.now() - started) }) + '\n'); }
    };
    // This is a source-level runtime fixture. Reuse the maintained worker's tsx
    // route for external local TypeScript; single-file ESM bundling can hoist
    // those imports even when their configuration readers are never called.
    symlinkSync(join(sourceRoot, 'node_modules'), join(f.root, 'node_modules'), 'dir');
    const bootEnv = { PATH: process.env.PATH, NODE_ENV: 'test', PAPERCUSP_BUILD_SHA: f.sourceSha };
    const loaderControl = join(dirname(f.entry), 'loader-control.mjs');
    writeFileSync(loaderControl, "console.log('BOOT_PARENT_LOADER_READY');");
    const smoke = timedPhase('loader-smoke', () => spawnSync(process.execPath, ['--import', sourceLoader, '--input-type=module', '--eval',
      "import { pathToFileURL } from 'node:url'; await import(pathToFileURL(process.argv[1]).href);", loaderControl],
    { encoding: 'utf8', timeout: 15_000, env: bootEnv }));
    expect(smoke.error, smoke.stdout + smoke.stderr).toBeUndefined();
    expect(smoke.status, smoke.stdout + smoke.stderr).toBe(0);
    expect(smoke.stdout).toContain('BOOT_PARENT_LOADER_READY');
    writeFileSync(f.entry, bootBundle.bytes);
    // Catch banner/bundle binding collisions before any runtime control starts.
    const syntax = timedPhase('syntax', () => spawnSync(process.execPath, ['--check', f.entry],
      { encoding: 'utf8', timeout: 15_000 }));
    expect(syntax.error, syntax.stderr).toBeUndefined();
    expect(syntax.status, syntax.stderr).toBe(0);
    // Independent compiler input and output measurement for this source-level
    // boot-boundary fixture. This does not claim full BG service/dependency closure.
    const members = Object.fromEntries(Object.keys(bootBundle.metafile.inputs)
      .filter(path => !path.includes('node_modules/') && !path.endsWith('boot-parent-runtime-boundary.ts'))
      .sort().map(path => {
        const bytes = readFileSync(join(sourceRoot, path));
        return [path, createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')];
      }));
    expect(Object.keys(members)).toContain('packages/operator-core/lib/observability/runtime.ts');
    const bundleSha256 = createHash('sha256').update(readFileSync(f.entry)).digest('hex');
    writeFileSync(f.entry + '.artifact-' + bundleSha256 + '.json', JSON.stringify({ schemaVersion: 1,
      sourceSha: f.sourceSha, entry: 'apps/operator/dist-host/hono-host.mjs', bundleSha256, sourceBlobs: members }));
    const parent = inheritedParent(f), bytes = JSON.stringify({ schemaVersion: 1, sourceBlobs: members });
    Object.assign(parent.acceptedManifest!, { members, sha256: createHash('sha256').update(bytes).digest('hex') });
    writeFileSync(parent.acceptedManifest!.path, bytes);
    const boot = (input: typeof parent, legacy = false) => {
      const configPath = join(dirname(f.entry), 'boot-parent-config.json');
      writeFileSync(configPath, JSON.stringify({ parent: input, legacy }));
      const child = timedPhase('boot', () => spawnSync(process.execPath, ['--import', sourceLoader, '--input-type=module', '--eval',
        "import { pathToFileURL } from 'node:url'; await import(pathToFileURL(process.argv[1]).href);",
        f.entry, configPath], {
        encoding: 'utf8', timeout: 15_000,
        env: bootEnv,
      }));
      if (child.error || child.status !== 0) {
        // Preserve complete child errors independently of assertion truncation.
        process.stderr.write('BOOT_PARENT_CHILD_DIAGNOSTICS\n' + child.stdout + child.stderr);
      }
      const diagnostics = JSON.stringify({ stderr: child.stderr?.slice(-1_500), signal: child.signal });
      expect(child.error, diagnostics).toBeUndefined();
      expect(child.status, diagnostics).toBe(0);
      const line = child.stdout.split('\n').find(row => row.startsWith('BOOT_PARENT_BOUNDARY '));
      expect(line, child.stdout + child.stderr).toBeTruthy();
      return JSON.parse(line!.slice('BOOT_PARENT_BOUNDARY '.length));
    };
    return { f, parent, boot, bundleSha256, members };
  }

  it('withholds fresh-process runtime initialization for an unknown parent and refuses later parent relabeling', async () => {
    const { f, parent, boot, bundleSha256, members } = await compiledBootRuntime();
    expect(boot(parent)).toMatchObject({ ready: true, error: null, initialized: true,
      artifact: { status: 'measured', sourceSha: f.sourceSha, bundleSha256, sourceBlobs: members } });
    const fullOutput = structuredClone(parent);
    fullOutput.acceptedManifest!.authorityKind = 'full-output';
    expect(boot(fullOutput)).toMatchObject({ ready: true, error: null, initialized: true,
      artifact: { status: 'measured', sourceSha: f.sourceSha, bundleSha256, sourceBlobs: members } });
    const sourceOnly = structuredClone(fullOutput);
    sourceOnly.acceptedManifest!.authorityKind = 'source-only';
    expect(boot(sourceOnly)).toMatchObject({ ready: false,
      error: expect.stringContaining('BG boot parent artifact unqualified'), initialized: false, artifact: null });
    expect(boot({ ...parent, acceptedManifest: null })).toMatchObject({ ready: false,
      error: expect.stringContaining('BG boot parent artifact unqualified'), initialized: false, artifact: null });
    expect(boot(parent, true)).toMatchObject({ ready: false,
      error: expect.stringContaining('BG boot parent expectation changed') });
  }, 30_000);

  // Reuse the real compiled initialization boundary, rather than assigning the
  // registered boot selectors to source-map inspection alone. These fixtures
  // still do not replace the selected BG service's independent runtime packet.
  for (const { rowId, testName } of BG_R1_PARTITION_CASES.filter(row =>
    row.rowId.startsWith('bg-r1-partition-new-boot-'))) {
    it(testName, async () => {
      const { f, parent, boot, bundleSha256, members } = await compiledBootRuntime();
      const fullOutput = structuredClone(parent);
      fullOutput.acceptedManifest!.authorityKind = 'full-output';
      const expectedReady = { ready: true, error: null, initialized: true,
        artifact: { status: 'measured', sourceSha: f.sourceSha, bundleSha256, sourceBlobs: members } };
      const expectedRefusal = { ready: false,
        error: expect.stringContaining('BG boot parent artifact unqualified'), initialized: false, artifact: null };
      const originalPath = fullOutput.acceptedManifest!.path;
      const originalBytes = readFileSync(originalPath);
      expect(boot(fullOutput)).toMatchObject(expectedReady);
      if (rowId === 'bg-r1-partition-new-boot-source-only-substitution') {
        const sourceOnly = structuredClone(fullOutput);
        // Keep every byte, path, digest and member equal: only authority changes.
        sourceOnly.acceptedManifest!.authorityKind = 'source-only';
        expect(boot(sourceOnly)).toMatchObject(expectedRefusal);
      } else if (rowId !== 'bg-r1-partition-new-boot-positive-control') {
        const changed = { ...members };
        const member = Object.keys(changed)[0]!;
        if (rowId === 'bg-r1-partition-new-boot-member-added')
          changed['packages/operator-core/lib/extra-boot-member.ts'] = 'c'.repeat(40);
        else if (rowId === 'bg-r1-partition-new-boot-member-omitted') delete changed[member];
        else if (rowId === 'bg-r1-partition-new-boot-member-changed') changed[member] = 'd'.repeat(40);
        else throw new Error('Unimplemented partition boot selector: ' + rowId);
        expect(changed).not.toEqual(members);
        const changedBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, sourceBlobs: changed }));
        try {
          writeFileSync(originalPath, changedBytes);
          // Re-pin the changed bytes so a digest refusal cannot mask either
          // literal-map guard. Check manifest/expectation and candidate/expectation.
          for (const expectedMembers of [members, changed]) {
            const bad = structuredClone(fullOutput);
            Object.assign(bad.acceptedManifest!, { members: expectedMembers,
              sha256: createHash('sha256').update(changedBytes).digest('hex') });
            expect(boot(bad)).toMatchObject(expectedRefusal);
          }
        } finally { writeFileSync(originalPath, originalBytes); }
      }
      expect(readFileSync(originalPath)).toEqual(originalBytes);
      expect(boot(fullOutput)).toMatchObject(expectedReady);
    }, 30_000);
  }
});

describe('BG compiler input custody', () => {
  async function compilerCandidate() {
    const root = mkdtempSync(join(tmpdir(), 'bg-artifact-compiler-'));
    roots.push(root);
    return makeBgCompilerCandidate(root);
  }

  for (const { kind, testName } of BG_R1_COMPILER_CASES) {
    it(testName, async () => {
      const { prepared, dependencies } = await compilerCandidate();
      const custody = createBgVerifierCompilerCustody({ prepared, dependencies });
      const { build } = await import('esbuild');
      const local = kind === 'source' ? 'packages/core/index.ts' : 'node_modules/fixture-dependency/index.js';
      const target = join(prepared.root, local), original = readFileSync(target);
      const replacement = kind === 'source' ? 'export const y = 9;\n' : 'export default 99;\n';
      expect(Buffer.byteLength(replacement)).toBe(original.length);
      let substituted = false, restored = false;
      const result = build({ absWorkingDir: prepared.root, entryPoints: [BG_INPUTS[0]!], bundle: true,
        format: 'esm', platform: 'node', write: false, logLevel: 'silent',
        plugins: [custody.plugin, { name: 'independent-transient-substitution', setup(builder) {
          builder.onResolve({ filter: kind === 'source' ? /core\/index$/ : /^fixture-dependency$/ }, () => {
            writeFileSync(target, replacement);
            substituted = true;
            return { path: target };
          });
          builder.onEnd(() => { writeFileSync(target, original); restored = true; });
        } }] });
      // A bypass that admits B must retain independently observed compiler output,
      // with A restored at both endpoint censuses, in the decisive failure.
      const outcome = await result.then(async compiled => {
        const emitted = await import('data:text/javascript;base64,'
          + Buffer.from(compiled.outputFiles[0]!.contents).toString('base64'));
        return { status: 'compiled', emitted: { y: emitted.y, dep: emitted.dep } };
      }, (error: unknown) => ({ status: 'rejected', error: String(error) }));
      expect({ substituted, restored }).toEqual({ substituted: true, restored: true });
      expect(readFileSync(target)).toEqual(original);
      expect(verifyBgVerifierSource(prepared, 'before-publication')).toBe(prepared);
      expect(captureVerifierDependencies({ dest: prepared.root, receipt: prepared.source })).toEqual(dependencies);
      expect(outcome).toEqual({ status: 'rejected',
        error: expect.stringContaining(`BG compiler consumed bytes mismatch: ${local}`) });
    });
  }

  it(BG_R1_COMPILER_POSITIVE_CASE.testName, async () => {
    const { prepared, dependencies } = await compilerCandidate();
    const originalReceipt = readFileSync(join(prepared.root, '.verifier-source.json'));
    const custody = createBgVerifierCompilerCustody({ prepared, dependencies });
    const { build } = await import('esbuild');
    const result = await build({ absWorkingDir: prepared.root, entryPoints: [BG_INPUTS[0]!], bundle: true,
      format: 'esm', platform: 'node', write: false, logLevel: 'silent', plugins: [custody.plugin] });
    const imported = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.contents).toString('base64'));
    expect({ y: imported.y, dep: imported.dep }).toEqual({ y: 2, dep: 41 });
    expect(custody.verifyBeforePublication().map((row: { path: string }) => row.path)).toEqual([
      BG_INPUTS[0]!, 'node_modules/fixture-dependency/index.js', 'packages/core/index.ts',
    ]);
    expect(readFileSync(join(prepared.root, '.verifier-source.json'))).toEqual(originalReceipt);
  });
});
