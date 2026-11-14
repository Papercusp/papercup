---
rel_path: "portability/census/v55/02-source-preview.mjs.part-001"
updated_at: 1794250602744
_body: "content"
---

 & {
 *   reportProgress?: (phase: 'deps.census' | 'deps.postverify', progress: VerifierDependencyProgress) => void
 * }} VerifierPhaseRunner */

/** Device numbers alone do not distinguish Linux bind mounts: link(2) returns
 * EXDEV across them even on one filesystem. Unknown mount identity uses copies.
 * @param {string} donor
 * @param {string} dest
 * @returns {'copy' | 'hardlink'}
 */
function verifierDependencyCopyMode(donor, dest) {
  const sourceFd = openSync(donor, 'r');
  let targetFd;
  try {
    targetFd = openSync(dest, 'r');
    if (fstatSync(sourceFd).dev !== fstatSync(targetFd).dev) return 'copy';
    if (process.platform === 'linux') {
      const mountId = fd => readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8').match(/^mnt_id:\s*(\d+)$/m)?.[1];
      const sourceMount = mountId(sourceFd), targetMount = mountId(targetFd);
      if (!sourceMount || sourceMount !== targetMount) return 'copy';
    }
    return 'hardlink';
  } finally {
    if (targetFd !== undefined) closeSync(targetFd);
    closeSync(sourceFd);
  }
}

/** Keep the verifier's snapshot path selection explicit and independently checkable.
 * @param {VerifierSnapshotSelection['copyMode']} copyMode
 * @param {boolean} generationSnapshotSupported
 * @param {boolean} [explicitGeneration]
 * @returns {VerifierSnapshotSelection}
 */
export function selectVerifierDependencySnapshot(copyMode, generationSnapshotSupported, explicitGeneration = false) {
  assert.ok(['copy', 'hardlink'].includes(copyMode), 'Invalid verifier dependency copy mode');
  assert.equal(typeof generationSnapshotSupported, 'boolean', 'Invalid generation snapshot capability');
  assert.equal(typeof explicitGeneration, 'boolean', 'Invalid explicit generation selection');
  if (explicitGeneration && !generationSnapshotSupported)
    throw new PreviewError('selected source does not support immutable verifier generations', 2);
  return { copyMode, generationSnapshotSupported, ...(explicitGeneration ? { explicitGeneration } : {}),
    command: (copyMode === 'copy' || explicitGeneration) && generationSnapshotSupported
      ? 'snapshot-generation-locked' : 'snapshot-locked' };
}

function assertVerifierSnapshotSelection(selection) {
  assert.deepEqual(selection,
    selectVerifierDependencySnapshot(selection?.copyMode, selection?.generationSnapshotSupported, selection?.explicitGeneration),
    'Verifier snapshot selection metadata does not match its route inputs');
}

/** The writer and historical budget reader accept the same progress contract. */
function assertVerifierDependencyProgress(progress) {
  assert.deepEqual(Object.keys(progress ?? {}).filter(key => key !== 'cacheHit').sort(), ['completedTrees', 'currentTree', 'totalTrees'],
    'Verifier dependency progress must remain bounded');
  assert.ok(!Object.hasOwn(progress, 'cacheHit') || typeof progress.cacheHit === 'boolean',
    'Verifier dependency cacheHit must be boolean');
  assert.ok(Number.isSafeInteger(progress.completedTrees) && Number.isSafeInteger(progress.totalTrees) &&
    progress.totalTrees > 0 && progress.totalTrees <= 1000 &&
    progress.completedTrees >= 0 && progress.completedTrees <= progress.totalTrees &&
    typeof progress.currentTree === 'string' && progress.currentTree.length > 0 &&
    progress.currentTree.length <= 256, 'Invalid verifier dependency progress');
}

/** Append outside the owned tree synchronously: a blocked event loop or SIGKILL
 * must leave the last started phase readable without claiming it completed.
 * Mirror exact records into the existing checkpoint-log store so temporary
 * receipt cleanup cannot erase a later command's reviewed budget evidence.
 * @param {string} path
 * @param {NodeJS.ProcessEnv} env
 * @param {string} childDiagnosticsPath
 * @returns {VerifierPhaseRunner & { archivePath: string }}
 */
export function verifierPhaseRunner(path, env, childDiagnosticsPath) {
  writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
  const archiveDir = env.PAPERCUSP_CHECKPOINT_LOG_DIR || join(papercuspHome(env), 'checkpoint-logs');
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const archivePath = join(archiveDir,
    `verifier-phases-${createHash('sha256').update(resolve(path)).digest('hex')}.jsonl`);
  writeFileSync(archivePath, '', { flag: 'wx', mode: 0o600 });
  const started = performance.now();
  let sequence = 0;
  const record = (phase, event, fields = {}) => {
    const bytes = `${JSON.stringify({
      schemaVersion: 'verifier-phase-v1', sequence: ++sequence,
      taskId: env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID ?? null,
      phase, event, elapsedMs: Math.round(performance.now() - started), ...fields,
    })}\n`;
    appendFileSync(archivePath, bytes);
    appendFileSync(path, bytes);
  };
  const active = new Set();
  const reportProgress = (phase, progress) => {
    assert.ok(active.has(phase) && ['deps.census', 'deps.postverify'].includes(phase),
      'Verifier dependency progress requires an active census phase');
    assertVerifierDependencyProgress(progress);
    record(phase, 'progress', { progress });
  };
  const run = async (phase, operation, metadata) => {
    if (metadata !== undefined) {
      assert.equal(phase, 'deps.snapshot', 'Only the snapshot phase accepts route metadata');
      assert.deepEqual(Object.keys(metadata).sort(), ['snapshotSelection'],
        'Verifier phase metadata must remain bounded');
      assertVerifierSnapshotSelection(metadata.snapshotSelection);
    }
    const before = performance.now();
    record(phase, 'started', metadata ?? {});
    active.add(phase);
    try {
      const result = await operation();
      record(phase, 'completed', { durationMs: Math.round(performance.now() - before),
        ...(['source.admission', 'child.admission'].includes(phase) ? { budget: result } : {}),
        ...(phase === 'child.run' ? { exitCode: result, diagnosticsPath: childDiagnosticsPath } : {}) });
      return result;
    } catch (error) {
      record(phase, 'failed', { durationMs: Math.round(performance.now() - before),
        ...(phase === 'child.run' ? { diagnosticsPath: childDiagnosticsPath } : {}),
        error: String(error?.message ?? error).slice(0, 2000) });
      throw error;
    } finally {
      active.delete(phase);
    }
  };
  return Object.assign(run, { archivePath, reportProgress });
}

/** Retain bounded child tails outside the cleaned source tree, including failures
 * before a fixture can allocate its own worker artifacts. Open exclusively and
 * verify each path still names its original file before publishing the receipt.
 * @param {string} receiptPath
 */
function verifierChildDiagnostics(receiptPath) {
  const limit = 64 * 1024;
  const files = [];
  const create = path => {
    const file = { path, fd: openSync(path, 'wx', 0o600), tail: Buffer.alloc(0), totalBytes: 0 };
    files.push(file);
    return file;
  };
  const close = () => { for (const file of files) closeSync(file.fd); };
  const write = (file, bytes) => {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(file.fd, bytes, offset, bytes.length - offset, offset);
      if (!written) throw new Error('Verifier child diagnostics write made no progress');
      offset += written;
    }
    ftruncateSync(file.fd, bytes.length);
  };
  let receipt, stdout, stderr;
  try {
    receipt = create(`${receiptPath}.child.json`);
    stdout = create(`${receiptPath}.stdout.log`);
    stderr = create(`${receiptPath}.stderr.log`);
    write(receipt, Buffer.from(JSON.stringify({ schemaVersion: 'verifier-child-v1', status: 'started',
      stdout: { path: stdout.path }, stderr: { path: stderr.path } }) + '\n'));
  } catch (error) { close(); throw error; }
  return {
    collect(stream, chunk) {
      const file = stream === 'stdout' ? stdout : stderr;
      file.totalBytes += chunk.length;
      file.tail = Buffer.concat([file.tail, chunk]).subarray(-limit);
      write(file, file.tail);
      process[stream].write(chunk);
    },
    finish(outcome) {
      try {
        for (const file of files) {
          const actual = lstatSync(file.path), opened = fstatSync(file.fd);
          if (!actual.isFile() || actual.dev !== opened.dev || actual.ino !== opened.ino)
            throw new Error(`Verifier child diagnostics path changed: ${file.path}`);
        }
        const summary = file => ({ path: file.path, totalBytes: file.totalBytes,
          retainedBytes: file.tail.length, truncated: file.totalBytes > file.tail.length });
        write(receipt, Buffer.from(JSON.stringify({ schemaVersion: 'verifier-child-v1',
          status: outcome.exitCode === null && outcome.signal === null ? 'incomplete' : 'completed',
          ...outcome, stdout: summary(stdout), stderr: summary(stderr) }) + '\n'));
      } finally { close(); }
    },
  };
}

/** Run a bounded dependency preflight without abandoning writers in its owned tree.
 * The maintained helpers emit measured byte, lock and completed-tree counters;
 * only increases extend the watchdog. Join its process group before cleanup.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number, maxMs?: number,
 *   stallWindowMs?: number, extensionMs?: number, signal?: AbortSignal, cutoffEpochMs?: number | null, now?: () => number,
 *   resourceInventory?: ReturnType<typeof verifierResourceInventory> }} options
 */
export async function runVerifierDependencyCommand(command, args, { cwd, env,
  timeoutMs = 600_000, maxMs = 1_800_000, stallWindowMs = 150_000, extensionMs = 60_000, signal, cutoffEpochMs, now = Date.now, resourceInventory }) {
  if (signal?.aborted) throw new PreviewError('verifier dependency preflight canceled before launch', 2);
  const deadline = readTaskDeadlineEpochMs(env);
  if (deadline !== null) maxMs = Math.min(maxMs, deadline - now() - 10_000);
  if (cutoffEpochMs != null) {
    if (!Number.isSafeInteger(cutoffEpochMs) || cutoffEpochMs <= 0)
      throw new PreviewError('invalid verifier preparation cutoff', 2);
    maxMs = Math.min(maxMs, cutoffEpochMs - now());
  }
  if (maxMs <= 0) throw new PreviewError('verifier dependency preflight has no task budget remaining', 2);
  const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'] });
  const lifetime = processGroupLifetime(child, message => process.stderr.write(`${message}\n`));
  let stdout = '', stderr = '', pending = '';
  const counters = new Map();
  let termination;
  let terminationReason;
  let rejectAborted;
  const aborted = new Promise((_, reject) => { rejectAborted = reject; });
  const terminate = reason => {
    if (termination) return;
    terminationReason = reason;
    termination = lifetime.terminate({ graceMs: 1_000, killWaitMs: 5_000 });
    termination.then(() => rejectAborted(new PreviewError(reason, 2)), error => {
      error.retainVerifierTree = true;
      rejectAborted(error);
    });
  };
  const watchdog = createProgressAwareWatchdog({ timeoutMs: Math.min(timeoutMs, maxMs), maxMs,
    stallWindowMs, extensionMs,
    onExtend: () => process.stderr.write('VERIFIER_DEPENDENCY_PROGRESS watchdog extended on advancing dependency counters\n'),
    onKill: decision => terminate(`verifier dependency preflight timed out: ${decision.reason}`) });
  const collect = (stream, chunk) => {
    const text = chunk.toString();
    if (stream === 'stdout') stdout = (stdout + text).slice(-4 * 1024 * 1024);
    else stderr = (stderr + text).slice(-4 * 1024 * 1024);
    process[stream].write(chunk);
    pending += text;
    const lines = pending.split('\n');
    pending = lines.pop().slice(-4096);
    for (const line of lines) {
      const counter = /((?:checksum read|copy) progress:.*?) (?:written|read)=(\d+)MiB/.exec(line)
        ?? /(copy lock progress:.*?) advances=(\d+)/.exec(line)
        ?? /^(verifier census progress: scan=\d+:\d+) checked=(\d+)(?: |$)/.exec(line)
        ?? /^(snapshot progress:) completed=(\d+)(?: |$)/.exec(line);
      if (counter && Number(counter[2]) > (counters.get(counter[1]) ?? 0)) {
        counters.set(counter[1], Number(counter[2]));
        watchdog.noteProgress();
      }
    }
  };
  child.stdout.on('data', chunk => collect('stdout', chunk));
  child.stderr.on('data', chunk => collect('stderr', chunk));
  const closed = new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => done({ code, signal }));
  });
  const onAbort = () => terminate('verifier dependency preflight canceled');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    if (resourceInventory) {
      const identity = readProcessIdentity(child.pid);
      assert.ok(identity, 'Verifier helper original process identity unavailable');
      resourceInventory.record({ id: `process:${child.pid}:${identity}`, kind: 'process',
        pid: child.pid, processIdentity: identity, processGroup: child.pid });
    }
    const result = await Promise.race([closed, aborted]);
    await Promise.race([lifetime.waitForExit({ timeoutMs: maxMs }), aborted]);
    if (terminationReason) throw new PreviewError(terminationReason, 2);
    if (result.code !== 0 || result.signal)
      throw new PreviewError(`verifier dependency preflight failed: ${stderr || stdout || result.signal || result.code}`, 2);
    return stdout;
  } catch (error) {
    if (child.pid !== undefined) {
      if (!termination) termination = lifetime.terminate({ graceMs: 1_000, killWaitMs: 5_000 });
      try { await termination; }
      catch (exitError) {
        exitError.retainVerifierTree = true;
        throw new AggregateError([error, exitError], `${error.message}; ${exitError.message}`,
          { cause: Object.assign(exitError, { retainVerifierTree: true }) });
      }
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    watchdog.stop();
  }
}

/** The expected population comes from the parent's accepted evidence, never
 * the candidate or compiler metafile. `path` retains the original artifact
 * bytes; `members` is the independently accepted literal source-blob map.
 * @typedef {{ path: string, evidenceRef: string, sha256: string, schemaVersion: 1,
 *   members: Record<string, string>, authorityKind?: 'source-only' | 'full-output' }} BgAcceptedManifest
 * @typedef {{ schemaVersion: 'bg-verifier-source-v1', root: string,
 *   acceptedManifest: BgAcceptedManifest,
 *   source: Awaited<ReturnType<typeof prepareVerifierSource>>,
 *   sourceReceiptSha256: string }} BgVerifierPreparation
 */

/** @param {BgAcceptedManifest} expected @param {string} root */
function readBgAcceptedManifest(expected, root) {
  assert.ok(expected && typeof expected === 'object', 'BG parent manifest authority is UNKNOWN');
  assert.ok(expected.authorityKind === undefined || ['source-only', 'full-output'].includes(expected.authorityKind),
    'BG parent manifest authority kind is UNKNOWN');
  assert.ok(typeof expected.evidenceRef === 'string' && expected.evidenceRef.trim()
    && !/^(?:unknown|absent|unresolved)$/i.test(expected.evidenceRef.trim()),
  'BG parent manifest authority is UNKNOWN');
  assert.equal(expected.schemaVersion, 1, 'BG parent manifest schema mismatch');
  assert.match(expected.sha256 ?? '', /^[a-f0-9]{64}$/, 'BG parent manifest digest is required');
  assert.ok(typeof expected.path === 'string' && isAbsolute(expected.path), 'BG parent manifest path is required');
  assertOutsideArchive(root, expected.path);
  assert.ok(lstatSync(expected.path).isFile() && realpathSync(expected.path) === expected.path,
    'BG parent manifest must be an independent regular file');
  const bytes = readFileSync(expected.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, 'BG parent manifest digest mismatch');
  const manifest = JSON.parse(String(bytes));
  assert.equal(manifest.schemaVersion, expected.schemaVersion, 'BG parent manifest schema mismatch');
  assert.ok(expected.members && typeof expected.members === 'object' && !Array.isArray(expected.members)
    && Object.keys(expected.members).length > 0, 'BG parent manifest members are required');
  for (const [path, blob] of Object.entries(expected.members)) {
    assert.ok(path && !isAbsolute(path) && !path.includes('\\')
      && !path.includes('\0') && path.split('/').every(part => part && part !== '.' && part !== '..'),
    'BG parent manifest member path is invalid');
    assert.match(blob, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, 'BG parent manifest source blob is invalid');
  }
  assert.deepEqual(manifest.sourceBlobs, expected.members, 'BG parent manifest literal membership mismatch');
  return bytes;
}

/** Retain a detached, recursively immutable expectation. Mutation of a caller's
 * descriptor or the returned receipt must not bless a later source population.
 * @template T @param {T} value @returns {T}
 */
function freezeBgExpectation(value) {
  const copy = JSON.parse(JSON.stringify(value));
  const freeze = item => {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(copy);
}

/** Prepare through the maintained Git exporter, with original parent authority
 * resolved BEFORE it creates a destination. No build or activation is implied.
 * @param {{ repo: string, ref: string, dest: string, inputs: string[],
 *   acceptedManifest: BgAcceptedManifest }} options
 * @returns {Promise<BgVerifierPreparation>}
 */
export async function prepareBgVerifierSource({ repo, ref, dest, inputs, acceptedManifest }) {
  readBgAcceptedManifest(acceptedManifest, dest);
  const accepted = freezeBgExpectation(acceptedManifest);
  const members = Object.keys(accepted.members).sort();
  assert.deepEqual([...inputs].sort(), members, 'BG accepted input membership mismatch');
  const selected = resolveCommit(repo, ref);
  const trees = new Map();
  for (const path of members) {
    assert.equal(committedInputBlob(repo, selected, path, trees), accepted.members[path],
      `BG accepted input blob mismatch: ${path}`);
  }
  const source = await prepareVerifierSource({ repo, ref: selected, dest, inputs: members, gitCheckout: true });
  try {
    const sourceReceiptSha256 = createHash('sha256')
      .update(readFileSync(join(dest, '.verifier-source.json'))).digest('hex');
    /** @type {BgVerifierPreparation} */
    const prepared = freezeBgExpectation({ schemaVersion: 'bg-verifier-source-v1', root: realpathSync(dest),
      acceptedManifest: accepted, source, sourceReceiptSha256 });
    verifyBgVerifierSource(prepared, 'before-build');
    return prepared;
  } catch (error) {
    // prepareVerifierSource created this previously absent destination. Leave
    // the parent evidence and any peer/active/rollback generations untouched.
    await fs.rm(dest, { recursive: true, force: true });
    throw error;
  }
}

/** Reuse at both compiler boundaries. The original receipt is never regenerated
 * from observed output; dependencies and compiler-consumed bytes require their
 * separate custody checks before this source proof can qualify a build.
 * @param {BgVerifierPreparation} prepared
 * @param {'before-build' | 'before-publication'} boundary
 */
export function verifyBgVerifierSource(prepared, boundary) {
  assert.ok(['before-build', 'before-publication'].includes(boundary), 'BG compiler boundary is invalid');
  assert.equal(prepared.schemaVersion, 'bg-verifier-source-v1', 'BG preparation schema mismatch');
  const { root, source, acceptedManifest } = prepared;
  assert.equal(realpathSync(root), root, 'BG source root identity changed');
  readBgAcceptedManifest(acceptedManifest, root);
  assert.equal(createHash('sha256').update(readFileSync(join(root, '.verifier-source.json'))).digest('hex'),
    prepared.sourceReceiptSha256, 'BG original source receipt changed');
  assert.deepEqual(source.testedInputs.map(row => row.path).sort(), Object.keys(acceptedManifest.members).sort(),
    'BG accepted input membership mismatch');
  verifyVerifierSourceSync(root, source, { runtimeArtifacts: true });
  const trees = new Map();
  for (const [path, blob] of Object.entries(acceptedManifest.members)) {
    assert.equal(committedInputBlob(root, source.sourceCommit, path, trees), blob,
      `BG accepted input blob mismatch: ${path}`);
  }
  return prepared;
}

/** Bind esbuild's actual onLoad result to the original source/dependency census.
 * Endpoint fences alone miss an A-to-B-to-A rewrite. Hash the buffer returned
 * to esbuild, and retain that same buffer as its contents; never reopen it after
 * validation. Retain original file identities across the whole compile interval
 * as well: resolver metadata can select different original-censused bytes while
 * restoring its content before endpoint hashes run. Retain ancestor directory
 * identities too: originally absent metadata can be created for resolution and
 * removed before publication without changing any censused file. Compiler
 * invocation/toolchain identity and runtime external imports still require
 * their separate qualification boundaries.
 * @param {{ prepared: BgVerifierPreparation,
 *   dependencies: ReturnType<typeof captureVerifierDependencies> }} options
 */
export function createBgVerifierCompilerCustody({ prepared, dependencies }) {
  return bgVerifierCompilerCustody({ prepared, dependencies }, (boundary, original) => {
    verifyBgVerifierSource(prepared, boundary);
    assert.deepEqual(captureVerifierDependencies({ dest: prepared.root, receipt: prepared.source }), original,
      'BG compiler dependency census changed');
  });
}

/** Bind original generation provenance before runtime effects, keeping its async
 * verifier in this host alongside the existing input interval witness.
 * @param {Parameters<typeof createBgVerifierCompilerCustody>[0]} options */
export async function createBgVerifierRuntimeCustody(options) {
  const prepared = freezeBgExpectation(options.prepared);
  const dependencies = freezeBgExpectation(options.dependencies);
  const inputCustody = createBgVerifierCompilerCustody({ prepared, dependencies });
  const generation = await bindFrozenDependencyGeneration(prepared.root, prepared.source.sourceCommit);
  const identity = freezeBgExpectation(generation.identity);
  const boundAtMs = Date.now(), boundMonotonicNs = process.hrtime.bigint();
  bgRuntimeInputCustodies.get(inputCustody).verify();
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const custody = Object.freeze({
    /** @param {Parameters<typeof qualifyBgVerifierRuntimeSources>[0]} args */
    async qualify(args) {
      assert.equal(this, custody, 'BG frozen generation custody is not a retained host witness');
      assert.ok(args.execution.inputCustody === undefined || args.execution.inputCustody === inputCustody,
        'BG frozen generation input custody differs');
      const qualify = () => qualifyBgVerifierRuntimeSources({ ...args,
        execution: { ...args.execution, inputCustody } });
      const before = qualify();
      assert.ok(before.inputCustody, 'BG frozen generation input interval is missing');
      assert.ok(boundAtMs < Math.floor(before.inputCustody.firstExecAtMs),
        'BG frozen generation binding completed after traced execution');
      const originalArgsSha256 = hash(args);
      await generation.assertUnchanged();
      assert.equal(hash(args), originalArgsSha256, 'BG frozen generation runtime evidence changed during qualification');
      const proof = qualify();
      assert.ok(proof.inputCustody, 'BG frozen generation input interval is missing');
      const verifiedAtMs = Date.now(), verifiedMonotonicNs = process.hrtime.bigint();
      assert.ok(verifiedAtMs >= Math.ceil(proof.inputCustody.lastTerminalAtMs)
        && Math.abs((verifiedAtMs - boundAtMs) - Number(verifiedMonotonicNs - boundMonotonicNs) / 1e6) < 10,
      'BG frozen generation clock or terminal boundary differs');
      return freezeBgExpectation({ ...proof,
        dependencyQualification: 'original-frozen-generation-stable-over-traced-lifetime',
        frozenGeneration: { ...identity, boundAtMs, verifiedAtMs } });
    },
  });
  return custody;
}

/** Host-local interval witnesses extend the existing input custody; serialized
 * receipts and freshly reconstructed endpoint censuses cannot manufacture one.
 * @type {WeakMap<object, { preparedSha256: string, dependencySha256: string,
 * capturedAtMs: number, capturedMonotonicNs: bigint, files: number, directories: number,
 * verify: () => void }>} */
const bgRuntimeInputCustodies = new WeakMap();

/** Compose checks within one synchronous boundary, never across phase awaits.
 * The callback is private: callers cannot supply a cached or skipped fence.
 * @param {Parameters<typeof createBgVerifierCompilerCustody>[0]} options
 * @param {(boundary: 'before-build' | 'before-publication',
 *   original: ReturnType<typeof captureVerifierDependencies>) => void} verifyBoundary
 */
function bgVerifierCompilerCustody({ prepared, dependencies }, verifyBoundary) {
  const original = freezeBgExpectation(dependencies);
  assert.equal(original.root, prepared.root, 'BG compiler dependency root mismatch');
  verifyBoundary('before-build', original);
  const files = new Map(prepared.source.files.map(row => [row.path, row]));
  for (const tree of original.trees) for (const row of tree.files) {
    const path = `${tree.path}/${row.path}`;
    assert.ok(!files.has(path), `BG compiler duplicate input: ${path}`);
    files.set(path, { ...row, path });
  }
  /** @param {string} local */
  const inputIdentity = local => {
    const path = join(prepared.root, local);
    const stat = lstatSync(path, { bigint: true });
    return { physical: realpathSync(path), dev: stat.dev, ino: stat.ino,
      mode: stat.mode, nlink: stat.nlink, size: stat.size,
      mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
  };
  const originalIdentities = new Map([...files.keys()].map(local => [local, inputIdentity(local)]));
  // Derive the protected directory population from retained inputs, never from
  // later directory discovery. Include physical ancestors of in-root links.
  // Generated-only output directories are outside this population, so ordinary
  // compiler output does not invalidate the original input directories.
  const directories = new Set(['.']);
  for (const [local, identity] of originalIdentities) {
    const physical = relative(prepared.root, identity.physical).split(sep).join('/');
    assert.ok(physical && physical !== '..' && !physical.startsWith('../') && !isAbsolute(physical),
      'BG compiler original input escaped selected generation');
    for (const path of [local, physical]) {
      let directory = dirname(path);
      while (directory !== '.') {
        directories.add(directory);
        directory = dirname(directory);
      }
    }
  }
  const originalDirectories = new Map([...directories].map(local => [local, inputIdentity(local)]));
  /** @type {Map<string, { path: string, realpath: string, sha256: string }>} */
  const consumed = new Map();
  /** Read once and validate the exact buffer handed to an evaluator/compiler.
   * @param {string} path */
  const readInput = path => {
    const physical = realpathSync(path);
    const local = relative(prepared.root, physical).split(sep).join('/');
    assert.ok(local && local !== '..' && !local.startsWith('../') && !isAbsolute(local),
      'BG compiler input escaped selected generation');
    const expected = files.get(local);
    assert.ok(expected?.kind === 'file', `BG compiler input is outside original census: ${local}`);
    const fd = openSync(physical, 'r');
    /** @type {Buffer} */
    let contents;
    try {
      const before = fstatSync(fd, { bigint: true });
      assert.ok(before.isFile(), 'BG compiler input must be regular');
      contents = readFileSync(fd);
      const after = fstatSync(fd, { bigint: true });
      assert.ok(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key])
        && realpathSync(path) === physical, `BG compiler input changed while reading: ${local}`);
    } finally { closeSync(fd); }
    const sha256 = createHash('sha256').update(contents).digest('hex');
    assert.equal(sha256, expected.sha256, `BG compiler consumed bytes mismatch: ${local}`);
    return { contents, identity: { path: local, realpath: physical, sha256 } };
  };
  // This plugin must precede any other onLoad provider. It fails closed for
  // unknown inputs/loaders instead of asking esbuild to read them unobserved.
  /** @type {import('esbuild').Plugin} */
  const plugin = { name: 'bg-original-input-custody', setup(build) {
    assert.equal(build.initialOptions.plugins?.[0], plugin, 'BG compiler custody must be the first plugin');
    assert.equal(build.initialOptions.stdin, undefined, 'BG compiler stdin is outside original census');
    build.onLoad({ filter: /.*/ }, ({ path, namespace }) => {
      assert.equal(namespace, 'file', 'BG compiler virtual input is outside original census');
      const { contents, identity } = readInput(path);
      const { path: local, realpath: physical } = identity;
      /** @type {Record<string, import('esbuild').Loader>} */
      const loaders = { js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', json: 'json', css: 'css', txt: 'text' };
      const loader = build.initialOptions.loader?.['.' + local.split('.').at(-1)]
        ?? loaders[local.split('.').at(-1)];
      assert.ok(loader, `BG compiler input loader is UNKNOWN: ${local}`);
      consumed.set(local, identity);
      return { contents, loader, resolveDir: dirname(physical) };
    });
  } };
  const verifyInputs = () => {
    verifyBoundary('before-publication', original);
    for (const [local, expected] of originalIdentities)
      assert.deepEqual(inputIdentity(local), expected, `BG compiler original input identity changed: ${local}`);
    for (const [local, expected] of originalDirectories)
      assert.deepEqual(inputIdentity(local), expected, `BG compiler original directory identity changed: ${local}`);
  };
  const custody = { plugin, readToolchainInput: readInput,
    consumed: () => freezeBgExpectation([...consumed.values()].sort((a, b) => a.path.localeCompare(b.path))),
    verifyBeforePublication() {
      verifyInputs();
      assert.ok(consumed.size > 0, 'BG compiler consumed input proof is UNKNOWN');
      return freezeBgExpectation([...consumed.values()].sort((a, b) => a.path.localeCompare(b.path)));
    } };
  bgRuntimeInputCustodies.set(custody, {
    preparedSha256: createHash('sha256').update(JSON.stringify(prepared)).digest('hex'),
    dependencySha256: createHash('sha256').update(JSON.stringify(original)).digest('hex'),
    capturedAtMs: Date.now(), capturedMonotonicNs: process.hrtime.bigint(),
    files: originalIdentities.size, directories: originalDirectories.size, verify: verifyInputs });
  return custody;
}

/** @typedef {{ path: string, dev: string, ino: string }} BgDirectoryIdentity */
/** @typedef {{ builder: string, argv: string[], node: string, compiler: string,
 *   packageManager: string, configuration: string[], environment: Record<string, string>,
 *   outputNamespace?: { bank: BgDirectoryIdentity, stage: BgDirectoryIdentity, transactionSha256?: string } }} BgBuildInvocation
 */

/** Record actual command inputs before effects. The caller executes exactly this
 * argv and explicit environment; inherited ambient resolution is forbidden.
 * @param {BgVerifierPreparation} prepared @param {BgBuildInvocation} invocation
 */
function readBgBuildInvocation(prepared, invocation) {
  const identity = readBgFileIdentity;
  const builder = identity(invocation.builder), compiler = identity(invocation.compiler);
  assert.equal(builder.realpath, join(prepared.root, 'apps/operator/bin/bundle-host.sh'),
    'BG builder must be the maintained selected builder');
  for (const file of [builder, compiler]) {
    const local = relative(prepared.root, file.realpath);
    assert.ok(local && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local),
      'BG builder/compiler escaped selected generation');
  }
  assert.ok(Array.isArray(invocation.argv) && invocation.argv.every(arg => typeof arg === 'string'),
    'BG build argv is UNKNOWN');
  assert.ok(invocation.environment.NODE_OPTIONS === '' && invocation.environment.NODE_PATH === '',
    'BG build ambient Node resolution is forbidden');
  assert.ok(Object.entries(invocation.environment).every(([key, value]) =>
    /^[A-Z_][A-Z0-9_]*$/.test(key) && typeof value === 'string'), 'BG build environment is invalid');
  const configuration = invocation.configuration.map(identity).sort((a, b) => a.path.localeCompare(b.path));
  assert.equal(new Set(configuration.map(row => row.path)).size, configuration.length, 'BG build configuration duplicated');
  for (const file of configuration) {
    const local = relative(prepared.root, file.realpath).split(sep).join('/');
    assert.ok(prepared.source.files.some(row => row.path === local && row.sha256 === file.sha256),
      'BG build configuration is outside original source census');
  }
  if (invocation.outputNamespace) {
    for (const expected of [invocation.outputNamespace.bank, invocation.outputNamespace.stage])
      assert.deepEqual(readBgDirectoryIdentity(expected.path), expected, 'BG build output namespace changed');
  }
  return { builder, compiler, node: identity(invocation.node), packageManager: identity(invocation.packageManager),
    ...(invocation.outputNamespace ? { outputNamespace: invocation.outputNamespace } : {}),
    argv: [...invocation.argv], configuration,
    environment: Object.fromEntries(Object.entries(invocation.environment).sort(([a], [b]) => a.localeCompare(b))) };
}

/** Expected host files are nominated independently BEFORE compilation/runtime,
 * using the same pinned-manifest/physical-file fences as the source authority.
 * Optional builtin sources are pinned from the same independently selected Node
 * before the target starts, then joined to its native executable identity.
 * Optional vDSO bytes are independently pinned from that reference host too.
 * This does not attest creator exclusion or complete runtime coverage.
 * @typedef {{ schemaVersion: 1, path: string, sha256: string, evidenceRef: string }} BgExpectedHostManifest
 * @param {BgExpectedHostManifest} expected @param {string} root
 */
function readBgExpectedHostManifest(expected, root) {
  assert.ok(expected && expected.schemaVersion === 1
    && typeof expected.evidenceRef === 'string' && expected.evidenceRef.trim()
    && !/^(?:unknown|absent|unresolved)$/i.test(expected.evidenceRef.trim()),
  'BG expected host manifest authority is UNKNOWN');
  assert.match(expected.sha256 ?? '', /^[a-f0-9]{64}$/, 'BG expected host manifest digest is required');
  assertOutsideArchive(root, expected.path);
  const identity = readBgIndependentOutputIdentity(expected.path);
  assert.ok(BigInt(identity.size) > 0n && BigInt(identity.size) <= 1024n * 1024n,
    'BG expected host manifest size is invalid');
  const bytes = readFileSync(expected.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256,
    'BG expected host manifest digest mismatch');
  assert.deepEqual(readBgIndependentOutputIdentity(expected.path), identity,
    'BG expected host manifest changed while reading');
  assert.equal(identity.sha256, expected.sha256, 'BG expected host manifest identity mismatch');
  /** @type {{ schemaVersion: number, files: { path: string, sha256: string, bytes: number }[],
   *   builtinSources?: { url: string, sha256: string, bytes: number }[],
   *   vdso?: { origin: 'kernel-auxv-AT_SYSINFO_EHDR', sha256: string, bytes: number } }} */
  const manifest = JSON.parse(String(bytes));
  assert.ok(manifest.schemaVersion === 1 && Array.isArray(manifest.files)
    && manifest.files.length > 0 && manifest.files.length <= 1024,
  'BG expected host manifest file census is invalid');
  const paths = new Set();
  for (const file of manifest.files) {
    assert.ok(file && typeof file.path === 'string' && isAbsolute(file.path)
      && resolve(file.path) === file.path && !paths.has(file.path),
    'BG expected host manifest file path is invalid or duplicate');
    paths.add(file.path);
    assertOutsideArchive(root, file.path);
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0,
      'BG expected host manifest file size is invalid');
    assert.match(file.sha256 ?? '', /^[a-f0-9]{64}$/, 'BG expected host manifest file digest is invalid');
    const actual = readBgFileIdentity(file.path);
    assert.ok(actual.path === actual.realpath && actual.sha256 === file.sha256
      && lstatSync(file.path).size === file.bytes, 'BG expected host file differs from pinned bytes');
  }
  if (manifest.builtinSources !== undefined) {
    assert.ok(Array.isArray(manifest.builtinSources) && manifest.builtinSources.length > 0
      && manifest.builtinSources.length <= 4096, 'BG expected builtin source census is invalid');
    const urls = new Set();
    for (const source of manifest.builtinSources) {
      assert.ok(source && typeof source.url === 'string'
        && /^node:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(source.url) && !urls.has(source.url),
      'BG expected builtin source URL is invalid or duplicate');
      urls.add(source.url);
      assert.match(source.sha256 ?? '', /^[a-f0-9]{64}$/, 'BG expected builtin source digest is invalid');
      assert.ok(Number.isSafeInteger(source.bytes) && source.bytes >= 0,
        'BG expected builtin source size is invalid');
    }
  }
  if (manifest.vdso !== undefined) {
    assert.ok(manifest.vdso?.origin === 'kernel-auxv-AT_SYSINFO_EHDR'
      && Number.isSafeInteger(manifest.vdso.bytes) && manifest.vdso.bytes >= 64
      && manifest.vdso.bytes <= 65536 && typeof manifest.vdso.sha256 === 'string'
      && /^[a-f0-9]{64}$/.test(manifest.vdso.sha256), 'BG expected vDSO census is invalid');
  }
  return { authority: expected, identity, files: manifest.files,
    ...(manifest.builtinSources === undefined ? {} : { builtinSources: manifest.builtinSources }),
    ...(manifest.vdso === undefined ? {} : { vdso: manifest.vdso }) };
}

/** A distinct, detached invocation record, never a restamped source receipt.
 * @param {{ prepared: BgVerifierPreparation, dependencies: ReturnType<typeof captureVerifierDependencies>,
 *   invocation: BgBuildInvocation, expectedHostManifest?: BgExpectedHostManifest }} options
 */
export function prepareBgVerifierBuildRecord({ prepared, dependencies, invocation, expectedHostManifest }) {
  verifyBgVerifierSource(prepared, 'before-build');
  assert.deepEqual(captureVerifierDependencies({ dest: prepared.root, receipt: prepared.source }), dependencies,
    'BG build dependency census changed');
  const host = expectedHostManifest === undefined ? undefined : readBgExpectedHostManifest(expectedHostManifest, prepared.root);
  if (host) {
    const node = readBgFileIdentity(invocation.node);
    assert.ok(host.files.some(file => file.path === node.realpath && file.sha256 === node.sha256),
      'BG expected host manifest omits original Node');
  }
  return freezeBgExpectation({ schemaVersion: 'bg-build-invocation-v1', prepared, dependencies,
    originalSourceReceiptSha256: prepared.sourceReceiptSha256,
    ...(host ? { expectedHostManifest: host } : {}),
    invocation: readBgBuildInvocation(prepared, invocation) });
}

/** The same original command and physical identities fence both boundaries.
 * @param {ReturnType<typeof prepareBgVerifierBuildRecord>} record
 * @param {BgBuildInvocation} invocation
 * @param {'before-build' | 'before-publication'} boundary
 */
export function verifyBgVerifierBuildRecord(record, invocation, boundary) {
  assert.equal(record.schemaVersion, 'bg-build-invocation-v1', 'BG build record is UNKNOWN');
  verifyBgVerifierSource(record.prepared, boundary);
  assert.equal(record.originalSourceReceiptSha256, record.prepared.sourceReceiptSha256,
    'BG build record original receipt changed');
  if (record.expectedHostManifest) assert.deepEqual(
    readBgExpectedHostManifest(record.expectedHostManifest.authority, record.prepared.root), record.expectedHostManifest,
    'BG original expected host manifest changed');
  assert.deepEqual(readBgBuildInvocation(record.prepared, invocation), record.invocation,
    'BG builder configuration or toolchain identity changed');
  assert.deepEqual(captureVerifierDependencies({ dest: record.prepared.root, receipt: record.prepared.source }), record.dependencies,
    'BG build dependency census changed');
  return record;
}

/** Translate only the maintained host recipe's compiler switches. Unknown
 * switches refuse before loading the compiler or creating output. Keep the
 * original argv in the build record; this translation never replaces it.
 * @param {string[]} argv @param {string} root
 */
function bgCompilerOptions(argv, root) {
  /** @type {import('esbuild').BuildOptions} */
  const options = { absWorkingDir: root, entryPoints: [], write: false };
  /** @type {string | undefined} */
  let metafile;
  for (const arg of argv) {
    if (!arg.startsWith('-')) { options.entryPoints.push(arg); continue; }
    const flag = { '--bundle': 'bundle', '--minify-whitespace': 'minifyWhitespace',
      '--minify-syntax': 'minifySyntax', '--keep-names': 'keepNames' }[arg];
    if (flag) { options[flag] = true; continue; }
    const scalar = /^--(platform|format|target|outfile|log-level|log-limit)=(.+)$/s.exec(arg);
    if (scalar) {
      const key = { 'log-level': 'logLevel', 'log-limit': 'logLimit' }[scalar[1]] ?? scalar[1];
      options[key] = scalar[1] === 'log-limit' ? Number(scalar[2]) : scalar[2];
      continue;
    }
    if (arg.startsWith('--metafile=')) { metafile = arg.slice(11); options.metafile = true; continue; }
    if (arg.startsWith('--external:')) { (options.external ??= []).push(arg.slice(11)); continue; }
    const mapping = /^--(define|alias|banner):([^=]+)=(.*)$/s.exec(arg);
    if (mapping) { (options[mapping[1]] ??= {})[mapping[2]] = mapping[3]; continue; }
    throw new Error(`BG compiler switch is outside maintained recipe: ${arg}`);
  }
  assert.equal(options.entryPoints.length, 1, 'BG compiler requires exactly one maintained entry');
  assert.ok(options.outfile, 'BG compiler output path is required');
  const ownedPath = path => {
    const output = resolve(root, path), local = relative(root, output);
    assert.ok(local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`),
      'BG compiler output escaped selected generation');
    // Refuse existing directory-link parents as well as lexical escapes.
    let parent = dirname(output);
    while (!existsSync(parent)) parent = dirname(parent);
    const physical = realpathSync(parent), inside = relative(root, physical);
    assert.ok(inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside),
      'BG compiler output escaped selected generation');
    return output;
  };
  options.outfile = ownedPath(options.outfile);
  if (metafile !== undefined) metafile = ownedPath(metafile);
  return { options, metafile };
}

/** Keep the common source/dependency receipt once, with a separate original
 * command for every maintained main/worker/spawner invocation. Commands are
 * selected by their complete argv, never by entry basename or call order.
 * @param {{ prepared: BgVerifierPreparation, dependencies: ReturnType<typeof captureVerifierDependencies>,
 *   invocations: BgBuildInvocation[], expectedHostManifest?: BgExpectedHostManifest }} args
 */
export function prepareBgVerifierBuildContexts({ prepared, dependencies, invocations, expectedHostManifest }) {
  assert.ok(Array.isArray(invocations) && invocations.length > 0, 'BG invocation set is empty');
  const record = prepareBgVerifierBuildRecord({ prepared, dependencies, invocation: invocations[0], expectedHostManifest });
  return readBgVerifierBuildContexts(record, invocations);
}

/** Capture command identities after the caller has checked the common input
 * cohort in THIS synchronous validation. Never retain an input-validation cache
 * across boundaries, compiler calls or publication operations.
 * @param {ReturnType<typeof prepareBgVerifierBuildRecord>} record
 * @param {BgBuildInvocation[]} invocations
 */
function readBgVerifierBuildContexts(record, invocations) {
  const context = freezeBgExpectation({ schemaVersion: 'bg-build-contexts-v1', record,
    invocations: invocations.map(invocation => ({ invocation, original: readBgBuildInvocation(record.prepared, invocation) })) });
  validateBgVerifierBuildContexts(context);
  return context;
}

/** @param {ReturnType<typeof prepareBgVerifierBuildContexts>} context */
function validateBgVerifierBuildContexts(context) {
  assert.equal(context.schemaVersion, 'bg-build-contexts-v1', 'BG invocation set is UNKNOWN');
  assert.ok(Array.isArray(context.invocations) && context.invocations.length > 0, 'BG invocation set is empty');
  assert.deepEqual(context.invocations[0].original, context.record.invocation,
    'BG invocation set changed first build record');
  const common = ({ argv, ...identity }) => identity;
  const commands = new Set(), outputs = new Set();
  for (const entry of context.invocations) {
    assert.deepEqual(common(entry.original), common(context.record.invocation),
      'BG invocation set changed common build identity');
    assert.deepEqual(entry.invocation.argv, entry.original.argv, 'BG invocation set changed original argv');
    const key = JSON.stringify(entry.original.argv);
    assert.ok(!commands.has(key), 'BG invocation set duplicated command');
    commands.add(key);
    const { options, metafile } = bgCompilerOptions(entry.original.argv, context.record.prepared.root);
    for (const output of [options.outfile, metafile].filter(Boolean)) {
      assert.ok(!outputs.has(output), 'BG invocation set duplicated output');
      outputs.add(output);
    }
  }
}

/** Refresh the shared source/dependency census once per boundary, while still
 * reading EVERY command's actual toolchain, configuration and namespace. The
 * structural common-identity check must precede this deduplication: later
 * invocations cannot borrow the first command's authority.
 * @param {ReturnType<typeof prepareBgVerifierBuildContexts>} context
 * @param {'before-build' | 'before-publication'} boundary
 */
function verifyBgVerifierBuildContexts(context, boundary) {
  validateBgVerifierBuildContexts(context);
  verifyBgVerifierBuildRecord(context.record, context.invocations[0].invocation, boundary);
  for (const entry of context.invocations.slice(1))
    assert.deepEqual(readBgBuildInvocation(context.record.prepared, entry.invocation), entry.original,
      'BG builder configuration or toolchain identity changed');
}

/** @param {ReturnType<typeof prepareBgVerifierBuildContexts>} context
 * @param {string[]} argv
 */
function selectBgVerifierBuildContext(context, argv) {
  validateBgVerifierBuildContexts(context);
  const entry = context.invocations.find(row => JSON.stringify(row.original.argv) === JSON.stringify(argv));
  assert.ok(entry, 'BG compiler argv is outside original invocation set');
  return { record: { ...context.record, invocation: entry.original }, invocation: entry.invocation };
}

/** A caller nominates this namespace BEFORE the recipe knows its shell PID.
 * Follow release-artifacts.sh's physical producer-bank/absent-output contract.
 * The token may vary only in temporary output leaves; no observed compiler argv
 * can nominate commands, source inputs, switches, or logical output membership.
 * This is preparation for whole-recipe publication, not a publication receipt.
 * @param {{ prepared: BgVerifierPreparation, dependencies: ReturnType<typeof captureVerifierDependencies>,
 *   invocations: BgBuildInvocation[], bank: string, stageLeaf: string, expectedHostManifest?: BgExpectedHostManifest,
 *   outputs: { temporary: string, final: string }[], publicationLeaf?: string,
 *   assets?: { source: string, temporary: string, final: string }[],
 *   recipe?: { entry: string, outfile: string, profile: 'development' | 'release' } }} args
 */
export function prepareBgVerifierBuildTransaction({ prepared, dependencies, invocations, bank, stageLeaf, outputs, assets, recipe, publicationLeaf, expectedHostManifest }) {
  const contexts = prepareBgVerifierBuildContexts({ prepared, dependencies, invocations, expectedHostManifest });
  const bankIdentity = readBgDirectoryIdentity(bank);
  const local = relative(prepared.root, bank);
  assert.ok(local && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local),
    'BG transaction bank escaped selected generation');
  assert.match(stageLeaf, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'BG transaction stage leaf is invalid');
  const transaction = freezeBgExpectation({ schemaVersion: 'bg-build-transaction-v1', contexts,
    bank: bankIdentity, stage: join(bank, stageLeaf), outputs, ...(assets === undefined ? {} : { assets }), ...(recipe ? { recipe } : {}),
    ...(publicationLeaf === undefined ? {} : { publicationLeaf }) });
  validateBgVerifierBuildTransaction(transaction);
  assert.ok(!existsSync(transaction.stage) && !isBgSymlink(transaction.stage), 'BG transaction stage already exists');
  if (publicationLeaf !== undefined) assert.ok(!existsSync(join(bank, publicationLeaf))
    && !isBgSymlink(join(bank, publicationLeaf)), 'BG transaction publication already exists');
  return transaction;
}

/** @param {string} path @returns {BgDirectoryIdentity} */
function readBgDirectoryIdentity(path) {
  assert.ok(isAbsolute(path) && realpathSync(path) === path, 'BG output directory must be physical');
  const stat = lstatSync(path, { bigint: true });
  assert.ok(stat.isDirectory(), 'BG output directory must be independent');
