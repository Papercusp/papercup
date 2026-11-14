/** Preparation of the actual T06 source/replay rail, with no native inference.
 * All attention sources, the registry, handler, PG trigger, listener and cache
 * are real. The private test runtime configuration is recorded, not a claim
 * about the original baseline host's configuration or task acceptance. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { createOrgTestDb } from '../../test/_org-test-db';
import { latencyAttentionFixtures } from '../../test/_latency-acceptance';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../_baseline-coord-fixture';
import { runWithWorkspace } from '../workspace-als';
import { ADMIN_COORD_UI_OWNER } from '../agent-tools/coordination/identity';
import { readAckedMsgIds } from '../agent-tools/coordination/messages';
import { stopInvalidationListener } from '../sync-sse';
import { __setCachedReadEnabledForTests, resetCachedReadStatsForTests } from '../cache/cached-read';
import { _refreshCacheLayerForTests, resetOperatorCacheForTests } from '../cache/instance';
import { _refreshL2FlagForTests } from '../cache/l2-tier';
import { registerCacheTagEcaRule, _refreshCacheEcaForTests } from '../events/cache-eca-rule';
import { benchAttentionInputSchema, benchFixtureBoundarySchema, allocateBenchFixtureReadLease,
  readBenchFixtureSourceSnapshot, requireBenchFixtureSourcePins, requireBenchFixtureReadLease,
  benchFixtureAllocationSha256, freezeBenchFixtureReadBoundary, benchFixtureResultSnapshot, benchFixtureProductCall,
  type BenchFixtureAllocation, type BenchFixtureReadBoundary } from './private-fixture-reads';
import { canonicalJson } from './reproducibility/canonical-json';
import { allCapabilities, currentProtocolFixture } from './reproducibility/_protocol-test-fixture';
import { upsertBenchRun } from './run-store';
import { replayLatencyAttentionFixture } from './latency-attention-replay';
import { currentBenchTaskProviderCapture, startCurrentBenchTaskAssignment, type CurrentTaskInput } from './run-launcher';
import { currentBenchAssignmentId } from './current-su';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';

let db: Awaited<ReturnType<typeof createOrgTestDb>>, environment: BaselineCoordFixture | undefined;
const previousHub = process.env.PAPERCUSP_LISTEN_HUB;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
beforeAll(async () => {
  db = await createOrgTestDb();
  environment = await setupBaselineCoordFixture({ dsn: db.adminDsn });
  process.env.PAPERCUSP_LISTEN_HUB = '0';
  setFlagOverridesForTest({ 'papercusp-cache-layer': true, 'papercusp-cache-tag-eca': true,
    'papercusp-cache-l2': true });
  resetOperatorCacheForTests(); resetCachedReadStatsForTests(); __setCachedReadEnabledForTests(true);
  await _refreshCacheLayerForTests(); await _refreshL2FlagForTests(); await _refreshCacheEcaForTests();
  registerCacheTagEcaRule();
}, 180_000);
afterAll(async () => {
  await stopInvalidationListener();
  __setCachedReadEnabledForTests(false); resetOperatorCacheForTests(); resetCachedReadStatsForTests();
  setFlagOverridesForTest(null);
  if (previousHub === undefined) delete process.env.PAPERCUSP_LISTEN_HUB;
  else process.env.PAPERCUSP_LISTEN_HUB = previousHub;
  await environment?.dispose();
  if (db) expect(await db.cleanupWithResult()).toBe('dropped');
}, 60_000);

describe('T06 private host event replay', () => {
  it('retains real outputs, principal differences and trigger payloads once under the assignment lease', async () => {
    const fixture = latencyAttentionFixtures();
    const { reference: _reference, measured: _measured, keys: _keys, observationRequired: _required, ...raw } = fixture;
    const input = benchAttentionInputSchema.parse(raw), workspaceId = input.workspace;
    const scope = { sql: db.adminSql, workspaceId }, hostRunId = 'private-t06-preparation', loopId = 'private-t06-loop';
    const protocol = { runId: 'private-t06-protocol' }, preregHash = hash(canonicalJson(protocol));
    let boundary = benchFixtureBoundarySchema.parse({ workspaceId, runId: protocol.runId, preregHash,
      assignmentId: 'bench-assignment:private-t06', armId: 'cold', seed: 1,
      taskId: 'LATENCY-M1:T06', fixtureSha256: 'a'.repeat(64), cases: {
        A: { input, viewWorkspaceId: input.workspace }, B: { input, viewWorkspaceId: input.otherWorkspace } } });
    const pin = async (which: 'A' | 'B') => {
      const text = canonicalJson(await readBenchFixtureSourceSnapshot(boundary, which, scope));
      return { bytes: Buffer.byteLength(text), sha256: hash(text) };
    };
    boundary = benchFixtureBoundarySchema.parse({ ...boundary, sourcePins: { A: await pin('A'), B: await pin('B') } });
    await upsertBenchRun({ id: hostRunId, arm: 'cold', taskSetId: 'custom', model: 'no-inference', status: 'running',
      config: { current: { preregHash }, protocol, loopId } }, scope);
    const lease = await allocateBenchFixtureReadLease({ scope, hostRunId, protocol, loopId, boundary, maxWallClockMs: 180_000 });
    const context = { workspaceId, harnessSlug: 'papercusp', isSuperuser: true, uiClientId: 'su-t06-private-host',
      principal: { slug: 'su-t06-private-host', workspaceId, capabilities: new Set() },
      log: vi.fn(), progress: vi.fn(), emit: vi.fn(), signal: new AbortController().signal } as PapercuspUnifiedToolContext;
    const host = { databaseName: db.dbName, context };
    await expect(replayLatencyAttentionFixture(lease.boundary, scope, { ...host, databaseName: 'production' }))
      .rejects.toThrow('non-private');
    const result = await replayLatencyAttentionFixture(lease.boundary, scope, host);
    const main = JSON.parse(result.A.text), isolation = JSON.parse(result.B.text);
    expect(main.acknowledgmentEncoding).toMatchObject({ input: { acker: 'admin' },
      readerPrincipal: ADMIN_COORD_UI_OWNER, matchesReaderPrincipal: false,
      storedEnvelope: { from: 'admin', kind: 'ack', related_msg_id: input.acknowledgment.msgId } });
    expect(ADMIN_COORD_UI_OWNER).toBe('pc-admin-coord-ui');
    expect(await runWithWorkspace(workspaceId, () => readAckedMsgIds('admin'))).toContain(input.acknowledgment.msgId);
    expect(await runWithWorkspace(workspaceId, () => readAckedMsgIds(ADMIN_COORD_UI_OWNER)))
      .not.toContain(input.acknowledgment.msgId);
    const final = main.reads.find((row: { label: string }) => row.label === 'after-acknowledgment:settled');
    expect(final.ids).toContain('coord-message:' + input.acknowledgment.msgId);
    expect(main.reads[0].ids).toEqual(expect.arrayContaining(fixture.reference.before));
    // No static-source suppression: preserve the entire real normalized output.
    expect(main.normalizedContents[main.reads[0].normalizedContentsSha256]).toHaveProperty('groups');
    expect(Object.keys(main.normalizedContents).length).toBeLessThan(main.reads.length);
    for (const [key, value] of Object.entries(main.normalizedContents)) expect(hash(canonicalJson(value))).toBe(key);
    expect(main.reads.every((row: { normalizedContentsSha256: string }) => main.normalizedContents[row.normalizedContentsSha256])).toBe(true);
    expect(isolation.reads.every((row: { workspaceId: string }) => row.workspaceId === input.otherWorkspace)).toBe(true);
    expect(isolation.reads.flatMap((row: { ids: string[] }) => row.ids))
      .not.toContain('coord-message:' + input.acknowledgment.msgId);
    expect(main.cache.issues).toEqual([]);
    expect(main.phaseSnapshots.map((row: { rows: unknown[] }) => row.rows.length)).toEqual([0, 2, 102, 103, 104]);
    const notifications = main.notifications.map((row: { payload: string }) => JSON.parse(row.payload))
      .filter((row: { name: string }) => row.name === 'harness_shared.coord_event_log.changed');
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications.every((row: { args: Record<string, unknown> }) => row.args.workspace_id === workspaceId && !('body' in row.args))).toBe(true);
    expect(main.triggers.some((row: { function_definition: string }) => row.function_definition.includes('row_jsonb'))).toBe(true);
    await requireBenchFixtureSourcePins(lease.boundary, scope);
    expect(await replayLatencyAttentionFixture(lease.boundary, scope, host)).toEqual(result);
    const [count] = await db.adminSql`SELECT count(*)::int AS n FROM harness_shared.coord_event_log
      WHERE workspace_id = ${workspaceId} AND surface = 'messages'`;
    expect(count?.n).toBe(104);
    if (process.env.PAPERCUSP_TEST_ARTIFACT_DIR) {
      mkdirSync(process.env.PAPERCUSP_TEST_ARTIFACT_DIR, { recursive: true });
      for (const [key, value] of Object.entries(result))
        writeFileSync(join(process.env.PAPERCUSP_TEST_ARTIFACT_DIR, `attention-replay-${key}.json`), value.text, { flag: 'wx' });
    }
    await lease.revoke();
    await expect(replayLatencyAttentionFixture(lease.boundary, scope, host)).rejects.toThrow(/host lease/);
  }, 180_000);
});

describe('T06 actual assignment factory preparation', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  async function fixture(armId: 'cold' | 'warm' = 'cold') {
    const { reference: _reference, measured: _measured, keys: _keys, observationRequired: _required, ...raw } = latencyAttentionFixtures();
    const suffix = randomUUID(), workspaceId = `factory-t06-${suffix}`;
    const schedule = benchAttentionInputSchema.parse({ ...raw, workspace: workspaceId, otherWorkspace: `${workspaceId}-other` });
    const scope = { sql: db.adminSql, workspaceId }, protocol = currentProtocolFixture(`factory-t06-${suffix}`, 180_000);
    const root = mkdtempSync(join(tmpdir(), 'bench-attention-factory-')); roots.push(root);
    const snapshot = JSON.stringify({ entries: [{ key: 'instructions', text: 'Read the assigned raw source inputs completely.' }] });
    for (const name of ['corpus', 'memory']) writeFileSync(join(root, `${name}.json`), snapshot);
    protocol.context = { ...protocol.context, corpusRef: 'corpus.json', memoryRef: 'memory.json',
      corpusHash: hash(snapshot), memoryHash: hash(snapshot) };
    const allocation: BenchFixtureAllocation = {
      'LATENCY-M1:T01': { A: { issueId: 'unused-a', comparisonTime: '2026-11-06T00:00:00Z' },
        B: { issueId: 'unused-b', comparisonTime: '2026-11-06T00:00:00Z' } },
      'LATENCY-M1:T02': { A: { issueId: 'unused-a', rubricRef: 'unused', subjectRef: 'unused', comparisonTime: '2026-11-06T00:00:00Z' },
        B: { issueId: 'unused-b', rubricRef: 'unused', subjectRef: 'unused', comparisonTime: '2026-11-06T00:00:00Z' } },
      'LATENCY-M1:T03': { A: { harness: 'papercusp', slug: 'unused-a', revision: 1, specAsOf: '2026-11-06T00:00:00Z' },
        B: { harness: 'papercusp', slug: 'unused-b', revision: 1, specAsOf: '2026-11-06T00:00:00Z' } },
      'LATENCY-M1:T06': { A: { input: schedule, viewWorkspaceId: schedule.workspace },
        B: { input: schedule, viewWorkspaceId: schedule.otherWorkspace } },
    };
    const task = { benchmark: 'harness-bench' as const, instanceId: 'LATENCY-M1:T06',
      problemStatement: 'Inspect both retained attention observations.', repo: root, baseCommit: 'a'.repeat(40),
      graderMeta: { latencyM1: { qualityOracle: { kind: 'exact-reference', required: ['retained-hidden-reference'] } } } };
    const provisional = freezeBenchFixtureReadBoundary({ binding: { workspaceId, runId: protocol.runId,
      preregHash: 'a'.repeat(64), assignmentId: 'bench-assignment:preparation', armId, seed: 1 },
      taskId: task.instanceId, expectedSha256: benchFixtureAllocationSha256(allocation), allocation })!;
    const pin = async (which: 'A' | 'B') => {
      const text = canonicalJson(await readBenchFixtureSourceSnapshot(provisional, which, scope));
      return { bytes: Buffer.byteLength(text), sha256: hash(text) };
    };
    allocation.verification = { 'LATENCY-M1:T06': { inputs: { A: await pin('A'), B: await pin('B') },
      promptSha256: hash(task.problemStatement), oracleSha256: hash(canonicalJson(task.graderMeta.latencyM1.qualityOracle)) } };
    protocol.taskIds = [task.instanceId];
    protocol.sampling!.taskRepositories = { [task.instanceId]: 'private-fixture', 'withheld-1': 'withheld-repo' };
    for (const [index, arm] of protocol.arms.entries()) {
      arm.id = index ? 'warm' : 'cold'; arm.account = 'private-provider-account';
      arm.control = { topology: 'solo', solverGroup: 'paired', solverToolsHash: 'f'.repeat(64),
        capabilities: allCapabilities('off'), fixtureReads: { kind: 'latency-m1-v1', sha256: benchFixtureAllocationSha256(allocation) } };
    }
    const preregHash = hash(canonicalJson(protocol)), loopId = `benchmark:${preregHash}`, hostRunId = `host-${suffix}`;
    const context = { workspaceId, harnessSlug: 'papercusp', isSuperuser: true, uiClientId: 'su-t06-private-host',
      principal: { slug: 'su-t06-private-host', workspaceId, capabilities: new Set() },
      log: vi.fn(), progress: vi.fn(), emit: vi.fn(), signal: new AbortController().signal } as PapercuspUnifiedToolContext;
    const input: CurrentTaskInput = { options: { workspaceId, runId: protocol.runId, armId, seed: 1, agent: 'codex',
      model: 'configured-alias', effort: 'high', account: 'private-provider-account',
      preregistration: { preregHash, config: protocol, repoRoot: root } }, protocol, task, context, scope, loopId, hostRunId,
      checkout: { dir: root, repo: root, baseCommit: task.baseCommit, cleanup: async () => {} }, fixtureReads: allocation,
      observation: { runtimeWorkspaceId: workspaceId, workerUnit: 'unused-worker', gatewayUnit: 'unused-gateway' },
      resources: { requestsPerArm: 2, inputTokens: 2000, outputTokens: 8192,
        armIds: protocol.arms.map(arm => currentBenchAssignmentId(protocol.runId, arm.id, task.instanceId, 1)).sort(),
        usdPerArm: 3, maxOpenUsd: 3, wallClockMsPerArm: 180_000, wallClockMs: 360_000 } };
    await upsertBenchRun({ id: hostRunId, arm: armId, taskSetId: 'custom', model: input.options.model, status: 'running',
      config: { current: { preregHash }, protocol, loopId } }, scope);
    const readSlot = async () => {
      const [row] = await db.adminSql`SELECT config->'privateFixtureReads' AS reads, config->'providerInputCaptures' AS captures
        FROM harness_shared.bench_runs WHERE workspace_id = ${workspaceId} AND id = ${hostRunId}`;
      return row!;
    };
    return { input, readSlot };
  }

  it('completes source/task preflight before invoking the callback or allocating a lease', async () => {
    const f = await fixture(), prepareFixture = vi.fn(), startGateway = vi.fn();
    f.input.task.problemStatement += ' changed';
    await expect(startCurrentBenchTaskAssignment(f.input, { prepareFixture, startGateway })).rejects.toThrow(/frozen input/);
    expect(prepareFixture).not.toHaveBeenCalled(); expect(startGateway).not.toHaveBeenCalled();
    expect(await f.readSlot()).toMatchObject({ reads: null, captures: null });
  });

  it.each(['missing-callback', 'throws', 'no-results', 'A-only', 'B-only', 'revoked'] as const)
    ('revokes the lease and never opens a gateway when preparation is %s', async failure => {
      const f = await fixture(), startGateway = vi.fn();
      let leased: BenchFixtureReadBoundary | undefined;
      const prepareFixture = async (boundary: BenchFixtureReadBoundary) => {
        leased = boundary;
        await requireBenchFixtureReadLease(boundary, f.input.scope);
        expect((await f.readSlot()).captures).toBeNull();
        if (failure === 'throws') throw new Error('trusted replay failed');
        if (failure === 'revoked') {
          await db.adminSql`UPDATE harness_shared.bench_runs SET status = 'cancelled' WHERE id = ${f.input.hostRunId}`;
        }
        if (failure === 'A-only' || failure === 'B-only') {
          const which = failure === 'A-only' ? 'A' : 'B';
          await benchFixtureResultSnapshot(boundary, benchFixtureProductCall(boundary,
            { operation: 'attention', case: which }), f.input.scope, '{"preparation":"one-sided"}');
        }
      };
      await expect(startCurrentBenchTaskAssignment(f.input, { startGateway,
        ...(failure === 'missing-callback' ? {} : { prepareFixture }) })).rejects.toThrow(
          /trusted host replay|trusted replay failed|no retained product read|host lease/);
      expect(startGateway).not.toHaveBeenCalled();
      const slot = await f.readSlot(); expect(slot.captures).toBeNull();
      expect(Object.values(slot.reads).map((value: any) => value.status)).toEqual(['revoked']);
      if (leased) await expect(requireBenchFixtureReadLease(leased, f.input.scope)).rejects.toThrow(/host lease/);
    });

  it.each(['cold', 'warm'] as const)('wires the real %s replay under its lease before gateway allocation', async armId => {
    const f = await fixture(armId), sequence: string[] = [];
    let leased: BenchFixtureReadBoundary | undefined;
    const stopGateway = vi.fn(async () => {});
    const prepareFixture = async (boundary: BenchFixtureReadBoundary) => {
        leased = boundary; sequence.push('prepare');
        await requireBenchFixtureReadLease(boundary, f.input.scope);
        expect((await f.readSlot()).captures).toBeNull();
        const result = await replayLatencyAttentionFixture(boundary, f.input.scope,
          { databaseName: db.dbName, context: f.input.context });
        expect(JSON.parse(result.A.text).phaseSnapshots.map((row: { rows: unknown[] }) => row.rows.length))
          .toEqual([0, 2, 102, 103, 104]);
        sequence.push('retained');
    };
    // The warm arm follows the same trusted input forwarding used by the
    // default liveCurrentTask; the cold arm retains the isolated factory port.
    if (armId === 'warm') f.input.prepareFixture = prepareFixture;
    const assignment = await startCurrentBenchTaskAssignment(f.input, {
      ...(armId === 'cold' ? { prepareFixture } : {}),
      startGateway: async () => {
        expect(sequence).toEqual(['prepare', 'retained']);
        for (const which of ['A', 'B'] as const) await benchFixtureResultSnapshot(leased!,
          benchFixtureProductCall(leased!, { operation: 'attention', case: which }), f.input.scope);
        sequence.push('gateway'); return { port: 32121, stop: stopGateway } as never;
      },
    });
    try {
      roots.push((await currentBenchTaskProviderCapture(f.input)).captureRoot);
      expect(sequence).toEqual(['prepare', 'retained', 'gateway']);
      expect(assignment.observations.fixtureReadLease).toEqual(leased!.lease);
      expect((await f.readSlot()).reads[leased!.assignmentId].attentionReplay.status).toBe('complete');
      await requireBenchFixtureReadLease(leased!, f.input.scope);
    } finally { await assignment.stop(); }
    await assignment.stop(); expect(stopGateway).toHaveBeenCalledTimes(1);
    await expect(requireBenchFixtureReadLease(leased!, f.input.scope)).rejects.toThrow(/host lease/);
    if (process.env.PAPERCUSP_TEST_ARTIFACT_DIR) {
      mkdirSync(process.env.PAPERCUSP_TEST_ARTIFACT_DIR, { recursive: true });
      writeFileSync(join(process.env.PAPERCUSP_TEST_ARTIFACT_DIR, `attention-factory-${armId}.json`),
        JSON.stringify({ sequence, slot: await f.readSlot() }), { flag: 'wx' });
    }
  }, 180_000);
});
