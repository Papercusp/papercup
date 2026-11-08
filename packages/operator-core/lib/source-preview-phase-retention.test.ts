import { createHash } from 'node:crypto';
import nativeFs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveVerifierTaskEvidence, captureVerifierDependencies, readVerifierPhaseMeasurements, selectVerifierDependencySnapshot,
  runCli, verifierPhaseRunner } from '../../../scripts/source-preview.mjs';

const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('verifier phase evidence retention', () => {
  it.each(['source', 'receipt'])('retains successful and failed strict CLI postchecks after %s tampering', async tampered => {
    const root = mkdtempSync(join(tmpdir(), 'verifier-cli-phase-retention-'));
    fixtures.push(root);
    const sourceRoot = join(root, 'source');
    mkdirSync(sourceRoot);
    const text = 'export {};';
    writeFileSync(join(sourceRoot, 'input.ts'), text);
    const file = { path: 'input.ts', kind: 'file', executable: false,
      sha256: createHash('sha256').update(text).digest('hex') };
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'f'.repeat(40),
      files: [file], testedInputs: [{ path: file.path, sha256: file.sha256 }] };
    const receiptPath = join(root, 'receipt.json');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    writeFileSync(join(sourceRoot, '.verifier-source.json'), JSON.stringify(receipt));
    const logs = join(root, 'persistent');
    vi.stubEnv('PAPERCUSP_CHECKPOINT_LOG_DIR', logs);
    try {
      const command = ['verifier-verify', '--out', sourceRoot, '--receipt', receiptPath];
      expect(await runCli(command)).toBe(0);
      writeFileSync(tampered === 'source' ? join(sourceRoot, 'input.ts') : receiptPath, 'changed');
      await expect(runCli(command)).rejects.toThrow();
      const local = readdirSync(root).filter(name => name.startsWith('receipt.json.verify.'));
      expect(local).toHaveLength(2);
      const retained = readdirSync(logs).map(name => readFileSync(join(logs, name), 'utf8'));
      expect(retained).toHaveLength(2);
      expect(retained.sort()).toEqual(local.map(name => readFileSync(join(root, name), 'utf8')).sort());
      const rows = retained.flatMap(bytes => bytes.trim().split('\n').map(line => JSON.parse(line)));
      expect(rows.filter(row => row.phase === 'source.verify' && row.event === 'started')).toHaveLength(2);
      expect(rows.filter(row => row.event === 'completed')).toHaveLength(1);
      expect(rows.filter(row => row.event === 'failed')).toHaveLength(1);
      for (const name of local) rmSync(join(root, name));
      expect(readdirSync(logs)).toHaveLength(2);
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(['source', 'manifest'])('keeps custody receipts and original bytes when the %s write runs out of space', failureStage => {
    const root = mkdtempSync(join(tmpdir(), 'verifier-task-retention-'));
    fixtures.push(root);
    const evidenceRoot = join(root, 'retained');
    mkdirSync(evidenceRoot);
    const receiptPath = join(root, 'source.json');
    const taskReceiptPath = join(root, 'task.json');
    const phaseArchivePath = join(root, 'phases.jsonl');
    const original = Buffer.from('original source receipt with a partial write');
    writeFileSync(receiptPath, original);
    writeFileSync(taskReceiptPath, '{"taskId":"retention-fixture","cleanup":"completed"}\n');
    writeFileSync(phaseArchivePath, '{"phase":"deps.preflight","event":"failed"}\n');
    const write = nativeFs.writeFileSync;
    const spy = vi.spyOn(nativeFs, 'writeFileSync').mockImplementation((path, bytes, options) => {
      const fail = Buffer.isBuffer(bytes) && (failureStage === 'source' ? bytes.equals(original)
        : bytes.toString().includes('verifier-task-evidence-v1'));
      if (typeof path === 'number' && fail) {
        write(path, bytes.subarray(0, 5));
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      }
      return write(path, bytes, options);
    });
    syncBuiltinESMExports();
    try {
      const archive = () => archiveVerifierTaskEvidence({ evidenceRoot, taskId: 'retention-fixture',
        sourceCommit: 'fixture', receiptPath, taskReceiptPath, phaseArchivePath,
        cleanup: 'completed', childExitCode: null, error: new Error('preflight refused') });
      if (failureStage === 'source') expect(archive)
        .toThrow(`code=ENOSPC source=${receiptPath} destination=${join(evidenceRoot, 'source.json')} expectedBytes=${original.length}`);
      else expect(archive)
        .toThrow(`code=ENOSPC source=generated manifest destination=${join(evidenceRoot, 'manifest.json')}`);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(readFileSync(receiptPath)).toEqual(original);
    for (const [name, source] of [['task.json', taskReceiptPath], ['phases.jsonl', phaseArchivePath]]) {
      expect(readFileSync(join(evidenceRoot, name))).toEqual(readFileSync(source));
      expect(statSync(join(evidenceRoot, name)).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(evidenceRoot).sort()).toEqual(failureStage === 'source'
      ? ['phases.jsonl', 'task.json'] : ['phases.jsonl', 'source.json', 'task.json']);
    if (failureStage === 'manifest') expect(readFileSync(join(evidenceRoot, 'source.json'))).toEqual(original);
    expect(existsSync(join(evidenceRoot, 'manifest.json'))).toBe(false);
  });

  it('publishes a complete manifest with exact digests and never overwrites retained evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'verifier-task-retention-'));
    fixtures.push(root);
    const evidenceRoot = join(root, 'retained');
    mkdirSync(evidenceRoot);
    const receiptPath = join(root, 'source.json');
    const taskReceiptPath = join(root, 'task.json');
    const phaseArchivePath = join(root, 'phases.jsonl');
    writeFileSync(receiptPath, '{"source":"original"}\n');
    writeFileSync(taskReceiptPath, '{"taskId":"retention-fixture"}\n');
    writeFileSync(phaseArchivePath, '{"phase":"cleanup","event":"completed"}\n');
    const args = { evidenceRoot, taskId: 'retention-fixture', sourceCommit: 'fixture',
      receiptPath, taskReceiptPath, phaseArchivePath, cleanup: 'completed', childExitCode: 0 };
    const path = archiveVerifierTaskEvidence(args);
    const manifestBytes = readFileSync(path);
    const manifest = JSON.parse(manifestBytes.toString());
    expect(manifest).toMatchObject({ wrapperStatus: 'completed', cleanup: 'completed', childExitCode: 0 });
    for (const artifact of Object.values(manifest.artifacts) as { path: string; sizeBytes: number; sha256: string }[]) {
      const bytes = readFileSync(artifact.path);
      expect(artifact.sizeBytes).toBe(bytes.length);
      expect(artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(statSync(artifact.path).mode & 0o777).toBe(0o600);
    }
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const retainedTask = readFileSync(join(evidenceRoot, 'task.json'));
    writeFileSync(taskReceiptPath, 'changed original');
    expect(() => archiveVerifierTaskEvidence(args)).toThrow('code=EEXIST');
    expect(readFileSync(join(evidenceRoot, 'task.json'))).toEqual(retainedTask);
    expect(readFileSync(path)).toEqual(manifestBytes);
    expect(readdirSync(evidenceRoot).sort()).toEqual(['manifest.json', 'phases.jsonl', 'source.json', 'task.json']);
  });

  it('keeps an unknown historical crash cause unknown after a successful replacement', () => {
    const root = mkdtempSync(join(tmpdir(), 'verifier-historical-cause-'));
    fixtures.push(root);
    const inputs = join(root, 'temporary');
    const originalRoot = join(root, 'original');
    const replacementRoot = join(root, 'replacement');
    for (const path of [inputs, originalRoot, replacementRoot]) mkdirSync(path);
    const receiptPath = join(inputs, 'source.json');
    const taskReceiptPath = join(inputs, 'task.json');
    const phaseArchivePath = join(inputs, 'phases.jsonl');
    // These are literal original observations. A lost child has no measured exit,
    // signal, stderr or fault cause; a later success cannot supply any of them.
    const original = {
      'source.json': '{"sourceCommit":"original-source","runtime":"original-runtime","dependencies":"original-dependencies"}\n',
      'task.json': '{"taskId":"original-attempt","cleanup":"completed"}\n',
      'phases.jsonl': '{"phase":"source.freeze","event":"completed"}\n{"phase":"child.run","event":"started"}\n{"phase":"child.run","event":"failed","error":"child result unavailable"}\n',
      'child.json': '{"pid":1234,"exitCode":null,"signal":null,"error":null}\n',
    };
    const paths = {
      'source.json': receiptPath,
      'task.json': taskReceiptPath,
      'phases.jsonl': phaseArchivePath,
      'child.json': `${receiptPath}.child.json`,
    };
    for (const name of Object.keys(original) as (keyof typeof original)[]) writeFileSync(paths[name], original[name]);
    const args = { taskId: 'original-attempt', sourceCommit: 'original-source', receiptPath,
      taskReceiptPath, phaseArchivePath, cleanup: 'completed', childExitCode: null,
      error: new Error('child result unavailable') };
    const originalManifestPath = archiveVerifierTaskEvidence({ ...args, evidenceRoot: originalRoot });
    const originalManifestBytes = readFileSync(originalManifestPath);

    // Reuse the temporary paths, as a replacement does, while retaining each
    // attempt under its own existing immutable archive identity.
    writeFileSync(receiptPath, '{"sourceCommit":"replacement-source"}\n');
    writeFileSync(taskReceiptPath, '{"taskId":"replacement-attempt","cleanup":"completed"}\n');
    writeFileSync(phaseArchivePath, '{"phase":"child.run","event":"completed"}\n');
    writeFileSync(`${receiptPath}.child.json`, '{"pid":5678,"exitCode":0,"signal":null,"error":null}\n');
    const replacementArgs = { ...args, taskId: 'replacement-attempt', sourceCommit: 'replacement-source',
      childExitCode: 0, error: undefined };
    const replacementManifestPath = archiveVerifierTaskEvidence({ ...replacementArgs, evidenceRoot: replacementRoot });
    expect(JSON.parse(readFileSync(replacementManifestPath, 'utf8'))).toMatchObject({
      taskId: 'replacement-attempt', wrapperStatus: 'completed', childExitCode: 0,
    });
    expect(() => archiveVerifierTaskEvidence({ ...replacementArgs, evidenceRoot: originalRoot })).toThrow('code=EEXIST');
    rmSync(inputs, { recursive: true });

    expect(readFileSync(originalManifestPath)).toEqual(originalManifestBytes);
    const retained = JSON.parse(readFileSync(originalManifestPath, 'utf8'));
    expect(retained).toMatchObject({ taskId: 'original-attempt', sourceCommit: 'original-source',
      wrapperStatus: 'failed', childExitCode: null, error: 'child result unavailable' });
    expect(Object.keys(retained.artifacts).sort()).toEqual(['child.json', 'phases.jsonl', 'source.json', 'task.json']);
    for (const name of Object.keys(original) as (keyof typeof original)[]) {
      expect(readFileSync(retained.artifacts[name].path, 'utf8')).toBe(original[name]);
      expect(retained.artifacts[name].sha256).toBe(createHash('sha256').update(original[name]).digest('hex'));
    }
    expect(JSON.parse(readFileSync(retained.artifacts['child.json'].path, 'utf8'))).toEqual({
      pid: 1234, exitCode: null, signal: null, error: null,
    });
    expect(retained.artifacts['stderr.log']).toBeUndefined();
    expect(retained.artifacts['stdout.log']).toBeUndefined();
  });

  it('keeps exact completed and failed phase bytes after temporary receipt deletion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verifier-phase-retention-'));
    fixtures.push(root);
    const path = join(root, 'temporary.phases.jsonl');
    const run = verifierPhaseRunner(path, { PAPERCUSP_HOME: join(root, 'persistent'),
      PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: 'retention-fixture' }, join(root, 'child.json'));
    await run('source.freeze', () => 1);
    const selection = selectVerifierDependencySnapshot('copy', true);
    await run('deps.snapshot', () => 2, { snapshotSelection: selection });
    const failure = new Error('fixture failed');
    await expect(run('child.run', () => { throw failure; })).rejects.toBe(failure);
    const original = readFileSync(path);
    const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    expect(run.archivePath.startsWith(join(root, 'persistent', 'checkpoint-logs') + '/')).toBe(true);
    expect(readFileSync(run.archivePath)).toEqual(original);
    expect(statSync(run.archivePath).mode & 0o777).toBe(0o600);
    rmSync(path);
    expect(existsSync(path)).toBe(false);
    expect(hash(readFileSync(run.archivePath))).toBe(hash(original));
    const rows = original.toString().trim().split('\n').map(line => JSON.parse(line));
    expect(rows.map(row => row.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.every(row => row.taskId === 'retention-fixture')).toBe(true);
    expect(rows.find(row => row.phase === 'deps.snapshot' && row.event === 'started').snapshotSelection)
      .toEqual({ copyMode: 'copy', generationSnapshotSupported: true, command: 'snapshot-generation-locked' });
    expect(selectVerifierDependencySnapshot('hardlink', true)).toEqual({
      copyMode: 'hardlink', generationSnapshotSupported: true, command: 'snapshot-locked',
    });
    expect(selectVerifierDependencySnapshot('copy', false)).toEqual({
      copyMode: 'copy', generationSnapshotSupported: false, command: 'snapshot-locked',
    });
    expect(rows.at(-1)).toMatchObject({ phase: 'child.run', event: 'failed', error: 'fixture failed' });
    expect(readVerifierPhaseMeasurements(run.archivePath)).toEqual({
      'source.freeze': rows[1].durationMs,
      'deps.snapshot': rows[3].durationMs,
    });
    expect(() => readVerifierPhaseMeasurements(path)).toThrow('ENOENT');
  });

  it('honors the existing log directory override and refuses to overwrite a retained run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verifier-phase-retention-'));
    fixtures.push(root);
    const path = join(root, 'temporary.phases.jsonl');
    const env = { PAPERCUSP_CHECKPOINT_LOG_DIR: join(root, 'logs') };
    const run = verifierPhaseRunner(path, env, join(root, 'child.json'));
    await run('cleanup', () => undefined);
    const retained = readFileSync(run.archivePath);
    rmSync(path);
    expect(() => verifierPhaseRunner(path, env, join(root, 'child.json'))).toThrow('EEXIST');
    expect(readFileSync(run.archivePath)).toEqual(retained);
    expect(run.archivePath.startsWith(env.PAPERCUSP_CHECKPOINT_LOG_DIR + '/')).toBe(true);
  });

  it('retains bounded per-tree progress while preserving the complete dependency census', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verifier-phase-progress-'));
    fixtures.push(root);
    const trees = ['apps/operator/node_modules', 'node_modules'];
    for (const tree of trees) {
      const packageDir = join(root, tree, 'pkg');
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, 'index.js'), 'module.exports = true;\n');
    }
    const write = (path: string, content: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    };
    write(join(root, 'papercusp-desktop/bin/lib/pinned-deps.sh'), [
      '#!/usr/bin/env bash',
      'test "$1" = trees || exit 2',
      "printf '%s\\n' node_modules apps/operator/node_modules",
      '',
    ].join('\n'));
    write(join(root, 'apps/operator/bin/release/dependency-generation.sh'), [
      'dependency_generation_source_records() {',
      "  printf 'pkg\\td\\t0755\\t1\\t1\\t0\\t0\\t0\\t0\\t\\npkg/index.js\\tf\\t0644\\t1\\t1\\t0\\t0\\t0\\t0\\t\\n' > \"$2\"",
      '}',
      '',
    ].join('\n'));

    const path = join(root, 'temporary.phases.jsonl');
    const run = verifierPhaseRunner(path, { PAPERCUSP_HOME: join(root, 'persistent') }, join(root, 'child.json'));
    const dependencies = await run('deps.postverify', () => captureVerifierDependencies({
      dest: root,
      receipt: { schemaVersion: 'fixture', sourceCommit: 'fixture', testedInputs: [], files: [], submodules: [] },
      env: {},
      onProgress: progress => run.reportProgress?.('deps.postverify', progress),
    }));
    expect(dependencies.trees.map(tree => tree.path)).toEqual(trees);
    expect(dependencies.trees.map(tree => tree.files.map(file => file.path))).toEqual([
      ['pkg/index.js'], ['pkg/index.js'],
    ]);

    const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const progress = rows.filter(row => row.event === 'progress');
    expect(progress.map(row => row.progress)).toEqual([
      { completedTrees: 0, totalTrees: 2, currentTree: trees[0], cacheHit: false },
      { completedTrees: 1, totalTrees: 2, currentTree: trees[1], cacheHit: false },
    ]);
    expect(rows.at(-1).event).toBe('completed');
    expect(readVerifierPhaseMeasurements(path)['deps.postverify']).toBe(rows.at(-1).durationMs);
  });
});
