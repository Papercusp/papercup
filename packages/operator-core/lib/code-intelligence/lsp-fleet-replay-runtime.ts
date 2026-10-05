/** Daemon execution and qualification for the existing saturation CLI, P-012. */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { callLspDaemonRpc, readLspDaemonAdmission } from './lsp-daemon-client';
import { LSP_DAEMON_SOCKET_ENV } from './lsp-daemon-socket';
import { classifyReplayAnswer, evaluateReplayLadder, runReplay, REPLAY_CLASSES,
  type ReplayClass, type ReplayMode, type ReplayOracle, type ReplayReport, type ReplayTriplet } from './lsp-fleet-replay';
import type { LspFacadeArgs } from './lsp-facade';
import type { LspDaemonAnswer } from './lsp-daemon-protocol';
import { lspEvidenceNow } from './lsp-query-evidence';

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
    if (!Number.isFinite(terminal) || terminal > sample.settledAtMs || evidence.respondedAtMs === null ||
        evidence.respondedAtMs > sample.settledAtMs) problems.push(`invalid-settlement-order:${sample.request.id}`);
  }
  return problems;
}

/** Complete, inspectable process identity; an unavailable /proc read is explicitly unknown. */
export function replayProcessIdentity(pid: number) {
  try { return { pid, cmdline: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean),
    cgroup: readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim(), unknown: [] as string[] }; }
  catch (error) { return { pid, cmdline: [], cgroup: null, unknown: [String(error)] }; }
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
    const snapshot = { label, atMs: Date.now(), health, admission, processes, fileDrift: replayFileMismatches(config.files) };
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
        const report = await runReplay({ concurrency, mode, runId: `${trialId}/${mode}`, oracles,
          now: lspEvidenceNow, execute: request => query(request.queryClass, request.id, request.actorId) });
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
        const servers = snapshot.health.daemonRuntime?.servers.filter(server => resolve(server.rootPath) === resolve(config.rootPath));
        if (!servers || servers.length !== 1 || servers[0].health !== 'healthy' || !servers[0].taskId || !servers[0].pid)
          problems.push('unqualified-warm-server-population');
        if (snapshot.admission.queued || snapshot.admission.inFlight || snapshot.admission.settlementFailures.length)
          problems.push('unsettled-boundary');
      }
      if (JSON.stringify(start.health.daemonRuntime?.servers.map(server => [server.taskId, server.pid])) !==
          JSON.stringify(end.health.daemonRuntime?.servers.map(server => [server.taskId, server.pid]))) problems.push('changed-server-population');
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
