---
rel_path: "portability/census/v55/02-source-preview.mjs.part-004"
updated_at: 1794250602744
_body: "content"
---

? ownership.processIdentity, deadlineEpochMs: originalDeadline,
        custody: inventoryCustody, now: clock.now });
      resourceInventory.record({ id: 'candidate-root', kind: 'root', path: owned });
      resourceInventory.record({ id: 'source-root', kind: 'root', path: root });
    }
    const tracedPhase = verifierPhaseRunner(`${resolve(receiptPath)}.phases.jsonl`, env,
      `${receiptPath}.child.json`);
    phaseArchivePath = tracedPhase.archivePath;
    if (ownership.taskId) {
      const taskEvidenceTaskRoot = join(dirname(phaseArchivePath), `verifier-task-${ownership.taskId}`);
      mkdirSync(taskEvidenceTaskRoot, { recursive: true, mode: 0o700 });
      const taskEvidenceStat = lstatSync(taskEvidenceTaskRoot);
      assert.ok(taskEvidenceStat.isDirectory() && !taskEvidenceStat.isSymbolicLink(),
        'Verifier task evidence directory is not private storage');
      assert.equal(taskEvidenceStat.mode & 0o077, 0, 'Verifier task evidence directory must be private');
      const runId = createHash('sha256').update(resolve(receiptPath)).digest('hex');
      taskEvidenceRoot = join(taskEvidenceTaskRoot, runId);
      mkdirSync(taskEvidenceRoot, { mode: 0o700 });
      const runEvidenceStat = lstatSync(taskEvidenceRoot);
      assert.ok(runEvidenceStat.isDirectory() && !runEvidenceStat.isSymbolicLink(),
        'Verifier task run-evidence directory is not private storage');
      assert.equal(runEvidenceStat.mode & 0o077, 0, 'Verifier task run-evidence directory must be private');
      taskEvidenceManifestPath = join(taskEvidenceRoot, 'manifest.json');
    }
    process.stderr.write(`VERIFIER_PHASE_ARCHIVE ${JSON.stringify({
      path: `${resolve(receiptPath)}.phases.jsonl`, archivePath: tracedPhase.archivePath,
    })}\n`);
    const measurements = {};
    const executePhase = async (phase, operation, metadata) => {
      // Synchronous archive/census work delays JS signal delivery. Yield before
      // admitting the next phase, so a pending cancellation cannot start tests.
      const mustFinishAfterCancellation = phase === 'cleanup' || phase === 'private-pg.release';
      if (!mustFinishAfterCancellation) {
        await new Promise(resolve => setImmediate(resolve));
        checkCancellation();
      }
      const before = performance.now();
      const result = await tracedPhase(phase, async () => {
        const result = await operation();
        if (phase === 'deps.snapshot') {
          const snapshotReceipt = join(root, '.papercusp-pinned-deps');
          // Retain the ORIGINAL selected generation before census can fail and
          // owned-tree cleanup removes its only custody record. Older helpers
          // may omit it; absence must stay absence rather than reconstruction.
          if (existsSync(snapshotReceipt)) {
            const identity = readBgIndependentOutputIdentity(snapshotReceipt);
            const bytes = await fs.readFile(snapshotReceipt);
            assert.equal(createHash('sha256').update(bytes).digest('hex'), identity.sha256,
              'Verifier dependency snapshot receipt changed while retaining it');
            await fs.writeFile(`${receiptPath}.snapshot.txt`, bytes, { flag: 'wx', mode: 0o600 });
          }
        }
        return result;
      }, metadata);
      if (resourceInventory) {
        const retained = { 'receipt.write': receiptPath, 'deps.snapshot': `${receiptPath}.snapshot.txt`,
          'deps.receipt.write': `${receiptPath}.dependencies.json` }[phase];
        if (retained && existsSync(retained)) resourceInventory.record({ id: phase, kind: 'binding',
          path: resolve(retained), retain: 'original source/dependency evidence' });
      }
      measurements[phase] = Math.ceil(performance.now() - before);
      if (!mustFinishAfterCancellation) {
        await new Promise(resolve => setImmediate(resolve));
        checkCancellation();
      }
      return result;
    };
    runPhase = Object.assign(executePhase, {
      reportProgress: (phase, progress) => tracedPhase.reportProgress?.(phase, progress),
    });
    let previousMeasurements;
    await runPhase('source.admission', () => {
      previousMeasurements = budgetFrom ? readVerifierPhaseMeasurements(budgetFrom) : null;
      const estimate = previousMeasurements
        ? estimateVerifierCommandBudget(previousMeasurements, childEstimateMs,
          { parentPgRelease: parentPgReleaseEnabled })
        : null;
      return admitBudget(estimate, true);
    });
    // Historical pins can track outputs that the private runtime must rebuild.
    // Reuse the archive exporter for those pins; retain the normal Git checkout
    // when its tracked source population can remain intact.
    const gitCheckout = !VERIFIER_REBUILT_OUTPUTS.some(path =>
      committedVerifierPathTracked(sourceRepo, sourceCommit, path));
    const receipt = await runPhase('source.freeze', () => prepareVerifierSource({ repo: sourceRepo, ref: sourceCommit, dest: root,
      inputs, inputsFile, tauriInputs, gitCheckout, sourceArchive, requireDependencyCoherence: true }));
    await runPhase('receipt.write', () => fs.writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 }));
    // Native generation selection also needs independently pinned archive
    // custody before dependency materialization, using the reporter contract.
    const sourceEnv = { ...env, VERIFY_TAURI_SOURCE_RECEIPT: resolve(receiptPath),
      VERIFY_TAURI_SOURCE_REF: receipt.sourceCommit };
    if (snapshotSelection.command === 'snapshot-generation-locked') {
      await runPhase('deps.preflight', () => {
        const check = spawnSync('bash', [join(root, helperPath), 'preflight-generation', donor, root],
          { env: verifierDependencyEnv(sourceEnv), encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
        if (check.error || check.status !== 0)
          throw new PreviewError('verifier generation preflight failed: ' +
            (check.error?.message || check.stderr || check.status), 2);
      });
    }
    const dependencies = await prepareVerifierDependencies({ donor, runtimeAssetDonor: runtimeDonor, dest: root, receipt, runPhase,
      signal: cancellation.signal, env: sourceEnv, maxMs: preparationMaxMs, cutoffEpochMs: budget.childCutoffEpochMs, now: clock.now, resourceInventory });
    await runPhase('deps.receipt.write', () => fs.writeFile(`${receiptPath}.dependencies.json`,
      `${JSON.stringify(dependencies)}\n`, { flag: 'wx', mode: 0o600 }));
    const childEstimate = estimateVerifierCommandBudget({ ...previousMeasurements, ...measurements }, childEstimateMs,
      { parentPgRelease: parentPgReleaseEnabled });
    await runPhase('child.admission', () => admitBudget(childEstimate));
    const childEnv = await runPhase('child.preflight', () => verifierSourceChildEnv({ root, receiptPath,
        env: { ...env, PAPERCUSP_REPO_DIR: root, NODE_OPTIONS: '', NODE_PATH: '',
          VERIFY_TAURI_SOURCE_INPUTS: receipt.testedInputs.map(input => input.path).join(',') } }));
    // Resource setup that depends on a ready command environment (for example
    // starting the parent's private PG) happens only after committed source and
    // dependency-generation preparation have succeeded. A missing generation
    // therefore cannot allocate PG and then fail inside this verifier.
    const preparedChildEnv = await runPhase('child.environment', async () =>
      (await prepareChildEnv({ sourceRoot: root })) ?? {});
    const finalChildEnv = { ...childEnv, ...preparedChildEnv };
    let exitCode;
    let childRunError;
    try { exitCode = await runPhase('child.run', async () => {
      // Preflight can consume the admitted clock. Check again at the actual
      // spawn boundary, then keep the absolute cutoff until the WHOLE group exits.
      admitBudget(childEstimate);
      const child = spawn(command[0], command.slice(1), { cwd: root, env: finalChildEnv,
        detached: process.platform !== 'win32', stdio: ['inherit', 'pipe', 'pipe'] });
      const lifetime = processGroupLifetime(child, message => process.stderr.write(`${message}\n`));
      let diagnostics, captureError;
      const outcome = { pid: child.pid ?? null, exitCode: null, signal: null, error: null };
      const collect = stream => chunk => {
        if (captureError) return;
        try { diagnostics.collect(stream, chunk); }
        catch (error) { captureError = error; rejectStopped(error); }
      };
      let termination;
      let timer;
      let finished = false;
      let rejectStopped;
      const stopped = new Promise((_, reject) => { rejectStopped = reject; });
      stopped.catch(() => {});
      const cutoffError = () => new PreviewError(`VERIFIER_CHILD_DEADLINE_CUTOFF deadlineEpochMs=${budget.deadlineEpochMs} ` +
        `cleanupReserveMs=${budget.cleanupReserveMs} childCutoffEpochMs=${budget.childCutoffEpochMs}`, 2);
      const onAbort = () => {
        if (termination) return;
        termination = lifetime.terminate({ graceMs: 1_000, killWaitMs: 5_000 });
        // An unverified group may never close its pipes. Surface the failed fence
        // without waiting forever for close, and retain its tree for reconciliation.
        termination.then(() => {
          budget.childExitVerifiedAtMs = clock.now();
          rejectStopped(budget.cutoffTriggeredAtMs !== null ? cutoffError()
            : new PreviewError(`verifier command canceled by ${cancellationSignal}`, 2));
        }, error => {
          error.retainVerifierTree = true;
          rejectStopped(error);
        });
      };
      const armCutoff = () => {
        if (finished || budget.childCutoffEpochMs === null || cancellation.signal.aborted) return;
        const remainingMs = budget.childCutoffEpochMs - clock.now();
        if (remainingMs > 0) {
          // Long deadlines must not overflow Node's signed 32-bit timer delay.
          timer = clock.setTimeout(armCutoff, Math.min(remainingMs, 2_147_483_647));
        } else {
          budget.cutoffTriggeredAtMs = clock.now();
          cancellation.abort();
        }
      };
      let onError, onClose;
      try {
        if (resourceInventory) {
          const identity = readProcessIdentity(child.pid);
          assert.ok(identity, 'Verifier child original process identity unavailable');
          resourceInventory.record({ id: `process:${child.pid}:${identity}`, kind: 'process',
            pid: child.pid, processIdentity: identity, processGroup: child.pid });
        }
        diagnostics = verifierChildDiagnostics(receiptPath);
        child.stdout.on('data', collect('stdout'));
        child.stderr.on('data', collect('stderr'));
        /** @type {Promise<number>} */
        const closed = new Promise((done, reject) => {
          onError = reject;
          onClose = (code, signal) => {
            outcome.exitCode = code;
            outcome.signal = signal;
            done(code ?? (128 + (constants.signals[signal] || 0)));
          };
          child.once('error', onError);
          child.once('close', onClose);
        });
        cancellation.signal.addEventListener('abort', onAbort, { once: true });
        if (cancellation.signal.aborted) onAbort();
        armCutoff();
        const code = await Promise.race([closed, stopped]);
        await (termination ?? lifetime.waitForExit({ timeoutMs: 60_000 }));
        if (termination) await termination;
        budget.childExitVerifiedAtMs = clock.now();
        if (budget.cutoffTriggeredAtMs !== null) throw cutoffError();
        if (captureError) throw captureError;
        commandExitCode = code;
        return code;
      } catch (error) {
        outcome.error = String(error?.message ?? error).slice(0, 2000);
        try { await (termination ?? lifetime.terminate({ graceMs: 1_000, killWaitMs: 5_000 })); }
        catch (exitError) {
          throw new AggregateError([error, exitError], `${error.message}; ${exitError.message}`,
            { cause: Object.assign(exitError, { retainVerifierTree: true }) });
        }
        budget.childExitVerifiedAtMs = clock.now();
        throw error;
      } finally {
        finished = true;
        if (timer !== undefined) clock.clearTimeout(timer);
        cancellation.signal.removeEventListener('abort', onAbort);
        if (onError) child.removeListener('error', onError);
        if (onClose) child.removeListener('close', onClose);
        diagnostics?.finish(outcome);
      }
    }); } catch (error) { childRunError = error; }
    let privatePgReleaseError;
    if (parentPgReleaseEnabled && budget && budget.childExitVerifiedAtMs !== null) {
      try {
        await runPhase('private-pg.release', () => requestParentPgReleaseImpl(parentPgReleaseToken));
      } catch (error) { privatePgReleaseError = error; }
    }
    if (childRunError && privatePgReleaseError) {
      const message = error => String(error?.message ?? error);
      throw new AggregateError([childRunError, privatePgReleaseError],
        `verifier child failed: ${message(childRunError)}; parent private PG release failed: ${message(privatePgReleaseError)}`,
        { cause: childRunError });
    }
    if (childRunError) throw childRunError;
    if (privatePgReleaseError) throw privatePgReleaseError;
    await runPhase('deps.postverify', async () => {
      const after = await captureVerifierCommandDependencies({ dest: root, receipt, env,
        run: (command, args) => runVerifierDependencyCommand(command, args,
          { cwd: root, env: verifierDependencyEnv(env), signal: cancellation.signal,
            cutoffEpochMs: budget.childCutoffEpochMs, now: clock.now, resourceInventory }),
        onProgress: progress => runPhase.reportProgress?.('deps.postverify', progress) });
      // Keep the actual final census even on drift; never overwrite the
      // original observation with a reconstructed matching receipt.
      await fs.writeFile(`${receiptPath}.dependencies.after.json`, `${JSON.stringify(after)}\n`,
        { flag: 'wx', mode: 0o600 });
      assert.deepEqual(after, dependencies, 'Verifier materialized dependencies changed during command');
    });
    await runPhase('source.postverify', () => verifyVerifierSource(root, receipt, { runtimeArtifacts: true }));
    return exitCode;
  } catch (error) {
    // Cancellation is a signal outcome, not a successful test or a generic
    // preflight error; preserve any unverified-writer retention fence.
    if (cancellationSignal) {
      failure = new PreviewError(`verifier command canceled by ${cancellationSignal}`,
        128 + constants.signals[cancellationSignal]);
      if (error.retainVerifierTree || error.cause?.retainVerifierTree) failure.retainVerifierTree = true;
      throw failure;
    }
    failure = error;
    throw error;
  } finally {
    let cleanup = 'pending';
    const inventoryOutcome = cancellationSignal ? 'cancellation' : budget?.cutoffTriggeredAtMs != null ? 'timeout'
      : failure || (commandExitCode !== null && commandExitCode !== 0) ? 'failure' : 'success';
    try {
      let inventoryHasWriters = false;
      if (resourceInventory) {
        inventoryTerminal = await resourceInventory.reconcile({ outcome: inventoryOutcome,
          custody: { ownership: JSON.parse(readFileSync(taskReceiptPath, 'utf8')), sourceCommit } });
        inventoryHasWriters = inventoryTerminal.observations.some(row => row.pid !== undefined && row.state !== 'exited');
      }
      // An unverified exit is not permission to race a live writer. The task's
      // retained ownership receipt lets the existing reconciler clean it later.
      if (inventoryHasWriters || failure?.retainVerifierTree || failure?.cause?.retainVerifierTree) {
        cleanup = 'deferred';
        process.stderr.write(`VERIFIER_CLEANUP_DEFERRED unverified process exit: ${owned}\n`);
      } else {
        let cleaned = false;
        try {
          try {
            await runPhase('cleanup', async () => {
              await fs.rm(owned, { recursive: true, force: true });
              cleaned = true;
            });
          } finally {
            // A phase-receipt IO failure must never prevent owned-tree cleanup.
            if (!cleaned) {
              await fs.rm(owned, { recursive: true, force: true });
              cleaned = true;
            }
            cleanup = 'completed';
          }
        } catch (cleanupError) {
          cleanup = cleaned ? 'completed' : 'failed';
          finalizationFailure = cleanupError;
          if (failure) {
            finalizationFailure = new AggregateError([failure, cleanupError],
              `${failure.message}; verifier cleanup failed: ${cleanupError.message}`);
            throw finalizationFailure;
          }
          throw cleanupError;
        }
      }
      if (resourceInventory) {
        inventoryTerminal = await resourceInventory.reconcile({ outcome: inventoryOutcome, custody: inventoryCustody });
        if (!failure && inventoryOutcome === 'success' && inventoryTerminal.status !== 'completed')
          throw new PreviewError(`Verifier teardown unqualified: ${JSON.stringify(inventoryTerminal)}`, 2);
      }
    } catch (cleanupError) {
      finalizationFailure = failure && failure !== cleanupError
        ? new AggregateError([failure, cleanupError], `${failure.message}; verifier finalization failed: ${cleanupError.message}`)
        : cleanupError;
      throw finalizationFailure;
    } finally {
      try {
        if (ownership) {
          const next = `${taskReceiptPath}.${process.pid}.tmp`;
          try {
            await fs.writeFile(next, `${JSON.stringify({ ...ownership, cleanup,
              resourceInventory: resourceInventory ? { path: `${receiptPath}.resources.jsonl`,
                history: resourceInventory.checkpoint(), terminal: inventoryTerminal }
                : { status: 'unknown', reason: 'original finite task deadline unavailable' },
              ...(budget ? { budget } : {}),
              ...(cancellationSignal ? { cancellationSignal } : {}),
              ...(taskEvidenceManifestPath ? { evidenceManifestPath: taskEvidenceManifestPath } : {}) })}\n`,
            { flag: 'wx', mode: 0o600 });
            await fs.rename(next, taskReceiptPath);
          } finally { await fs.rm(next, { force: true }); }
        }
        if (taskEvidenceRoot && ownership && phaseArchivePath) {
          try {
            const retainedManifestPath = archiveVerifierTaskEvidence({ evidenceRoot: taskEvidenceRoot, taskId: ownership.taskId,
              sourceCommit, receiptPath, taskReceiptPath, phaseArchivePath, cleanup,
              childExitCode: commandExitCode, error: failure ?? finalizationFailure });
            process.stderr.write(`VERIFIER_TASK_EVIDENCE ${JSON.stringify({
              taskId: ownership.taskId, manifestPath: retainedManifestPath,
            })}\n`);
          } catch (evidenceError) {
            const priorError = failure ?? finalizationFailure;
            if (priorError) throw new AggregateError([priorError, evidenceError],
              `${priorError.message}; verifier task evidence retention failed: ${evidenceError.message}`,
              { cause: priorError });
            throw evidenceError;
          }
        }
      } finally {
        process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); process.off('SIGHUP', onHup);
        signal?.removeEventListener('abort', onTerm);
      }
    }
    checkCancellation();
  }
}

/** Fail closed on absent/changed provenance or any modified/extra/missing source byte.
 * @param {string} dest
 * @param {Awaited<ReturnType<typeof prepareVerifierSource>>} expected
 * @param {{ runtimeArtifacts?: boolean, dependencyStaging?: boolean }} [options] Source-only runtime mode permits
 * named untracked build outputs and materialized dependency directories, not source edits.
 * dependencyStaging is reserved for the pre-copy preparation check; it never attests dependency bytes.
 */
export async function verifyVerifierSource(dest, expected, options = {}) {
  return verifyVerifierSourceSync(dest, expected, options);
}

/** Synchronous boundary for hooks such as Playwright onBegin, whose return
 * value is not awaited. Uses the same source population and receipt checks.
 * @param {string} dest
 * @param {Awaited<ReturnType<typeof prepareVerifierSource>>} expected
 * @param {{ runtimeArtifacts?: boolean, dependencyStaging?: boolean }} [options]
 * dependencyStaging is reserved for the pre-copy preparation check.
 */
export function verifyVerifierSourceSync(dest, expected, options = {}) {
  try {
    const result = verifyArchivedSourceSync(dest, expected,
      expected?.operatorApiInputs ? { ...options, runtimeArtifacts: true } : options);
    if (expected.operatorApiInputs) {
      assertOutsideArchive(dest, expected.operatorApiInputs.path);
      const bytes = pinnedReceiptBytes(expected.operatorApiInputs.path, expected.operatorApiInputs.sha256);
      assertOperatorApiPlannedInputs(dest, expected, JSON.parse(String(bytes)));
    }
    return result;
  } catch (error) {
    if (error instanceof VerifierSourceError) throw new PreviewError(error.message, 2);
    throw error;
  }
}

/** Validate the existing producer's planned contract without inventing an
 * observed import, schema or environment pin from static source membership. */
function assertOperatorApiPlannedInputs(root, source, inputs) {
  assert.equal(inputs?.phase, 'planned', 'Operator-api independent planned inputs are required');
  assert.equal(inputs.sourceCommit, source.sourceCommit, 'Operator-api selected source differs');
  for (const key of ['testPaths', 'helperPaths', 'configPaths', 'executedImports', 'copiedSources',
    'dependencyFiles', 'copiedArtifacts', 'omitted', 'opaque'])
    assert.ok(Array.isArray(inputs[key]), `Operator-api required dimension missing: ${key}`);
  assert.deepEqual(inputs.omitted, [], 'Operator-api required dimensions omitted');
  assert.deepEqual(inputs.opaque, [], 'Operator-api required dimensions opaque');
  const files = new Map(source.files.map(file => [file.path, file]));
  const sourcePath = path => {
    assert.ok(typeof path === 'string' && path && !isAbsolute(path) && !path.includes('\\')
      && !path.split('/').some(part => !part || part === '.' || part === '..'), 'Invalid operator-api source path');
    assert.ok(files.has(path), `Operator-api source outside selected archive: ${path}`);
    assert.ok(isInside(realpathSync(root), realpathSync(join(root, path))), `Operator-api source escapes archive: ${path}`);
  };
  for (const key of ['testPaths', 'helperPaths', 'configPaths', 'executedImports'])
    assert.ok(inputs[key].length, `Operator-api required observation missing: ${key}`);
  for (const path of [...inputs.testPaths, ...inputs.helperPaths, ...inputs.configPaths,
    ...inputs.executedImports, ...inputs.copiedSources]) sourcePath(path);
  for (const path of inputs.testPaths) assert.ok(source.testedInputs.some(input => input.path === path
    && input.sha256 === files.get(path).sha256), `Operator-api test missing from selected tested inputs: ${path}`);
  for (const key of ['schema', 'environment', 'externalResolutions'])
    assert.ok(inputs[key] && typeof inputs[key] === 'object' && !Array.isArray(inputs[key]),
      `Operator-api required dimension missing: ${key}`);
  for (const key of ['schema', 'environment']) {
    assert.ok(Object.keys(inputs[key]).length, `Operator-api required observation missing: ${key}`);
    for (const value of Object.values(inputs[key])) assert.ok(typeof value === 'string' && value,
      `Operator-api invalid observation: ${key}`);
  }
  for (const value of Object.values(inputs.environment)) assert.match(value, /^[a-f0-9]{64}$/,
    'Operator-api environment digest missing');
  assert.ok(inputs.dependencyFiles.length, 'Operator-api materialized dependencies missing');
  const modules = join(root, 'node_modules');
  assert.ok(lstatSync(modules).isDirectory(), 'Operator-api dependencies must be an independent directory');
  assert.deepEqual(verifierSourceFiles(modules), inputs.dependencyFiles, 'Operator-api materialized dependency census differs');
  for (const file of inputs.dependencyFiles) if (file.kind === 'symlink')
    assert.ok(isInside(realpathSync(modules), realpathSync(join(modules, file.path))),
      `Operator-api dependency symlink escapes materialized tree: ${file.path}`);
  const dependencies = new Set(inputs.dependencyFiles.map(file => `node_modules/${file.path}`));
  for (const path of Object.values(inputs.externalResolutions)) assert.ok(dependencies.has(path),
    `Operator-api external resolution lacks dependency pin: ${path}`);
  const copies = new Map();
  for (const copy of inputs.copiedArtifacts) {
    sourcePath(copy.sourcePath);
    assert.ok(typeof copy.path === 'string' && copy.path && !isAbsolute(copy.path) && !copy.path.includes('\\')
      && !copy.path.split('/').some(part => !part || part === '.' || part === '..'), 'Invalid operator-api artifact path');
    assert.ok(!['operator-api-preflight.json', 'operator-api-inputs.json', 'verifier-source.json',
      'hono-host.mjs', 'hono-host.mjs.meta.json', 'operator-api-build.log'].includes(copy.path)
      && !copies.has(copy.path), 'Reserved or duplicate operator-api artifact path');
    copies.set(copy.path, copy.sourcePath);
  }
  assert.deepEqual([...new Set(copies.values())].sort(), [...new Set(inputs.copiedSources)].sort(),
    'Operator-api copied source census differs');
}

function prospectiveRealpath(path, links = new Set()) {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    let stat;
    try { stat = lstatSync(absolute); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) {
      assert.ok(!links.has(absolute), 'Operator-api receipt path has a symlink cycle');
      links.add(absolute);
      return prospectiveRealpath(resolve(dirname(absolute), readlinkSync(absolute)), links);
    }
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(prospectiveRealpath(parent, links), basename(absolute));
  }
}

function assertOutsideArchive(root, path) {
  // Resolve missing ancestors and dangling links as well as existing parents;
  // the export root may not have been allocated yet.
  assert.ok(!isInside(prospectiveRealpath(root), prospectiveRealpath(path)),
    'Operator-api receipt must be outside the archive');
}

function pinnedReceiptBytes(path, expected) {
  assert.match(expected ?? '', /^[a-f0-9]{64}$/, 'Operator-api receipt digest is required');
  const bytes = readFileSync(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, 'Pinned operator-api receipt changed');
  return bytes;
}

function readOperatorApiHandoff(options, selectedCommit) {
  assertOutsideArchive(realpathSync(options.root), options.sourceReceiptPath);
  assertOutsideArchive(realpathSync(options.root), options.inputReceiptPath);
  const source = JSON.parse(String(pinnedReceiptBytes(options.sourceReceiptPath, options.sourceReceiptSha256)));
  assert.equal(source.sourceCommit, selectedCommit, 'Operator-api independent selected commit differs');
  verifyArchivedSourceSync(options.root, source, { runtimeArtifacts: true });
  const bytes = pinnedReceiptBytes(options.inputReceiptPath, options.inputReceiptSha256);
  const inputs = JSON.parse(String(bytes));
  assertOperatorApiPlannedInputs(options.root, source, inputs);
  return { source, inputs, bytes };
}

/** Transport the independently verified archive receipt into native reporters.
 * A successful parent preflight alone does not give a child source provenance.
 * @param {{ root: string, receiptPath: string, env?: NodeJS.ProcessEnv }} options
 */
export function verifierSourceChildEnv({ root, receiptPath, env = process.env }) {
  const sourceRoot = realpathSync(root);
  const receipt = realpathSync(receiptPath);
  const receiptRel = relative(sourceRoot, receipt);
  if (receiptRel !== '..' && !receiptRel.startsWith(`..${sep}`)) {
    throw new PreviewError('verifier source receipt must be outside the archive', 2);
  }
  const expected = JSON.parse(readFileSync(receipt, 'utf8'));
  verifyVerifierSourceSync(sourceRoot, expected, { runtimeArtifacts: true });
  const childEnv = { ...env, VERIFY_TAURI_SOURCE_RECEIPT: receipt, VERIFY_TAURI_SOURCE_REF: expected.sourceCommit };
  delete childEnv[PRIVATE_TEST_PG_RELEASE_TOKEN_ENV];
  return childEnv;
}

const VERIFIER_PREPARATION_PHASES = ['source.freeze', 'receipt.write', 'deps.source.before',
  'deps.snapshot', 'deps.source.after-snapshot', 'deps.inputs', 'deps.measure',
  'deps.source.after-preflight', 'deps.census', 'deps.receipt.write'];
// Older receipts and non-native runs may omit these phases. Completed native
// observations still consume preparation time and must enter the launch forecast.
const VERIFIER_OPTIONAL_PREPARATION_PHASES = ['deps.preflight', 'deps.runtime-assets',
  'deps.source.after-runtime-assets'];

/** Read observations only, never acceptance evidence. A killed phase is not a duration.
 * @param {string} path @returns {Record<string, number>}
 */
export function readVerifierPhaseMeasurements(path) {
  const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const measurements = {};
  const started = new Set();
  let sequence = 0, elapsed = 0;
  for (const row of rows) {
    assert.ok(row.schemaVersion === 'verifier-phase-v1' && row.sequence === ++sequence &&
      Number.isSafeInteger(row.elapsedMs) && row.elapsedMs >= elapsed && typeof row.phase === 'string',
    'Invalid verifier phase budget receipt');
    elapsed = row.elapsedMs;
    if (row.event === 'started') {
      assert.ok(!started.has(row.phase), 'Duplicate verifier phase start');
      if (row.snapshotSelection !== undefined) {
        assert.ok(row.phase === 'deps.snapshot', 'Snapshot selection belongs to the snapshot phase');
        assertVerifierSnapshotSelection(row.snapshotSelection);
      }
      started.add(row.phase);
    } else if (row.event === 'progress') {
      const progress = row.progress;
      assert.ok(started.has(row.phase) && ['deps.census', 'deps.postverify'].includes(row.phase),
        'Invalid verifier phase progress receipt');
      assertVerifierDependencyProgress(progress);
    } else {
      assert.ok(started.delete(row.phase) && ['completed', 'failed'].includes(row.event),
        'Verifier phase terminal record lacks a start');
      if (row.event === 'completed') {
        assert.ok(Number.isSafeInteger(row.durationMs) && row.durationMs >= 0,
          'Invalid verifier phase duration');
        measurements[row.phase] = Math.max(measurements[row.phase] ?? 0, row.durationMs);
      }
    }
  }
  return measurements;
}

/** Reserve both complete final censuses and cleanup, using this run's observations or an
 * explicitly selected earlier phase receipt. Estimates are prognoses, not guarantees;
 * an omitted child estimate remains explicitly unknown. No source/dependency scope changes.
 * `totalMs` is work remaining at source admission, not a caller timeout. Use
 * `requiredTimeoutMs` when launching: startup already spends the absolute clock.
 * Reserve at least 30s, or 125% of an explicitly measured launch delay. This is
 * a forecast; admission still checks the actual remaining clock independently.
 * @param {Record<string, number>} measurements @param {number} [childEstimateMs]
 * @param {{ observedLaunchMs?: number, maxTimeoutMs?: number, parentPgRelease?: boolean,
 *   bgRecipe?: { invocationCount: number, completedPhases?: string[],
 *     activePhase?: { phase: string, elapsedMs: number } } }} [options]
 */
export function estimateVerifierCommandBudget(measurements, childEstimateMs = 0,
  { observedLaunchMs, maxTimeoutMs, parentPgRelease = false, bgRecipe } = {}) {
  for (const [phase, duration] of Object.entries(measurements))
    assert.ok(Number.isSafeInteger(duration) && duration >= 0, `Invalid verifier phase duration: ${phase}`);
  assert.ok(Number.isSafeInteger(childEstimateMs) && childEstimateMs >= 0, 'Invalid verifier child estimate');
  assert.ok(observedLaunchMs === undefined || Number.isSafeInteger(observedLaunchMs) && observedLaunchMs >= 0,
    'Invalid verifier launch observation');
  assert.ok(maxTimeoutMs === undefined || Number.isSafeInteger(maxTimeoutMs) && maxTimeoutMs > 0,
    'Invalid verifier caller timeout ceiling');
  let recipePhases;
  if (bgRecipe) {
    const { invocationCount, completedPhases = [], activePhase } = bgRecipe;
    assert.ok(Number.isSafeInteger(invocationCount) && invocationCount > 0 && invocationCount <= 1000,
      'Invalid BG recipe invocation count');
    for (const phase of ['bg.compiler.before-build', 'bg.compiler.custody', 'bg.compiler.build', 'bg.compiler.verify'])
      assert.ok(Object.hasOwn(measurements, phase), `Verifier budget requires completed phase: ${phase}`);
    const compilerMs = Math.max(1,
      Object.entries(measurements).filter(([phase]) => phase.startsWith('bg.compiler.'))
        .reduce((total, [, duration]) => total + duration, 0),
      ...Object.entries(measurements).filter(([phase]) => /^bg\.recipe\.compiler\.\d+$/.test(phase))
        .map(([, duration]) => duration));
    // A completed compiler includes all three fresh censuses and consumed-byte
    // checks. Use that whole cost for EACH tail census until a slower tail is
    // observed. Counts follow the maintained call graph: logical qualification
    // does output(2), artifact(2), logical(3); publication checks logical twice.
    // These are explicit conservative proxies, never completed tail evidence.
    /** @type {[string, number][]} */
    const plan = [['bg.recipe.validate', 1], ['bg.recipe.begin', 3],
      ...Array.from({ length: invocationCount }, (_, i) => /** @type {[string, number]} */ ([`bg.recipe.compiler.${i}`, 1])),
      ['bg.recipe.assets', 2], ['bg.recipe.output', 2], ['bg.recipe.logical', 7],
      ['bg.recipe.publish', 6], ['bg.recipe.verify', 3]];
    assert.ok(new Set(completedPhases).size === completedPhases.length &&
      completedPhases.every((phase, index) => phase === plan[index]?.[0]),
    'BG recipe budget completion order changed');
    if (activePhase) assert.ok(activePhase.phase === plan[completedPhases.length]?.[0] &&
      Number.isSafeInteger(activePhase.elapsedMs) && activePhase.elapsedMs >= 0,
    'Invalid BG recipe active phase');
    recipePhases = plan.slice(completedPhases.length).map(([phase, passes]) => {
      const estimateMs = Math.max(measurements[phase] ?? 0, compilerMs * Number(passes));
      return { phase: String(phase), estimateMs: Math.max(0,
        estimateMs - (activePhase?.phase === phase ? activePhase.elapsedMs : 0)) };
    });
  } else {
    for (const phase of VERIFIER_PREPARATION_PHASES)
      assert.ok(Object.hasOwn(measurements, phase), `Verifier budget requires completed phase: ${phase}`);
  }
  const preparationMs = bgRecipe ? 0 : [...VERIFIER_PREPARATION_PHASES, ...VERIFIER_OPTIONAL_PREPARATION_PHASES]
    .reduce((total, phase) => total + (measurements[phase] ?? 0), 0);
  const sourceCheckMs = Math.max(...['deps.source.before', 'deps.source.after-snapshot',
    'deps.source.after-runtime-assets', 'deps.source.after-preflight', 'child.preflight',
    'source.postverify'].map(phase => measurements[phase] ?? 0));
  const dependencyCheckMs = Math.max(measurements['deps.census'] ?? 0, measurements['deps.postverify'] ?? 0);
  // With no completed cleanup receipt, reserve at least the observed snapshot/freezing
  // work: deletion must still walk the whole population. This is a conservative proxy.
  const cleanupMs = Math.max(120_000, measurements.cleanup ?? 0, measurements['source.freeze'] ?? 0, measurements['deps.snapshot'] ?? 0);
  const privatePgReleaseMs = parentPgRelease ? 10_000 : 0;
  const remainingMs = (recipePhases ? recipePhases.reduce((total, phase) => total + phase.estimateMs, 0)
    : sourceCheckMs * 2 + dependencyCheckMs + childEstimateMs) + cleanupMs + privatePgReleaseMs;
  const remainingBudgetMs = Math.ceil(remainingMs * 1.25);
  // Preparation consumes its margin before child admission reforecasts the
  // remaining work. Reserve that child margin at launch too: a slower snapshot
  // both spends preparation time and raises the protected cleanup reserve.
  const totalMs = Math.ceil((preparationMs + remainingBudgetMs) * 1.25);
  const launchReserveMs = Math.max(30_000, Math.ceil((observedLaunchMs ?? 0) * 1.25));
  // The launcher publishes whole seconds and admission requires strictly more
  // than the forecast. Retain that strict boundary even on exact seconds.
  const requiredTimeoutMs = (Math.floor((totalMs + launchReserveMs) / 1_000) + 1) * 1_000;
  assert.ok(Number.isSafeInteger(requiredTimeoutMs), 'Invalid verifier launch budget');
  if (maxTimeoutMs !== undefined && requiredTimeoutMs > maxTimeoutMs)
    throw new PreviewError(`VERIFIER_LAUNCH_BUDGET_REFUSAL requiredTimeoutMs=${requiredTimeoutMs} ` +
      `maxTimeoutMs=${maxTimeoutMs} workEstimateMs=${totalMs} launchReserveMs=${launchReserveMs} — ` +
      'the caller ceiling cannot fit the work forecast plus launch reserve; do not start providers.', 2);
  return { preparationMs, sourceCheckMs, dependencyCheckMs, cleanupMs, childEstimateMs,
    unknownChild: !bgRecipe && childEstimateMs === 0, remainingMs: remainingBudgetMs,
    totalMs, observedLaunchMs: observedLaunchMs ?? null, launchReserveMs, requiredTimeoutMs,
    ...(recipePhases ? { recipePhases } : {}) };
}

/** Reuse the launcher's absolute deadline and the scheduler's attributable refusal. */
export function admitVerifierCommandBudget(estimate, { env = process.env, nowMs = Date.now(), preparation = false } = {}) {
  const privatePgReleaseMs = env[PRIVATE_TEST_PG_RELEASE_TOKEN_ENV] ? 10_000 : 0;
  const cleanupReserveMs = Math.max(120_000, estimate?.cleanupMs ?? 0) + privatePgReleaseMs;
  const knownEstimateMs = Math.max(cleanupReserveMs, estimate ? (preparation ? estimate.totalMs : estimate.remainingMs) : 0);
  try {
    return { ...admitTaskDeadline({ env, nowMs, cleanupReserveMs, knownEstimateMs,
      knownTasks: estimate ? (estimate.recipePhases?.length ?? VERIFIER_PREPARATION_PHASES.length) : 0,
      unknownTasks: estimate?.unknownChild === false ? 0 : 1 }), estimate };
  } catch (error) {
    throw new PreviewError(error.message, 2);
  }
}

/**
 * Copy the managed verifier's receipts into the existing checkpoint-log store
 * before the command can exit. Terminal wakes may be consumed hours later, after
 * their caller's /tmp files have been removed. The task id names the bundle; the
 * manifest is written last so readers never mistake a partial copy for a verdict.
 * @param {{ evidenceRoot: string, taskId: string, sourceCommit: string, receiptPath: string,
 *   taskReceiptPath: string, phaseArchivePath: string, cleanup: string,
 *   childExitCode: number|null, error?: unknown }} args
 * @returns {string}
 */
export function archiveVerifierTaskEvidence({ evidenceRoot, taskId, sourceCommit, receiptPath, taskReceiptPath,
  phaseArchivePath, cleanup, childExitCode, error }) {
  const candidates = [
    // Retain the small custody records before a potentially large source or
    // dependency census. A bulk-copy failure must still leave its task and
    // terminal phases available without publishing a complete manifest.
    ['task.json', taskReceiptPath],
    ['phases.jsonl', phaseArchivePath],
    ['resources.jsonl', `${receiptPath}.resources.jsonl`],
    ['source.json', receiptPath],
    ['snapshot.txt', `${receiptPath}.snapshot.txt`],
    ['dependencies.json', `${receiptPath}.dependencies.json`],
    ['dependencies-after.json', `${receiptPath}.dependencies.after.json`],
    ['child.json', `${receiptPath}.child.json`],
    ['stdout.log', `${receiptPath}.stdout.log`],
    ['stderr.log', `${receiptPath}.stderr.log`],
  ];
  const artifacts = {};
  /** @param {string} name @param {string} sourcePath @param {Buffer} bytes */
  const retain = (name, sourcePath, bytes) => {
    const retainedPath = join(evidenceRoot, name);
    const pendingPath = join(evidenceRoot, `.${name}.${process.pid}.tmp`);
    let created = false;
    try {
      const descriptor = openSync(pendingPath, 'wx', 0o600);
      created = true;
      try { writeFileSync(descriptor, bytes); }
      finally { closeSync(descriptor); }
      // link is exclusive: an existing evidence artifact is never replaced.
      // Readers see the final name only after the entire write has completed.
      linkSync(pendingPath, retainedPath);
    } catch (copyError) {
      throw new Error(`Verifier task evidence copy failed: code=${copyError.code ?? 'unknown'} ` +
        `source=${sourcePath} destination=${retainedPath} expectedBytes=${bytes.byteLength}; ` +
        `original receipts remain at their source paths; ${copyError.message}`, { cause: copyError });
    } finally {
      if (created) unlinkSync(pendingPath);
    }
    return retainedPath;
  };
  for (const [name, sourcePath] of candidates) {
    let sourceStat;
    try { sourceStat = lstatSync(sourcePath); }
    catch (readError) {
      if (readError?.code === 'ENOENT') continue;
      throw readError;
    }
    assert.ok(sourceStat.isFile() && !sourceStat.isSymbolicLink(),
      `Verifier task evidence is not a regular file: ${sourcePath}`);
    const bytes = readFileSync(sourcePath);
    const afterStat = lstatSync(sourcePath);
    assert.deepEqual({ dev: afterStat.dev, ino: afterStat.ino, size: afterStat.size,
      mtimeMs: afterStat.mtimeMs, ctimeMs: afterStat.ctimeMs },
    { dev: sourceStat.dev, ino: sourceStat.ino, size: sourceStat.size,
      mtimeMs: sourceStat.mtimeMs, ctimeMs: sourceStat.ctimeMs },
    `Verifier task evidence changed while being retained: ${sourcePath}`);
    assert.equal(bytes.byteLength, sourceStat.size, `Verifier task evidence read was short: ${sourcePath}`);
    const retainedPath = retain(name, sourcePath, bytes);
    artifacts[name] = { path: retainedPath, sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  assert.ok(artifacts['task.json'] && artifacts['phases.jsonl'],
    'Managed verifier evidence requires its terminal task receipt and retained phase archive');
  const manifestPath = join(evidenceRoot, 'manifest.json');
  const manifest = {
    schemaVersion: 'verifier-task-evidence-v1',
    taskId,
    runId: basename(evidenceRoot),
    sourceCommit,
    wrapperStatus: error ? 'failed' : 'completed',
    cleanup,
    childExitCode,
    ...(error ? { error: String(error?.message ?? error).slice(0, 2000) } : {}),
    childLogs: { stdout: 'stdout.log', stderr: 'stderr.log' },
    artifacts,
  };
  retain('manifest.json', 'generated manifest', Buffer.from(`${JSON.stringify(manifest)}\n`));
  return manifestPath;
}

async function listFiles(dir) {
  const out = [];
  async function walk(d) {
    for (const ent of await fs.readdir(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) await walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  }
  await walk(dir);
  return out.sort();
}

export function noticeText(manifest) {
  if (manifest.target === 'public') {
    return [
      'Papercusp',
      '',
      `Copyright (c) ${manifest.year} Papercusp.`,
      '',
      'Licensed under the Sustainable Use License 1.0 (see LICENSE). Components with their own',
      'license file or SPDX header (for example the permissively licensed libs/generic/*)',
      'are covered by that license instead.',
      '',
      'Third-party components keep their own licenses.',
      '',
      `Exported from ${manifest.source.repo} @ ${manifest.source.commit}`,
      '',
    ].join('\n');
  }
  return [
    'Papercusp — private source preview',
    '',
    `Copyright (c) ${manifest.year} Papercusp. All rights reserved.`,
    '',
    'This source is shared privately, by invitation, for EVALUATION ONLY.',
    '',
    'You may read it and run it on your own machines to evaluate Papercusp.',
    'You may not redistribute, publish, sublicense or sell it, in whole or in part,',
    'or use it to build or train a competing product or model.',
    '',
    'No license is granted beyond this evaluation permission. Access can be',
    'revoked at any time, and this notice applies to every copy you keep.',
    '',
    `Snapshot: ${manifest.source.repo} @ ${manifest.source.commit}`,
    '',
  ].join('\n');
}

async function describeWorkspaces(dir) {
  const rows = [];
  for (const top of ['apps', 'libs', 'packages']) {
    const base = join(dir, top);
    if (!existsSync(base)) continue;
    const walk = async (rel, depth) => {
      const abs = join(dir, rel);
      const pkg = join(abs, 'package.json');
      if (existsSync(pkg)) {
        let name = rel;
        let description = '';
        try {
          const j = JSON.parse(await fs.readFile(pkg, 'utf8'));
          name = j.name || rel;
          description = typeof j.description === 'string' ? j.description : '';
        } catch { /* unparsable package.json: list the path only */ }
        rows.push({ rel, name, description });
        return;
      }
      if (depth === 0) return;
      for (const ent of await fs.readdir(abs, { withFileTypes: true })) {
        if (ent.isDirectory()) await walk(`${rel}/${ent.name}`, depth - 1);
      }
    };
    for (const ent of (await fs.readdir(base, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.isDirectory()) await walk(`${top}/${ent.name}`, 1);
    }
  }
  return rows;
}

/**
 * The releases page README.md links to: `${PAPERCUSP_UPDATE_BASE_URL}/index.html`.
 * Reads `env` only — never a file — so a test's verdict cannot depend on the home
 * directory it runs in; the CLI fills `env` first (loadReleaseHost).
 * @param {NodeJS.ProcessEnv} env
 */
export function releasesPageUrl(env) {
  const base = (env[RELEASE_BASE_ENV] ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/\S+$/.test(base)) {
    throw new PreviewError(`${RELEASE_BASE_ENV} is ${base ? `not an https URL (${base})` : 'unset'} — README.md must link the releases page; export it or provide ${RELEASE_HOST_ENV_PATH}`, 2);
  }
  return `${base}/index.html`;
}

/**
 * Fill PAPERCUSP_UPDATE_BASE_URL from the release scripts' own config file when the
 * environment is silent. An exported value always wins, as in release-host.sh.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [path]
 */
export function loadReleaseHost(env = process.env, path = RELEASE_HOST_ENV_PATH) {
  if (env[RELEASE_BASE_ENV] || !existsSync(path)) return;
  const value = parseEnv(readFileSync(path, 'utf8'))[RELEASE_BASE_ENV];
  if (value) env[RELEASE_BASE_ENV] = value;
}

export async function readmeText(dir, manifest, releasesUrl) {
  const tops = (await fs.readdir(dir, { withFileTypes: true }))
    .filter((e) => !PUBLIC_ADDED_TOPS.has(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  const ws = await describeWorkspaces(dir);
  const isPublic = manifest.target === 'public';
  const intro = isPublic
    ? [
      '# Papercusp',
      '',
      'Papercusp is a desktop workspace where coding agents work alongside you, coordinated',
      'through shared plans, work items, locks and memory. Papercusp is source-available',
      'under the Sustainable Use License 1.0 (see LICENSE and NOTICE). You may use and modify',
      'it for your own internal business purposes, non-commercial purposes or personal use.',
      'You may distribute it or provide it to others only free of charge for non-commercial',
      'purposes. Commercial embedding, redistribution or provision requires a separate license.',
      '',
      `- Exported from \`${manifest.source.repo}\` at \`${manifest.source.commit}\`, with`,
      `  ${manifest.submodules.length} submodule(s) flattened in at their pinned commits (MANIFEST.json).`,
      '- It is the same public-safe source cut the Papercusp Server installer carries, without',
      '  `node_modules` (run `npm ci` to install dependencies from `package-lock.json`), plus the',
      '  Tauri desktop shell in `papercusp-desktop/`.',
      '- Each update is a new commit on top of the previous one, so `git pull` works and forks',
      '  and pull requests keep a shared history.',
      '',
    ]
    : [
      '# Papercusp — source preview',
      '',
      'Papercusp is a desktop workspace where coding agents work alongside you, coordinated',
      'through shared plans, work items, locks and memory. This repository is a private,',
      'read-only snapshot of its source, shared for evaluation (see NOTICE).',
      '',
      `- Snapshot of \`${manifest.source.repo}\` at \`${manifest.source.commit}\`, with`,
      `  ${manifest.submodules.length} submodule(s) flattened in at their pinned commits (MANIFEST.json).`,
      '- It is the same public-safe source cut the Papercusp Server installer carries, without',
      '  `node_modules` (run `npm ci` to install dependencies from `package-lock.json`)',
      '  and without the Tauri desktop shell or git history.',
      '- It is replaced wholesale on each update: re-clone or `git fetch && git reset --hard origin/main`.',
      '',
    ];
  const lines = [
    ...intro,
    '## Download Papercusp',
    '',
    `Installers for every published version, with release notes and install instructions, are on`,
    `the **[Papercusp releases page](${releasesUrl})**. Install both apps: **Papercusp Server**`,
    'runs the operator, its embedded database and your agents on your machine, and **Papercusp GUI**',
    'is the desktop window onto it.',
    '',
    ...(isPublic
      ? [
        '## Build and run from source',
        '',
        'You need **Node.js 25** (see `.nvmrc`), **Rust stable** (1.77 or newer) and your platform\'s',
        'webview build libraries (the table under "Prerequisites" 
