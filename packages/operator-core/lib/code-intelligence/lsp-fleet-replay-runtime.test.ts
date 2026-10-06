import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freezeCompilerReplayConfig, freezeReplayRuntimeFiles, materializeReplaySource, replayBoundaryProblems, replayDurableReport, replayEvidenceProblems, replayFileMismatches, replayHash, replayOracleFingerprint,
  replayPopulationFingerprint, replayProcessIdentity, replayServerPopulation, replaySourceFingerprint, replayWireOverlap,
  runDaemonReplay, validateDaemonReplayConfig, type DaemonReplayConfig, type ReplayBoundary, type ReplayOracleInput } from './lsp-fleet-replay-runtime';
import { callLspDaemonRpc, readLspDaemonAdmission } from './lsp-daemon-client';
import { scopeUnitForTask } from '../task-manager/types';
import { buildReplayTrace, type ReplayReport } from './lsp-fleet-replay';
import type { LspDaemonAnswer } from './lsp-daemon-protocol';
import { runSaturationCli } from './lsp-saturation-bench-cli';

vi.mock('./code-intel-bench.ts', () => { throw new Error('legacy benchmark must not load in independent replay mode'); });
vi.mock('./lsp-daemon-client', () => ({ callLspDaemonRpc: vi.fn(), readLspDaemonAdmission: vi.fn() }));

const roots: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('prelaunch replay runtime dependency population', () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'lsp-runtime-population-')); roots.push(root);
    const modules = join(root, 'node_modules'); mkdirSync(modules);
    const pkg = join(modules, 'external'); mkdirSync(pkg);
    const entry = join(pkg, 'index.js'); writeFileSync(entry, 'module.exports = 7;');
    return { root, modules, pkg, entry };
  }
  it('freezes external files, canonical aliases and the declared native dependency graph before launch', () => {
    const f = fixture();
    const addon = join(f.pkg, 'pty.node'); writeFileSync(addon, 'native addon');
    const library = join(f.root, 'libutil.so.1'); writeFileSync(library, 'native library');
    symlinkSync('index.js', join(f.pkg, 'alias.js'));
    const files = freezeReplayRuntimeFiles([f.modules], { nativeDependencies: path => path === addon ? [library] : [] });
    expect(files[f.entry]).toBe(replayHash(readFileSync(f.entry)));
    expect(files[join(f.pkg, 'alias.js')]).toBe(files[f.entry]);
    expect(files[addon]).toBe(replayHash('native addon'));
    expect(files[library]).toBe(replayHash('native library'));
    writeFileSync(f.entry, 'module.exports = 8;');
    expect(replayFileMismatches(files)).toContain(`changed-file:${f.entry}`);
  });
  it('refuses a dependency symlink escaping the independently copied input root', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'live.js'), 'live donor');
    symlinkSync('../../live.js', join(f.pkg, 'live.js'));
    expect(() => freezeReplayRuntimeFiles([f.modules], { nativeDependencies: () => [] })).toThrow('escaping-replay-runtime-link');
  });
  it('retains directory alias descendants regardless of canonical traversal order', () => {
    const f = fixture();
    const metadata = join(f.pkg, 'package.json'); writeFileSync(metadata, '{"main":"index.js"}');
    const alias = join(f.modules, 'alias'); symlinkSync('external', alias);
    for (const paths of [[f.pkg, alias], [alias, f.pkg], [f.modules]]) {
      const files = freezeReplayRuntimeFiles(paths, { nativeDependencies: () => [] });
      expect(files[join(alias, 'package.json')]).toBe(replayHash(readFileSync(metadata)));
      expect(files[join(alias, 'index.js')]).toBe(files[f.entry]);
      writeFileSync(metadata, '{"main":"changed.js"}');
      expect(replayFileMismatches(files)).toContain(`changed-file:${join(alias, 'package.json')}`);
      writeFileSync(metadata, '{"main":"index.js"}');
    }
  });
  it('refuses canonical directory cycles rather than silently dropping their descendants', () => {
    const f = fixture(); symlinkSync('.', join(f.pkg, 'loop'));
    expect(() => freezeReplayRuntimeFiles([f.modules], { nativeDependencies: () => [] })).toThrow('cyclic-replay-runtime-link');
  });
  it('refuses missing transitive libraries and changed files instead of returning a partial population', () => {
    const f = fixture();
    expect(() => freezeReplayRuntimeFiles([f.modules], { nativeDependencies: () => [join(f.root, 'missing.so')] })).toThrow();
    expect(() => freezeReplayRuntimeFiles([f.modules], { nativeDependencies: path => {
      writeFileSync(path, 'changed during dependency discovery'); return [];
    } })).toThrow('changed-during-replay-runtime-freeze');
  });
  it.runIf(process.platform === 'linux')('captures the actual Node ELF dependency graph with the default scanner', () => {
    const files = freezeReplayRuntimeFiles([process.execPath]);
    const libraries = [...execFileSync('ldd', [process.execPath], { encoding: 'utf8' })
      .matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s+\(/gm)].map(match => realpathSync(match[1]));
    expect(libraries.length).toBeGreaterThan(0);
    for (const file of [realpathSync(process.execPath), ...libraries])
      expect(files[file]).toBe(replayHash(readFileSync(file)));
  });
});
function config(): DaemonReplayConfig {
  const rootPath = mkdtempSync(join(tmpdir(), 'lsp-replay-config-')); roots.push(rootPath);
  const file = join(rootPath, 'source.ts');
  writeFileSync(file, 'export function hot() {}\nhot();\n');
  const files = { [file]: replayHash(readFileSync(file)) };
  const sites = [{ path: 'source.ts', line1: 1 }, { path: 'source.ts', line1: 2 }];
  const make = (expected: typeof sites) => ({ cursor: { file, line1: 2, character: 1 },
    oracle: { sites: expected, sourceFingerprint: replaySourceFingerprint(files), oracleFingerprint: replayOracleFingerprint({ sites: expected }) } });
  return { schemaVersion: 'lsp-daemon-replay-config-v1', runId: 'source-oracle', rootPath, socketPath: join(rootPath, 'daemon.sock'),
    workspaceId: 'test', levels: [1, 8, 1000], requestTimeoutMs: 90_000,
    oracleProvenance: { method: 'source-authored exact locations', evidenceRef: 'fixture:source.ts' }, files,
    corpus: { definition: make(sites.slice(0, 1)), 'hot-references': make(sites) } };
}
function report(): ReplayReport {
  const population = buildReplayTrace(3, 'mixed', 'live');
  const samples = population.map(request => {
    const receiptId = `receipt/${request.id}`;
    const hot = request.queryClass === 'hot-references';
    const answer: LspDaemonAnswer = { backend: 'lsp-adapter', intent: hot ? 'references' : 'definition', query: 'hot', sites: [],
      truncation: { truncated: false, totalAvailable: 0, continuation: null },
      freshness: { health: 'healthy', indexedAt: null, indexedCommit: null, staleVsDisk: false }, latencyMs: 5, error: null,
      daemonEvidence: { requestId: request.id, daemonPid: 10, receivedAtMs: 1, respondedAtMs: hot ? 21 : 10,
        events: [{ phase: 'durable-enqueued', atMs: 2, receiptId }, { phase: 'durable-settled', atMs: hot ? 20 : 9, receiptId, confirmed: true }],
        wire: [{ method: hot ? 'textDocument/references' : 'textDocument/definition', taskId: 'server-task', pid: 11,
          startedAtMs: hot ? 4 : 5, endedAtMs: hot ? 18 : 7, outcome: 'response' }] } };
    return { request, issuedAtMs: 0, settledAtMs: 22, answer, transportError: null };
  });
  return { schemaVersion: 'lsp-fleet-replay-v1', concurrency: 3, mode: 'mixed', population, samples,
    classes: {} as ReplayReport['classes'], sourceFingerprint: 'source', oracleFingerprint: 'oracle',
    complete: true, accountingErrors: [], certifiedFalseEmpty: 0, certifiedStale: 0, failures: [], classesOverlap: true };
}
describe('daemon replay RPC cursor origin', () => {
  it.each(['relative', 'absolute'])('uses the declared source root for %s cursor files without rewriting the oracle', async kind => {
    const frozen = config();
    if (kind === 'relative') for (const corpus of Object.values(frozen.corpus)) corpus.cursor.file = 'source.ts';
    const original = JSON.stringify(frozen);
    vi.mocked(callLspDaemonRpc).mockImplementation(async (_socket, request) => {
      if (request.op === 'health') throw new Error('fixture-stop-before-load');
      return readyAnswer(frozen, request.op === 'symbol' ? 'definition' : 'hot-references');
    });
    await expect(runDaemonReplay(frozen, frozen.rootPath)).rejects.toThrow('fixture-stop-before-load');
    const queries = vi.mocked(callLspDaemonRpc).mock.calls.filter(([, request]) => request.op !== 'health');
    expect(queries.map(([, request]) => [request.op, request.args.file, request.args.rootPath]))
      .toEqual(['symbol', 'references'].map(op => [op, join(frozen.rootPath, 'source.ts'), frozen.rootPath]));
    expect(JSON.stringify(frozen)).toBe(original);
    expect(JSON.parse(readFileSync(join(frozen.rootPath, frozen.runId, 'config.json'), 'utf8')).config).toEqual(frozen);
  });
});
function readyAnswer(frozen: DaemonReplayConfig, queryClass: 'definition' | 'hot-references'): LspDaemonAnswer {
  const sites = frozen.corpus[queryClass].oracle.sites.map(site => ({ ...site, kind: 'function' }));
  return { backend: 'lsp-adapter', intent: queryClass === 'definition' ? 'definition' : 'references', query: 'fixture', sites,
    truncation: { truncated: false, totalAvailable: sites.length, continuation: null },
    freshness: { health: 'healthy', indexedAt: null, indexedCommit: null, staleVsDisk: false }, latencyMs: 1, error: null };
}
describe('daemon replay readiness and runtime admission', () => {
  function boundary(frozen: DaemonReplayConfig): ReplayBoundary {
    const taskId = 'replayserver';
    const cgroup = `0::/papercusp.slice/${scopeUnitForTask(taskId)}`;
    const executable = { path: join(frozen.rootPath, 'source.ts'), sha256: frozen.files[join(frozen.rootPath, 'source.ts')] };
    const process = (pid: number) => ({ pid, identity: `fixture:${pid}`, cmdline: ['fixture'], cgroup, executable,
      loadedModules: { receipts: [], native: [], unknown: [] }, unknown: [] });
    return { label: 'fixture', atMs: 1, fileDrift: [],
      health: { ...readyAnswer(frozen, 'definition'), daemonRuntime: {
        enabled: true, overall: 'healthy', provisioned: {} as NonNullable<LspDaemonAnswer['daemonRuntime']>['provisioned'],
        pid: 10, node: executable.path, entry: executable.path, sampledAtMs: 1,
        servers: [{ language: 'typescript', rootPath: frozen.rootPath, taskId, pid: 11, health: 'healthy', coldStartMs: 1,
          openDocs: 1, everSettled: true, quiescent: true, pendingProgress: 0, progressGeneration: 1,
          certifiedReadiness: ['definition', 'references'], unprovenReadiness: [] }],
      } },
      processes: [process(10), process(11)],
      populations: [{ taskId, rootPid: 11, cgroup, groups: [], processes: [process(11), process(12)], unknown: [] }],
      admission: { queued: 0, inFlight: 0, settlementFailures: [] } };
  }
  function rows(frozen: DaemonReplayConfig, file: string) {
    return readFileSync(join(frozen.rootPath, frozen.runId, file), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  }
  it.each(['refusal', 'empty', 'degraded', 'stale', 'truncated', 'missing-site', 'unexpected-site'])
    ('archives a %s hot-reference warmup and issues no measured request', async failure => {
      const frozen = config();
      const answer = readyAnswer(frozen, 'hot-references');
      const failed: LspDaemonAnswer = { ...answer,
        error: failure === 'refusal' ? 'not ready' : null,
        sites: failure === 'empty' ? [] : failure === 'missing-site' ? answer.sites.slice(0, 1) :
          failure === 'unexpected-site' ? [...answer.sites, { path: 'source.ts', line1: 3, kind: 'function' }] : answer.sites,
        freshness: { ...answer.freshness, health: failure === 'degraded' ? 'degraded' : 'healthy', staleVsDisk: failure === 'stale' },
        truncation: { ...answer.truncation, truncated: failure === 'truncated' } };
      vi.mocked(callLspDaemonRpc).mockImplementation(async (_socket, request) =>
        request.op === 'symbol' ? readyAnswer(frozen, 'definition') : failed);
      await expect(runDaemonReplay(frozen, frozen.rootPath)).rejects.toThrow('replay-readiness-refused:hot-references:');
      expect(vi.mocked(callLspDaemonRpc).mock.calls.map(([, request]) => request.actorId)).toEqual(['warmup', 'warmup']);
      expect(rows(frozen, 'warmups.jsonl')).toHaveLength(2);
      expect(rows(frozen, 'preflights.jsonl')[0]).toMatchObject({ phase: 'readiness', ready: false });
      expect(rows(frozen, 'errors.jsonl')[0].error).toContain('replay-readiness-refused');
      expect(existsSync(join(frozen.rootPath, frozen.runId, 'runs.jsonl'))).toBe(false);
      expect(existsSync(join(frozen.rootPath, frozen.runId, 'result.json'))).toBe(false);
      const saved = readFileSync(join(frozen.rootPath, frozen.runId, 'warmups.jsonl'), 'utf8');
      await expect(runDaemonReplay(frozen, frozen.rootPath)).rejects.toThrow('archive already exists');
      expect(readFileSync(join(frozen.rootPath, frozen.runId, 'warmups.jsonl'), 'utf8')).toBe(saved);
    });
  it.each(['root-load', 'child-load', 'population', 'executable', 'health', 'unsettled', 'drift', 'missing-root', 'wrong-server'])
    ('refuses %s at the first runtime boundary before measured load', async failure => {
      const frozen = config();
      const start = boundary(frozen);
      if (failure === 'root-load') start.processes[0].loadedModules = 'unmeasured';
      if (failure === 'child-load') start.populations[0].processes[1].loadedModules = 'unmeasured';
      if (failure === 'population') start.populations[0].unknown.push('unreadable-census');
      if (failure === 'executable') start.processes[0].executable!.sha256 = replayHash('changed inode');
      if (failure === 'health') start.health.daemonRuntime!.servers[0].health = 'degraded';
      if (failure === 'unsettled') start.admission.inFlight = 1;
      if (failure === 'missing-root') start.processes.shift();
      if (failure === 'wrong-server') start.populations[0].rootPid = 999;
      vi.mocked(readLspDaemonAdmission).mockResolvedValue({ ...start.admission } as Awaited<ReturnType<typeof readLspDaemonAdmission>>);
      vi.mocked(callLspDaemonRpc).mockImplementation(async (_socket, request) => {
        if (request.op === 'health') {
          if (failure === 'drift') writeFileSync(join(frozen.rootPath, 'source.ts'), 'changed after warmup');
          return start.health;
        }
        return readyAnswer(frozen, request.op === 'symbol' ? 'definition' : 'hot-references');
      });
      await expect(runDaemonReplay(frozen, frozen.rootPath, { captureRuntime: () => start }))
        .rejects.toThrow('replay-start-boundary-refused');
      expect(vi.mocked(callLspDaemonRpc).mock.calls.filter(([, request]) => request.op !== 'health'))
        .toHaveLength(2);
      expect(rows(frozen, 'boundaries.jsonl')).toHaveLength(1);
      expect(rows(frozen, 'preflights.jsonl')[1]).toMatchObject({ phase: 'runtime', ready: false });
      expect(rows(frozen, 'errors.jsonl')[0].error).toContain('replay-start-boundary-refused');
      expect(existsSync(join(frozen.rootPath, frozen.runId, 'runs.jsonl'))).toBe(false);
    });
  it('advances exact healthy warmups and qualified runtime boundaries through all three triplets', async () => {
    const frozen = { ...config(), levels: [1] };
    const start = boundary(frozen);
    expect(replayBoundaryProblems(start, frozen)).toEqual([]);
    vi.mocked(readLspDaemonAdmission).mockResolvedValue({ ...start.admission } as Awaited<ReturnType<typeof readLspDaemonAdmission>>);
    vi.mocked(callLspDaemonRpc).mockImplementation(async (_socket, request) => request.op === 'health' ? start.health :
      readyAnswer(frozen, request.op === 'symbol' ? 'definition' : 'hot-references'));
    await runDaemonReplay(frozen, frozen.rootPath, { captureRuntime: () => start });
    expect(rows(frozen, 'runs.jsonl')).toHaveLength(9);
    expect(rows(frozen, 'triplets.jsonl')).toHaveLength(3);
    expect(rows(frozen, 'preflights.jsonl').every(row => row.ready === true)).toBe(true);
    expect(existsSync(join(frozen.rootPath, frozen.runId, 'result.json'))).toBe(true);
    // Synthetic transport has no durable query evidence; admission is proven,
    // while the archive must still refuse to claim acceptance for these runs.
    expect(rows(frozen, 'triplets.jsonl').every(row => row.qualification.qualified === false)).toBe(true);
  });
});
describe('independent replay source materialization', () => {
  function fixture() {
    const frozen = config();
    const parent = mkdtempSync(join(tmpdir(), 'lsp-replay-snapshot-')); roots.push(parent);
    const target = join(parent, 'source');
    writeFileSync(join(frozen.rootPath, 'tsconfig.json'), JSON.stringify({ files: ['source.ts'], compilerOptions: { noLib: true } }));
    const input: ReplayOracleInput = { runId: 'copied-source', rootPath: frozen.rootPath,
      socketPath: frozen.socketPath, workspaceId: 'test', levels: [1], requestTimeoutMs: 90_000,
      tsconfigPath: 'tsconfig.json', definition: { file: 'source.ts', line1: 2, character: 1 },
      references: { file: 'source.ts', line1: 2, character: 1 }, runtimeFiles: [], evidenceRef: 'source-copy-fixture' };
    const dependencies = (_donor: string, out: string) => writeFileSync(join(out, '.papercusp-pinned-deps'), 'mode=copy\ntrees=0\n');
    const options = { enumerateSources: () => ['source.ts', 'tsconfig.json'], snapshotDependencies: dependencies };
    return { input, target, options, parent };
  }
  it('uses independent source and external runtime bytes after the donor changes in place', () => {
    const f = fixture();
    const binary = join(f.parent, 'node-fixture');
    writeFileSync(binary, 'original executable', { mode: 0o755 });
    const copied = materializeReplaySource({ ...f.input, runtimeFiles: [binary],
      definition: { ...f.input.definition, file: join(f.input.rootPath, 'source.ts') } }, f.target, f.options);
    expect(copied.definition.file).toBe('source.ts');
    expect(statSync(join(copied.rootPath, 'source.ts')).ino).not.toBe(statSync(join(f.input.rootPath, 'source.ts')).ino);
    writeFileSync(join(f.input.rootPath, 'source.ts'), 'export const replacement = 1;');
    writeFileSync(binary, 'changed executable');
    expect(readFileSync(copied.runtimeFiles[0], 'utf8')).toBe('original executable');
    expect(statSync(copied.runtimeFiles[0]).mode & 0o111).toBe(0o111);
    const oracle = freezeCompilerReplayConfig(copied);
    expect(oracle.corpus['hot-references'].oracle.sites).toEqual([{ path: 'source.ts', line1: 1 }, { path: 'source.ts', line1: 2 }]);
    expect(() => validateDaemonReplayConfig(oracle)).not.toThrow();
    writeFileSync(copied.sourceSnapshot!.manifestPath, '{}');
    expect(() => validateDaemonReplayConfig(oracle)).toThrow('changed-file');
  });
  it('freezes through the maintained CLI without loading Git-dependent legacy probes', async () => {
    const f = fixture();
    expect(existsSync(join(f.input.rootPath, '.git'))).toBe(false);
    const inputPath = join(f.parent, 'input.json');
    const outputPath = join(f.parent, 'frozen.json');
    writeFileSync(inputPath, JSON.stringify(f.input));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const progress = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runSaturationCli(['node', 'lsp-saturation-bench-cli.ts', '--freeze-replay', inputPath, outputPath]);
      const frozen = JSON.parse(readFileSync(outputPath, 'utf8')) as DaemonReplayConfig;
      expect(frozen.rootPath).toBe(f.input.rootPath);
      expect(frozen.corpus['hot-references'].oracle.sites).toEqual([
        { path: 'source.ts', line1: 1 }, { path: 'source.ts', line1: 2 },
      ]);
      expect(() => validateDaemonReplayConfig(frozen)).not.toThrow();
    } finally { output.mockRestore(); progress.mockRestore(); }
  });
  it('refuses a source-directory escape through the destination parent', () => {
    const f = fixture();
    const alias = join(f.parent, 'donor-link');
    symlinkSync(f.input.rootPath, alias);
    expect(() => materializeReplaySource(f.input, join(alias, 'snapshot'), f.options)).toThrow('must-be-disjoint');
    expect(existsSync(join(f.input.rootPath, 'snapshot'))).toBe(false);
  });
  it('retains deletions and refuses an existing output instead of overwriting another run', () => {
    const f = fixture();
    const copied = materializeReplaySource(f.input, f.target, { ...f.options,
      enumerateSources: () => ['source.ts', 'tsconfig.json', 'deleted.ts'] });
    expect(JSON.parse(readFileSync(copied.sourceSnapshot!.manifestPath, 'utf8')).absent).toEqual(['deleted.ts']);
    expect(() => materializeReplaySource(f.input, f.target, f.options)).toThrow();
    expect(() => materializeReplaySource(copied, join(f.parent, 'again'), f.options)).toThrow('already-materialized');
    expect(readFileSync(join(f.target, 'source.ts'), 'utf8')).toContain('hot();');
  });
  it('refuses a dependency symlink to the live donor before publishing the source manifest', () => {
    const f = fixture();
    expect(() => materializeReplaySource(f.input, f.target, { ...f.options, snapshotDependencies: (donor, out) => {
      f.options.snapshotDependencies(donor, out);
      mkdirSync(join(out, 'node_modules'));
      symlinkSync(join(donor, 'source.ts'), join(out, 'node_modules', 'live-source'));
    } })).toThrow('escaping-replay-snapshot-link');
    expect(existsSync(join(f.target, '.replay-source-snapshot.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(f.target, '.replay-source-capture.json'), 'utf8')).sourceFiles['source.ts']).toBeTruthy();
  });
  it('captures ignored workspace launcher and conditional-export output named by package metadata', () => {
    const f = fixture();
    mkdirSync(join(f.input.rootPath, 'dist'));
    writeFileSync(join(f.input.rootPath, 'dist', 'cli.js'), 'export const cli = 1;');
    writeFileSync(join(f.input.rootPath, 'dist', 'api.js'), 'export const api = 1;');
    writeFileSync(join(f.input.rootPath, 'package.json'), JSON.stringify({ bin: { fixture: './dist/cli.js' },
      exports: { '.': { import: './dist/api.js' } } }));
    const copied = materializeReplaySource(f.input, f.target, { ...f.options,
      enumerateSources: () => [...f.options.enumerateSources(), 'package.json'], snapshotDependencies: (donor, out) => {
        f.options.snapshotDependencies(donor, out);
        mkdirSync(join(out, 'node_modules'));
        symlinkSync('../dist/cli.js', join(out, 'node_modules', 'fixture-cli'));
      } });
    expect(readFileSync(join(copied.rootPath, 'node_modules', 'fixture-cli'), 'utf8')).toContain('cli = 1');
    expect(readFileSync(join(copied.rootPath, 'dist', 'api.js'), 'utf8')).toContain('api = 1');
    writeFileSync(join(f.input.rootPath, 'dist', 'cli.js'), 'changed donor');
    expect(readFileSync(join(copied.rootPath, 'node_modules', 'fixture-cli'), 'utf8')).toContain('cli = 1');
    expect(JSON.parse(readFileSync(copied.sourceSnapshot!.manifestPath, 'utf8')).sourceFiles['dist/cli.js']).toBeTruthy();
  });
  it('refuses source path escapes and hardlinked dependency mode', () => {
    const f = fixture();
    expect(() => materializeReplaySource(f.input, f.target, { ...f.options, enumerateSources: () => ['../foreign.ts'] }))
      .toThrow('escaping-replay-source');
    const second = join(f.parent, 'hardlinked');
    expect(() => materializeReplaySource(f.input, second, { ...f.options, snapshotDependencies: (_donor, out) =>
      writeFileSync(join(out, '.papercusp-pinned-deps'), 'mode=hardlink\n') })).toThrow('not-independent-copies');
  });
  it('rejects a shared compiler library outside the copied population', () => {
    const f = fixture();
    writeFileSync(join(f.input.rootPath, 'tsconfig.json'), JSON.stringify({ files: ['source.ts'] }));
    const copied = materializeReplaySource(f.input, f.target, f.options);
    const phases: string[] = [];
    // This test's compiler is intentionally the original one, like a shared CLI.
    expect(() => freezeCompilerReplayConfig(copied, { onProgress: progress => phases.push(progress.phase) })).toThrow('snapshot-input-escape');
    expect(phases).not.toContain('references-scanned');
  });
});
describe('daemon replay qualification', () => {
  it('hashes complete multi-chunk binary bytes and reports each final validation attempt', () => {
    const frozen = config();
    const binary = join(frozen.rootPath, 'runtime.bin');
    const bytes = Buffer.alloc(192 * 1024 + 17);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    writeFileSync(binary, bytes);
    const missing = join(frozen.rootPath, 'absent.bin');
    const files = { ...frozen.files, [binary]: replayHash(bytes), [missing]: replayHash('absent') };
    const progress: { phase: string; file?: string; completed: number; total: number }[] = [];
    expect(replayFileMismatches(files, { onProgress: row => progress.push(row) })).toEqual([`unreadable-file:${missing}`]);
    const completed = progress.filter(row => row.phase === 'file-validated');
    expect(completed.map(row => row.file)).toEqual(Object.keys(files));
    expect(completed.map(row => row.completed)).toEqual([1, 2, 3]);
    expect(progress.find(row => row.file === binary)).toMatchObject({ phase: 'files-validating', completed: 1, total: 3 });
    bytes[bytes.length - 1] ^= 255;
    writeFileSync(binary, bytes);
    expect(replayFileMismatches(files)).toEqual([`changed-file:${binary}`, `unreadable-file:${missing}`]);
  });
  it('refuses a mutation during final file validation and never emits frozen success', () => {
    const frozen = config();
    const root = frozen.rootPath;
    const source = join(root, 'source.ts');
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ files: ['source.ts'], compilerOptions: { noLib: true } }));
    const phases: string[] = [];
    expect(() => freezeCompilerReplayConfig({ runId: 'validation-drift', rootPath: root, socketPath: frozen.socketPath,
      workspaceId: 'test', levels: [1], requestTimeoutMs: 90_000, tsconfigPath: 'tsconfig.json',
      definition: { file: 'source.ts', line1: 2, character: 1 }, references: { file: 'source.ts', line1: 2, character: 1 },
      runtimeFiles: [], evidenceRef: 'final-validation-mutation-control' }, { onProgress: progress => {
        phases.push(progress.phase);
        if (progress.phase === 'files-validating' && progress.file === source)
          writeFileSync(source, 'export function replacement() {}\nreplacement();\n');
      } })).toThrow(`changed-file:${source}`);
    expect(phases).toContain('file-validated');
    expect(phases).not.toContain('validated');
  });
  it('freezes source and exact oracle before querying, and rejects cursor/source drift', () => {
    const frozen = config();
    expect(() => validateDaemonReplayConfig(frozen)).not.toThrow();
    writeFileSync(Object.keys(frozen.files)[0], 'changed');
    expect(replayFileMismatches(frozen.files)).toHaveLength(1);
    expect(() => validateDaemonReplayConfig(frozen)).toThrow('changed-file');
  });
  it('rejects unfrozen, escaping and duplicate expected sites rather than blessing subject output', () => {
    const frozen = config();
    for (const sites of [[{ path: '../escape.ts', line1: 1 }], [{ path: 'unknown.ts', line1: 1 }],
      [{ path: 'source.ts', line1: 1 }, { path: 'source.ts', line1: 1 }]]) {
      const modified = { ...frozen, corpus: { ...frozen.corpus, definition: { ...frozen.corpus.definition,
        oracle: { ...frozen.corpus.definition.oracle, sites, oracleFingerprint: replayOracleFingerprint({ sites }) } } } };
      expect(() => validateDaemonReplayConfig(modified)).toThrow();
    }
    expect(() => validateDaemonReplayConfig({ ...frozen, levels: [1, 1] })).toThrow('ladder');
    expect(() => validateDaemonReplayConfig({ ...frozen, runId: '../overwrite' })).toThrow('identity');
  });
  it('requires cheap completion inside actual expensive wire occupancy, not just overlapping RPC waits', () => {
    const live = report();
    expect(replayWireOverlap(live)).toBe(true);
    for (const sample of live.samples) if (sample.request.queryClass === 'hot-references') {
      (sample.answer as LspDaemonAnswer).daemonEvidence!.wire[0].endedAtMs = 9;
    }
    expect(live.classesOverlap).toBe(true);
    expect(replayWireOverlap(live)).toBe(false);
  });
  it('refuses wrong request IDs, unconfirmed durable receipts and pending wires even on healthy replies', () => {
    const live = report();
    expect(replayEvidenceProblems(live)).toEqual([]);
    (live.samples[0].answer as LspDaemonAnswer).daemonEvidence!.wire[0].endedAtMs = null;
    const answer = live.samples[1].answer as LspDaemonAnswer;
    const broken: LspDaemonAnswer = { ...answer, daemonEvidence: { ...answer.daemonEvidence!,
      events: answer.daemonEvidence!.events.map(event => event.phase === 'durable-settled' ? { ...event, confirmed: false } : event) } };
    const missing = { ...live.samples[2], answer: { ...live.samples[2].answer!, daemonEvidence: undefined } };
    expect(replayEvidenceProblems({ ...live, samples: [live.samples[0], { ...live.samples[1], answer: broken }, missing] }))
      .toEqual([`unsettled-wire:${live.samples[0].request.id}`, `unconfirmed-durable-settlement:${live.samples[1].request.id}`,
        `missing-daemon-identity:${live.samples[2].request.id}`]);
  });
  it('measures the whole durable settlement tail while retaining the later client completion', () => {
    const live = report();
    const oracle = { sites: [], sourceFingerprint: 'source', oracleFingerprint: 'oracle' };
    const durable = replayDurableReport(live, { definition: oracle, 'hot-references': oracle });
    expect(durable.classes.definition.elapsedMs).toBe(9);
    expect(durable.classes['hot-references'].elapsedMs).toBe(20);
    expect(durable.samples[0]).toMatchObject({ settledAtMs: 9, clientSettledAtMs: 22 });
    expect(replayEvidenceProblems(durable)).toEqual([]);
  });
  it('builds the complete source oracle across an alias while excluding comments and a same-name shadow', () => {
    const frozen = config();
    const root = frozen.rootPath;
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, files: ['source.ts', 'consumer.ts'] }));
    writeFileSync(join(root, 'consumer.ts'), ["import { hot as alias } from './source';", 'alias();',
      'function shadow() { const hot = () => 2; hot(); }', '// hot();', ''].join('\n'));
    const oracle = freezeCompilerReplayConfig({ runId: 'independent', rootPath: root, socketPath: frozen.socketPath,
      workspaceId: 'test', levels: [1, 8, 1000], requestTimeoutMs: 90_000, tsconfigPath: 'tsconfig.json',
      definition: { file: 'consumer.ts', line1: 2, character: 1 }, references: { file: 'source.ts', line1: 2, character: 1 },
      runtimeFiles: [], evidenceRef: 'source-authored-test' });
    expect(oracle.corpus.definition.oracle.sites).toEqual([{ path: 'source.ts', line1: 1 }]);
    expect(oracle.corpus['hot-references'].oracle.sites).toEqual([{ path: 'consumer.ts', line1: 1 },
      { path: 'consumer.ts', line1: 2 }, { path: 'source.ts', line1: 1 }, { path: 'source.ts', line1: 2 }]);
  });
  it('freezes inherited config and declaration dependencies that determine symbol binding', () => {
    const frozen = config();
    const root = frozen.rootPath;
    writeFileSync(join(root, 'base.json'), JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ extends: './base.json', files: ['source.ts', 'ambient.d.ts'] }));
    writeFileSync(join(root, 'ambient.d.ts'), 'declare const ambient: string;\n');
    const oracle = freezeCompilerReplayConfig({ runId: 'config-closure', rootPath: root, socketPath: frozen.socketPath,
      workspaceId: 'test', levels: [1], requestTimeoutMs: 90_000, tsconfigPath: 'tsconfig.json',
      definition: { file: 'source.ts', line1: 2, character: 1 }, references: { file: 'source.ts', line1: 2, character: 1 },
      runtimeFiles: [], evidenceRef: 'config-closure-fixture' });
    expect(oracle.files[join(root, 'base.json')]).toBe(replayHash(readFileSync(join(root, 'base.json'))));
    expect(oracle.files[join(root, 'ambient.d.ts')]).toBeTruthy();
    writeFileSync(join(root, 'base.json'), '{}');
    expect(() => validateDaemonReplayConfig(oracle)).toThrow('changed-file');
  });
  it('rejects a disk edit after compiler load instead of labeling old bindings with the new bytes', () => {
    const frozen = config();
    const root = frozen.rootPath;
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ files: ['source.ts'], compilerOptions: { noLib: true } }));
    const phases: string[] = [];
    expect(() => freezeCompilerReplayConfig({ runId: 'loaded-drift', rootPath: root, socketPath: frozen.socketPath,
      workspaceId: 'test', levels: [1], requestTimeoutMs: 90_000, tsconfigPath: 'tsconfig.json',
      definition: { file: 'source.ts', line1: 2, character: 1 }, references: { file: 'source.ts', line1: 2, character: 1 },
      runtimeFiles: [], evidenceRef: 'disk-mutation-control' }, { onProgress: progress => {
        phases.push(progress.phase);
        if (progress.phase === 'compiler-loaded') writeFileSync(join(root, 'source.ts'), 'export function replacement() {}\nreplacement();\n');
      } })).toThrow(`changed-file:${join(root, 'source.ts')}`);
    expect(phases).toContain('references-scanned');
    expect(phases).not.toContain('validated');
  });
  it.each(['utf8', 'utf16le', 'utf16be'] as const)('retains original %s BOM bytes used for compiler binding', encoding => {
    const frozen = config();
    const root = frozen.rootPath;
    const source = 'export function hot() {}\nhot();\n';
    const bytes = encoding === 'utf8' ? Buffer.from(`\uFEFF${source}`) :
      Buffer.concat([Buffer.from(encoding === 'utf16le' ? [255, 254] : [254, 255]),
        encoding === 'utf16le' ? Buffer.from(source, 'utf16le') : Buffer.from(source, 'utf16le').swap16()]);
    writeFileSync(join(root, 'source.ts'), bytes);
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ files: ['source.ts'], compilerOptions: { noLib: true } }));
    const oracle = freezeCompilerReplayConfig({ runId: `bom-${encoding}`, rootPath: root, socketPath: frozen.socketPath,
      workspaceId: 'test', levels: [1], requestTimeoutMs: 90_000, tsconfigPath: 'tsconfig.json',
      definition: { file: 'source.ts', line1: 2, character: 1 }, references: { file: 'source.ts', line1: 2, character: 1 },
      runtimeFiles: [], evidenceRef: 'encoded-source-control' });
    expect(oracle.files[join(root, 'source.ts')]).toBe(replayHash(bytes));
    expect(oracle.corpus['hot-references'].oracle.sites).toEqual([{ path: 'source.ts', line1: 1 }, { path: 'source.ts', line1: 2 }]);
  });
});

describe('kernel replay process provenance', () => {
  const taskId = 'replayserver';
  const cgroup = `/papercusp.slice/${scopeUnitForTask(taskId)}`;
  function fixture() {
    const identities = new Map([[10, 'linux:boot:100'], [11, 'linux:boot:101']]);
    const process = {
      identity: (pid: number) => identities.get(pid) ?? null,
      text: (path: string) => path.endsWith('/cgroup') ? `0::${cgroup}${path.includes('/11/') ? '/worker' : ''}` : 'node\0server.js\0',
      bytes: () => Buffer.from('actual executable inode'),
      link: () => '/usr/bin/node',
    };
    const root = `/sys/fs/cgroup${cgroup}`;
    const fs = {
      readFile: (path: string) => path === `${root}/cgroup.procs` ? '10\n' : path === `${root}/worker/cgroup.procs` ? '11\n' : null,
      readDir: (path: string) => path === root ? ['worker'] : [],
      isDir: (path: string) => path === root || path === `${root}/worker`,
    };
    return { process, fs, identities };
  }
  it('censuses nested server children and retains kernel executable bytes without claiming loaded JS', () => {
    const deps = fixture();
    const population = replayServerPopulation(10, taskId, deps);
    expect(population.unknown).toEqual([]);
    expect(population.processes.map(row => row.pid)).toEqual([10, 11]);
    expect(population.processes[1]).toMatchObject({ identity: 'linux:boot:101',
      executable: { path: '/usr/bin/node', sha256: replayHash(Buffer.from('actual executable inode')) }, loadedModules: 'unmeasured' });
    deps.identities.set(11, 'linux:boot:999');
    expect(replayPopulationFingerprint(replayServerPopulation(10, taskId, deps))).not.toBe(replayPopulationFingerprint(population));
  });
  it('rejects PID reuse during reads and unavailable executable evidence', () => {
    const deps = fixture();
    let calls = 0;
    deps.process.identity = () => ++calls === 1 ? 'linux:boot:100' : 'linux:boot:999';
    expect(replayProcessIdentity(10, deps.process).unknown).toContain('process-replaced-during-snapshot');
    expect(replayProcessIdentity(10, { ...fixture().process, bytes: () => { throw new Error('inaccessible'); } }).unknown)
      .toEqual(['executable:Error: inaccessible']);
  });
  it('rejects foreign task scopes before walking them and lost or escaped descendants', () => {
    const deps = fixture();
    expect(replayServerPopulation(10, 'other-task', deps).groups).toEqual([]);
    expect(replayServerPopulation(10, 'other-task', deps).unknown).toContain('server-task-cgroup-mismatch');
    deps.identities.delete(11);
    expect(replayServerPopulation(10, taskId, deps).unknown).toContain('pid:11:process-identity-unavailable');
    const escaped = { ...fixture().process, text: (path: string) => path.endsWith('/cgroup') ? `0::${path.includes('/11/') ? '/foreign' : cgroup}` : 'node\0' };
    expect(replayServerPopulation(10, taskId, { ...fixture(), process: escaped }).unknown).toContain('process-outside-server-cgroup:11');
  });
  it('does not treat unreadable cgroup branches as an empty, qualified population', () => {
    const deps = fixture();
    const readable = deps.fs.readFile;
    deps.fs.readFile = path => path.includes('/worker/') ? null : readable(path);
    expect(replayServerPopulation(10, taskId, deps).unknown).toContain(`unreadable-cgroup:/sys/fs/cgroup${cgroup}/worker/cgroup.procs`);
    expect(replayServerPopulation(10, taskId, { ...fixture(), fs: { ...fixture().fs,
      readDir: () => { throw new Error('permission denied'); } } }).unknown.join('\n')).toContain('permission denied');
  });
});
