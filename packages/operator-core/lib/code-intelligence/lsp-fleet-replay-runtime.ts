/** Daemon execution and qualification for the existing saturation CLI, P-012. */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { callLspDaemonRpc, readLspDaemonAdmission } from './lsp-daemon-client';
import { LSP_DAEMON_SOCKET_ENV } from './lsp-daemon-socket';
import { classifyReplayAnswer, evaluateReplayLadder, runReplay, scoreReplay, REPLAY_CLASSES,
  type ReplayClass, type ReplayMode, type ReplayOracle, type ReplayReport, type ReplayTriplet } from './lsp-fleet-replay';
import type { LspFacadeArgs } from './lsp-facade';
import type { LspDaemonAnswer } from './lsp-daemon-protocol';
import { lspEvidenceNow } from './lsp-query-evidence';
import { taskIdFromScopeUnit } from '../task-manager/types';
import { absCgroupDir, parseProcCgroup, walkCgroupTree, type CgroupFs } from '../task-manager/cgroup-read';
import { readProcessIdentity } from '../process-identity';
import ts from 'typescript';

export interface ReplayCorpus {
  readonly cursor: Required<Pick<LspFacadeArgs, 'file' | 'line1' | 'character'>>;
  readonly oracle: ReplayOracle;
}
/** Authored independently from subject answers, frozen before any measurement. */
export interface DaemonReplayConfig {
  readonly schemaVersion: 'lsp-daemon-replay-config-v1';
  readonly runId: string;
  readonly rootPath: string;
  readonly socketPath: string;
  readonly workspaceId: string;
  readonly levels: readonly number[];
  readonly requestTimeoutMs: number;
  readonly oracleProvenance: { readonly method: string; readonly evidenceRef: string };
  /** Complete declared source/config/binary population, SHA256 keyed by absolute path. */
  readonly files: Readonly<Record<string, string>>;
  readonly corpus: Readonly<Record<ReplayClass, ReplayCorpus>>;
}
export const replayHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const replaySourceFingerprint = (files: DaemonReplayConfig['files']) => replayHash(JSON.stringify(Object.entries(files).sort()));
export const replayOracleFingerprint = (oracle: Pick<ReplayOracle, 'sites' | 'staleSites'>) => replayHash(JSON.stringify(oracle));
export interface ReplayOracleInput {
  readonly runId: string;
  readonly rootPath: string;
  readonly socketPath: string;
  readonly workspaceId: string;
  readonly levels: readonly number[];
  readonly requestTimeoutMs: number;
  readonly tsconfigPath: string;
  readonly definition: ReplayCorpus['cursor'];
  readonly references: ReplayCorpus['cursor'];
  /** Additional runtime binaries and loaded daemon/config source whose drift invalidates qualification. */
  readonly runtimeFiles: readonly string[];
  readonly evidenceRef: string;
}

/**
 * Independent static source census: resolves lexical bindings with the compiler
 * checker, never calls the subject adapter/server or learns sites from a warmup.
 * The explicit config/roots bound the population and are retained in the archive.
 */
export function freezeCompilerReplayConfig(input: ReplayOracleInput): DaemonReplayConfig {
  const tsconfigPath = resolve(input.rootPath, input.tsconfigPath);
  const configInputs = new Set<string>();
  const readConfig = (file: string) => { configInputs.add(resolve(file)); return ts.sys.readFile(file); };
  const read = ts.readConfigFile(tsconfigPath, readConfig);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, { ...ts.sys, readFile: readConfig }, resolve(tsconfigPath, '..'), undefined, tsconfigPath);
  if (parsed.errors.length) throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  const roots = [...new Set([...parsed.fileNames, resolve(input.rootPath, input.definition.file), resolve(input.rootPath, input.references.file)])];
  const program = ts.createProgram({ rootNames: roots, options: parsed.options });
  const checker = program.getTypeChecker();
  const canonical = (symbol: ts.Symbol | undefined): ts.Symbol | undefined => {
    const seen = new Set<ts.Symbol>();
    while (symbol && symbol.flags & ts.SymbolFlags.Alias && !seen.has(symbol)) { seen.add(symbol); symbol = checker.getAliasedSymbol(symbol); }
    return symbol;
  };
  const sourceFiles = program.getSourceFiles().filter(source => !source.isDeclarationFile &&
    !relative(input.rootPath, source.fileName).startsWith('..') && !source.fileName.includes('/node_modules/'));
  const files: Record<string, string> = {};
  // Declaration inputs and inherited configs affect symbol binding even though
  // they are not candidate reference sites. Their drift invalidates the oracle.
  for (const file of [...program.getSourceFiles().map(source => source.fileName), ...configInputs, ...input.runtimeFiles]) {
    const absolute = resolve(input.rootPath, file);
    files[absolute] = replayHash(readFileSync(absolute));
  }
  const sourceFingerprint = replaySourceFingerprint(files);
  const locate = (cursor: ReplayCorpus['cursor']) => {
    const source = program.getSourceFile(resolve(input.rootPath, cursor.file));
    if (!source) throw new Error(`oracle cursor outside compiler population:${cursor.file}`);
    const lines = source.getLineStarts();
    if (cursor.line1 < 1 || cursor.line1 > lines.length) throw new Error('oracle cursor line outside source');
    const offset = lines[cursor.line1 - 1] + cursor.character;
    let identifier: ts.Identifier | undefined;
    const visit = (node: ts.Node) => {
      if (offset < node.getStart(source) || offset >= node.end) return;
      if (ts.isIdentifier(node)) identifier = node;
      else ts.forEachChild(node, visit);
    };
    visit(source);
    const symbol = canonical(identifier ? checker.getSymbolAtLocation(identifier) : undefined);
    if (!symbol || !symbol.declarations?.length) throw new Error(`unresolved source oracle:${cursor.file}`);
    return symbol;
  };
  const site = (node: ts.Node) => ({ path: relative(input.rootPath, node.getSourceFile().fileName).replaceAll('\\', '/'),
    line1: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  const unique = (sites: ReplayOracle['sites']) => [...new Map(sites.map(site => [JSON.stringify(site), site])).values()]
    .sort((a, b) => a.path.localeCompare(b.path) || (a.line1 ?? 0) - (b.line1 ?? 0));
  const cheap = locate(input.definition);
  const hot = locate(input.references);
  const definitions = unique(cheap.declarations!.map(site));
  const references: { path: string; line1: number }[] = [];
  for (const source of sourceFiles) {
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && canonical(checker.getSymbolAtLocation(node)) === hot) references.push(site(node));
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const corpus = (cursor: ReplayCorpus['cursor'], sites: ReplayOracle['sites']): ReplayCorpus => ({ cursor,
    oracle: { sites, sourceFingerprint, oracleFingerprint: replayOracleFingerprint({ sites }) } });
  const config: DaemonReplayConfig = { schemaVersion: 'lsp-daemon-replay-config-v1', runId: input.runId,
    rootPath: input.rootPath, socketPath: input.socketPath, workspaceId: input.workspaceId, levels: input.levels,
    requestTimeoutMs: input.requestTimeoutMs, files,
    oracleProvenance: { method: 'static TypeScript symbol-binding census over the frozen compiler source population; no daemon answers',
      evidenceRef: input.evidenceRef },
    corpus: { definition: corpus(input.definition, definitions), 'hot-references': corpus(input.references, unique(references)) } };
  validateDaemonReplayConfig(config);
  return config;
}
export function replayFileMismatches(files: DaemonReplayConfig['files']): string[] {
  return Object.entries(files).flatMap(([file, hash]) => {
    try { return replayHash(readFileSync(file)) === hash ? [] : [`changed-file:${file}`]; }
    catch { return [`unreadable-file:${file}`]; }
  });
}

export function validateDaemonReplayConfig(config: DaemonReplayConfig): void {
  if (config.schemaVersion !== 'lsp-daemon-replay-config-v1' || !/^[a-zA-Z0-9_-]+$/.test(config.runId))
    throw new Error('invalid replay config identity');
  if (!isAbsolute(config.rootPath) || !isAbsolute(config.socketPath) || !config.workspaceId)
    throw new Error('replay requires absolute project/socket and explicit workspace');
  if (!config.levels.length || new Set(config.levels).size !== config.levels.length ||
      config.levels.some(level => !Number.isSafeInteger(level) || level < 1)) throw new Error('invalid declared ladder');
  if (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1)
    throw new Error('invalid frozen request deadline');
  if (!config.oracleProvenance.method || !config.oracleProvenance.evidenceRef || !Object.keys(config.files).length)
    throw new Error('independent oracle provenance and frozen file population are required');
  for (const [file, hash] of Object.entries(config.files)) {
    if (!isAbsolute(file) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid frozen source identity');
  }
  for (const queryClass of REPLAY_CLASSES) {
    const { cursor, oracle } = config.corpus[queryClass];
    const file = resolve(config.rootPath, cursor.file);
    if (!config.files[file] || !Number.isInteger(cursor.line1) || cursor.line1 < 1 ||
        !Number.isInteger(cursor.character) || cursor.character < 0) throw new Error(`invalid frozen cursor:${queryClass}`);
    if (!oracle.sites.length || !oracle.sourceFingerprint || !oracle.oracleFingerprint)
      throw new Error(`missing complete positive oracle:${queryClass}`);
    if (oracle.sourceFingerprint !== replaySourceFingerprint(config.files) ||
        oracle.oracleFingerprint !== replayOracleFingerprint({ sites: oracle.sites, ...(oracle.staleSites ? { staleSites: oracle.staleSites } : {}) }))
      throw new Error(`unmatched frozen fingerprint:${queryClass}`);
    const seen = new Set<string>();
    for (const site of oracle.sites) {
      if (!site.line1 || !Number.isInteger(site.line1) || site.line1 < 1 || isAbsolute(site.path) ||
          relative(config.rootPath, resolve(config.rootPath, site.path)).startsWith('..'))
        throw new Error(`invalid oracle site:${queryClass}`);
      if (!config.files[resolve(config.rootPath, site.path)]) throw new Error(`unfrozen oracle file:${site.path}`);
      const key = JSON.stringify([site.path, site.line1]);
      if (seen.has(key)) throw new Error(`duplicate oracle site:${queryClass}`);
      seen.add(key);
    }
  }
  if (config.corpus.definition.oracle.sourceFingerprint !== config.corpus['hot-references'].oracle.sourceFingerprint)
    throw new Error('unmatched source fingerprints');
  const drift = replayFileMismatches(config.files);
  if (drift.length) throw new Error(drift.join('\n'));
}

/** Actual wire occupancy, not caller wait overlap. Epoch clocks come from daemon evidence. */
export function replayWireOverlap(report: ReplayReport): boolean {
  const cheap = report.samples.filter(row => row.request.queryClass === 'definition');
  const hot = report.samples.filter(row => row.request.queryClass === 'hot-references');
  return cheap.some(row => {
    const answer = row.answer as LspDaemonAnswer | null;
    const end = answer?.daemonEvidence?.respondedAtMs;
    return end !== null && end !== undefined && hot.some(reference =>
      (reference.answer as LspDaemonAnswer | null)?.daemonEvidence?.wire.some(wire =>
        wire.method === 'textDocument/references' && wire.endedAtMs !== null &&
        wire.startedAtMs < end && end < wire.endedAtMs));
  });
}

export function replayEvidenceProblems(report: ReplayReport): string[] {
  const problems: string[] = [];
  for (const sample of report.samples) {
    const answer = sample.answer as LspDaemonAnswer | null;
    const evidence = answer?.daemonEvidence;
    if (!evidence || evidence.requestId !== sample.request.id) { problems.push(`missing-daemon-identity:${sample.request.id}`); continue; }
    const method = sample.request.queryClass === 'definition' ? 'textDocument/definition' : 'textDocument/references';
    const wire = evidence.wire.filter(row => row.method === method);
    if (!wire.length || wire.some(row => !row.taskId || !row.pid || row.endedAtMs === null || row.outcome !== 'response'))
      problems.push(`unsettled-wire:${sample.request.id}`);
    const receipts = evidence.events.filter(event => event.phase === 'durable-enqueued');
    if (!receipts.length || receipts.some(receipt => !receipt.receiptId || !evidence.events.some(event =>
      event.receiptId === receipt.receiptId && event.phase === 'durable-settled' && event.confirmed === true)))
      problems.push(`unconfirmed-durable-settlement:${sample.request.id}`);
    const terminal = Math.max(...evidence.events.filter(event => event.phase === 'durable-settled').map(event => event.atMs));
    const clientEnd = sample.clientSettledAtMs ?? sample.settledAtMs;
    if (!Number.isFinite(terminal) || terminal < sample.issuedAtMs || terminal > clientEnd || evidence.respondedAtMs === null ||
        evidence.respondedAtMs > clientEnd) problems.push(`invalid-settlement-order:${sample.request.id}`);
  }
  return problems;
}

interface ReplayProcessReader {
  identity(pid: number): string | null;
  text(path: string): string;
  bytes(path: string): Buffer;
  link(path: string): string;
}
const replayProcessReader: ReplayProcessReader = {
  identity: readProcessIdentity,
  text: path => readFileSync(path, 'utf8'),
  bytes: readFileSync,
  link: readlinkSync,
};
/** Kernel executable bytes and boot/start identity, not a later disk-path hash. */
export function replayProcessIdentity(pid: number, reader: ReplayProcessReader = replayProcessReader) {
  const unknown: string[] = [];
  const before = reader.identity(pid);
  const read = <T>(label: string, fn: () => T): T | null => {
    try { return fn(); } catch (error) { unknown.push(`${label}:${String(error)}`); return null; }
  };
  const cmdline = read('cmdline', () => reader.text(`/proc/${pid}/cmdline`).split('\0').filter(Boolean)) ?? [];
  const cgroup = read('cgroup', () => reader.text(`/proc/${pid}/cgroup`).trim());
  const executable = read('executable', () => ({ path: reader.link(`/proc/${pid}/exe`), sha256: replayHash(reader.bytes(`/proc/${pid}/exe`)) }));
  const after = reader.identity(pid);
  if (!before || !after) unknown.push('process-identity-unavailable');
  else if (before !== after) unknown.push('process-replaced-during-snapshot');
  // Executable identity does not witness scripts, loaders or native modules.
  return { pid, identity: before, cmdline, cgroup, executable, loadedModules: 'unmeasured' as const, unknown };
}

/** Reuse the managed cgroup walk, retaining unreadable branches as unknown. */
export function replayServerPopulation(pid: number, taskId: string, deps: {
  process?: ReplayProcessReader; fs?: CgroupFs;
} = {}) {
  const processReader = deps.process ?? replayProcessReader;
  const root = replayProcessIdentity(pid, processReader);
  const unknown = [...root.unknown];
  const cgroup = root.cgroup ? parseProcCgroup(root.cgroup) : null;
  if (!cgroup || taskIdFromScopeUnit(basename(cgroup)) !== taskId)
    unknown.push('server-task-cgroup-mismatch');
  const absolute = cgroup ? absCgroupDir(cgroup) : null;
  const checked = <T>(path: string, fn: () => T, fallback: T): T => {
    try { return fn(); } catch (error) { unknown.push(`unreadable-cgroup:${path}:${String(error)}`); return fallback; }
  };
  const fs: CgroupFs = deps.fs ?? {
    readFile: path => checked(path, () => readFileSync(path, 'utf8'), null as string | null),
    readDir: path => checked(path, () => readdirSync(path), [] as string[]),
    isDir: path => checked(path, () => statSync(path).isDirectory(), false),
  };
  // Do not census a broad foreign service cgroup when task provenance failed.
  const groups = absolute && !unknown.length ? walkCgroupTree(absolute, fs) : [];
  const pids = [...new Set(groups.flatMap(group => group.pids))].sort((a, b) => a - b);
  if (!pids.includes(pid)) unknown.push('server-missing-from-cgroup-census');
  const processes = pids.map(child => child === pid ? root : replayProcessIdentity(child, processReader));
  for (const child of processes) {
    unknown.push(...child.unknown.map(reason => `pid:${child.pid}:${reason}`));
    const childGroup = child.cgroup ? parseProcCgroup(child.cgroup) : null;
    if (!childGroup || !cgroup || (childGroup !== cgroup && !childGroup.startsWith(`${cgroup}/`)))
      unknown.push(`process-outside-server-cgroup:${child.pid}`);
  }
  if (processReader.identity(pid) !== root.identity) unknown.push('server-replaced-during-census');
  return { taskId, rootPid: pid, cgroup, groups, processes, unknown: [...new Set(unknown)] };
}

export function replayPopulationFingerprint(population: ReturnType<typeof replayServerPopulation>) {
  return replayHash(JSON.stringify(population.processes.map(row => ({ pid: row.pid, identity: row.identity,
    cgroup: row.cgroup, cmdline: row.cmdline, executable: row.executable }))));
}

export function replayDurableReport(report: ReplayReport, oracles: Readonly<Record<ReplayClass, ReplayOracle>>): ReplayReport {
  const samples = report.samples.map(sample => {
    const events = (sample.answer as LspDaemonAnswer | null)?.daemonEvidence?.events ?? [];
    const terminal = Math.max(...events.filter(event => event.phase === 'durable-settled' && event.confirmed === true).map(event => event.atMs));
    return { ...sample, clientSettledAtMs: sample.settledAtMs,
      settledAtMs: Number.isFinite(terminal) ? terminal : sample.settledAtMs };
  });
  return scoreReplay(report.concurrency, report.mode, report.population, samples, oracles);
}

/** Archive is append-only and exclusively created; no prior evidence is overwritten. */
export async function runDaemonReplay(config: DaemonReplayConfig, archiveParent: string) {
  validateDaemonReplayConfig(config);
  const directory = join(archiveParent, config.runId);
  if (existsSync(directory)) throw new Error(`archive already exists:${directory}`);
  mkdirSync(directory, { recursive: true });
  const configFingerprint = replayHash(JSON.stringify(config));
  const record = (name: string, value: unknown) => appendFileSync(join(directory, name), `${JSON.stringify(value)}\n`);
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ configFingerprint, config }, null, 2), { flag: 'wx' });
  const previousSocket = process.env[LSP_DAEMON_SOCKET_ENV];
  process.env[LSP_DAEMON_SOCKET_ENV] = config.socketPath;
  const query = (queryClass: ReplayClass, id: string, actorId: string) => callLspDaemonRpc(config.socketPath, {
    op: queryClass === 'definition' ? 'symbol' : 'references', workspaceId: config.workspaceId,
    args: { ...config.corpus[queryClass].cursor, rootPath: config.rootPath }, actorId, archive: true,
    deadlineAtMs: Date.now() + config.requestTimeoutMs,
  }, config.requestTimeoutMs + 5_000, id);
  const boundary = async (label: string) => {
    const health = await callLspDaemonRpc(config.socketPath, { op: 'health', args: {}, archive: true,
      workspaceId: config.workspaceId }, 10_000, `${config.runId}/${label}`);
    const admission = await readLspDaemonAdmission(config.workspaceId);
    const runtime = health.daemonRuntime;
    const processes = runtime ? [runtime.pid, ...runtime.servers.flatMap(server => server.pid ? [server.pid] : [])]
      .map(replayProcessIdentity) : [];
    const populations = runtime?.servers.filter(server => resolve(server.rootPath) === resolve(config.rootPath))
      .flatMap(server => server.pid && server.taskId ? [replayServerPopulation(server.pid, server.taskId)] : []) ?? [];
    const snapshot = { label, atMs: Date.now(), health, admission, processes, populations, fileDrift: replayFileMismatches(config.files) };
    record('boundaries.jsonl', snapshot);
    return snapshot;
  };
  const oracles = { definition: config.corpus.definition.oracle, 'hot-references': config.corpus['hot-references'].oracle };
  const triplets: ReplayTriplet[] = [];
  try {
    // Warm both intents independently; warmups remain visible but outside measured populations.
    for (const queryClass of REPLAY_CLASSES) {
      const answer = await query(queryClass, `${config.runId}/warm/${queryClass}`, 'warmup');
      record('warmups.jsonl', { queryClass, answer, classification: classifyReplayAnswer(answer, oracles[queryClass]) });
    }
    for (const concurrency of config.levels) for (let trial = 0; trial < 3; trial += 1) {
      const trialId = `${config.runId}/c${concurrency}/t${trial}`;
      const start = await boundary(`c${concurrency}/t${trial}/start`);
      const modes: ReplayMode[] = trial === 1 ? ['mixed', 'hot-references', 'definition'] : ['definition', 'hot-references', 'mixed'];
      const reports = new Map<ReplayMode, ReplayReport>();
      const problems = [...start.fileDrift];
      for (const mode of modes) {
        const report = replayDurableReport(await runReplay({ concurrency, mode, runId: `${trialId}/${mode}`, oracles,
          now: lspEvidenceNow, execute: request => query(request.queryClass, request.id, request.actorId) }), oracles);
        // Preserve every raw answer/ID/timestamp before scoring or inspecting qualification.
        record('runs.jsonl', report);
        reports.set(mode, report);
        problems.push(...replayEvidenceProblems(report));
        record('progress.jsonl', { trialId, mode, concurrency, complete: report.complete, classes: report.classes,
          failures: report.failures.length, certifiedFalseEmpty: report.certifiedFalseEmpty, certifiedStale: report.certifiedStale });
      }
      const end = await boundary(`c${concurrency}/t${trial}/end`);
      problems.push(...end.fileDrift);
      for (const snapshot of [start, end]) {
        if (!snapshot.health.daemonRuntime?.enabled || snapshot.processes.some(process => process.unknown.length || !process.cgroup))
          problems.push('unqualified-runtime-or-process');
        if (snapshot.populations.length !== 1 || snapshot.populations.some(population => population.unknown.length))
          problems.push('unqualified-server-descendant-population');
        for (const process of [...snapshot.processes, ...snapshot.populations.flatMap(population => population.processes)]) {
          if (!process.executable || config.files[process.executable.path] !== process.executable.sha256)
            problems.push(`unfrozen-running-executable:${process.pid}`);
        }
        const servers = snapshot.health.daemonRuntime?.servers.filter(server => resolve(server.rootPath) === resolve(config.rootPath));
        if (!servers || servers.length !== 1 || servers[0].health !== 'healthy' || !servers[0].taskId || !servers[0].pid)
          problems.push('unqualified-warm-server-population');
        for (const server of servers ?? []) {
          const process = snapshot.processes.find(process => process.pid === server.pid);
          const unit = process?.cgroup?.split('\n').find(line => line.startsWith('0::'))?.slice(3);
          if (!unit || taskIdFromScopeUnit(basename(unit)) !== server.taskId) problems.push('unqualified-server-task-cgroup');
        }
        if (snapshot.admission.queued || snapshot.admission.inFlight || snapshot.admission.settlementFailures.length)
          problems.push('unsettled-boundary');
      }
      if (JSON.stringify(start.health.daemonRuntime?.servers.map(server => [server.taskId, server.pid])) !==
          JSON.stringify(end.health.daemonRuntime?.servers.map(server => [server.taskId, server.pid]))) problems.push('changed-server-population');
      if (JSON.stringify(start.processes) !== JSON.stringify(end.processes) ||
          JSON.stringify(start.populations.map(replayPopulationFingerprint)) !== JSON.stringify(end.populations.map(replayPopulationFingerprint)))
        problems.push('changed-runtime-process-identity');
      const mixed = reports.get('mixed')!;
      if (concurrency > 1 && !replayWireOverlap(mixed)) problems.push('no-measured-expensive-wire-overlap');
      const triplet: ReplayTriplet = { trialId, definition: reports.get('definition')!, references: reports.get('hot-references')!, mixed,
        qualification: { qualified: problems.length === 0, fingerprint: configFingerprint, reasons: [...new Set(problems)] } };
      triplets.push(triplet);
      record('triplets.jsonl', { trialId, qualification: triplet.qualification });
    }
    const result = evaluateReplayLadder(triplets, config.levels);
    writeFileSync(join(directory, 'result.json'), JSON.stringify({ configFingerprint, result }, null, 2), { flag: 'wx' });
    return { directory, configFingerprint, result };
  } catch (error) {
    record('errors.jsonl', { atMs: Date.now(), error: String(error) });
    throw error;
  } finally {
    if (previousSocket === undefined) delete process.env[LSP_DAEMON_SOCKET_ENV];
    else process.env[LSP_DAEMON_SOCKET_ENV] = previousSocket;
  }
}
