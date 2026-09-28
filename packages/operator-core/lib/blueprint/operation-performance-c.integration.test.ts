/** P-013 workload C fixture: the legacy durable coord-program workflow (control)
 * vs the blueprint execution program submitted through the public operation
 * surface (candidate), in one migrated throwaway org database with an isolated
 * DBOS system schema. Default (no env): admission/invariant smoke. P013_MATRIX=1:
 * the D-016 paired matrix, same env knobs as workload A's rig. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import type { DBOS as DBOSType } from '@dbos-inc/dbos-sdk';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { BlueprintSchema, compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { startDedicatedNativePg, startDedicatedTestPg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { getResourceProfile } from '../resource-profile';
import { runPairedBenchmark, gradePairedBenchmark, P013_PROTOCOL, type BenchmarkArm } from '../../test/_paired-operation-benchmark';
import { projectBlueprintToPg } from './project-to-pg';
import {
  P013C_HARNESS, P013C_PROGRAM_STEPS, P013C_SOURCE, P013C_WORKSPACE, programStepNames, runP013WorkloadC,
  type P013CArm, type P013CSample, type P013CTools,
} from './operation-performance-c-driver';

const fixture = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fixture.sql }),
}));
vi.mock('../workspace-registry', async () => ({
  ...(await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry')),
  activeWorkspaceId: () => 'p013-benchmark-c',
}));
vi.mock('../harness-core', async () => ({
  ...(await vi.importActual<typeof import('../harness-core')>('../harness-core')),
  resolveProject: async (slug: string) => ({ slug, path: `/tmp/${slug}` }),
}));
vi.mock('../hive-federation', async () => ({
  ...(await vi.importActual<typeof import('../hive-federation')>('../hive-federation')),
  potHomeSlugForHarness: async (_workspace: string, slug: string) => slug,
}));

const WS = P013C_WORKSPACE;
const HARNESS = P013C_HARNESS;
interface PgCounters { xactCommit: number; walRecords: number; walBytes: number }
async function readPgCounters(sql: Sql): Promise<PgCounters> {
  const [row] = await sql<Array<PgCounters>>`
    SELECT
      (SELECT xact_commit FROM pg_stat_database WHERE datname = current_database())::float8 AS "xactCommit",
      (SELECT wal_records FROM pg_stat_wal)::float8 AS "walRecords",
      (SELECT wal_bytes FROM pg_stat_wal)::float8 AS "walBytes"`;
  return row;
}

let db: OrgTestDb;
let DBOS: typeof DBOSType | undefined;
let tools: P013CTools;
let dedicatedPg: StartedPostgreSqlContainer | DedicatedNativePg | undefined;
const priorAdminUrl = process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
// P013_DEDICATED_PG=1 → a dedicated Docker container; =native → a dedicated
// native cluster (same as workloads A/D). `native` exists because Docker
// container create on this host hung 2–30 min (WI-10003403).
const dedicatedPgMode = process.env.P013_DEDICATED_PG === 'native'
  ? 'native' : process.env.P013_DEDICATED_PG === '1' ? 'container' : null;
const dedicatedPgRequested = dedicatedPgMode !== null;
const DEDICATED_PG_SETTINGS = { max_connections: '200', dynamic_shared_memory_type: 'mmap' };
// D-024: size the getOrgPg() stand-in pool like production (the resource profile's
// pgPoolMax), not the fixture default of 2; P013_ORG_POOL_MAX=<n> pins it.
const P013_ORG_POOL_MAX = (() => {
  const pinned = Number(process.env.P013_ORG_POOL_MAX);
  return Number.isInteger(pinned) && pinned > 0 ? pinned : getResourceProfile().pgPoolMax;
})();

beforeAll(async () => {
  const startedAt = Date.now();
  const stamp = (step: string) => console.error(`P013C_SETUP step=${step} elapsedMs=${Date.now() - startedAt}`);
  // D-022(c): a cluster owned by this run, so cluster-wide WAL counters belong to the arms.
  if (dedicatedPgMode === 'native') {
    dedicatedPg = await startDedicatedNativePg({ settings: DEDICATED_PG_SETTINGS });
    process.env.PAPERCUSP_TEST_PG_ADMIN_URL = dedicatedPg.getConnectionUri();
    stamp('dedicated-native-pg-started');
  } else if (dedicatedPgMode === 'container') {
    // startDedicatedTestPg: the stock pg_isready healthcheck crash-restarts a
    // dedicated cluster mid-run under load (2026-09-27, see the helper).
    dedicatedPg = await startDedicatedTestPg({
      command: ['postgres', ...Object.entries(DEDICATED_PG_SETTINGS).flatMap(([k, v]) => ['-c', `${k}=${v}`])],
    });
    process.env.PAPERCUSP_TEST_PG_ADMIN_URL = dedicatedPg.getConnectionUri();
    stamp('dedicated-pg-started');
  }
  db = await createOrgTestDb({ adminPoolMax: P013_ORG_POOL_MAX });
  fixture.sql = db.adminSql;
  stamp('org-test-db-ready');
  await db.adminSql`
    INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${WS}, ${HARNESS}, ${Buffer.from([12])}, 'kc-p013c-benchmark', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING`;
  const blueprint = BlueprintSchema.parse(P013C_SOURCE);
  await projectBlueprintToPg(db.adminSql, { workspaceId: WS, harnessSlug: HARNESS, blueprint,
    specification: compileAgentSpecification({ source: P013C_SOURCE }) });
  // D-016/P-024 isolation: DBOS system schema inside the throwaway database;
  // never a live shared queue. The parent's own application version keeps it
  // from dequeuing a cold child's workflow and vice versa.
  ({ DBOS } = await import('@dbos-inc/dbos-sdk'));
  DBOS.setConfig({ name: 'p013-workload-c', systemDatabaseUrl: db.adminDsn,
    systemDatabaseSchemaName: 'dbos', applicationVersion: 'p013c-parent', runAdminServer: false });
  const workflow = await import('../dbos/coord-program-workflow');
  workflow.setCoordProgramBlueprintResolver(async () => blueprint);
  await DBOS.launch();
  stamp('dbos-launched');
  tools = {
    submitOperationTool: (await import('../agent-tools/blueprint/submit-operation')).default,
    operationResultTool: (await import('../agent-tools/blueprint/result-operation')).default,
    workflow,
  };
}, dedicatedPgRequested ? 420_000 : 120_000);

afterAll(async () => {
  if (DBOS) await DBOS.shutdown();
  await db?.cleanup();
  await dedicatedPg?.stop({ timeout: 10_000 });
  if (dedicatedPg) {
    if (priorAdminUrl === undefined) delete process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
    else process.env.PAPERCUSP_TEST_PG_ADMIN_URL = priorAdminUrl;
  }
}, 180_000);

describe('P-013 workload C fixture', () => {
  it('runs the same 4-step gated program on both arms with stable step ids and zero plan rows', async () => {
    const runArm = (arm: P013CArm, index: number) => runP013WorkloadC(db.adminSql, tools, arm, index);
    let sequence = 0;
    const samples: P013CSample[] = [];
    if (process.env.P013_MATRIX === '1') {
      const matrix = matrixShape();
      let childrenInFlight = 0;
      const counterRows: Array<{ arm: P013CArm; sequence: number; overlappingChildren: number } & PgCounters> = [];
      const benchmarkArm = (arm: P013CArm): BenchmarkArm => ({
        warmup: async () => { samples.push(await runArm(arm, sequence++)); },
        run: async () => { const sample = await runArm(arm, sequence++); samples.push(sample); return sample.marks; },
        coldStart: async () => {
          const childSequence = sequence++;
          const before = await readPgCounters(db.adminSql);
          const child = spawn(process.execPath, [
            '--import', 'tsx', fileURLToPath(new URL('./operation-performance-c-child.ts', import.meta.url)),
          ], {
            cwd: process.cwd(),
            env: { ...process.env, P013_COLD_DSN: db.adminDsn, P013_COLD_ARM: arm,
              P013_COLD_SEQUENCE: String(childSequence), PAPERCUSP_WORKSPACE_ID: WS,
              DBOS__VMID: `p013c-${arm}-${childSequence}`,
              HARNESS_ADMIN_DATABASE_URL: db.adminDsn, HARNESS_DATABASE_URL: db.appDsn },
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            signal: AbortSignal.timeout(120_000),
          });
          const overlappingChildren = childrenInFlight++;
          let stderr = '';
          let stage = 'spawned';
          let sample: P013CSample | undefined;
          child.stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4_000); });
          child.on('message', (message: { kind?: string; stage?: string; sample?: P013CSample }) => {
            if (message?.kind === 'p013-stage') stage = message.stage ?? stage;
            if (message?.kind === 'p013-sample') sample = message.sample;
          });
          const exit = new Promise<void>((resolve, reject) => {
            child.once('error', (error) => reject(new Error(`P-013 C cold child ${stage}: ${error.message}; ${stderr}`)));
            // 'close', not 'exit': under load 'exit' can fire before the already-sent p013-sample
            // IPC message is dispatched (the child self-SIGKILLs right after send's callback), so
            // a successful sample read as a failed child. 'close' waits for the IPC channel to drain.
            child.once('close', (code, signal) => code === 0 || (signal === 'SIGKILL' && sample)
              ? resolve()
              : reject(new Error(`P-013 C cold child ${stage} exited ${code}/${signal}: ${stderr}`)));
          });
          const settled = () => { childrenInFlight--; };
          void exit.then(settled, settled);
          return {
            run: async () => {
              await exit;
              expect(sample?.arm).toBe(arm);
              const after = await readPgCounters(db.adminSql);
              counterRows.push({ arm, sequence: childSequence, overlappingChildren,
                xactCommit: after.xactCommit - before.xactCommit - 1,
                walRecords: after.walRecords - before.walRecords,
                walBytes: after.walBytes - before.walBytes });
              samples.push(sample!);
              return sample!.marks;
            },
            close: async () => { if (!child.killed && child.exitCode === null) child.kill(); await exit; },
          };
        },
      });
      const trials = await runPairedBenchmark({ control: benchmarkArm('control'),
        candidate: benchmarkArm('candidate') }, matrix);
      expect(trials).toHaveLength(2 * matrix.repetitions * matrix.modes.length * matrix.concurrencies.length);
      // Grade in-test only for a full-protocol run; a split run (one repetition per
      // process, via P013_REPETITION_OFFSET) is graded after its reps are aggregated.
      const complete = matrix.modes.length === 2 && matrix.concurrencies.length === 2 &&
        matrix.repetitions === P013_PROTOCOL.repetitions && (matrix.repetitionOffset ?? 0) === 0;
      console.info('P-013 workload C per-sample persistence counters', JSON.stringify({
        cluster: dedicatedPg ? 'dedicated' : 'shared', rows: counterRows }));
      console.info(`P-013 workload C ${matrix.modes.join('+')} trials`, JSON.stringify({
        ...matrix, cluster: dedicatedPg ? 'dedicated' : 'shared', orgPoolMax: P013_ORG_POOL_MAX, trials,
        grade: complete ? gradePairedBenchmark('C', trials) : null }));
    } else {
      for (const arm of ['control', 'candidate', 'candidate', 'control'] as const) {
        samples.push(await runArm(arm, sequence++));
      }
      console.info('P-013 workload C smoke; no grade', JSON.stringify(samples.map(({ arm, marks, stepProfile }) => ({
        arm, totalMs: marks.businessEvent - marks.ingress, dispatchMs: marks.dispatched - marks.accepted,
        acceptMs: marks.accepted - marks.ingress, terminalMs: marks.terminal - marks.dispatched,
        eventMs: marks.businessEvent - marks.terminal, stepProfile }))));
    }
    // Stable step ids on both arms, across every sample (and so across replays).
    for (const sample of samples) expect(sample.stepNames).toEqual([...P013C_PROGRAM_STEPS]);
    // No duplicated step effects: each program step recorded exactly once per workflow.
    const dup = await db.adminSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM (
        SELECT workflow_uuid, function_name FROM dbos.operation_outputs
         WHERE workflow_uuid LIKE 'coord-program:%' GROUP BY 1, 2 HAVING count(*) > 1) d`;
    expect(dup[0]!.n).toBe(0);
    const stepRows = await db.adminSql<Array<{ name: string }>>`
      SELECT function_name AS name FROM dbos.operation_outputs WHERE workflow_uuid LIKE 'coord-program:%'`;
    expect(programStepNames(stepRows)).toHaveLength(samples.length * P013C_PROGRAM_STEPS.length);
    const candidates = samples.filter((sample) => sample.arm === 'candidate').length;
    const [{ items, plans, runs }] = await db.adminSql<Array<{ items: number; plans: number; runs: number }>>`
      SELECT
        (SELECT count(*)::int FROM harness_shared.work_items
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND status = 'done') AS items,
        (SELECT count(*)::int FROM harness_shared.harness_plans
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}) AS plans,
        (SELECT count(*)::int FROM harness_shared.plan_runs
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}) AS runs`;
    expect({ items, plans, runs }).toEqual({ items: candidates, plans: 0, runs: 0 });
  }, budgetMs());
});

function matrixShape() {
  const count = (name: string, fallback: number, min: number) => {
    const value = Number(process.env[name] ?? String(fallback));
    if (!Number.isInteger(value) || value < min) throw new Error(`P-013 ${name} must be an integer >= ${min}`);
    return value;
  };
  const list = <T extends string>(name: string, fallback: string, allowed: readonly T[]): T[] => {
    const values = (process.env[name] ?? fallback).split(',').map((value) => value.trim()).filter(Boolean);
    if (values.length === 0 || values.some((value) => !allowed.includes(value as T))) {
      throw new Error(`P-013 ${name} must be a comma list of ${allowed.join('|')}`);
    }
    return values as T[];
  };
  return {
    repetitions: count('P013_REPETITIONS', 1, 1),
    repetitionOffset: count('P013_REPETITION_OFFSET', 0, 0),
    coldSamples: count('P013_COLD_SAMPLES', 1, 1),
    warmSamples: count('P013_WARM_SAMPLES', 1, 1),
    warmups: count('P013_WARMUPS', 0, 0),
    modes: list('P013_MODES', 'warm,cold', ['warm', 'cold'] as const),
    concurrencies: list('P013_CONCURRENCIES', '1', ['1', '8'] as const).map(Number) as Array<1 | 8>,
  };
}

function budgetMs(): number {
  if (process.env.P013_MATRIX !== '1') return 180_000;
  const m = matrixShape();
  const per = (m.modes.includes('cold') ? m.repetitions * m.coldSamples * 60_000 : 0) +
    (m.modes.includes('warm') ? m.repetitions * m.warmSamples * 5_000 : 0) + m.warmups * 5_000;
  return Math.min(115 * 60_000, Math.max(180_000, 2 * m.concurrencies.length * per + 120_000));
}
