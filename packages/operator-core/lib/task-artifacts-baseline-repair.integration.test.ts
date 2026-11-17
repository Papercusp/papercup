/** Planning-only regeneration proof; never a qualifying installed/native baseline. */
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createScratchClone } from './scratch-git-clone';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof } from '../test/isolated-integration-proof';
import { repairedBaselineEdition } from '../test/task-artifacts-baseline-repair';

const root = resolve(import.meta.dirname, '../../..');
const sourceSha = '729986dd35171f1e0cb11bd1505295917f2d946f';
const fixturePath = 'packages/operator-core/test/fixtures/task-artifacts/baseline-729986dd35.json';
const fixtureSha = '9c7e72bff652470ac294d0aa927e859989c0a3dfc47e56b1143acde4b8e1a7ea';
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

it('regenerates the actual frozen baseline lock with the maintained local-target producer', async context => {
  let scratch: string | undefined;
  const producerOptions = isolatedWorkerOptions(180_000, process.env, 180_000, {}, 180_000);
  try {
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/task-artifacts-baseline-repair.integration.test.ts',
      sourcePaths: [fixturePath, 'packages/operator-core/test/task-artifacts-baseline-repair.ts',
        'packages/operator-core/lib/scratch-git-clone.ts', 'scripts/npm-install-safe.mjs',
        'scripts/with-test-pg.mjs'],
      retainedArtifacts: ['phases/execute/dependency-repair-inputs.json',
        'phases/execute/dependency-repair-receipt.json', 'phases/execute/dependency-lock-original.json',
        'phases/execute/dependency-lock-repaired.json', 'phases/execute/dependency-repair-delta.json',
        'phases/execute/dependency-edition.json', 'phases/execute/producer-cleanup.json'],
      prepare: async () => {
        expect(digest(readFileSync(join(root, fixturePath)))).toBe(fixtureSha);
        const clone = await createScratchClone({ source: root, ref: sourceSha,
          includeSubmodules: true, signal: AbortSignal.timeout(180_000) });
        scratch = clone.path;
        expect(clone.sha).toBe(sourceSha);
      },
      execute: async (observe, evidenceDir) => {
        const sourceRoot = scratch!;
        try {
          const env = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
            NODE_OPTIONS: '', NODE_PATH: '' };
          const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime', '--',
            process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/task-artifacts-baseline-repair.ts'),
            '--source-root=' + sourceRoot, '--evidence-dir=' + evidenceDir,
            '--fixture-path=' + join(root, fixturePath), '--fixture-sha=' + fixtureSha],
          { cwd: root, detached: true, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
          observe(child);
          const result = await captureIsolatedWorker(child, evidenceDir, producerOptions);
          expect(result, isolatedWorkerFailureDetail(result.output, result)).toMatchObject({ code: 0, signal: null,
            timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
          const edition = JSON.parse(readFileSync(join(evidenceDir, 'dependency-edition.json'), 'utf8'));
          expect(edition).toMatchObject({ edition: repairedBaselineEdition, originalSourceSha: sourceSha,
            originalDependenciesReconstructed: false, changedInputs: ['package-lock.json'] });
          expect(edition.beforeSources).toHaveLength(14);
          expect(edition.afterSources).toEqual(edition.beforeSources);
          expect(edition.beforeProductBoundary.changedPaths).toEqual([]);
          expect(edition.afterProductBoundary.changedPaths).toEqual(['package-lock.json']);
          const receipt = JSON.parse(readFileSync(join(evidenceDir, 'dependency-repair-receipt.json'), 'utf8'));
          expect(receipt.cleanup.removed).toBe(true);
          const repaired = readFileSync(join(evidenceDir, 'dependency-lock-repaired.json'));
          expect(digest(repaired)).toBe(edition.repairedLockSha256);
          const packages = JSON.parse(repaired.toString()).packages;
          const app = 'apps/slack-asana-bug-drill';
          expect(packages[app + '/node_modules/@papercusp/template-kit']).toMatchObject({
            link: true, resolved: app + '/template-kit' });
          expect(packages['node_modules/@papercusp/template-kit']).toMatchObject({
            link: true, resolved: 'libs/generic/template-kit' });
          expect(packages['node_modules/next'].version).toBe('16.4.1');
          expect(packages[app + '/node_modules/next'].version).toBe('16.4.0');
          expect(packages[app + '/template-kit/node_modules/@types/node']).toMatchObject({
            dev: true, version: expect.stringMatching(/^22\./),
            resolved: expect.stringMatching(/^https:\/\/registry\.npmjs\.org\//),
            integrity: expect.stringMatching(/^sha512-/) });
        } finally {
          await rm(sourceRoot, { recursive: true, force: true });
          const removed = !statSync(sourceRoot, { throwIfNoEntry: false });
          await writeFile(join(evidenceDir, 'producer-cleanup.json'), JSON.stringify({ sourceRoot, removed }), { flag: 'wx' });
          expect(removed).toBe(true);
          scratch = undefined;
        }
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('TASK_ARTIFACT_PRODUCER_REGENERATION_RUN ' + runId);
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}, isolatedWorkerOptions(180_000, process.env, 180_000, {}, 180_000).testTimeoutMs);
