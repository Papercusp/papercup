/** Current-source daemon + pinned TypeScript server + migrated real PG stores; flag and DB routing are isolated. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:net';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const storage = vi.hoisted(() => ({ sql: undefined as postgres.Sql | undefined }));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => { if (!storage.sql) throw new Error('pinned test PG not initialized'); return { sql: storage.sql }; },
}));

vi.mock('@papercusp/flags/server', async importOriginal => {
  const original = await importOriginal<typeof import('@papercusp/flags/server')>();
  return { ...original, getFlag: async (...args: Parameters<typeof original.getFlag>) =>
    args[0] === 'papercusp-code-intel-lsp' ? true : original.getFlag(...args) };
});
vi.mock('../resource-governor/execution', async importOriginal => {
  const original = await importOriginal<typeof import('../resource-governor/execution')>();
  const { PgAdmissionCutoverQueueStore } = await import('../resource-governor/admission-cutover-store');
  const { WorkItemAdmissionQueueDriver } = await import('../resource-governor/queue');
  const { Governor } = await import('../resource-governor/admission');
  return { ...original, governedExecutionRuntime: (workspaceId: string) => {
    if (!storage.sql) throw new Error('pinned test PG not initialized');
    const driver = new WorkItemAdmissionQueueDriver(new PgAdmissionCutoverQueueStore({ workspaceId, sql: storage.sql }), { namespace: 'lsp-query' });
    return { driver, governor: new Governor(driver) };
  } };
});

import { runLspDaemonServer } from './lsp-daemon-server';
import { callLspDaemonRpc, readLspDaemonAdmission, readLspDaemonHealth } from './lsp-daemon-client';
import { LSP_DAEMON_SOCKET_ENV } from './lsp-daemon-socket';
import { lspClientInventory, resolveServerBin, shutdownAllLspClients } from './lsp-adapter';
import { corpusCase } from './acceptance-corpus';
import { buildLspAdmissionStatePayload } from '../agent-tools/state/lsp-admission';
import { MAX_SITES_PER_ANSWER } from './lsp-daemon-facade';
import { freezeCompilerReplayConfig, runDaemonReplay } from './lsp-fleet-replay-runtime';
import type { ReplayReport } from './lsp-fleet-replay';
import { classifyReplayAnswer } from './lsp-fleet-replay';

const rootPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const workspaceId = `test-lsp-admission-pinned-${process.pid}`;
const previousSocket = process.env[LSP_DAEMON_SOCKET_ENV];
let server: Server | undefined;
let socketRoot: string | undefined;
let corpusRoot: string | undefined;
let db: OrgTestDb | undefined;
beforeAll(async () => {
  db = await createOrgTestDb();
  storage.sql = db.adminSql;
  expect((await db.adminSql`SELECT to_regclass('harness_shared.lsp_capabilities') AS name`)[0].name).toBeTruthy();
}, 120_000);
afterAll(async () => {
  await shutdownAllLspClients();
  if (server) await new Promise<void>(done => server!.close(() => done()));
  if (socketRoot) rmSync(socketRoot, { recursive: true, force: true });
  if (corpusRoot) rmSync(corpusRoot, { recursive: true, force: true });
  if (previousSocket === undefined) delete process.env[LSP_DAEMON_SOCKET_ENV];
  else process.env[LSP_DAEMON_SOCKET_ENV] = previousSocket;
  storage.sql = undefined;
  await db?.cleanup();
}, 30_000);

describe('daemon admission against the pinned TypeScript server', () => {
  it('answers tracked cross-package ground truth through learned cost lanes and live RPC readback', async () => {
    // Absence fails this acceptance check; a skip is not proof of a working backend.
    expect(resolveServerBin('typescript'), 'provision the maintained pinned TypeScript server').not.toBeNull();
    const file = join(rootPath, 'libs/generic/search/src/leg-health.ts');
    const lines = readFileSync(file, 'utf8').split('\n');
    const line0 = lines.findIndex(line => line.includes('import { pinModuleState'));
    expect(line0).toBeGreaterThanOrEqual(0);
    const args = { file, rootPath, line1: line0 + 1, character: lines[line0].indexOf('pinModuleState') };
    const expected = corpusCase('definition-cross-package-bare-specifier')!.expectedSites[0];
    socketRoot = mkdtempSync(join(tmpdir(), 'lsp-pinned-admission-'));
    const socket = join(socketRoot, 'daemon.sock');
    process.env[LSP_DAEMON_SOCKET_ENV] = socket;
    server = runLspDaemonServer();
    await once(server, 'listening');
    const query = (actorId: string) => callLspDaemonRpc(socket, { workspaceId, op: 'symbol', args, actorId, archive: true,
      deadlineAtMs: Date.now() + 90_000 }, 90_000, `pinned/${actorId}`);
    const warm = await query('warmup');
    expect(warm.error).toBeNull();
    expect(warm.freshness.health).toBe('healthy');
    expect(warm.sites).toContainEqual(expect.objectContaining({ path: expected.path, line1: expected.line1 }));
    const answers = await Promise.all(Array.from({ length: 8 }, (_, index) => query(`agent-${index}`)));
    for (const answer of answers) {
      expect(answer.error).toBeNull();
      expect(answer.freshness.health).toBe('healthy');
      expect(answer.sites).toContainEqual(expect.objectContaining({ path: expected.path, line1: expected.line1 }));
    }
    await vi.waitFor(async () => {
      expect(await readLspDaemonAdmission(workspaceId)).toMatchObject({ assessment: 'idle', queued: 0, inFlight: 0,
        settlementFailures: [], costObservations: 1 });
    });
    expect(await buildLspAdmissionStatePayload(workspaceId)).toMatchObject({ measurement: 'measured', assessment: 'idle', unknown: [] });
    const inventory = lspClientInventory().filter(client => client.language === 'typescript');
    expect(inventory).toHaveLength(1);
    expect(inventory[0].taskId).toBeTruthy();
    expect(inventory[0].health).toBe('healthy');
    const owningHealth = await readLspDaemonHealth(workspaceId);
    expect(owningHealth).toMatchObject({ pid: process.pid, sampledAtMs: expect.any(Number),
      servers: [{ taskId: inventory[0].taskId, pid: inventory[0].pid, certifiedReadiness: expect.any(Array),
        unprovenReadiness: expect.any(Array), progressGeneration: expect.any(Number) }] });
    for (const [index, answer] of answers.entries()) {
      expect(answer.daemonEvidence!.requestId).toBe(`pinned/agent-${index}`);
      const wire = answer.daemonEvidence!.wire.filter(row => row.method === 'textDocument/definition');
      expect(wire).toHaveLength(1);
      expect(wire[0]).toMatchObject({ taskId: inventory[0].taskId, pid: inventory[0].pid, outcome: 'response' });
      expect(wire[0].endedAtMs!).toBeGreaterThanOrEqual(wire[0].startedAtMs);
    }
    const receipts = answers.flatMap(answer => answer.daemonEvidence!.events.filter(event => event.phase === 'durable-settled'));
    expect(receipts.length).toBeGreaterThan(0);
    for (const receipt of receipts) {
      expect(receipt.confirmed).toBe(true);
      const rows = await db!.adminSql`SELECT state FROM harness_shared.resource_governor_admissions
        WHERE workspace_id = ${workspaceId} AND receipt_id = ${receipt.receiptId!}`;
      expect(rows).toEqual([{ state: 'completed' }]);
    }
    // This is a protocol/full-set precondition, not the repository-hot-class BAR.
    // A source-authored oracle cannot inherit missing sites from a warmup answer.
    corpusRoot = mkdtempSync(join(tmpdir(), 'lsp-archive-corpus-'));
    const corpusFile = join(corpusRoot, 'hot.ts');
    const callCount = MAX_SITES_PER_ANSWER + 20;
    writeFileSync(join(corpusRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, files: ['hot.ts'] }));
    writeFileSync(corpusFile, ['export function archiveHot() { return 1; }',
      ...Array.from({ length: callCount }, () => 'archiveHot();'), ''].join('\n'));
    const hotArgs = { file: corpusFile, line1: 2, character: 1, rootPath: corpusRoot };
    const preflight = await callLspDaemonRpc(socket, { workspaceId, op: 'symbol', args: hotArgs, archive: true }, 90_000, 'pinned/corpus/preflight');
    expect(preflight.error, JSON.stringify(preflight)).toBeNull();
    expect(preflight.sites.map(site => ({ path: site.path, line1: site.line1 }))).toEqual([{ path: 'hot.ts', line1: 1 }]);
    const request = { workspaceId, op: 'references' as const, args: hotArgs, deadlineAtMs: Date.now() + 90_000 };
    const full = await callLspDaemonRpc(socket, { ...request, archive: true }, 90_000, 'pinned/hot/archive');
    expect(full.error, JSON.stringify(full)).toBeNull();
    expect(full.sites.length).toBeGreaterThan(MAX_SITES_PER_ANSWER);
    expect(full.sites.map(site => ({ path: site.path, line1: site.line1 })).sort((a, b) => (a.line1 ?? 0) - (b.line1 ?? 0)))
      .toEqual(Array.from({ length: callCount + 1 }, (_, line) => ({ path: 'hot.ts', line1: line + 1 })));
    expect(full.truncation.truncated).toBe(false);
    const bounded = await callLspDaemonRpc(socket, { ...request, args: { ...hotArgs, limit: Number.MAX_SAFE_INTEGER } }, 90_000);
    expect(bounded.daemonEvidence).toBeUndefined();
    expect(bounded.sites).toHaveLength(MAX_SITES_PER_ANSWER);
    expect(bounded.truncation).toMatchObject({ truncated: true, totalAvailable: full.sites.length });
    expect(lspClientInventory().filter(client => client.language === 'typescript' && client.rootPath === rootPath)).toHaveLength(1);
    expect(lspClientInventory().filter(client => client.language === 'typescript' && client.rootPath === corpusRoot)).toHaveLength(1);
    // Exercise the maintained runner through the real socket and migrated PG,
    // without confusing this small corpus/control with the full1000 repository BAR.
    const replayConfig = freezeCompilerReplayConfig({ runId: 'protocol-runner', rootPath: corpusRoot,
      socketPath: socket, workspaceId, levels: [3], requestTimeoutMs: 90_000, tsconfigPath: 'tsconfig.json',
      definition: hotArgs, references: hotArgs, runtimeFiles: [], evidenceRef: 'source-authored145-call-protocol-fixture' });
    const replay = await runDaemonReplay(replayConfig, join(corpusRoot, 'archives'));
    expect(replay.result.unknown).toContain('missing-1000-level');
    const runs = readFileSync(join(replay.directory, 'runs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as ReplayReport);
    expect(runs).toHaveLength(9);
    expect(runs.reduce((count, report) => count + report.population.length, 0)).toBe(54);
    for (const report of runs) {
      expect(report.complete, JSON.stringify(report.accountingErrors)).toBe(true);
      for (const sample of report.samples) {
        expect(sample.clientSettledAtMs!).toBeGreaterThanOrEqual(sample.settledAtMs);
        const evidence = (sample.answer as typeof full).daemonEvidence!;
        expect(evidence.requestId).toBe(sample.request.id);
        // Exact source correctness and backend certification are separate facts.
        // Stable correct references can remain degraded under the current canary
        // strategy; preserve that failed BAR instead of forcing readiness green.
        const expected = replayConfig.corpus[sample.request.queryClass].oracle;
        expect(sample.answer!.error).toBeNull();
        const keys = (sites: typeof expected.sites) => sites.map(site => JSON.stringify([site.path, site.line1])).sort();
        expect(keys(sample.answer!.sites)).toEqual(keys(expected.sites));
        const classification = classifyReplayAnswer(sample.answer, expected);
        expect(report.failures.some(failure => failure.id === sample.request.id)).toBe(!classification.usefulCorrect);
        for (const terminal of evidence.events.filter(event => event.phase === 'durable-settled')) {
          expect(terminal.confirmed).toBe(true);
          expect(await db!.adminSql`SELECT state FROM harness_shared.resource_governor_admissions
            WHERE workspace_id = ${workspaceId} AND receipt_id = ${terminal.receiptId!}`).toEqual([{ state: 'completed' }]);
        }
      }
      for (const queryClass of ['definition', 'hot-references'] as const) {
        const useful = report.samples.filter(sample => sample.request.queryClass === queryClass &&
          classifyReplayAnswer(sample.answer, replayConfig.corpus[queryClass].oracle).usefulCorrect).length;
        expect(report.classes[queryClass].usefulCorrect).toBe(useful);
      }
    }
  }, 120_000);
});
