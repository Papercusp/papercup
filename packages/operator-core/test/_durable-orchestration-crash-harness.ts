/** Shared real-process DBOS fixture. No live tool handler or mail transport is installed. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';
import type postgres from 'postgres';
import type { GroundedMeasurementInput, GroundedMeasurementScope } from '../lib/grounded-evidence-measurement';
import { captureDurableProcessBoundary, materializeDurableCapture } from './_durable-orchestration-capture';

export interface DurableCrashScenario {
  runKey: string;
  script: string;
  crashTarget: string;
  revoke?: string;
  inputs?: Record<string, string>;
  gecScope?: GroundedMeasurementScope;
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
  async function retainInitialKeys(mode: 'crash' | 'recover', scenario: DurableCrashScenario) {
    if (!scenario.gecScope) return;
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
    if (scenario.gecScope) materializeDurableCapture(join(config.artifacts, `${scenario.runKey}-${mode}.json`));
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
    await retainInitialKeys('crash', scenario);
    const crashed = runChild('crash', scenario);
    expect(crashed.signal, 'crash child stdout: ' + crashed.stdout + '\nstderr: ' + crashed.stderr).toBe('SIGKILL');
    const afterCrash = await calls(scenario.runKey);
    await retainInitialKeys('recover', scenario);
    const recovered = runChild('recover', scenario);
    expect(recovered.status, 'recovery stdout: ' + recovered.stdout + '\nstderr: ' + recovered.stderr).toBe(0);
    const line = recovered.stdout.split('\n').find(candidate => candidate.startsWith('DURABLE_OUTCOME '));
    expect(line, 'recovery stdout: ' + recovered.stdout).toBeDefined();
    const parsed = JSON.parse(line!.slice('DURABLE_OUTCOME '.length)) as {
      outcome: Record<string, unknown>; status: { status: string; steps: Array<{ name: string }> };
    };
    return { afterCrash, ...parsed };
  }
  async function groundedStage(caseId: 'C3' | 'C5' | 'C6', scope: GroundedMeasurementScope) {
    const scenario: DurableCrashScenario = { runKey: `${scope.runId}-${caseId}-${scope.iteration}`, gecScope: scope,
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
