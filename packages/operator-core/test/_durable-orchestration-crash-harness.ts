/** Shared real-process DBOS fixture. No live tool handler or mail transport is installed. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { expect } from 'vitest';
import type postgres from 'postgres';
import pg from 'pg';
import type { GroundedMeasurementInput, GroundedMeasurementScope } from '../lib/grounded-evidence-measurement';
import { captureDurableProcessBoundary, materializeDurableCapture, reviewedDurableServerValues } from './_durable-orchestration-capture';

export interface DurableCrashScenario {
  runKey: string;
  script: string;
  crashTarget: string;
  revoke?: string;
  inputs?: Record<string, string>;
  gecScope?: GroundedMeasurementScope;
  /** Independent measurement only; absence never proves zero writes. */
  retainCommittedRows?: boolean;
}

interface DurableChildCapture {
  census: NonNullable<GroundedMeasurementInput['durable']>;
  storage: NonNullable<GroundedMeasurementInput['storage']>;
  invocations: NonNullable<GroundedMeasurementInput['invocations']>;
  boundary: GroundedMeasurementInput['boundary'];
  catalog: Array<{ name: string; description: string; input: Record<string, unknown> }>;
}

export function createDurableCrashHarness(config: {
  packageRoot: string; dsn: () => string; sql: () => postgres.Sql; artifacts: string; workspaceId?: string;
}) {
  const childPath = resolve(config.packageRoot, 'test/_durable-orchestration-crash-child.ts');
  async function retainServerValueSetup(mode: 'crash' | 'recover', scenario: DurableCrashScenario) {
    const require = createRequire(import.meta.url);
    const sdkDirectory = dirname(require.resolve('@dbos-inc/dbos-sdk'));
    const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const systemDatabase = digest(readFileSync(join(sdkDirectory, 'system_database.js')));
    const serverMessageSourceRef = 'source:pg/lib/client.js@'
      + digest(readFileSync(join(dirname(require.resolve('pg')), 'client.js'))) + '#NoticeResponse+ReadyForQuery';
    const { SystemDatabase } = require(join(sdkDirectory, 'system_database.js')) as {
      SystemDatabase: new (...args: unknown[]) => { init(): Promise<void>; destroy(): Promise<void> } };
    const pool = new pg.Pool({ connectionString: config.dsn(), max: 1 });
    const quiet = () => {};
    const database = new SystemDatabase(config.dsn(), { debug: quiet, info: quiet, warn: quiet, error: quiet }, {},
      1, pool, 'dbos', false);
    try { await database.init(); }
    finally { try { await database.destroy(); } finally { await pool.end(); } }
    const query = "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'dbos' AND table_name IN ('workflow_status', 'operation_outputs', 'application_versions') ORDER BY table_name, ordinal_position";
    const catalog = [...await config.sql().unsafe(query)];
    const columns = Object.fromEntries(['workflow_status', 'operation_outputs', 'application_versions']
      .map(table => [table, catalog.filter(row => row.table_name === table).map(row => String(row.column_name))])) as
      Record<'workflow_status' | 'operation_outputs' | 'application_versions', string[]>;
    const sourceRef = join(config.artifacts, `${scenario.runKey}-${mode}.server-values.json`);
    const fixture = reviewedDurableServerValues({ systemDatabase, serverMessageSourceRef, columns,
      retainCommittedRows: scenario.retainCommittedRows === true,
      marker: digest(JSON.stringify({ scope: scenario.gecScope, mode, runKey: scenario.runKey, pid: process.pid })),
      catalogSourceRef: sourceRef + '#catalog@sha256:' + digest(JSON.stringify(catalog)) });
    if (!fixture) throw new Error('GEC unreviewed installed DBOS server-value writer or protocol');
    for (const statement of fixture.ddl) await config.sql().unsafe(statement);
    writeFileSync(sourceRef, JSON.stringify({ kind: 'dbos-server-value-setup', scope: scenario.gecScope,
      mode, runKey: scenario.runKey, producerPid: process.pid, databaseHash: digest(config.dsn()),
      systemDatabase, serverMessageSourceRef, query, catalog, columns, fixture,
      retainCommittedRows: scenario.retainCommittedRows === true,
      complete: true, exclusive: true }), { flag: 'wx', mode: 0o600 });
  }
  async function retainCommittedRows(mode: 'crash' | 'recover', scenario: DurableCrashScenario,
    child: ReturnType<typeof spawnSync>) {
    if (!scenario.retainCommittedRows) return null;
    const setupPath = join(config.artifacts, `${scenario.runKey}-${mode}.server-values.json`);
    const setupBytes = readFileSync(setupPath);
    const setup = JSON.parse(setupBytes.toString('utf8')) as {
      mode: string; runKey: string; databaseHash: string; retainCommittedRows: boolean;
      fixture: NonNullable<ReturnType<typeof reviewedDurableServerValues>>;
    };
    const enrollment = setup.fixture.committedRows;
    const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    if (setup.mode !== mode || setup.runKey !== scenario.runKey || !setup.retainCommittedRows
      || setup.databaseHash !== digest(config.dsn()) || !enrollment)
      throw new Error('GEC missing matching committed-row enrollment');
    // This connection exists in the parent after the child has exited. Query
    // only this launch's marker; recovery never inherits the crash population.
    const admittedAt = new Date().toISOString();
    const reader = await config.sql().reserve();
    try {
      const [identity] = await reader.unsafe('SELECT pg_backend_pid() AS backend_pid');
      if (!identity || !Number.isSafeInteger(identity.backend_pid) || identity.backend_pid <= 0)
        throw new Error('GEC missing independent receipt reader identity');
      const rows = [...await reader.unsafe(enrollment.query, [enrollment.marker])];
      const sourceRef = join(config.artifacts, `${scenario.runKey}-${mode}.committed-rows.json`);
      writeFileSync(sourceRef, JSON.stringify({ kind: 'dbos-independent-committed-server-values',
        scope: scenario.gecScope, mode, runKey: scenario.runKey, producerPid: process.pid,
        databaseHash: setup.databaseHash, setupSourceRef: setupPath + '@sha256:' + digest(setupBytes),
        admittedAt, settledAt: new Date().toISOString(), readerBackendPid: identity.backend_pid,
        child: { pid: child.pid, status: child.status, signal: child.signal, error: child.error?.message ?? null },
        ...enrollment, parameters: [enrollment.marker], rows,
        // A successful query proves visibility of these rows, not operation,
        // transaction or storage-cost completeness. Missing receipts stay unknown.
        queryComplete: true, operationCensus: 'unmeasured', storageBytes: null,
      }), { flag: 'wx', mode: 0o600 });
      return sourceRef;
    } finally { reader.release(); }
  }
  async function retainInitialKeys(mode: 'crash' | 'recover', scenario: DurableCrashScenario) {
    if (!scenario.gecScope) return;
    // Migrate and install the exclusive fixture before the measured process
    // exists. Bootstrap pools are closed before the child's protocol hooks bind.
    await retainServerValueSetup(mode, scenario);
    const admittedAt = new Date().toISOString();
    const query = 'SELECT workflow_uuid, function_id, output, error FROM dbos.operation_outputs ORDER BY workflow_uuid, function_id';
    // This fixture runs one child at a time against its private database. Read
    // the ENTIRE key population before that child exists, not a post-run subset.
    // First launch may precede DBOS schema creation; retain that measured absence.
    const [relation] = await config.sql().unsafe("SELECT to_regclass('dbos.operation_outputs')::text AS relation");
    if (!relation || (relation.relation !== null && typeof relation.relation !== 'string'))
      throw new Error('GEC missing independent operation-output relation observation');
    const rows = relation?.relation ? [...await config.sql().unsafe(query)] : [];
    if (rows.some(row => typeof row.workflow_uuid !== 'string' || !Number.isSafeInteger(row.function_id)))
      throw new Error('GEC invalid independently read operation-output keys');
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    const sourceRef = join(config.artifacts, `${scenario.runKey}-${mode}.initial-keys.json`);
    writeFileSync(sourceRef, JSON.stringify({ kind: 'operation-output-initial-census',
      scope: scenario.gecScope, mode, runKey: scenario.runKey, producerPid: process.pid,
      admittedAt, settledAt: new Date().toISOString(), relation: relation?.relation ?? null, query, rows,
      complete: true, exclusive: true, keyParameters: [0, 1],
      initialKeys: rows.map(row => [digest(row.workflow_uuid), digest(String(row.function_id))]),
    }), { flag: 'wx', mode: 0o600 });
  }
  function runChild(mode: 'crash' | 'recover' | 'code', scenario: DurableCrashScenario) {
    expect(config.dsn(), 'private DBOS database must be prepared before launching the child').toBeTruthy();
    expect(scenario.runKey, 'durable run key is required').toBeTruthy();
    expect(scenario.script, 'durable script source is required').toBeTruthy();
    const launch = () => spawnSync(process.execPath, ['--import', 'tsx', childPath], {
      cwd: config.packageRoot,
      env: { ...process.env, DURABLE_CRASH_DSN: config.dsn(), DURABLE_CRASH_RUN_KEY: scenario.runKey,
        DURABLE_CRASH_MODE: mode, DURABLE_CRASH_SCRIPT: scenario.script,
        DURABLE_CRASH_WORKSPACE: config.workspaceId ?? 'ws-p019-crash',
        DURABLE_CRASH_INPUTS: JSON.stringify(scenario.inputs ?? {}), DURABLE_CRASH_TARGET: scenario.crashTarget,
        DURABLE_CRASH_REVOKE: mode === 'recover' ? (scenario.revoke ?? '') : '',
        ...(scenario.gecScope ? { DURABLE_CRASH_GEC_SCOPE: JSON.stringify(scenario.gecScope),
          DURABLE_CRASH_GEC_TAPE: join(config.artifacts, `${scenario.runKey}-${mode}.json`),
          DURABLE_CRASH_GEC_SERVER_VALUES: join(config.artifacts, `${scenario.runKey}-${mode}.server-values.json`),
          DURABLE_CRASH_GEC_INITIAL_KEYS: join(config.artifacts, `${scenario.runKey}-${mode}.initial-keys.json`) } : {}),
      }, timeout: mode === 'code' ? 240_000 : 150_000, encoding: 'utf8',
    });
    const child = scenario.gecScope ? captureDurableProcessBoundary(
      join(config.artifacts, `${scenario.runKey}-${mode}.json`), scenario.gecScope, launch).child : launch();
    const prefix = 'DURABLE_DBOS_STARTUP ';
    const startup = (child.stderr ?? '').split('\n').filter(line => line.startsWith(prefix))
      .map(line => JSON.parse(line.slice(prefix.length)));
    // Console output may be suppressed by the test reporter. Keep the exact
    // returned startup events and process outcome beside the original tape.
    if (scenario.gecScope) writeFileSync(join(config.artifacts, `${scenario.runKey}-${mode}-startup.json`),
      JSON.stringify({ mode, runKey: scenario.runKey, phases: startup,
        status: child.status, signal: child.signal, error: child.error?.message ?? null }));
    if (scenario.gecScope) materializeDurableCapture(join(config.artifacts, `${scenario.runKey}-${mode}.json`), child);
    if (startup.length) console.info('DURABLE_DBOS_STARTUP_TRACE ' + JSON.stringify({
      mode, runKey: scenario.runKey, phases: startup,
    }));
    return child;
  }
  async function calls(runKey: string) {
    const rows = await config.sql().unsafe(
      'SELECT tool, mode, args, idempotency_key FROM test_durable.calls WHERE run_key = $1 ORDER BY seq', [runKey]);
    return rows.map(row => ({ tool: String(row.tool), mode: String(row.mode),
      args: JSON.parse(String(row.args)) as Record<string, unknown>, key: row.idempotency_key as string | null }));
  }
  async function stepNames(runKey: string): Promise<string[]> {
    const rows = await config.sql().unsafe(
      'SELECT function_name FROM dbos.operation_outputs WHERE workflow_uuid = $1 ORDER BY function_id',
      [`orchestrate-durable:${config.workspaceId ?? 'ws-p019-crash'}:${runKey}`]);
    return rows.map(row => String(row.function_name));
  }
  async function crashThenRecover(scenario: DurableCrashScenario) {
    if (scenario.retainCommittedRows && !scenario.gecScope)
      throw new Error('GEC committed-row enrollment requires an explicit measurement scope');
    await retainInitialKeys('crash', scenario);
    const crashed = runChild('crash', scenario);
    const crashCommittedRows = await retainCommittedRows('crash', scenario, crashed);
    expect(crashed.signal, 'crash child stdout: ' + crashed.stdout + '\nstderr: ' + crashed.stderr).toBe('SIGKILL');
    const afterCrash = await calls(scenario.runKey);
    await retainInitialKeys('recover', scenario);
    const recovered = runChild('recover', scenario);
    const recoveryCommittedRows = await retainCommittedRows('recover', scenario, recovered);
    expect(recovered.status, 'recovery stdout: ' + recovered.stdout + '\nstderr: ' + recovered.stderr).toBe(0);
    const line = recovered.stdout.split('\n').find(candidate => candidate.startsWith('DURABLE_OUTCOME '));
    expect(line, 'recovery stdout: ' + recovered.stdout).toBeDefined();
    const parsed = JSON.parse(line!.slice('DURABLE_OUTCOME '.length)) as {
      outcome: Record<string, unknown>; status: { status: string; steps: Array<{ name: string }> };
    };
    return { afterCrash, ...parsed, committedRows: { crash: crashCommittedRows, recover: recoveryCommittedRows } };
  }
  async function groundedStage(caseId: 'C3' | 'C5' | 'C6', scope: GroundedMeasurementScope,
    options: Pick<DurableCrashScenario, 'retainCommittedRows'> = {}) {
    const scenario: DurableCrashScenario = { runKey: `${scope.runId}-${caseId}-${scope.iteration}`, gecScope: scope,
      ...options,
      crashTarget: caseId === 'C3' ? 'before:items:get' : caseId === 'C5' ? 'before:items:put' : 'mail:send',
      ...(caseId === 'C3' ? { revoke: 'items:put' } : {}),
      script: caseId === 'C3'
        ? "const historical = await tools.call('items:put', { k: 3 }); await tools.call('items:get', { k: 3 }); return await tools.call('items:put', { k: 4, prior: historical.tool });"
        : caseId === 'C5'
          ? "const a = await tools.call('items:get', { k: 1 }); return await tools.call('items:put', { k: 1, prior: a.tool });"
          : "await tools.call('items:get', { k: 2 }); return await tools.call('mail:send', { k: 2 });" };
    const result = await crashThenRecover(scenario);
    const crash = JSON.parse(readFileSync(join(config.artifacts, `${scenario.runKey}-crash.json`), 'utf8')) as DurableChildCapture;
    const recovered = JSON.parse(readFileSync(join(config.artifacts, `${scenario.runKey}-recover.json`), 'utf8')) as DurableChildCapture;
    const processes = (['crash', 'recover'] as const).map(mode => JSON.parse(readFileSync(
      join(config.artifacts, `${scenario.runKey}-${mode}.json.process.json`), 'utf8')));
    return { caseId, scenario, result, crash, recovered,
      processes,
      originalCalls: await calls(scenario.runKey), originalSteps: await stepNames(scenario.runKey) };
  }
  return { runChild, calls, stepNames, crashThenRecover, groundedStage };
}
