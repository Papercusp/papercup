import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freezeCompilerReplayConfig, materializeReplaySource, replayDurableReport, replayEvidenceProblems, replayFileMismatches, replayHash, replayOracleFingerprint,
  replayPopulationFingerprint, replayProcessIdentity, replayServerPopulation, replaySourceFingerprint, replayWireOverlap,
  validateDaemonReplayConfig, type DaemonReplayConfig, type ReplayOracleInput } from './lsp-fleet-replay-runtime';
import { scopeUnitForTask } from '../task-manager/types';
import { buildReplayTrace, type ReplayReport } from './lsp-fleet-replay';
import type { LspDaemonAnswer } from './lsp-daemon-protocol';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
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
