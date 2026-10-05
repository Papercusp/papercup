import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayEvidenceProblems, replayFileMismatches, replayHash, replayOracleFingerprint,
  replaySourceFingerprint, replayWireOverlap, validateDaemonReplayConfig, type DaemonReplayConfig } from './lsp-fleet-replay-runtime';
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
});
