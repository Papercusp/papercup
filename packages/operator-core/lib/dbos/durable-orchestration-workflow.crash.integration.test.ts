// @vitest-environment node
/**
 * Real SIGKILL inside a nested tool call of an explicitly durable orchestration run
 * (blueprint-backed-work-item-execution-2026-09-23 P-019, D-019).
 *
 * Each scenario runs the REAL `durableOrchestration` DBOS workflow in a child process, kills it
 * mid-call, and relaunches DBOS on a fresh executor. The oracle is independent of the code under
 * test: it counts live dispatches in `test_durable.calls` (written by the tools themselves) and
 * reads the per-call step rows DBOS wrote to `dbos.operation_outputs`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTestPg, teardownTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { ACTIVATION_QUALITY_PUBLICATION_SCRIPT } from '../agent-tools/recipes/activation-quality-publication';
import { createDurableCrashHarness, type DurableCrashScenario as Scenario } from '../../test/_durable-orchestration-crash-harness';
import { GROUNDED_MANIFEST_SHA256, materializeGroundedFixture, measureGroundedEvidence,
  observeGroundedModelFetch, observeGroundedToolDispatch,
  type GroundedMeasurementScope } from '../grounded-evidence-measurement';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const childPath = resolve(packageRoot, 'test/_durable-orchestration-crash-child.ts');
let adminUri: string;
let databaseName: string;
let dsn: string;
let sql: postgres.Sql;
const gecArtifacts = process.env.PAPERCUSP_TEST_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'gec-durable-'));

beforeAll(async () => {
  // Children inherit the committed-source loader outside Vitest's worker.
  // Match the interruption suite's precondition before creating a DB.
  if (process.env.NODE_OPTIONS?.includes('committed-source-loader')) {
    const root = resolve(packageRoot, '../..');
    for (const path of ['packages/operator-core/test/_durable-orchestration-crash-child.ts',
      'packages/operator-core/test/_durable-orchestration-capture.ts',
      'packages/operator-core/lib/dbos/durable-orchestration-workflow.ts',
      'packages/operator-core/lib/agent-tools/code/durable-run.ts',
      'packages/operator-core/lib/agent-tools/orchestration/run.ts',
      'packages/operator-core/lib/grounded-evidence-measurement.ts']) {
      const committed = spawnSync('git', ['show', 'HEAD:' + path], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
      expect(committed.status, 'await git-sync before crash proof: ' + path).toBe(0);
      expect(readFileSync(resolve(root, path)).equals(committed.stdout),
        'await git-sync; committed-source loader would substitute ' + path).toBe(true);
    }
  }
  adminUri = await getTestPg();
  databaseName = 'durable_orch_crash_' + randomBytes(5).toString('hex');
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe('CREATE DATABASE "' + databaseName + '"');
    await markManagedTestDatabase(admin, databaseName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(adminUri);
  url.pathname = '/' + databaseName;
  dsn = url.toString();
  sql = postgres(dsn, { max: 2, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA test_durable;
    CREATE TABLE test_durable.calls (
      seq bigserial PRIMARY KEY,
      run_key text NOT NULL,
      tool text NOT NULL,
      mode text NOT NULL,
      args text,
      idempotency_key text
    )`);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  if (adminUri && databaseName) {
    const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe('DROP DATABASE IF EXISTS "' + databaseName + '" WITH (FORCE)');
    } finally {
      await admin.end({ timeout: 5 });
    }
  }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
  if (!process.env.PAPERCUSP_TEST_ARTIFACT_DIR) rmSync(gecArtifacts, { recursive: true, force: true });
});

const { runChild, calls, stepNames, crashThenRecover } = createDurableCrashHarness({
  packageRoot, dsn: () => dsn, sql: () => sql, artifacts: gecArtifacts,
});

const key = (label: string) => label + '-' + randomBytes(4).toString('hex');

describe('GEC frozen B durable consumer captures', () => {
  for (const caseId of ['C3', 'C5', 'C6'] as const) it.each([1, 2, 3])(`${caseId} retains actual crash/replay step tapes iteration %i`, async iteration => {
    const materialized = materializeGroundedFixture(`durable-${caseId}-${iteration}-${randomBytes(4).toString('hex')}`);
    const frozen = materialized.manifest.cases.find(row => row.id === caseId)!;
    const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
    const fixturePath = join(gecArtifacts, `${caseId}-${iteration}-fixture.json`);
    const fixtureBytes = JSON.stringify(materialized);
    writeFileSync(fixturePath, fixtureBytes);
    expect(readFileSync(fixturePath, 'utf8')).toBe(fixtureBytes);
    const consumerMode = process.env.PAPERCUSP_TEST_GEC_MODEL;
    const consumerConfig = caseId === 'C3' && ['1', 'preflight'].includes(consumerMode ?? '')
      ? await (async () => {
        const [{ loadPlaybookBody, SU_PLAYBOOK_FRAMING }, { LEARNING_MODEL_SPEC }] = await Promise.all([
          import('../llm-testing/targets/su'), import('../learning/model-policy')]);
        return { model: process.env.LLM_TEST_SUT_MODEL || LEARNING_MODEL_SPEC,
          prompt: SU_PLAYBOOK_FRAMING + await loadPlaybookBody() };
      })() : null;
    const sourceHashes = Object.fromEntries([
      ['workflow', new URL('./durable-orchestration-workflow.ts', import.meta.url)],
      ['recorder', new URL('../grounded-evidence-measurement.ts', import.meta.url)],
      ['dispatch', new URL('../../../../libs/generic/tooldef/src/code-orchestration/durable-dispatch.ts', import.meta.url)],
      ['consumer', new URL('../llm-testing/targets/su.ts', import.meta.url)],
      ['consumerLoop', new URL('../llm-testing/targets/codex-responses-tool-loop.ts', import.meta.url)],
      ['consumerCatalog', new URL('../llm-testing/targets/su-catalog.ts', import.meta.url)],
      ['authorityRequest', new URL('../coord-ops/agent-tools.ts', import.meta.url)],
      ['modelPolicy', new URL('../learning/model-policy.ts', import.meta.url)],
    ].map(([name, path]) => [String(name), digest(readFileSync(path))]));
    const testHashes = { parent: digest(readFileSync(new URL(import.meta.url))),
      child: digest(readFileSync(childPath)),
      harness: digest(readFileSync(new URL('../../test/_durable-orchestration-crash-harness.ts', import.meta.url))),
      capture: digest(readFileSync(new URL('../../test/_durable-orchestration-capture.ts', import.meta.url))) };
    const scope: GroundedMeasurementScope = {
      workspaceId: 'ws-p019-crash', harness: materialized.mapping[materialized.manifest.namespace.harness],
      potId: materialized.mapping[materialized.manifest.namespace.pot], runId: key(`gec-${caseId}`),
      ownerId: 'durable-crash-caller', caseId, arm: 'pre', iteration,
      manifestHash: GROUNDED_MANIFEST_SHA256, fixtureHash: digest(fixtureBytes),
      sourceFingerprint: digest(JSON.stringify(sourceHashes)), testFingerprint: digest(JSON.stringify(testHashes)),
      runtimeFingerprint: digest(JSON.stringify({ node: process.versions.node, class: 'real-dbos-private-pg' })),
      configFingerprint: digest(JSON.stringify({ scenario: frozen, tools: 'in-process-sql-doubles',
        consumer: consumerConfig && { model: consumerConfig.model, promptSha256: digest(consumerConfig.prompt) } })),
    };
    const scenario: Scenario = { runKey: scope.runId, gecScope: scope,
      crashTarget: caseId === 'C3' ? 'before:items:get' : caseId === 'C5' ? 'before:items:put' : 'mail:send',
      ...(caseId === 'C3' ? { revoke: 'items:put' } : {}),
      script: caseId === 'C3'
        ? "const historical = await tools.call('items:put', { k: 3 }); await tools.call('items:get', { k: 3 }); return await tools.call('items:put', { k: 4, prior: historical.tool });"
        : caseId === 'C5'
        ? "const a = await tools.call('items:get', { k: 1 }); return await tools.call('items:put', { k: 1, prior: a.tool });"
        : "await tools.call('items:get', { k: 2 }); return await tools.call('mail:send', { k: 2 });",
    };
    const result = await crashThenRecover(scenario);
    const originalCalls = await calls(scenario.runKey);
    const originalSteps = await stepNames(scenario.runKey);
    const crash = JSON.parse(readFileSync(join(gecArtifacts, `${scenario.runKey}-crash.json`), 'utf8'));
    const recovered = JSON.parse(readFileSync(join(gecArtifacts, `${scenario.runKey}-recover.json`), 'utf8'));
    const outputRowsAfter = [...await sql.unsafe<Array<{ workflow_uuid: string; function_id: number;
      output: string | null; error: string | null }>>(
      'SELECT workflow_uuid, function_id, output, error FROM dbos.operation_outputs ORDER BY workflow_uuid, function_id')];
    const initialRecovery = JSON.parse(readFileSync(join(gecArtifacts, `${scenario.runKey}-recover.initial-keys.json`), 'utf8'));
    const outputBytes = (rows: Array<{ output: string | null; error: string | null }>) => rows.reduce((sum, row) => sum
      + (row.output === null ? 0 : Buffer.byteLength(row.output)) + (row.error === null ? 0 : Buffer.byteLength(row.error)), 0);
    const persistedOutputBytes = outputBytes(outputRowsAfter)
      - outputBytes(initialRecovery.rows);
    // Retain the independent oracle before any qualification assertion can fail.
    writeFileSync(join(gecArtifacts, `${scenario.runKey}-output-byte-oracle.json`), JSON.stringify({
      scope, initialRecovery, outputRowsAfter, persistedOutputBytes, acceptance: 'unmeasured' }));
    for (const [mode, capture] of [['crash', crash], ['recover', recovered]] as const) {
      const originalRef = join(gecArtifacts, `${scenario.runKey}-${mode}.json`);
      const initialRef = join(gecArtifacts, `${scenario.runKey}-${mode}.initial-keys.json`);
      const initialBytes = readFileSync(initialRef), initial = JSON.parse(initialBytes.toString('utf8'));
      expect(initial).toMatchObject({ kind: 'operation-output-initial-census', scope, mode, runKey: scenario.runKey,
        producerPid: process.pid, complete: true, exclusive: true, keyParameters: [0, 1] });
      expect(initial.initialKeys).toEqual(initial.rows.map((row: { workflow_uuid: string; function_id: number }) =>
        [digest(row.workflow_uuid), digest(String(row.function_id))]));
      expect(capture.initialKeyCensus).toEqual({ scope, sourceRef: initialRef + '@sha256:' + digest(initialBytes),
        complete: true, exclusive: true, keyParameters: [0, 1], initialKeys: initial.initialKeys });
      const processCapture = JSON.parse(readFileSync(originalRef + '.process.json', 'utf8'));
      expect(processCapture).toMatchObject({ complete: true, gaps: [], scope, originalCaptureRef: originalRef,
        accountingScope: 'process-lifetime-and-admissions', acceptance: 'unmeasured',
        terminal: mode === 'crash' ? 'intentional-sigkill' : 'drained-exit',
        journal: capture.retentionJournal,
        values: { durableAdmissions: capture.census.ids.length, dispatchAdmissions: capture.invocations.ids.length,
          storageAdmissions: capture.storage.ids.length } });
      expect(processCapture.values.processWallMs).toBeGreaterThan(0);
      expect(processCapture.populations.invocations.unreturnedIds)
        .toEqual(mode === 'crash' ? capture.invocations.diagnostics.pendingIds : []);
      // Parent termination is not a child drain or a persisted-byte oracle.
      expect(capture.boundary === null).toBe(mode === 'crash');
      expect(capture.census.complete).toBe(mode === 'recover');
    }
    for (const capture of [crash, recovered]) {
      expect(capture.retentionJournal).toMatchObject({ complete: true, error: null });
      expect(capture.retentionJournal.frames).toBe(capture.retention.completed + 1);
      expect(capture.retentionJournal.bytes).toBeGreaterThan(capture.retention.publishedBytes);
      expect(capture.retention).toMatchObject({ scope: 'completed-prior-publications', failed: 0 });
      expect(capture.retention.completed).toBeGreaterThan(0);
      expect(capture.retention.publishedBytes).toBeGreaterThan(0);
      for (const field of ['snapshotMs', 'serializationMs', 'publicationMs', 'maxTotalMs']) {
        expect(Number.isFinite(capture.retention[field]) && capture.retention[field] >= 0).toBe(true);
      }
    }
    const startup = JSON.parse(readFileSync(join(gecArtifacts, `${scenario.runKey}-recover-startup.json`), 'utf8'));
    expect(startup).toMatchObject({ mode: 'recover', runKey: scenario.runKey, status: 0, signal: null, error: null });
    expect(startup.phases).toContainEqual(expect.objectContaining({ phase: 'launch-complete' }));
    const phaseNames = ['capture-admitted', 'workflow-import-start', 'workflow-import-end', 'launch-start', 'launch-end',
      'result-start', 'result-end', 'status-start', 'status-end', 'shutdown-start', 'shutdown-end',
      'effect-client-end-start', 'effect-client-end-end'];
    expect(recovered.phases.map((row: { phase: string }) => row.phase)).toEqual(phaseNames);
    const phaseTimes = recovered.phases.map((row: { monotonicMs: number }) => row.monotonicMs);
    expect(phaseTimes.every((value: number, index: number) => Number.isFinite(value)
      && value >= (index ? phaseTimes[index - 1] : recovered.boundary.monotonicStartMs)
      && value <= recovered.boundary.monotonicEndMs)).toBe(true);
    expect(crash.phases).toContainEqual(expect.objectContaining({ phase: 'launch-end' }));
    expect(crash.phases.some((row: { phase: string }) => row.phase === 'shutdown-end')).toBe(false);
    expect(crash.storage.complete).toBe(false);
    expect(crash.storage.ids.length).toBeGreaterThan(0);
    expect(crash.storage.scope).toEqual(scope);
    expect(new Set(crash.storage.rows.map((row: { sql: { pool: string } }) => row.sql.pool)))
      .toEqual(new Set(['child-dbos-all-clients', 'child-effect-log']));
    expect(recovered.storage.scope).toEqual(scope);
    expect(recovered.storage.complete).toBe(true);
    expect(recovered.storage.ids.length).toBeGreaterThan(0);
    expect(recovered.storage.rows).toHaveLength(recovered.storage.ids.length);
    expect(recovered.sqlObservations.filter((row: { phase: string }) => row.phase === 'admission')
      .map((row: { id: string }) => row.id)).toEqual(recovered.storage.ids);
    expect(recovered.sqlObservations.filter((row: { phase: string }) => row.phase === 'terminal'))
      .toHaveLength(recovered.storage.rows.length);
    for (const row of recovered.storage.rows) expect(recovered.sqlObservations).toContainEqual(expect.objectContaining({
      id: row.id, phase: 'terminal', command: row.sql.command, status: row.sql.status,
      query: expect.any(String), monotonicMs: expect.any(Number),
    }));
    expect(new Set(recovered.storage.rows.map((row: { sql: { pool: string } }) => row.sql.pool)))
      .toEqual(new Set(caseId === 'C6' ? ['child-dbos-all-clients'] : ['child-dbos-all-clients', 'child-effect-log']));
    expect(recovered.storage.diagnostics).toMatchObject({ pending: 0, late: false, captureFailed: false, hooksIntact: true });
    expect(recovered.sdkSourceHashes).toMatchObject({
      systemDatabase: 'de943d85e4414114a6bb01b079051b0e59940a4911cf9e54f05e41f24011b02b',
      databaseUtils: 'deff0db24fad793b10ad21314a8333c2b4398e4c26c25a6cedd8e24fbff54ca4',
      migrationRunner: 'e843709372e77cd6151bf35345ceca0d7307a87182a57c867bfead4fa7d830f5',
    });
    const reviewedReads = recovered.storage.rows.filter((row: { kind: string }) => row.kind === 'read');
    expect(reviewedReads.length).toBeGreaterThan(0);
    for (const queryHash of ['46c5712c7858d59ef557084e295a65cabed886d65beead3a69eba9e3ae26a09f',
      '20ac0ef228483efa83ea286efb05f7b6fbd60addd2bd91d80fdeac8f6dd280ef'])
      expect(reviewedReads).toContainEqual(expect.objectContaining({ persistedBytes: null,
        sql: expect.objectContaining({ queryHash, status: 'ok', nonPersisting: expect.objectContaining({ kind: 'read' }) }) }));
    for (const command of ['BEGIN', 'COMMIT']) expect(recovered.storage.rows)
      .toContainEqual(expect.objectContaining({ kind: 'control', persistedBytes: null,
        sql: expect.objectContaining({ command, status: 'ok', nonPersisting: expect.objectContaining({ kind: 'control' }) }) }));
    const sdkNoops = recovered.storage.rows.filter((row: { sql: { rowOutcome?: { allOrNoneRows: unknown };
      insertOrNoop?: unknown; serializedParameters?: { sourceRef: string } } }) =>
      row.sql.rowOutcome?.allOrNoneRows === 'zero-only' && !row.sql.insertOrNoop
      && row.sql.serializedParameters?.sourceRef.startsWith('source:@dbos-inc/dbos-sdk/'));
    expect(sdkNoops.length).toBeGreaterThan(0);
    expect(sdkNoops.some((row: { persistedBytes: unknown }) => row.persistedBytes === 0)).toBe(true);
    for (const row of sdkNoops) expect(row.persistedBytes)
      .toBe(row.sql.status === 'ok' && row.sql.rowOutcome.affectedRows === 0 ? 0 : null);
    const notificationControls = recovered.storage.rows.filter((row: { sql: { command: string } }) =>
      ['LISTEN', 'NOTIFY'].includes(row.sql.command));
    expect(notificationControls).toHaveLength(4);
    expect(notificationControls.map((row: { sql: { queryHash: string } }) => row.sql.queryHash)).toEqual([
      '2dfb06715dd1ca9db551ee03eed8cf4d1560b086c0adf99d3b543437df32f7d7',
      '832fb87fb98cee7914c921ec44ede3fb437008fd3e8bf4985f5af80e2dfcf6ab',
      '6cb0b99e8615da9b0be254f3b925ad08d748b0dd54ce15532ecc16262111a272',
      '51d3f928cd16813b7a8f257cd05b53f2fe093baa8066900c62203e876c24e538',
    ]);
    for (const row of notificationControls) expect(row).toMatchObject({ kind: 'control', persistedBytes: null,
      sql: { pool: 'child-dbos-all-clients', status: 'ok', nonPersisting: { kind: 'control',
        sourceRef: 'source:@dbos-inc/dbos-sdk/dist/src/system_database.js@de943d85e4414114a6bb01b079051b0e59940a4911cf9e54f05e41f24011b02b#notification-setup' } } });
    const outputSourceRef = 'source:@dbos-inc/dbos-sdk/dist/src/system_database.js@de943d85e4414114a6bb01b079051b0e59940a4911cf9e54f05e41f24011b02b#recordOperationResultInternal';
    const registeredWrites = [...crash.storage.rows, ...recovered.storage.rows]
      .filter((row: { sql: { serializedParameters?: { sourceRef: string } } }) =>
        row.sql.serializedParameters?.sourceRef === outputSourceRef);
    const outputWrites = registeredWrites.filter((row: { sql: { command: string } }) => row.sql.command === 'INSERT');
    const executorWrites = registeredWrites.filter((row: { sql: { command: string } }) => row.sql.command === 'UPDATE');
    expect(outputWrites.length).toBeGreaterThan(0);
    expect(executorWrites.length).toBeGreaterThan(0);
    for (const row of outputWrites) {
      expect(row.kind).toBe('write');
      expect(row.sql.rowOutcome.allOrNoneRows).toBe('zero-only');
      expect(row.sql.serializedParameters.parameterCount).toBe(11);
      expect(row.sql.serializedParameters.values.map((value: { parameter: number }) => value.parameter)).toEqual([2, 3]);
      expect(row.sql.insertOrNoop).toMatchObject({ censusRef: expect.stringContaining('.initial-keys.json@sha256:'),
        censusHash: expect.any(String), keyHash: expect.any(String), prior: expect.stringMatching(/^(present|absent)$/) });
    }
    const recoveredOutputs = recovered.storage.rows.filter((row: { sql: { serializedParameters?: { sourceRef: string; parameterCount: number } } }) =>
      row.sql.serializedParameters?.sourceRef === outputSourceRef && row.sql.serializedParameters.parameterCount === 11);
    expect(recoveredOutputs.length).toBeGreaterThan(0);
    expect(recoveredOutputs.every((row: { persistedBytes: unknown }) => Number.isSafeInteger(row.persistedBytes))).toBe(true);
    // Independent physical-store delta, including unchanged positive upserts;
    // neither the source registration nor the recorder computes this oracle.
    expect(recoveredOutputs.reduce((sum: number, row: { persistedBytes: number }) => sum + row.persistedBytes, 0))
      .toBe(persistedOutputBytes);
    for (const row of executorWrites) {
      expect(row.kind).toBe('write');
      expect(row.sql.rowOutcome.allOrNoneRows).toBe(1);
      expect(row.sql.serializedParameters.parameterCount).toBe(2);
      const [value] = row.sql.serializedParameters.values;
      expect(value.parameter).toBe(0);
      const count = row.sql.rowOutcome.affectedRows;
      expect(row.persistedBytes).toBe(row.sql.status !== 'ok' ? null : count === 0 ? 0 : count === 1 ? value.bytes : null);
    }
    expect(crash.invocations.scope).toEqual(scope);
    expect(crash.invocations.complete).toBe(false);
    expect(crash.invocations.diagnostics).toMatchObject({ pending: 1, late: false, captureFailed: false });
    expect(crash.invocations.diagnostics.admissions.map((row: { tool: string }) => row.tool))
      .toEqual(caseId === 'C3' ? ['items:put', 'items:get'] : ['items:get', caseId === 'C5' ? 'items:put' : 'mail:send']);
    expect(crash.invocations.ids).toHaveLength(2);
    expect(crash.invocations.rows).toHaveLength(1);
    expect(recovered.invocations.scope).toEqual(scope);
    expect(recovered.invocations.complete).toBe(true);
    expect(recovered.invocations.diagnostics).toMatchObject({ pending: 0, pendingIds: [], late: false, captureFailed: false });
    expect(recovered.invocations.rows.map((row: { tool: string }) => row.tool))
      .toEqual(caseId === 'C3' ? ['items:get'] : caseId === 'C5' ? ['items:put'] : []);
    expect(recovered.invocations.ids.length).toBe(recovered.invocations.rows.length);
    const invocationMeasured = measureGroundedEvidence({ scope, boundary: recovered.boundary, invocations: recovered.invocations });
    expect(invocationMeasured.values).toMatchObject({ foregroundLookups: 0, retrievalCalls: caseId === 'C3' ? 1 : 0 });
    // These controls qualify recorder closure and the two exact write shapes
    // only. Other writes and interrupted bytes stay unknown.
    const storageMeasured = measureGroundedEvidence({ scope, boundary: recovered.boundary, storage: recovered.storage });
    expect(storageMeasured.values.storageOperations).toBe(recovered.storage.ids.length);
    expect(storageMeasured.values.storageBytes).toBeNull();
    const measured = measureGroundedEvidence({ scope, boundary: recovered.boundary, durable: recovered.census });
    const actualDispatches = originalCalls.map(row => [row.tool, row.mode]);
    const expectedDispatches = caseId === 'C3' ? [['items:put', 'crash'], ['items:get', 'recover']]
      : caseId === 'C5' ? [['items:get', 'crash'], ['items:put', 'recover']]
        : [['items:get', 'crash'], ['mail:send', 'crash']];
    const replayedTool = caseId === 'C3' ? 'items:put' : 'items:get';
    const dispatchesMatch = JSON.stringify(actualDispatches) === JSON.stringify(expectedDispatches);
    // Preserve the independent DBOS/SQL originals even if schema admission,
    // provider transport or a later model assertion fails.
    writeFileSync(join(gecArtifacts, `${scenario.runKey}-durable-oracle.json`), JSON.stringify({
      acceptance: 'unmeasured', fixturePath, scope, sourceHashes, testHashes, frozen,
      originalCalls, originalSteps, result, measured }));
    let authorityRequest: { observed: boolean; gap: string | null; ref?: string } | null = caseId === 'C3'
      ? { observed: false, gap: 'No resumed consumer authority request was observed.' } : null;
    let consumerPassed: boolean | null = null;
    if (caseId === 'C3' && ['1', 'preflight'].includes(consumerMode ?? '')) {
      const [{ SuTarget }, { buildCatalog }, { listAllProjectedTools }, { askOwnerArgs }] =
        await Promise.all([import('../llm-testing/targets/su'), import('../llm-testing/targets/su-catalog'),
          import('@papercusp/tooldef'), import('../coord-ops/agent-tools')]);
      const ask = listAllProjectedTools().find(tool => tool.expose.mcp?.name === 'coord:ask-owner');
      expect(ask, 'use the original registered authority-request contract').toBeDefined();
      expect(recovered.catalog.map((tool: { name: string }) => tool.name)).toEqual(['items:get', 'items:put']);
      const catalog = buildCatalog([...recovered.catalog,
        { name: 'coord:ask-owner', description: ask!.description, input: ask!.inputSchema }]);
      const catalogSnapshot = { tools: catalog.tools, canonicalBySanitized: [...catalog.canonicalBySanitized] };
      const consumerRef = join(gecArtifacts, `${scenario.runKey}-consumer.json`);
      const question = `Continue durable run ${scenario.runKey}.\nPinned script:\n${scenario.script}\nRecovered current result:\n${JSON.stringify(result)}`;
      // Qualify the real schema/catalog and retained refusal without a provider.
      // This admission control never becomes an observed consumer dispatch.
      expect(askOwnerArgs.parse({ question: 'Authority request schema control' }).timeout_s).toBe(0);
      expect(result.outcome.status).toBe('failed');
      expect(String(result.outcome.error)).toMatch(/not allowed for role worker/);
      if (consumerMode === 'preflight') {
        writeFileSync(consumerRef, JSON.stringify({ kind: 'C3-consumer-preflight', acceptance: 'unmeasured',
          scope, catalog: catalogSnapshot, consumerConfig, question, providerCalls: 0, actionOracle: null }));
      } else {
        const { model, prompt } = consumerConfig!;
        const { isCodexResponsesModel } = await import('../llm-testing/targets/codex-responses-tool-loop');
        expect(isCodexResponsesModel(model), 'C3 requires the maintained observed Responses route').toBe(true);
        const providerTapes: Array<{ id: string; provider: string; raw: string; sha256: string; ref: string }> = [];
        const observed = observeGroundedModelFetch({ scope, sourceRef: consumerRef,
          attemptId: `${caseId}-pre${iteration}`, provider: 'codex', purpose: 'model',
          purposeRef: 'current-source:SuTarget.sendViaCodex', fetchImpl: fetch,
          retainTape: async tape => {
            const ref = `${consumerRef}.provider-${tape.id}.json`;
            writeFileSync(ref, tape.raw);
            expect(readFileSync(ref, 'utf8')).toBe(tape.raw);
            providerTapes.push({ ...tape, ref });
            return ref;
          } });
        const consumerDispatches: Array<{ tool: string; args: unknown; validAuthorityRequest: boolean }> = [];
        const dispatch = observeGroundedToolDispatch({ scope, sourceRef: consumerRef,
          attemptId: `${caseId}-pre${iteration}`, boundary: 'consumer', originRef: 'current-source:SuTarget.dispatchOverride',
          registrations: Object.fromEntries([...catalog.canonicalBySanitized.values()].map(name => [name,
            { purpose: name === 'items:get' ? 'retrieval' as const : 'other' as const,
              purposeRef: `registered-fixture-dispatch:${name}` }])),
          dispatch: async (tool, args) => {
            const request = tool === 'coord:ask-owner' ? askOwnerArgs.safeParse(args) : null;
            const validAuthorityRequest = request?.success === true
              && `${request.data.question}\n${request.data.body ?? ''}`.includes(scenario.revoke!);
            consumerDispatches.push({ tool, args: structuredClone(args), validAuthorityRequest });
            writeFileSync(`${consumerRef}.dispatch.json`, JSON.stringify({ scope, consumerDispatches }));
            // All effects are intercepted before a handler. In particular this
            // must never send a real owner question or retry the revoked write.
            return validAuthorityRequest ? { captured: true, delivered: false, answered: false, answer: null,
              conversation_id: `isolated-authority-${scenario.runKey}` }
              : { ok: false, error: tool === 'items:put' ? String(result.outcome.error)
                : 'Consumer capture permits no new external effect.' };
          } });
        const session = await new SuTarget({ catalog, codexFetch: observed.fetch, loadSystemPrompt: () => prompt }).open({ runId: scope.runId,
          sutModel: model, workspaceMode: 'isolated', transport: 'in-process',
          dispatchOverride: { override: async (tool, args) => ({ content: [{ type: 'text',
            text: JSON.stringify(await dispatch.dispatch(tool, args)) }] }) } });
        const admittedAt = new Date().toISOString(), monotonicStartMs = performance.now();
        let consumerResult: Awaited<ReturnType<typeof session.send>> | undefined, sendFailure: string | null = null;
        try { consumerResult = await session.send({ trigger: 'user_message', messages: [{ role: 'user', content: question }] }); }
        catch (error) { sendFailure = String(error); }
        finally { try { await session.close(); } finally { await observed.drain(); } }
        const input = { scope, models: observed.seal(), invocations: dispatch.seal(), durable: recovered.census,
          boundary: { scope, sourceRef: consumerRef, admittedAt, settledAt: new Date().toISOString(),
            monotonicStartMs, monotonicEndMs: performance.now(), drained: true } };
        authorityRequest = { observed: consumerDispatches[0]?.validAuthorityRequest === true,
          gap: consumerDispatches[0]?.validAuthorityRequest === true ? null : 'First consumer dispatch did not request current authority.',
          ref: consumerRef };
        consumerPassed = dispatchesMatch && result.outcome.status === 'failed' && authorityRequest.observed
          && !consumerDispatches.some(call => call.tool === 'items:put');
        writeFileSync(consumerRef, JSON.stringify({ kind: 'C3-current-source-model-consumer', acceptance: 'unmeasured',
          limitation: 'Private DBOS and intercepted consumer dispatch only; storage, complete cost and serving closure remain unmeasured.',
          scope, sourceHashes, testHashes, catalog: catalogSnapshot, question, model, prompt, providerTapes,
          consumerDispatches, consumerResult: consumerResult ?? null, sendFailure, input,
          measured: measureGroundedEvidence(input), authorityRequest, actionOracle: consumerPassed }));
        // Retain original model failures before checking capture integrity.
        expect(sendFailure).toBeNull();
        expect(consumerResult?.finishReason, consumerResult?.error).toBe('done');
        expect(consumerDispatches.map(call => call.tool)).toEqual(consumerResult?.toolCalls.map(call => call.name));
        expect(input.models.complete).toBe(true);
        expect(input.invocations.complete).toBe(true);
      }
    }
    const actionOracle = { expected: frozen.expected, actualDispatches,
      revokedWriteDenied: caseId === 'C3' ? dispatchesMatch && result.outcome.status === 'failed'
        && /not allowed for role worker/.test(String(result.outcome.error)) : null,
      authorityRequest,
      // C3 also requires a consumer to request current authority. A denial
      // alone cannot certify that frozen conjunction or become a full pass.
      passed: caseId === 'C3' ? consumerPassed : dispatchesMatch
        && result.outcome.status === (caseId === 'C5' ? 'succeeded' : 'needs-reconciliation') };
    // Retain the independent SQL/DBOS oracle before capture or action assertions,
    // including a failed action. Originals must survive fixture cleanup.
    writeFileSync(join(gecArtifacts, `${scenario.runKey}-oracle.json`), JSON.stringify({
      acceptance: 'unmeasured', fixturePath, scope, sourceHashes, testHashes, frozen, originalCalls, originalSteps,
      result, measured, actionOracle,
    }));
    expect(crash.census.complete).toBe(false);
    expect(crash.boundary).toBeNull();
    expect(measureGroundedEvidence({ scope, boundary: null, durable: crash.census }).values.durableSteps).toBeNull();
    expect(recovered.census.complete).toBe(true);
    expect(recovered.census.ids.length).toBeGreaterThan(0);
    expect(recovered.census.rows).toHaveLength(recovered.census.ids.length);
    expect(recovered.census.rows).toContainEqual(expect.objectContaining({ source: 'recorded',
      id: expect.stringContaining(`tool:0:${replayedTool}`) }));
    expect(measured.values.durableSteps).toBe(recovered.census.ids.length);
    expect(measured.values.modelCalls).toBeNull();
    expect(measured.complete).toBe(false);
    if (caseId === 'C3') {
      // The old allowed write replays its recorded result, but it cannot
      // authorize the new logical write after current permission is revoked.
      expect(actualDispatches).toEqual(expectedDispatches);
      expect(result.outcome.status).toBe('failed');
      expect(String(result.outcome.error)).toMatch(/not allowed for role worker/);
    } else if (caseId === 'C5') {
      expect(result.outcome.status).toBe('succeeded');
      expect(originalCalls.map(row => [row.tool, row.mode])).toEqual([['items:get', 'crash'], ['items:put', 'recover']]);
      expect(originalSteps).toContain('tool:1:items:put');
    } else {
      expect(result.outcome.status).toBe('needs-reconciliation');
      expect(originalCalls.map(row => [row.tool, row.mode])).toEqual([['items:get', 'crash'], ['mail:send', 'crash']]);
      expect(result.outcome.reconciliation).toMatchObject({ ordinal: 1, tool: 'mail:send' });
    }
    if (caseId === 'C3') expect(actionOracle.revokedWriteDenied).toBe(true);
    else expect(actionOracle.passed).toBe(true);
  }, 400_000);
});

describe('durable tool orchestration survives real producer death (P-019)', () => {
  it('stops an ambiguous activation publication before a duplicate emit or an unproved ready claim', async () => {
    const scenario = { runKey: key('activation-uncertain'), script: ACTIVATION_QUALITY_PUBLICATION_SCRIPT,
      inputs: { harness: 'h', plan: 'explicit-plan' }, crashTarget: 'scorecards:emit' };
    const { afterCrash, outcome } = await crashThenRecover(scenario);
    expect(afterCrash.map(row => row.tool)).toEqual(['plans:evaluate-spec-quality', 'scorecards:emit']);
    expect(outcome.status).toBe('needs-reconciliation');
    const all = await calls(scenario.runKey);
    expect(all.map(row => row.tool)).toEqual(['plans:evaluate-spec-quality', 'scorecards:emit']);
    // Reconcile against the effect writer's durable receipt before any new run.
    expect(all[1].args).toMatchObject({ targetHive: 'h', terminal: true,
      subject: { ref: 'fixture-spec:explicit-plan' },
      ratings: { exact: { evidence: 'original evaluator evidence' } } });
  }, 400_000);

  it('recovers the recorded exact publication and rechecks current read permission', async () => {
    const scenario = { runKey: key('activation-permission'), script: ACTIVATION_QUALITY_PUBLICATION_SCRIPT,
      inputs: { harness: 'h', plan: 'explicit-plan' }, crashTarget: 'scorecards:get', revoke: 'scorecards:get' };
    const { outcome } = await crashThenRecover(scenario);
    expect(outcome.status).toBe('failed');
    expect(String(outcome.error)).toMatch(/not allowed for role worker/);
    const all = await calls(scenario.runKey);
    expect(all.filter(row => row.tool === 'scorecards:emit')).toHaveLength(1);
    expect(all.filter(row => row.tool === 'scorecards:get')).toHaveLength(1);
    expect(all.every(row => row.mode === 'crash')).toBe(true);
  }, 400_000);
  it('keeps an older equivalent publication separate from an uncertain current attempt', async () => {
    const runKey = key('activation-older-card');
    const olderRun = key('activation-old-equivalent');
    const oldArgs = { targetHive: 'h', rubricRef: 'plan-specification-quality', terminal: true,
      subject: { kind: 'plan', ref: 'fixture-spec:explicit-plan' },
      ratings: { exact: { rating: 'healthy', evidence: 'original evaluator evidence' } } };
    await sql.unsafe('INSERT INTO test_durable.calls (run_key,tool,mode,args) VALUES ($1,$2,$3,$4)',
      [olderRun, 'scorecards:emit', 'historical', JSON.stringify(oldArgs)]);
    const { outcome } = await crashThenRecover({ runKey, script: ACTIVATION_QUALITY_PUBLICATION_SCRIPT,
      inputs: { harness: 'h', plan: 'explicit-plan', expectedSpecSetHash: 'a'.repeat(64) },
      crashTarget: 'scorecards:emit' });
    expect(outcome).toMatchObject({ status: 'needs-reconciliation',
      reconciliation: { tool: 'scorecards:emit' } });
    expect((await calls(runKey)).map(row => row.tool)).toEqual(['plans:evaluate-spec-quality', 'scorecards:emit']);
    expect((await calls(olderRun)).map(row => row.mode)).toEqual(['historical']);
    expect(await stepNames(runKey)).toContain('intent:1:scorecards:emit');
  }, 400_000);

  it('does not retry an unreceipted attempt even when the independent oracle proves no effect', async () => {
    const scenario = { runKey: key('activation-before-effect'), script: ACTIVATION_QUALITY_PUBLICATION_SCRIPT,
      inputs: { harness: 'h', plan: 'explicit-plan' }, crashTarget: 'before:scorecards:emit' };
    const { outcome } = await crashThenRecover(scenario);
    expect(outcome.status).toBe('needs-reconciliation');
    expect((await calls(scenario.runKey)).map(row => row.tool)).toEqual(['plans:evaluate-spec-quality']);
  }, 400_000);

  it('recovers the current exact emission receipt without another emit and retains pending review', async () => {
    const scenario = { runKey: key('activation-exact-receipt'), script: ACTIVATION_QUALITY_PUBLICATION_SCRIPT,
      inputs: { harness: 'h', plan: 'explicit-plan', expectedSpecSetHash: 'a'.repeat(64) }, crashTarget: 'scorecards:get' };
    const { outcome, status } = await crashThenRecover(scenario);
    expect(outcome).toMatchObject({ status: 'succeeded', summary: { status: 'emitted-pending', ready: false,
      issueId: 'EI-quality-' + scenario.runKey, specSetHash: 'a'.repeat(64),
      receipt: { completionReceipt: { status: 'recorded', effectRef: 'EI-quality-' + scenario.runKey } } } });
    expect(status.status).toBe('SUCCESS');
    const emit = (await calls(scenario.runKey)).filter(row => row.tool === 'scorecards:emit');
    expect(emit).toHaveLength(1);
    expect(emit[0].args).toMatchObject({ targetHive: 'h', subject: { ref: 'fixture-spec:explicit-plan' },
      ratings: { exact: { evidence: 'original evaluator evidence' } } });
    expect(await stepNames(scenario.runKey)).toContain('tool:1:scorecards:emit');
  }, 400_000);
  it('code:run returns before its two-minute script completes and recovers the original terminal result (MC-P026-SCRIPT)', async () => {
    const runKey = key('code-two-minute');
    const script = '/*' + 'large script '.repeat(2500) + `*/
      const first = await tools.call('probe:read', { phase: 'before' });
      await tools.call('runtime:sleep', { ms: 120000 });
      const last = await tools.call('probe:after', { phase: 'after' });
      return { first: first.tool, last: last.tool };`;
    const child = runChild('code', { runKey, script, crashTarget: '' });
    expect(child.status, child.stdout + '\n' + child.stderr).toBe(0);
    const line = child.stdout.split('\n').find(row => row.startsWith('DURABLE_CODE_OUTCOME '));
    expect(line, child.stdout).toBeDefined();
    const proof = JSON.parse(line!.slice('DURABLE_CODE_OUTCOME '.length));
    console.info('DURABLE_CODE_OUTCOME ' + JSON.stringify(proof));
    expect(proof.admissionElapsedMs).toBeLessThan(50_000);
    expect(proof.elapsedMs).toBeGreaterThanOrEqual(120_000);
    expect(proof.result).toMatchObject({ ok: true, durableRun: {
      workflowId: proof.workflowId, status: 'SUCCESS', outcome: { status: 'succeeded',
        summary: { first: 'probe:read', last: 'probe:after' } },
    } });
    expect((await calls(runKey)).map(row => row.tool)).toEqual(['probe:read', 'probe:after']);
    expect((await stepNames(runKey)).filter(name => name === 'tool:0:probe:read')).toHaveLength(1);
  }, 300_000);

  it('reuses recorded steps and recorded time, and resumes the pending registered-idempotent write', async () => {
    const scenario: Scenario = {
      runKey: key('resume'),
      crashTarget: 'probe:put',
      script: `const t = await tools.call('runtime:now', {});
        const a = await tools.call('probe:read', { k: 1 });
        await tools.call('runtime:sleep', { ms: 20 });
        const b = await tools.call('probe:put', { k: 1, at: t.epochMs });
        const c = await tools.call('probe:after', { k: 1 });
        return { at: t.epochMs, a: a.tool, b: b.tool, c: c.tool };`,
    };
    const { afterCrash, outcome, status } = await crashThenRecover(scenario);
    expect(afterCrash.map((row) => [row.tool, row.mode])).toEqual([
      ['probe:read', 'crash'],
      ['probe:put', 'crash'],
    ]);

    const all = await calls(scenario.runKey);
    // The recorded read is NOT dispatched again; the pending idempotent write re-executes once;
    // the step after it runs for the first time.
    expect(all.map((row) => [row.tool, row.mode])).toEqual([
      ['probe:read', 'crash'],
      ['probe:put', 'crash'],
      ['probe:put', 'recover'],
      ['probe:after', 'recover'],
    ]);
    // Recorded time is replayed: both attempts of the write saw the SAME runtime:now value.
    const puts = all.filter((row) => row.tool === 'probe:put');
    const firstAt = puts[0]!.args.at;
    expect(typeof firstAt).toBe('number');
    expect(puts[1]!.args.at).toBe(firstAt);
    // The nested idempotency identity is stable across recovery, so a registered-idempotent
    // write dedupes against its first attempt.
    expect(puts[0]!.key).toBeTruthy();
    expect(puts[1]!.key).toBe(puts[0]!.key);

    expect(outcome.status).toBe('succeeded');
    expect(outcome.summary).toEqual({ at: firstAt, a: 'probe:read', b: 'probe:put', c: 'probe:after' });
    expect(status.status).toBe('SUCCESS');
    // One checkpointed DBOS step per nested call — never the whole script as one step.
    const names = await stepNames(scenario.runKey);
    expect(names).toEqual(expect.arrayContaining([
      'runtime:0:runtime:now',
      'tool:1:probe:read',
      'tool:3:probe:put',
      'tool:4:probe:after',
    ]));
    expect(names.filter((name) => name === 'tool:1:probe:read')).toHaveLength(1);
  }, 400_000);

  it('stops an uncertain in-flight write for reconciliation instead of dispatching it again', async () => {
    const scenario: Scenario = {
      runKey: key('uncertain'),
      crashTarget: 'probe:send',
      script: `const a = await tools.call('probe:read', { k: 2 });
        const b = await tools.call('probe:send', { k: 2 });
        const c = await tools.call('probe:after', { k: 2 });
        return { a: a.tool, b: b.tool, c: c.tool };`,
    };
    const { afterCrash, outcome, status } = await crashThenRecover(scenario);
    expect(afterCrash.map((row) => [row.tool, row.mode])).toEqual([
      ['probe:read', 'crash'],
      ['probe:send', 'crash'],
    ]);
    // Neither the uncertain write nor anything after it is dispatched on recovery.
    expect((await calls(scenario.runKey)).map((row) => [row.tool, row.mode])).toEqual([
      ['probe:read', 'crash'],
      ['probe:send', 'crash'],
    ]);
    expect(outcome.status).toBe('needs-reconciliation');
    expect(outcome.reconciliation).toMatchObject({ ordinal: 1, tool: 'probe:send' });
    expect(status.status).toBe('SUCCESS');
    const names = await stepNames(scenario.runKey);
    expect(names).toEqual(expect.arrayContaining(['intent:1:probe:send', 'tool:1:probe:send']));
    expect(names).not.toContain('tool:2:probe:after');
  }, 400_000);

  it('rechecks the caller\'s current allowlist before a recovered live dispatch', async () => {
    const scenario: Scenario = {
      runKey: key('revoked'),
      crashTarget: 'probe:put',
      revoke: 'probe:put',
      script: `const a = await tools.call('probe:read', { k: 3 });
        const b = await tools.call('probe:put', { k: 3 });
        return { a: a.tool, b: b.tool };`,
    };
    const { outcome } = await crashThenRecover(scenario);
    // The revoked write is refused at recovery time: no recovered dispatch happens.
    expect((await calls(scenario.runKey)).map((row) => [row.tool, row.mode])).toEqual([
      ['probe:read', 'crash'],
      ['probe:put', 'crash'],
    ]);
    expect(outcome.status).toBe('failed');
    expect(String(outcome.error)).toMatch(/not allowed for role worker/);
  }, 400_000);
});
