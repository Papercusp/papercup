/** Preparation of the actual T06 source/replay rail, with no native inference.
 * All attention sources, the registry, handler, PG trigger, listener and cache
 * are real. The private test runtime configuration is recorded, not a claim
 * about the original baseline host's configuration or task acceptance. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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
  readBenchFixtureSourceSnapshot, requireBenchFixtureSourcePins } from './private-fixture-reads';
import { canonicalJson } from './reproducibility/canonical-json';
import { upsertBenchRun } from './run-store';
import { replayLatencyAttentionFixture } from './latency-attention-replay';
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
