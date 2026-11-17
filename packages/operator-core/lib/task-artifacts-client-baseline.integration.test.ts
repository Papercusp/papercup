/** Pre-edit client evidence from the pinned original source, never candidate handlers. */
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createScratchClone } from './scratch-git-clone';
import { preparePrivateOperatorApiBundle, privateGitCloneBundleEnv,
  privateOperatorApiBuildBudget } from '../test/private-http-workspace-preflight';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  isolatedWorkerReceipt, recordIsolatedIntegrationProof } from '../test/isolated-integration-proof';
// @ts-ignore -- maintained process-group/dependency preparation, shared with grading runtime proof.
import { runVerifierDependencyCommand } from '../../../scripts/source-preview.mjs';
// @ts-ignore -- same immutable dependency preflight used by committed verifiers.
import { assertCommittedWorkspaceLockMatches } from '../../../scripts/lint-as-committed.mjs';
import { assertBaselineInstalledTree, assertBaselineToolchain, captureBaselineInstalledTree,
  assertBaselinePlannedRepair, assertBaselineRepairInputs, assertFrozenBaselineSources, baselineProductBoundary,
  repairedBaselineEdition } from '../test/task-artifacts-baseline-repair';
import { readBaselinePacket, readBaselineQualification, retainBaselineProducerPacket,
  sealBaselineQualification } from '../test/task-artifacts-baseline-repair';
import { withNativeProofLedger } from '../test/isolated-integration-proof';
import { appendNativeProofEvent, readNativeProofRun } from './testing-run-store';

const root = resolve(import.meta.dirname, '../../..');
const sourceSha = '729986dd35171f1e0cb11bd1505295917f2d946f';
const fixturePath = 'packages/operator-core/test/fixtures/task-artifacts/baseline-729986dd35.json';
const fixtureSha = '9c7e72bff652470ac294d0aa927e859989c0a3dfc47e56b1143acde4b8e1a7ea';
const nativeEntryPoint = 'packages/operator-core/test/task-artifacts-baseline-http-fixture.ts';
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const buildBudget = privateOperatorApiBuildBudget();
const generationBudgetMs = 1_800_000;
const options = isolatedWorkerOptions(180_000, process.env, 180_000, {}, generationBudgetMs + 360_000 + buildBudget.maxMs);


it('retains real MCP and ptool text requests for the source-frozen dependency-repaired pre-feature edition', async context => {
  let sourceRoot: string | undefined;
  let scratch: string | undefined;
  let prepared: Awaited<ReturnType<typeof preparePrivateOperatorApiBundle>> | undefined;
  let baselineSucceeded = false;
  try {
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/task-artifacts-client-baseline.integration.test.ts',
      nativeChildEntryPoint: nativeEntryPoint,
      sourcePaths: [fixturePath, 'packages/operator-core/test/task-artifacts-baseline-http-fixture.ts',
        'packages/operator-core/lib/testing-run-store.ts',
        'packages/operator-core/lib/scratch-git-clone.ts', 'scripts/source-preview.mjs',
        'scripts/npm-install-safe.mjs', 'scripts/lint-as-committed.mjs',
        'packages/operator-core/test/task-artifacts-baseline-repair.ts',
        'packages/operator-core/lib/task-artifacts-baseline-custody.ts',
        'apps/operator/bin/release/dependency-lock-tree-audit.mjs',
        'apps/operator/bin/release/dependency-generation.sh',
        'papercusp-desktop/bin/lib/pinned-deps.sh', 'apps/operator/bin/bundle-host.sh',
        'apps/operator/bin/hono-host.ts', 'apps/operator/scripts/ptool.mjs',
        'packages/operator-core/lib/agent-mcp-client.ts'],
      retainProducedArtifacts: async runDir => {
        // The durable intent is written before preparation (even its failures).
        const intentPath = join(runDir, 'phases/prepare/native-proof-intent.json');
        if (!existsSync(intentPath)) return [];
        const fingerprint: string = JSON.parse(readFileSync(intentPath, 'utf8')).fingerprint;
        expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
        // Recursively retain every producer original and a stable census. The
        // builder's one verified installed-tree binding is recorded explicitly;
        // no other symlink, special file or changed population can be omitted.
        const seal = retainBaselineProducerPacket(runDir,
          join(runDir, '../retained', basename(runDir), 'native-objects'), fingerprint,
          sourceRoot ? { 'phases/prepare/node_modules': join(sourceRoot, 'node_modules') } : {});
        const path = join(runDir, 'phases/teardown/baseline-packet-seal.json');
        readBaselinePacket(seal, digest(seal), fingerprint);
        // Immutable locator is itself retained by the existing harness, beside
        // its objects; failed runs preserve bytes but never become qualified.
        await writeFile(path, seal, { flag: 'wx' });
        if (baselineSucceeded) await withNativeProofLedger(process.env, async sql => {
          const run = await readNativeProofRun(sql, basename(runDir));
          expect(run?.events).toHaveLength(6);
          const qualified = sealBaselineQualification(seal, run!, runDir);
          const sealed = await appendNativeProofEvent(sql, run!.runId, fingerprint, 6,
            { kind: 'sealed', receiptRef: qualified.path, receiptSha256: qualified.sha256 });
          expect(readFileSync(qualified.path).equals(qualified.bytes)).toBe(true);
          const readback = await appendNativeProofEvent(sql, run!.runId, fingerprint, sealed.events.length,
            { kind: 'readback', receiptRef: qualified.path, receiptSha256: digest(readFileSync(qualified.path)) });
          readBaselineQualification(readback);
          await writeFile(join(runDir, 'phases/teardown/baseline-qualification.json'),
            JSON.stringify({ runId: run!.runId, fingerprint, path: qualified.path, sha256: qualified.sha256 }), { flag: 'wx' });
        });
        return ['phases/teardown/baseline-packet-seal.json',
          ...(baselineSucceeded ? ['phases/teardown/baseline-qualification.json'] : [])];
      },
      prepare: async (evidenceDir, native) => {
        expect(native, 'Qualifying baseline requires its original durable intent').toBeDefined();
        assertBaselineToolchain(native!.input.toolchain);
        const raw = readFileSync(join(root, fixturePath));
        expect(digest(raw)).toBe(fixtureSha);
        const fixture = JSON.parse(raw.toString());
        await writeFile(join(evidenceDir, 'baseline-fixture.json'), raw, { flag: 'wx' });
        expect(fixture.sourceSha).toBe(sourceSha);
        // Preserve the measured refusal of the original edition before any
        // allocation. This new edition explicitly repairs its dependency lock;
        // it must never be reported as original-dependency reconstruction.
        let refusal: string | undefined;
        try { assertCommittedWorkspaceLockMatches(root, sourceSha); }
        catch (error) { refusal = String(error); }
        expect(refusal).toContain('NPM_INSTALL_SAFE_WORKSPACE_LOCK_DRIFT');
        await writeFile(join(evidenceDir, 'original-coherence-refusal.json'), JSON.stringify({
          originalSourceSha: sourceSha, originalDependenciesReconstructed: false, refusal,
          selectedEdition: repairedBaselineEdition,
        }), { flag: 'wx' });
        console.info('TASK_ARTIFACT_CLIENT_BASELINE_STAGE=source-frozen-copy');
        // Let the maintained helper select its data-volume fixture root. The
        // repository's ignored scratch can be a different mounted filesystem.
        const cloned = await createScratchClone({ source: root, ref: sourceSha,
          includeSubmodules: true, signal: AbortSignal.timeout(180_000) });
        sourceRoot = cloned.path;
        scratch = cloned.path;
        expect(cloned.sha).toBe(sourceSha);
        for (const file of fixture.files) {
          expect(digest(file.content), file.path).toBe(file.sha256);
          expect(digest(readFileSync(join(sourceRoot, file.path))), file.path).toBe(file.sha256);
        }
        await writeFile(join(evidenceDir, 'baseline-source.json'), JSON.stringify({
          sourceSha, fixtureSha256: fixtureSha, originalCapture: fixture.originalCapture,
          files: fixture.files.map((file: { path: string; sha256: string }) => ({ path: file.path, sha256: file.sha256 })),
          originalLoadedRuntime: fixture.loadedRuntime,
          edition: repairedBaselineEdition, originalDependenciesReconstructed: false,
          qualification: 'Source-frozen, dependency-repaired compatibility edition; not original-dependency or removed original-bundle execution',
        }), { flag: 'wx' });
        console.info('TASK_ARTIFACT_CLIENT_BASELINE_STAGE=dependencies');
        for (const name of ['dependency-preflight.log', 'dependency-generation.log',
          'dependency-snapshot.log', 'dependency-prediction.log', 'dependency-install.log', 'dependency-repair.log'])
          await writeFile(join(evidenceDir, name), '', { flag: 'wx' });
        const helper = join(root, 'papercusp-desktop/bin/lib/pinned-deps.sh');
        const helperBytes = readFileSync(helper);
        expect(helperBytes.toString()).toMatch(/^\s*preflight-generation\)/m);
        expect(helperBytes.toString()).toMatch(/^\s*snapshot-generation-locked\)/m);
        await writeFile(join(evidenceDir, 'baseline-preconditions.json'), JSON.stringify({
          sourceSha, helperSha256: digest(helperBytes),
          donorDevice: statSync(root).dev, destinationDevice: statSync(sourceRoot).dev,
          edition: repairedBaselineEdition,
          dependencyRoute: 'strict selected-copy metadata resolver -> retained lock delta -> guarded ci -> source-frozen build',
          liveDonorCopyAllowed: false, generationBudgetMs, buildBudget,
        }), { flag: 'wx' });
        const dependencyCommand = async (args: string[], logName: string, maxMs = 180_000) => {
          // Positional arguments preserve paths; pipefail retains the helper's
          // refusal and tee keeps diagnostics after disposable clone cleanup.
          return await runVerifierDependencyCommand('bash', ['-c',
            'set -o pipefail; log="$1"; shift; "$@" 2>&1 | tee "$log"',
            'baseline-dependencies', join(evidenceDir, logName), ...args],
          { cwd: root, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '',
            DEPENDENCY_GENERATION_NODE: process.execPath }, timeoutMs: Math.min(600_000, maxMs), maxMs });
        };
        await dependencyCommand([process.execPath, '--import', 'tsx',
          join(root, 'packages/operator-core/test/task-artifacts-baseline-repair.ts'),
          '--source-root=' + sourceRoot, '--evidence-dir=' + evidenceDir,
          '--fixture-path=' + join(root, fixturePath), '--fixture-sha=' + fixtureSha],
        'dependency-repair.log', generationBudgetMs);
        const edition = JSON.parse(readFileSync(join(evidenceDir, 'dependency-edition.json'), 'utf8'));
        expect(edition).toMatchObject({ edition: repairedBaselineEdition,
          originalSourceSha: sourceSha, originalDependenciesReconstructed: false });
        const inputs = JSON.parse(readFileSync(join(evidenceDir, 'dependency-repair-inputs.json'), 'utf8'));
        const snapshot = new Map<string, Buffer | null>(inputs.inputs.map((input: { path: string; base64: string | null }) =>
          [input.path, input.base64 === null ? null : Buffer.from(input.base64, 'base64')]));
        const repairedOutput = { path: 'package-lock.json',
          bytes: readFileSync(join(evidenceDir, 'dependency-lock-repaired.json')) };
        const graph = assertBaselinePlannedRepair(native!.input, snapshot, repairedOutput.bytes,
          readFileSync(join(evidenceDir, 'dependency-repair-delta.json')));
        await writeFile(join(evidenceDir, 'dependency-candidate-graph.json'), graph, { flag: 'wx' });
        await dependencyCommand([process.execPath, join(root, 'scripts/npm-install-safe.mjs'),
          '--repo-root', sourceRoot, '--offline-safe', 'ci'], 'dependency-install.log', generationBudgetMs);
        assertBaselineRepairInputs(sourceRoot, snapshot, repairedOutput);
        const afterInstallSources = assertFrozenBaselineSources(sourceRoot, fixture.files);
        const afterInstallProductBoundary = baselineProductBoundary(sourceRoot, ['package-lock.json']);
        expect(digest(readFileSync(join(sourceRoot, 'package-lock.json')))).toBe(edition.repairedLockSha256);
        const installedTree = await captureBaselineInstalledTree(sourceRoot, root);
        assertBaselineToolchain(native!.input.toolchain);
        await writeFile(join(evidenceDir, 'dependency-installed-tree.json'), JSON.stringify(installedTree), { flag: 'wx' });
        const installedReceipt = join(evidenceDir, 'dependency-installed.json');
        await writeFile(installedReceipt, JSON.stringify({ sourceSha, repairedLockSha256: edition.repairedLockSha256,
          installLogSha256: digest(readFileSync(join(evidenceDir, 'dependency-install.log'))),
          afterInstallSources, afterInstallProductBoundary, installedTreeSha256: installedTree.sha256,
          installedTreeManifestSha256: digest(readFileSync(join(evidenceDir, 'dependency-installed-tree.json'))),
          qualification: 'Guarded ci and complete content/lock/runtime tree census completed; full native qualification remains required' }), { flag: 'wx' });
        await native!.observe('installed', installedReceipt);
        console.info('TASK_ARTIFACT_CLIENT_BASELINE_STAGE=dependency-repaired-build');
        prepared = await preparePrivateOperatorApiBundle(sourceRoot, evidenceDir, { builder: {
          ...buildBudget, env: privateGitCloneBundleEnv(sourceRoot, sourceSha),
        } });
        assertBaselineRepairInputs(sourceRoot, snapshot, repairedOutput);
        const afterBuildSources = assertFrozenBaselineSources(sourceRoot, fixture.files);
        const afterBuildProductBoundary = baselineProductBoundary(sourceRoot, ['package-lock.json']);
        await assertBaselineInstalledTree(sourceRoot, installedTree, root);
        assertBaselineToolchain(native!.input.toolchain);
        expect(digest(readFileSync(join(sourceRoot, 'package-lock.json')))).toBe(edition.repairedLockSha256);
        await writeFile(join(evidenceDir, 'dependency-edition-after-build.json'), JSON.stringify({
          ...edition, afterInstallSources, afterBuildSources, afterInstallProductBoundary,
          afterBuildProductBoundary, rebuiltBundleSha256: prepared.sha256,
          receiptSha256: prepared.receiptSha256, installedTreeSha256: installedTree.sha256,
        }), { flag: 'wx' });
        await native!.observe('built', join(evidenceDir, 'dependency-edition-after-build.json'));
      },
      execute: async (observe, evidenceDir, nativeChild) => {
        expect(nativeChild, 'Qualifying baseline requires its original single-fork handoff').toBeDefined();
        expect(prepared).toBeDefined();
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        await mkdir(join(evidenceDir, 'tmp'));
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          TASK_ARTIFACT_BASELINE_EVIDENCE_DIR: evidenceDir, TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
        for (const key of ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE']) delete env[key];
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
          process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/task-artifacts-baseline-http-fixture.ts'),
          '--baseline-root=' + sourceRoot, '--prepared-api-sha=' + prepared!.sha256,
          '--native-proof-child=' + join(evidenceDir, 'native-proof-child.json'),
          '--prepared-receipt-sha=' + prepared!.receiptSha256],
        { cwd: root, detached: true, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
        try { result = await captureIsolatedWorker(child, evidenceDir, options); }
        finally { await rm(join(evidenceDir, 'node_modules')); }
        expect(result, isolatedWorkerFailureDetail(result.output, result)).toMatchObject({ code: 0, signal: null,
          timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
        const line = isolatedWorkerReceipt(result.output, 'TASK_ARTIFACT_CLIENT_BASELINE_RECEIPT');
        expect(line, isolatedWorkerFailureDetail(result.output, result)).toBeDefined();
        const receipt = JSON.parse(line!);
        expect(receipt).toMatchObject({ sourceSha, bundleSha256: prepared!.sha256, hostStopped: true,
          completedMatrix: false, adapters: ['mcp-http', 'ptool-http'] });
        const beforeCustody = readFileSync(join(evidenceDir, 'baseline-runtime-custody-before.json'));
        const afterCustody = readFileSync(join(evidenceDir, 'baseline-runtime-custody-after.json'));
        expect(afterCustody).toEqual(beforeCustody);
        expect(receipt).toMatchObject(JSON.parse(afterCustody.toString()));
        expect(receipt.traces).toHaveLength(6);
        baselineSucceeded = true;
        console.info('TASK_ARTIFACT_CLIENT_BASELINE_VERIFIED ' + JSON.stringify(receipt));
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('TASK_ARTIFACT_CLIENT_BASELINE_RUN ' + runId);
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}, options.testTimeoutMs);
