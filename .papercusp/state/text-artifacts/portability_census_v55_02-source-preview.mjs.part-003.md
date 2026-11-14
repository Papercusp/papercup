---
rel_path: "portability/census/v55/02-source-preview.mjs.part-003"
updated_at: 1794250602744
_body: "content"
---

xecution.binary,
    'BG original compiler binary changed');
  const binaryStat = lstatSync(execution.binary.realpath, { bigint: true });
  const native = execution.compilerBinary;
  assert.ok(native.kind === 'kernel-sealed-fd-v1' && native.sha256 === execution.binary.sha256
    && native.bytes === String(binaryStat.size) && /^[0-9]+$/.test(native.dev)
    && /^[1-9][0-9]*$/.test(native.ino) && native.launches === 1,
  'BG original sealed compiler binary is UNKNOWN');
  assert.deepEqual(readBgIndependentOutputIdentity(output.entry.path), receipt.output,
    'BG compiler produced output identity changed');
  assert.deepEqual(readBgIndependentOutputIdentity(meta.path), receipt.metafile,
    'BG compiler produced metafile identity changed');
  assert.deepEqual(receipt.consumed, sealed.consumed, 'BG sealed complete compiler consumption changed');
  assert.ok(Array.isArray(receipt.consumed) && receipt.consumed.length > 0,
    'BG complete compiler consumption is UNKNOWN');
  const files = new Map(record.prepared.source.files.map(row => [row.path, row]));
  for (const tree of record.dependencies.trees) for (const row of tree.files) {
    const path = `${tree.path}/${row.path}`;
    assert.ok(!files.has(path), 'BG compiler consumption census overlap');
    files.set(path, { ...row, path });
  }
  for (const identity of [execution.api, execution.binary]) {
    const local = relative(record.prepared.root, identity.realpath).split(sep).join('/');
    const original = files.get(local);
    assert.ok(original?.kind === 'file' && original.sha256 === identity.sha256,
      'BG original compiler execution is outside dependency census');
  }
  const sourceBlobs = {}, seen = new Set(), trees = new Map();
  for (const row of receipt.consumed) {
    assert.ok(!seen.has(row.path), 'BG compiler consumption member duplicated');
    seen.add(row.path);
    const original = files.get(row.path);
    assert.ok(original?.kind === 'file', 'BG compiler consumption is outside original census');
    assert.equal(row.sha256, original.sha256, 'BG compiler consumption bytes mismatch');
    assert.equal(row.realpath, join(record.prepared.root, row.path), 'BG compiler consumption physical path mismatch');
    if (!row.path.split('/').includes('node_modules')) sourceBlobs[row.path] =
      committedInputBlob(record.prepared.root, record.prepared.source.sourceCommit, row.path, trees);
  }
  for (const [path, blob] of Object.entries(accepted.members))
    assert.equal(sourceBlobs[path], blob, 'BG protected source was not consumed by main compiler');
  assert.deepEqual(output.artifact.sourceBlobs, sourceBlobs, 'BG output complete compiler consumption mismatch');
}

/** Bind the maintained artifact writer's measured output to the ORIGINAL build
 * record. Builder exit status alone is never artifact qualification. This is a
 * separate output fence, not proof of compiler consumption or service readiness.
 * @typedef {{ schemaVersion: 'bg-build-output-v1', buildRecordSha256: string,
 *   originalSourceReceiptSha256: string, entry: ReturnType<typeof readBgFileIdentity>,
 *   manifest: ReturnType<typeof readBgFileIdentity>,
 *   compilerReceipt?: Awaited<ReturnType<typeof compileBgVerifierInvocation>>,
 *   artifact: Extract<import('@papercusp/operator-core/lib/release/operator-artifact').OperatorArtifactIdentity,
 *     { status: 'measured' }> }} BgVerifierOutputRecord
 * @param {{ record: ReturnType<typeof prepareBgVerifierBuildRecord>,
 *   invocation: BgBuildInvocation, entry: string,
 *   compilerReceipt?: Awaited<ReturnType<typeof compileBgVerifierInvocation>> }} options
 * @returns {Promise<BgVerifierOutputRecord>}
 */
export async function qualifyBgVerifierOutput({ record, invocation, entry, compilerReceipt }) {
  verifyBgVerifierBuildRecord(record, invocation, 'before-publication');
  const file = readBgFileIdentity(entry);
  const local = relative(record.prepared.root, file.realpath);
  assert.ok(file.path === file.realpath && local && !isAbsolute(local)
    && local !== '..' && !local.startsWith(`..${sep}`), 'BG output escaped selected generation');
  const artifact = await writeOperatorArtifactManifest({ root: record.prepared.root, entry,
    sourceSha: record.prepared.source.sourceCommit });
  assert.equal(artifact.status, 'measured', 'BG output artifact is UNKNOWN');
  if (artifact.status !== 'measured') throw new Error('BG output artifact is UNKNOWN');
  /** @type {BgVerifierOutputRecord} */
  const output = freezeBgExpectation({ schemaVersion: 'bg-build-output-v1',
    buildRecordSha256: createHash('sha256').update(JSON.stringify(record)).digest('hex'),
    originalSourceReceiptSha256: record.originalSourceReceiptSha256,
    entry: file, manifest: readBgFileIdentity(artifact.evidenceRef), artifact,
    ...(compilerReceipt ? { compilerReceipt } : {}) });
  verifyBgVerifierOutputRecord(output, record, invocation);
  return output;
}

/** Recheck the same detached output immediately before publication; never
 * regenerate a source receipt, input record or manifest to bless replacement.
 * @param {BgVerifierOutputRecord} output
 * @param {ReturnType<typeof prepareBgVerifierBuildRecord>} record
 * @param {BgBuildInvocation} invocation
 */
export function verifyBgVerifierOutputRecord(output, record, invocation) {
  verifyBgVerifierBuildRecord(record, invocation, 'before-publication');
  assert.equal(output.schemaVersion, 'bg-build-output-v1', 'BG output record is UNKNOWN');
  assert.equal(output.buildRecordSha256, createHash('sha256').update(JSON.stringify(record)).digest('hex'),
    'BG output original build record mismatch');
  assert.equal(output.originalSourceReceiptSha256, record.originalSourceReceiptSha256,
    'BG output original source receipt mismatch');
  assert.deepEqual(readBgFileIdentity(output.entry.path), output.entry, 'BG output bundle changed');
  assert.deepEqual(readBgFileIdentity(output.manifest.path), output.manifest, 'BG output manifest changed');
  assert.equal(output.artifact.status, 'measured', 'BG output artifact is UNKNOWN');
  assert.equal(output.artifact.sourceSha, record.prepared.source.sourceCommit, 'BG output source commit mismatch');
  assert.equal(output.artifact.bundleSha256, output.entry.sha256, 'BG output bundle digest mismatch');
  assert.equal(output.artifact.manifestSha256, output.manifest.sha256, 'BG output manifest digest mismatch');
  assert.equal(output.artifact.evidenceRef, `${output.entry.path}.artifact-${output.entry.sha256}.json`,
    'BG output manifest identity mismatch');
  verifyBgOutputAuthority(output, record);
  return output;
}

/** Join independently traced parsed bytes to the ORIGINAL compiler consumption
 * and output. A logical copy may have another physical path, but must contain
 * those exact generated bytes. URLs/source maps alone never establish origin.
 * Separately loaded files bind to the original source/dependency census, never
 * to a fresh census of runtime paths. Other scripts stay explicit; this grants
 * no host, native or creator authority.
 * The capture and close witness are host-local inputs, never transport claims.
 * @param {{ output: BgVerifierOutputRecord,
 *   record: ReturnType<typeof prepareBgVerifierBuildRecord>, invocation: BgBuildInvocation,
 *   execution: { entry: string, trace: string,
 *     terminal: Parameters<typeof bindRuntimeSourcePopulation>[1],
 *     captures: Parameters<typeof bindRuntimeSourcePopulation>[2],
 *     jitCaptures?: Parameters<typeof bindRuntimeSourcePopulation>[4],
 *     inputCustody?: ReturnType<typeof createBgVerifierCompilerCustody>,
 *     nativeScope?: 'selected-requests' | 'process-lifetime',
 *     nativeCaptures?: { stderr: Buffer,
 *       windows: Parameters<typeof bindNativeLoaderClosure>[1],
 *       firstRun: Parameters<typeof bindNativeLoaderClosure>[2],
 *       receipt: Parameters<typeof bindNativeLoaderClosure>[3] }[] } }} args
 */
export function qualifyBgVerifierRuntimeSources({ output, record, invocation, execution }) {
  verifyBgVerifierOutputRecord(output, record, invocation);
  assert.ok(execution.nativeScope === undefined || execution.nativeScope === 'selected-requests'
    || execution.nativeScope === 'process-lifetime', 'BG native qualification scope unsupported');
  assert.ok(execution.nativeScope !== 'process-lifetime' || execution.nativeCaptures?.length,
    'BG native lifetime capture missing');
  // Full-parent membership alone also cannot stand in for observed compilation.
  verifyBgOutputAuthority(output, record, true);
  const entry = readBgFileIdentity(execution.entry);
  assert.equal(entry.path, entry.realpath, 'BG runtime entry must be physical');
  assert.equal(entry.sha256, output.entry.sha256, 'BG runtime entry differs from original compiler output');
  const population = bindRuntimeSourcePopulation(execution.trace, execution.terminal, execution.captures,
    undefined, execution.jitCaptures);
  let inputCustody;
  if (execution.inputCustody !== undefined) {
    const retained = bgRuntimeInputCustodies.get(execution.inputCustody);
    assert.ok(retained, 'BG runtime input custody is not a retained host witness');
    const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    assert.equal(retained.preparedSha256, hash(record.prepared), 'BG runtime input custody source differs');
    assert.equal(retained.dependencySha256, hash(record.dependencies), 'BG runtime input custody dependencies differ');
    const tree = bindRuntimeProcessTree(execution.trace, execution.terminal);
    const firstExecAtMs = Math.min(...tree.tasks.flatMap(task => task.execs.map(exec => exec.atMs)));
    const lastTerminalAtMs = Math.max(...tree.tasks.map(task => task.terminalAtMs));
    assert.ok(retained.capturedAtMs < Math.floor(firstExecAtMs),
      'BG runtime input custody began after traced execution');
    retained.verify();
    const verifiedAtMs = Date.now(), verifiedMonotonicNs = process.hrtime.bigint();
    assert.ok(verifiedAtMs >= Math.ceil(lastTerminalAtMs)
      && Math.abs((verifiedAtMs - retained.capturedAtMs)
        - Number(verifiedMonotonicNs - retained.capturedMonotonicNs) / 1e6) < 10,
    'BG runtime input custody clock or terminal boundary differs');
    inputCustody = { preparedSha256: retained.preparedSha256, dependencySha256: retained.dependencySha256,
      capturedAtMs: retained.capturedAtMs, firstExecAtMs, lastTerminalAtMs, verifiedAtMs,
      files: retained.files, directories: retained.directories };
  }
  const expectedUrl = pathToFileURL(entry.path).href;
  /** @type {Map<string, { path: string, kind: string, sha256: string, origin: 'source' | 'dependency' }>} */
  const originalFiles = new Map();
  /** @type {Map<string, ReturnType<typeof readBgFileIdentity>>} */
  const inputIdentities = new Map();
  /** @param {{path: string, kind: string, sha256: string}} file
   * @param {'source' | 'dependency'} origin */
  const addInput = (file, origin) => {
    const path = join(record.prepared.root, file.path), url = pathToFileURL(path).href;
    assert.ok(!originalFiles.has(url), 'BG runtime original input census overlaps');
    originalFiles.set(url, { ...file, path, origin });
  };
  for (const file of record.prepared.source.files) addInput(file, 'source');
  for (const tree of record.dependencies.trees) for (const file of tree.files)
    addInput({ ...file, path: `${tree.path}/${file.path}` }, 'dependency');
  const rootUrl = pathToFileURL(record.prepared.root + sep).href;
  const bindings = [], inputBindings = [], builtinBindings = [], unqualifiedSources = [];
  const builtinSources = record.expectedHostManifest?.builtinSources;
  const originalBuiltins = new Map(builtinSources?.map(source => [source.url, source]));
  for (const rows of execution.captures) for (const row of rows.filter(row => row.kind === 'source')) {
    const identity = { processId: rows[0].processId, target: row.target, scriptId: row.scriptId,
      url: row.url, sha256: row.sha256, bytes: row.bytes };
    let url = row.url;
    if (isAbsolute(url)) {
      assert.equal(resolve(url), url, 'BG runtime source URL is not canonical');
      url = pathToFileURL(url).href;
    } else if (url.startsWith('file:')) {
      const canonical = pathToFileURL(fileURLToPath(url)).href;
      assert.equal(canonical, url, 'BG runtime source URL is not canonical');
    }
    if (url !== expectedUrl) {
      if (url.startsWith('node:') && builtinSources) {
        const original = originalBuiltins.get(url);
        assert.ok(original, 'BG runtime builtin is outside original expected manifest');
        assert.ok(row.sha256 === original.sha256 && row.bytes === original.bytes,
          'BG parsed builtin differs from original Node source bytes');
        builtinBindings.push({ ...identity,
          expectedHostManifestSha256: record.expectedHostManifest.identity.sha256 });
        continue;
      }
      const original = originalFiles.get(url);
      if (original) {
        assert.equal(original.kind, 'file', 'BG parsed runtime input is not an original regular file');
        assert.equal(row.sha256, original.sha256, 'BG parsed runtime input differs from original input bytes');
        const file = readBgFileIdentity(original.path);
        assert.ok(file.path === file.realpath && file.sha256 === original.sha256,
          'BG runtime original input identity changed');
        inputIdentities.set(file.path, file);
        inputBindings.push({ ...identity, origin: original.origin, file });
      } else {
        assert.ok(!url.startsWith(rootUrl), 'BG runtime file is outside original input census');
        unqualifiedSources.push(identity);
      }
      continue;
    }
    assert.equal(row.sha256, entry.sha256, 'BG parsed runtime bytes differ from original compiler output');
    assert.equal(String(row.bytes), output.compilerReceipt.output.size,
      'BG parsed runtime size differs from original compiler output');
    bindings.push(identity);
  }
  assert.ok(bindings.length, 'BG original compiler output was not observed in runtime sources');
  const nativeBindings = [];
  if (execution.nativeCaptures !== undefined) {
    assert.ok(Array.isArray(execution.nativeCaptures)
      && execution.nativeCaptures.length === execution.captures.length,
    'BG native capture process population differs from source population');
    const nativeProcesses = new Set();
    for (const capture of execution.nativeCaptures) {
      const processId = capture.firstRun?.processId;
      const rows = execution.captures.find(rows => rows[0].processId === processId);
      assert.ok(rows && !nativeProcesses.has(processId), 'BG native capture process duplicate or foreign');
      nativeProcesses.add(processId);
      const ns = value => typeof value === 'string' && /^[1-9]\d*$/.test(value);
      const start = rows[0].monotonicNs, end = rows.at(-1).monotonicNs;
      const runtime = capture.firstRun.runtime;
      assert.ok(ns(start) && ns(end) && BigInt(start) < BigInt(end)
        && runtime && ns(runtime.beforeNs) && ns(runtime.afterNs)
        && BigInt(start) <= BigInt(runtime.beforeNs) && BigInt(runtime.afterNs) <= BigInt(end)
        && Array.isArray(capture.windows) && capture.windows.length
        && capture.windows.every(window => ns(window.startMonotonicNs) && ns(window.endMonotonicNs)
          && BigInt(start) <= BigInt(window.startMonotonicNs) && BigInt(window.endMonotonicNs) <= BigInt(end)),
      'BG native capture lies outside source lifetime');
      const closure = bindNativeLoaderClosure(capture.stderr, capture.windows, capture.firstRun, capture.receipt,
        { scope: execution.nativeScope });
      assert.ok(closure.executable.path === record.invocation.node.realpath
        && closure.executable.sha256 === record.invocation.node.sha256,
      'BG native executable differs from original compiler Node');
      const expectedVdso = record.expectedHostManifest?.vdso;
      if (expectedVdso) assert.ok(closure.vdso.origin === expectedVdso.origin
        && closure.vdso.sha256 === expectedVdso.sha256 && closure.vdso.bytes === expectedVdso.bytes,
      'BG native kernel vDSO differs from original expected manifest');
      const files = runtime.libraries.map(mapped => {
        const file = readBgFileIdentity(mapped.path);
        assert.ok(file.path === file.realpath && file.sha256 === mapped.sha256 && lstatSync(file.path).size === mapped.bytes,
          'BG native mapped file identity changed');
        const original = originalFiles.get(pathToFileURL(file.path).href);
        if (original) {
          assert.ok(original.kind === 'file' && original.sha256 === mapped.sha256,
            'BG native mapped input differs from original input bytes');
          inputIdentities.set(file.path, file);
        } else {
          assert.ok(!pathToFileURL(file.path).href.startsWith(rootUrl),
            'BG native mapped file is outside original input census');
          if (record.expectedHostManifest) {
            const expected = record.expectedHostManifest.files.find(expected => expected.path === file.path);
            assert.ok(expected && expected.sha256 === mapped.sha256 && expected.bytes === mapped.bytes,
              'BG native mapped host file is outside original expected manifest');
          }
        }
        return { file, origin: original?.origin ?? (record.expectedHostManifest ? 'expected-host' : 'host-observed') };
      });
      nativeBindings.push({ processId, closure, files, expectedHostManifestQualified: !!record.expectedHostManifest,
        expectedVdsoQualified: !!expectedVdso,
        expectedHostManifestSha256: record.expectedHostManifest?.identity.sha256 ?? null });
    }
  }
  for (const builtin of builtinBindings) assert.ok(nativeBindings.some(native =>
    native.processId === builtin.processId && native.expectedHostManifestQualified),
  'BG builtin source lacks original native executable qualification');
  assert.ok(!record.expectedHostManifest?.vdso || nativeBindings.length > 0,
    'BG expected vDSO lacks original native capture');
  for (const [path, identity] of inputIdentities)
    assert.deepEqual(readBgFileIdentity(path), identity, 'BG runtime original input changed during qualification');
  assert.deepEqual(readBgFileIdentity(execution.entry), entry, 'BG runtime entry changed during qualification');
  verifyBgVerifierOutputRecord(output, record, invocation);
  return freezeBgExpectation({ schemaVersion: 'bg-runtime-compiled-sources-v1',
    originalSourceReceiptSha256: record.originalSourceReceiptSha256,
    buildRecordSha256: output.buildRecordSha256, compilerOutputSha256: output.entry.sha256,
    captureSha256: createHash('sha256').update(JSON.stringify(execution.captures)).digest('hex'),
    traceSha256: createHash('sha256').update(execution.trace).digest('hex'),
    entry, population, bindings, inputBindings, builtinBindings, unqualifiedSources, nativeBindings,
    builtinQualification: builtinBindings.length ? 'original-node-bytes' : 'not-observed',
    nativeQualification: execution.nativeCaptures === undefined ? 'not-observed'
      : execution.nativeScope === 'process-lifetime' ? 'file-backed-glibc-process-lifetimes' : 'selected-windows-only',
    vdsoQualification: nativeBindings.some(native => native.expectedVdsoQualified)
      ? 'original-host-bytes' : execution.nativeCaptures === undefined ? 'not-observed' : 'required',
    executableMemoryQualification: population.executableMemoryQualification,
    jitByteOriginQualification: population.mappingOrigins.jitByteOriginQualification,
    jitByteCapture: population.jitByteCapture,
    jitBindings: population.jitBindings ?? [],
    compiledOutputBytesObserved: true,
    ...(inputCustody ? { inputCustody } : {}),
    completeRuntimeClosureVerified: false,
    dependencyQualification: inputCustody ? 'original-inputs-stable-over-traced-lifetime' : 'required',
    creatorFence: 'required' });
}

/** Attach dependencies to the independently invoked tree before its first Node
 * command. Reuse the release helper's donor install mutex and private snapshot.
 * An explicit allowance is shared across phases and requires a finite caller
 * deadline. Neither progress nor a forecast grants more time. Keep the default
 * dependency ceiling when omitted, and reserve the parent's cleanup window.
 * @param {{ donor: string, runtimeAssetDonor?: string, dest: string, receipt: Awaited<ReturnType<typeof prepareVerifierSource>>, runPhase?: VerifierPhaseRunner, signal?: AbortSignal,
 *   env?: NodeJS.ProcessEnv, maxMs?: number, cutoffEpochMs?: number | null, now?: () => number,
 *   resourceInventory?: ReturnType<typeof verifierResourceInventory> }} options
 */
export async function prepareVerifierDependencies({ donor, runtimeAssetDonor = donor, dest, receipt, runPhase = async (_phase, operation) => operation(), signal,
  env = process.env, maxMs, cutoffEpochMs, now = Date.now, resourceInventory }) {
  const admission = admitVerifierCommandBudget(null, { env, nowMs: now() });
  if (maxMs !== undefined && (!Number.isSafeInteger(maxMs) || maxMs <= 0 || admission.deadlineEpochMs === null))
    throw new PreviewError('explicit verifier preparation allowance needs positive integer milliseconds and a finite caller task deadline', 2);
  const cutoffs = [admission.childCutoffEpochMs, cutoffEpochMs,
    maxMs === undefined ? null : now() + maxMs].filter(value => value != null);
  const preparationCutoff = cutoffs.length ? Math.min(...cutoffs) : null;
  env = verifierDependencyEnv(env);
  const run = (command, args) => runVerifierDependencyCommand(command, args,
    { cwd: dest, env, signal, maxMs, cutoffEpochMs: preparationCutoff, now, resourceInventory });
  // A retry can retain staging and completed dependency trees. Only this
  // pre-copy check permits staging; the locked helper must adopt it, and
  // subsequent source checks still reject unfinished copies. Runtime assets
  // are seeded only after the committed source itself has been verified.
  await runPhase('deps.source.before', async () => {
    await verifyVerifierSource(dest, receipt, { runtimeArtifacts: true, dependencyStaging: true });
    // A live nested checkout can already match the root lock while its pinned
    // gitlink still selects an older manifest. Check the selected source before
    // copying dependencies or allocating a native runtime, never the live donor.
    assertRootLockManifestMatches(dest);
  });
  const runtimeSetup = join(dest, 'apps/operator/scripts/setup-porcupine-runtime.sh');
  if (existsSync(runtimeSetup)) {
    const modelDonor = join(runtimeAssetDonor, 'apps/operator/public/porcupine/porcupine_params.pv');
    // The model is gitignored. Copy it through the selected source's own
    // checksum-pinned helper; never link the mutable work-root cache into the
    // immutable verifier snapshot.
    await runPhase('deps.runtime-assets', () => run('bash', [runtimeSetup, '--source', modelDonor]));
  }
  await runPhase('deps.source.after-runtime-assets', () => verifyVerifierSource(dest, receipt,
    { runtimeArtifacts: true, dependencyStaging: true }));
  const copyMode = verifierDependencyCopyMode(donor, dest);
  // Reuse a full immutable generation on the destination filesystem instead
  // of repeatedly copying the mutable donor across devices before tests start.
  // Older frozen refs pin a helper that only has the original locked snapshot.
  // Select its published CLI before invoking it; a supported generation command
  // must still refuse invalid custody rather than retrying through the donor.
  const snapshotHelper = join(dest, 'papercusp-desktop/bin/lib/pinned-deps.sh');
  const generationSnapshotSupported = /^\s*snapshot-generation-locked\s*\)/m.test(await fs.readFile(snapshotHelper, 'utf8'));
  const snapshotSelection = selectVerifierDependencySnapshot(copyMode, generationSnapshotSupported,
    Boolean(env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT));
  await runPhase('deps.snapshot', () => run('bash', [snapshotHelper,
    snapshotSelection.command, realpathSync(donor), realpathSync(dest), copyMode]), { snapshotSelection });
  await runPhase('deps.source.after-snapshot', () => verifyVerifierSource(dest, receipt, { runtimeArtifacts: true }));
  const script = join(dest, 'scripts/source-preview.mjs');
  // The CLI imports workspace TypeScript, including extensionless and directory
  // imports. Resolve its loader from the private snapshot, never ambient options.
  const nodeArgs = ['--import', 'tsx', script];
  const receiptSha256 = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  await runPhase('deps.inputs', () => run(process.execPath, [...nodeArgs, 'verifier-inputs-check', '--repo', dest,
    '--ref', receipt.sourceCommit, '--receipt-sha256', receiptSha256,
    '--inputs', receipt.testedInputs.map(input => input.path).join(',')]));
  // The source archive has no Git database. Validate and measure it from its
  // externally pinned receipt, with full source censuses around both reads.
  await runPhase('deps.measure', async () => {
    const bytes = (await run(process.execPath, [...nodeArgs, 'verifier-measure', '--repo', dest,
      '--ref', receipt.sourceCommit, '--receipt-sha256', receiptSha256])).trim();
    if (!/^\d+$/.test(bytes) || Number(bytes) <= 0)
      throw new PreviewError('verifier dependency preflight returned no source size', 2);
  });
  await runPhase('deps.source.after-preflight', () => verifyVerifierSource(dest, receipt, { runtimeArtifacts: true }));
  return runPhase('deps.census', () => captureVerifierCommandDependencies({ dest, receipt, env, run,
    onProgress: progress => runPhase.reportProgress?.('deps.census', progress) }));
}

/** Measure installed bytes, not lockfile intent. Reuse the release helper's
 * product-owned tree population and the source verifier's exact file census.
 * Workspace link targets still need source verification; this receipt does
 * not claim final transformed code or a complete runtime import closure.
 * @param {{ dest: string, receipt: Awaited<ReturnType<typeof prepareVerifierSource>>, env?: NodeJS.ProcessEnv,
 *   onProgress?: (progress: VerifierDependencyProgress) => void }} options
 */
export function captureVerifierDependencies({ dest, receipt, env = process.env, onProgress }) {
  const root = realpathSync(dest);
  const result = spawnSync('bash', [join(root, 'papercusp-desktop/bin/lib/pinned-deps.sh'), 'trees', root],
    { cwd: root, env: verifierDependencyEnv(env), encoding: 'utf8',
      timeout: 60_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new PreviewError(`verifier dependency enumeration failed: ${result.error?.message || result.stderr || result.status}`, 2);
  return captureVerifierDependencyPopulation({ dest, receipt, env, onProgress }, result.stdout);
}

/** Managed commands use the existing process-group/deadline runner for discovery.
 * Keep the synchronous capture API for callers that do not own an async command.
 * Both paths share the exact installed-byte census and population validation.
 * @param {Parameters<typeof captureVerifierDependencies>[0] & {
 *   run: (command: string, args: string[]) => Promise<string> }} options
 */
async function captureVerifierCommandDependencies({ run, ...options }) {
  const root = realpathSync(options.dest);
  const output = await run('bash', [join(root, 'papercusp-desktop/bin/lib/pinned-deps.sh'), 'trees', root]);
  return captureVerifierDependencyPopulation(options, output);
}

/** The verifier's helper must use the same interpreter even under a sanitized
 * compiler PATH or an inherited dependency-generation override.
 * @param {NodeJS.ProcessEnv} env */
function verifierDependencyEnv(env) {
  return { ...env, NODE_OPTIONS: '', NODE_PATH: '', DEPENDENCY_GENERATION_NODE: process.execPath };
}

const VERIFIER_DEPENDENCY_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const VERIFIER_DEPENDENCY_CACHE_MAX_ENTRIES = 64;
/** @type {Map<string, { fingerprint: string, files: Array<{ path: string, kind: string, executable: boolean, sha256: string }>, bytes: number }>} */
const verifierDependencyCensusCache = new Map();
let verifierDependencyCensusCacheBytes = 0;

/** @param {string} cacheKey @param {string} fingerprint */
function readVerifierDependencyCache(cacheKey, fingerprint) {
  const cached = verifierDependencyCensusCache.get(cacheKey);
  if (!cached || cached.fingerprint !== fingerprint) return null;
  verifierDependencyCensusCache.delete(cacheKey);
  verifierDependencyCensusCache.set(cacheKey, cached);
  return cached.files.map(file => ({ ...file }));
}

/** @param {string} cacheKey @param {string} fingerprint
 * @param {Array<{ path: string, kind: string, executable: boolean, sha256: string }>} files */
function rememberVerifierDependencyCache(cacheKey, fingerprint, files) {
  const previous = verifierDependencyCensusCache.get(cacheKey);
  if (previous) {
    verifierDependencyCensusCache.delete(cacheKey);
    verifierDependencyCensusCacheBytes -= previous.bytes;
  }
  const bytes = files.reduce((total, file) => total + Buffer.byteLength(file.path)
    + Buffer.byteLength(file.sha256) + 48, 0);
  if (bytes > VERIFIER_DEPENDENCY_CACHE_MAX_BYTES) return;
  const cachedFiles = files.map(file => Object.freeze({ ...file }));
  verifierDependencyCensusCache.set(cacheKey, { fingerprint, files: cachedFiles, bytes });
  verifierDependencyCensusCacheBytes += bytes;
  while (verifierDependencyCensusCache.size > VERIFIER_DEPENDENCY_CACHE_MAX_ENTRIES
    || verifierDependencyCensusCacheBytes > VERIFIER_DEPENDENCY_CACHE_MAX_BYTES) {
    const oldestKey = verifierDependencyCensusCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = verifierDependencyCensusCache.get(oldestKey);
    verifierDependencyCensusCache.delete(oldestKey);
    if (oldest) verifierDependencyCensusCacheBytes -= oldest.bytes;
  }
}

/** @param {Parameters<typeof captureVerifierDependencies>[0]} options
 * @param {string} output */
function captureVerifierDependencyPopulation({ dest, receipt, env = process.env, onProgress }, output) {
  const root = realpathSync(dest);
  const paths = output.trim().split('\n').filter(Boolean).sort();
  assert.ok(paths.length > 0 && paths.length <= 1000 && new Set(paths).size === paths.length,
    'Verifier dependency tree population missing or duplicated');
  const policyPath = 'apps/operator/bin/release/dependency-generation.sh';
  const policy = { path: policyPath,
    sha256: createHash('sha256').update(readFileSync(join(root, policyPath))).digest('hex') };
  const sourceReceiptSha256 = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  const trees = [];
  for (const [treeIndex, path] of paths.entries()) {
    assert.ok(!isAbsolute(path) && !path.includes('\\') &&
      !path.split('/').some(part => !part || part === '.' || part === '..') &&
      path.split('/').at(-1) === 'node_modules' &&
      !paths.some(other => path.startsWith(`${other}/`)), 'Invalid verifier dependency tree');
    const tree = join(root, path);
    assert.ok(lstatSync(tree).isDirectory() && realpathSync(tree) === tree,
      `Verifier dependency tree must be independent: ${path}`);
    // Use the generation writer's population, including its exact ephemeral
    // output policy. A second cache-name list would eventually disagree with
    // the immutable install whose bytes this verifier is meant to measure.
    const records = spawnSync('bash', ['-c',
      'source "$1" || exit; records=$(mktemp) || exit; trap \'rm -f -- "$records" "$records.unsorted"\' EXIT; dependency_generation_source_records "$2" "$records" || exit; cat "$records"',
      'verifier-dependency-records', join(root, policyPath), tree],
    { cwd: root, env: verifierDependencyEnv(env), encoding: 'utf8',
      timeout: 120_000, maxBuffer: 128 * 1024 * 1024 });
    if (records.error || records.status !== 0)
      throw new PreviewError(`verifier dependency census failed: ${records.error?.message || records.stderr || records.status}`, 2);
    // The final link-target column is empty for regular files/directories.
    // Trimming whitespace would erase that field from the final record.
    const population = records.stdout.split('\n').filter(Boolean).map(line => line.split('\t'));
    assert.ok(population.every(row => row.length === 10 && ['d', 'f', 'l'].includes(row[1])),
      'Invalid verifier dependency generation records');
    // Source records carry mode, size, mtime, inode, ctime and link target.
    // Include policy and receipt manifests so any of those changes invalidates
    // the byte hashes without trusting size/mtime as content proof.
    const cacheKey = root + '\0' + path;
    const fingerprint = createHash('sha256').update('verifier-dependency-census-v1\0')
      .update(root).update('\0').update(path).update('\0')
      .update(policy.path).update('\0').update(policy.sha256).update('\0')
      .update(sourceReceiptSha256).update('\0').update(records.stdout).digest('hex');
    const cachedFiles = readVerifierDependencyCache(cacheKey, fingerprint);
    const cacheHit = cachedFiles !== null;
    onProgress?.({ completedTrees: treeIndex, totalTrees: paths.length,
      currentTree: path.slice(0, 256), cacheHit });
    const files = cachedFiles ?? verifierSourceFiles(tree, { symlinkRoot: root,
      includedPaths: new Set(population.map(row => row[0])) });
    assert.equal(files.length, population.filter(row => row[1] !== 'd').length,
      'Verifier dependency population changed during census');
    if (!cacheHit) rememberVerifierDependencyCache(cacheKey, fingerprint, files);
    trees.push({ path, files });
  }
  return { schemaVersion: 'verifier-dependencies-v1', scope: 'materialized-dependency-files',
    root, sourceCommit: receipt.sourceCommit, policy,
    sourceReceiptSha256, trees };
}

/** Admit against the caller's disclosure ledger before leaving its checkout.
 * Frozen source excludes local operator configuration. Preserve its database
 * pins in the child environment so governed admission uses the same control
 * plane, without copying the config file or unrelated secrets into the archive.
 * Explicit database pins and isolated PG selection keep their precedence.
 * @param {{ repo: string, env?: NodeJS.ProcessEnv, preflight?: typeof runTreeRestrictedHoldPreflight }} options
 * @returns {NodeJS.ProcessEnv}
 */
export function verifierCommandAdmissionEnv({ repo, env = process.env, preflight = runTreeRestrictedHoldPreflight }) {
  const verdict = preflight({ roots: [repo], env });
  if (verdict.verdict === 'refuse')
    throw new PreviewError(formatTreeRestrictedHoldRefusal('verifier-run', verdict), 3);
  const childEnv = verdict.verdict === 'admit'
    ? { ...env, [RESTRICTED_HOLD_PREFLIGHT_ENV]: RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_ROUTER }
    : { ...env };
  // Resolve while the caller's .env.local still exists. A frozen child otherwise
  // discovers a different desktop cluster when its dedicated queue client opens.
  if (!PG_URL_ENV_VARS.some(key => childEnv[key]))
    applyEnvLocal({ root: join(repo, 'apps', 'operator'), env: childEnv });
  return childEnv;
}

/** Collect the exact committed source population needed to validate generated
 * workspace executable outputs before allocating the verifier snapshot.
 * @param {string} repo
 * @param {string} commit
 * @param {string} prefix
 * @param {Map<string, { mode: string, repo: string, commit: string, oid: string }>} sourceEntries
 * @param {Array<{ prefix: string, localPath: string, content: string, packageJson: Record<string, unknown> }>} manifests
 */
function collectVerifierWorkspaceBinInputs(repo, commit, prefix, sourceEntries, manifests) {
  const links = [];
  for (const entry of git(repo, ['ls-tree', '-r', '-z', commit]).split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    if (tab < 0) throw new PreviewError('cannot enumerate committed verifier source tree', 2);
    const [mode, type, oid] = entry.slice(0, tab).split(' ');
    const localPath = entry.slice(tab + 1);
    if (mode === '160000' && type === 'commit') {
      links.push({ path: localPath, sha: oid });
    } else if (type === 'blob') {
      const path = prefix ? posixPath.join(prefix, localPath) : localPath;
      sourceEntries.set(path, { mode, repo, commit, oid });
    }
  }

  const grep = spawnSync('git', ['-C', repo, 'grep', '-z', '-l', '-I', '-E',
    '"bin"[[:space:]]*:', commit, '--', ':(top)package.json', ':(glob)**/package.json'],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (grep.error || (grep.status !== 0 && grep.status !== 1))
    throw new PreviewError('cannot inspect committed workspace package manifests for verifier bins: ' +
      (grep.error?.message || grep.stderr || grep.status), 2);
  for (const hit of (grep.stdout || '').split('\0').filter(Boolean)) {
    const colon = hit.indexOf(':');
    const localPath = colon < 0 ? hit : hit.slice(colon + 1);
    if (posixPath.basename(localPath) !== 'package.json') continue;
    const content = git(repo, ['show', commit + ':' + localPath]);
    let packageJson;
    try { packageJson = JSON.parse(content); }
    catch (error) {
      throw new PreviewError('invalid committed workspace package manifest ' +
        (prefix ? prefix + '/' : '') + localPath + ': ' + error.message, 2);
    }
    manifests.push({ prefix, localPath, content, packageJson });
  }

  for (const link of links) {
    const fullPath = prefix ? prefix + '/' + link.path : link.path;
    const submodule = materializedSubmodule(repo, link, fullPath);
    collectVerifierWorkspaceBinInputs(submodule, link.sha, fullPath, sourceEntries, manifests);
  }
}

function committedVerifierPathExists(sourceEntries, path, seen = new Set()) {
  if (seen.has(path)) return false;
  seen.add(path);
  const entry = sourceEntries.get(path);
  if (entry) {
    if (entry.mode !== '120000') return true;
    const target = git(entry.repo, ['cat-file', 'blob', entry.oid]);
    const resolved = posixPath.normalize(posixPath.join(posixPath.dirname(path), target));
    if (posixPath.isAbsolute(target) || resolved === '..' || resolved.startsWith('../')) return false;
    return committedVerifierPathExists(sourceEntries, resolved, seen);
  }
  for (const sourcePath of sourceEntries.keys())
    if (sourcePath.startsWith(path + '/')) return true;
  return false;
}

/** Mirror the pinned-deps workspace-bin requirements without copying anything.
 * The pinned helper remains authoritative for the eventual immutable copy.
 * @param {{ repo: string, commit: string, donor: string }} options
 */
function preflightVerifierWorkspaceBinDonor({ repo, commit, donor }) {
  const sourceEntries = new Map();
  const manifests = [];
  collectVerifierWorkspaceBinInputs(repo, commit, '', sourceEntries, manifests);
  const donorRoot = realpathSync(donor);
  for (const manifest of manifests) {
    const bin = manifest.packageJson.bin;
    const bins = typeof bin === 'string' ? [bin] : Object.values(bin || {});
    const packageDir = posixPath.dirname(manifest.localPath);
    const packageRoot = packageDir === '.' ? '' : packageDir;
    const globalPackageRoot = manifest.prefix
      ? (packageRoot ? manifest.prefix + '/' + packageRoot : manifest.prefix)
      : packageRoot;
    const manifestPath = manifest.prefix ? manifest.prefix + '/' + manifest.localPath : manifest.localPath;
    for (const target of bins) {
      if (typeof target !== 'string' || !/^(\.\/)?dist\//.test(target)) continue;
      const localTarget = posixPath.normalize(posixPath.join(packageDir, target));
      if (posixPath.isAbsolute(localTarget) ||
          (packageRoot && localTarget !== packageRoot && !localTarget.startsWith(packageRoot + '/')) ||
          (!packageRoot && (localTarget === '..' || localTarget.startsWith('../'))))
        throw new PreviewError('escaping-workspace-bin:' + manifestPath, 2);
      const targetPath = manifest.prefix ? manifest.prefix + '/' + localTarget : localTarget;
      if (committedVerifierPathExists(sourceEntries, targetPath)) continue;
      const outputPath = posixPath.join(globalPackageRoot, 'dist');
      if (committedVerifierPathExists(sourceEntries, outputPath))
        throw new PreviewError('recorded-workspace-bin-output:' + outputPath, 2);

      const donorManifest = join(donorRoot, ...manifestPath.split('/'));
      let donorManifestBytes;
      try { donorManifestBytes = readFileSync(donorManifest); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        throw new PreviewError('workspace-bin-manifest-missing:' + manifestPath, 2);
      }
      if (!donorManifestBytes.equals(Buffer.from(manifest.content)))
        throw new PreviewError('workspace-bin-manifest-mismatch:' + manifestPath, 2);
      const donorTarget = join(donorRoot, ...targetPath.split('/'));
      if (!existsSync(donorTarget))
        throw new PreviewError('missing-workspace-bin-output:' + manifestPath, 2);
      const donorOutput = join(donorRoot, ...outputPath.split('/'));
      const outputStat = lstatSync(donorOutput, { throwIfNoEntry: false });
      const physicalOutput = outputStat?.isDirectory() ? realpathSync(donorOutput) : '';
      const outputRelative = physicalOutput ? relative(donorRoot, physicalOutput) : '';
      if (!outputStat?.isDirectory() || outputRelative === '..' ||
          outputRelative.startsWith('..' + sep) || isAbsolute(outputRelative))
        throw new PreviewError('unsafe-workspace-bin-output:' + outputPath, 2);
    }
  }
}

/** Freeze source and dependencies before invoking a command that allocates fixtures.
 * The receipt survives outside the owned tree; only this invocation's tree is removed.
 * @param {{ repo: string, runtimeAssetDonor?: string, ref: string, receiptPath: string, inputs?: string[], inputsFile?: string, tauriInputs?: boolean, sourceArchive?: { root: string, receiptSha256: string }, command: string[], env?: NodeJS.ProcessEnv, budgetFrom?: string, childEstimateMs?: number, preparationMaxMs?: number, prepareChildEnv?: (context: { sourceRoot: string }) => Promise<NodeJS.ProcessEnv | void> | NodeJS.ProcessEnv | void, releaseParentPrivatePg?: boolean, requestParentPgReleaseImpl?: (token: string) => Promise<unknown>,
 *   signal?: AbortSignal, clock?: { now: () => number, setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>, clearTimeout: (timer: ReturnType<typeof setTimeout>) => void } }} options
 * @returns {Promise<number>}
 */
export async function runVerifierCommand({ repo, runtimeAssetDonor, ref, receiptPath, inputs = [], inputsFile, tauriInputs = false, sourceArchive, command, env = process.env, budgetFrom, childEstimateMs = 0, preparationMaxMs, prepareChildEnv = async () => ({}),
  releaseParentPrivatePg = false, requestParentPgReleaseImpl = requestPrivateTestPgRelease, signal,
  clock = { now: Date.now, setTimeout, clearTimeout } }) {
  if (signal?.aborted) throw new PreviewError('verifier command canceled before launch', 143);
  if (!ref?.trim() || !receiptPath || !command?.length || !command[0])
    throw new PreviewError('verifier command needs an explicit ref, external receipt and command', 2);
  if (!Number.isSafeInteger(childEstimateMs) || childEstimateMs < 0)
    throw new PreviewError('verifier child estimate must be a nonnegative integer', 2);
  const sourceRepo = realpathSync(repo);
  env = verifierCommandAdmissionEnv({ repo: sourceRepo, env });
  const parentPgReleaseToken = env[PRIVATE_TEST_PG_RELEASE_TOKEN_ENV];
  if (releaseParentPrivatePg && !parentPgReleaseToken)
    throw new PreviewError('parent private test-PG release requires the wrapper-issued token', 2);
  const parentPgReleaseEnabled = releaseParentPrivatePg === true && Boolean(parentPgReleaseToken);
  if (preparationMaxMs !== undefined && (!Number.isSafeInteger(preparationMaxMs) || preparationMaxMs <= 0 || readTaskDeadlineEpochMs(env) === null))
    throw new PreviewError('explicit verifier preparation allowance needs positive integer milliseconds and a finite caller task deadline', 2);
  const sourceCommit = resolveCommit(sourceRepo, ref);
  // prepareVerifierSource validates the pinned archive and its complete census
  // inside source.freeze. Repeating it here spends the absolute task deadline
  // before source admission and leaves that work outside the budget journal.
  const explicitGeneration = Boolean(env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT);
  const donor = explicitGeneration ? sourceRepo : committedWorkRootDependencyDonor(sourceRepo);
  // A frozen Git source may consume an immutable dependency generation while
  // ignored model bytes live in a separate cache. Only the selected source's
  // checksum-pinned helper can admit and copy those bytes.
  const runtimeDonor = realpathSync(runtimeAssetDonor ?? donor);
  const runtimeSetupPath = 'apps/operator/scripts/setup-porcupine-runtime.sh';
  if (git(sourceRepo, ['ls-tree', sourceCommit, '--', runtimeSetupPath]).trim()) {
    // Ignored runtime assets are not covered by node/workspace generation custody.
    // Use the selected commit's checksum pin before allocating the source tree;
    // the eventual snapshot still copies and rechecks the donor bytes.
    const runtimeSetup = git(sourceRepo, ['show', sourceCommit + ':' + runtimeSetupPath]);
    const modelDonor = join(runtimeDonor, 'apps/operator/public/porcupine/porcupine_params.pv');
    const check = spawnSync('bash', ['-c', runtimeSetup, join(sourceRepo, runtimeSetupPath),
      '--check-source', modelDonor], { cwd: sourceRepo, env: verifierDependencyEnv(env),
      encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
    if (check.error || check.status !== 0)
      throw new PreviewError('verifier runtime asset preflight failed: ' +
        (check.error?.message || check.stderr || check.status), 2);
  }
  // Never allocate below a source donor: even ignored scratch is part of an
  // immutable source census. Reuse the external root the task reconciler knows.
  let scratch = await fs.realpath(tmpdir());
  if (process.platform === 'linux') {
    const data = await fs.realpath('/mnt/data');
    const dataDevice = (await fs.stat(data)).dev;
    if (dataDevice === (await fs.stat('/')).dev)
      throw new PreviewError('verifier command requires a separate /mnt/data filesystem', 2);
    scratch = join(data, 'tmp');
    await fs.mkdir(scratch, { recursive: true });
    scratch = await fs.realpath(scratch);
    if ((await fs.stat(scratch)).dev !== dataDevice)
      throw new PreviewError('verifier command scratch resolves outside the data filesystem', 2);
  }
  if (isInside(donor, scratch) || isInside(sourceRepo, scratch))
    throw new PreviewError('verifier command scratch must be outside the source and dependency donor', 2);
  const copyMode = verifierDependencyCopyMode(donor, scratch);
  const helperPath = 'papercusp-desktop/bin/lib/pinned-deps.sh';
  const helperObject = committedInputObject(sourceRepo, sourceCommit, helperPath, new Map(), true);
  const helperSource = helperObject ? git(helperObject.repo, ['cat-file', 'blob', helperObject.blob]) : '';
  const snapshotSelection = selectVerifierDependencySnapshot(copyMode,
    /^\s*snapshot-generation-locked\s*\)/m.test(helperSource), explicitGeneration);
  // Automatic cross-device selection consumes the same immutable closure as an
  // explicit generation. Select its contract from the requested commit, then
  // validate custody against that frozen source before copying dependencies.
  if (snapshotSelection.command === 'snapshot-generation-locked') {
    if (!/^\s*preflight-generation\s*\)/m.test(helperSource))
      throw new PreviewError('selected source does not support immutable verifier generations', 2);
  } else preflightVerifierWorkspaceBinDonor({ repo: sourceRepo, commit: sourceCommit, donor });
  const taskReceiptPath = `${resolve(receiptPath)}.task.json`;
  const cancellation = new AbortController();
  let cancellationSignal;
  const cancel = signal => {
    cancellationSignal ??= signal;
    cancellation.abort();
  };
  const onInt = () => cancel('SIGINT'), onTerm = () => cancel('SIGTERM'), onHup = () => cancel('SIGHUP');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm); process.on('SIGHUP', onHup);
  signal?.addEventListener('abort', onTerm, { once: true });
  if (signal?.aborted) onTerm();
  let owned;
  try { owned = await fs.mkdtemp(join(scratch, 'verifier-command-')); }
  catch (error) {
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); process.off('SIGHUP', onHup);
    signal?.removeEventListener('abort', onTerm);
    throw error;
  }
  const root = join(owned, 'invoked-source');
  const checkCancellation = () => {
    if (cancellationSignal)
      throw new PreviewError(`verifier command canceled by ${cancellationSignal}`,
        128 + constants.signals[cancellationSignal]);
  };
  let ownership;
  /** @type {VerifierPhaseRunner} */
  let runPhase = async (_phase, operation) => operation();
  let failure;
  let finalizationFailure;
  let budget;
  let commandExitCode = null;
  let phaseArchivePath;
  let taskEvidenceRoot;
  let taskEvidenceManifestPath;
  let resourceInventory;
  let inventoryCustody;
  let inventoryTerminal;
  const admitBudget = (estimate, preparation = false) => {
    const admission = admitVerifierCommandBudget(estimate, { env, preparation, nowMs: clock.now() });
    budget = { deadlineEpochMs: admission.deadlineEpochMs, cleanupReserveMs: admission.cleanupReserveMs,
      childCutoffEpochMs: admission.childCutoffEpochMs, admittedAtMs: clock.now(),
      cutoffTriggeredAtMs: null, childExitVerifiedAtMs: null };
    return admission;
  };
  try {
    assertOutsideArchive(owned, resolve(receiptPath));
    ownership = writeVerifierTaskReceipt(owned, sourceRepo, env, taskReceiptPath);
    const originalDeadline = readTaskDeadlineEpochMs(env);
    if (originalDeadline !== null) {
      inventoryCustody = { ownership, sourceCommit };
      resourceInventory = verifierResourceInventory({ path: `${receiptPath}.resources.jsonl`,
        owner: ownership.taskId ?
