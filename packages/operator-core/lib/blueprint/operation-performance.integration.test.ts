/** P-013 workload A fixture: the canonical direct create path and the public
 * blueprint operation admission path in one migrated throwaway org database.
 * This is the admission/invariant smoke, not a latency grade. The D-016 paired
 * matrix is run separately once the terminal and event probes are wired. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { BlueprintSchema, compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { runPairedBenchmark, type BenchmarkArm } from '../../test/_paired-operation-benchmark';
import { projectBlueprintToPg } from './project-to-pg';
import { P013_HARNESS, P013_WORKSPACE, runP013WorkloadA,
  type P013Arm, type P013Sample } from './operation-performance-driver';

const fixture = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fixture.sql }),
}));
vi.mock('../workspace-registry', async () => ({
  ...(await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry')),
  activeWorkspaceId: () => 'p013-benchmark',
}));
vi.mock('../harness-core', async () => ({
  ...(await vi.importActual<typeof import('../harness-core')>('../harness-core')),
  resolveProject: async (slug: string) => ({ slug, path: `/tmp/${slug}` }),
}));
vi.mock('../hive-federation', async () => ({
  ...(await vi.importActual<typeof import('../hive-federation')>('../hive-federation')),
  potHomeSlugForHarness: async (_workspace: string, slug: string) => slug,
}));

const { default: createWorkItemTool } = await import('../agent-tools/work_items/create');
const { default: claimWorkItemTool } = await import('../agent-tools/work_items/claim');
const { default: completeWorkItemTool } = await import('../agent-tools/work_items/complete');
const { default: getWorkItemTool } = await import('../agent-tools/work_items/get');
const { default: submitOperationTool } = await import('../agent-tools/blueprint/submit-operation');
const { default: operationEventsTool } = await import('../agent-tools/blueprint/events-operation');
const { default: operationResultTool } = await import('../agent-tools/blueprint/result-operation');
const warmTools = {
  createWorkItemTool, claimWorkItemTool, completeWorkItemTool, getWorkItemTool,
  submitOperationTool, operationEventsTool, operationResultTool,
};
const WS = P013_WORKSPACE;
const HARNESS = P013_HARNESS;
type Arm = P013Arm;
const SOURCE = {
  id: 'p013-workload-a', workItem: { kind: 'feature' },
  roles: [{ id: 'worker' }],
  spine: { steps: [{ id: 'open', op: 'coord:thread-open', args: { title: 'P-013' } }] },
  operations: [{
    id: 'direct', version: '1', target: { kind: 'work-item', itemKind: 'feature' },
    execution: { kind: 'agent', role: 'worker' },
    inputSchema: { type: 'object', required: ['value'],
      properties: { value: { type: 'string' } }, additionalProperties: false },
    acceptance: { resultSchema: { type: 'object', required: ['value'],
      properties: { value: { type: 'string' } }, additionalProperties: false } },
  }],
};

let db: OrgTestDb;
beforeAll(async () => {
  db = await createOrgTestDb();
  fixture.sql = db.adminSql;
  await db.adminSql`
    INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${WS}, ${HARNESS}, ${Buffer.from([13])}, 'kc-p013-benchmark', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING
  `;
  await projectBlueprintToPg(db.adminSql, {
    workspaceId: WS, harnessSlug: HARNESS,
    blueprint: BlueprintSchema.parse(SOURCE),
    specification: compileAgentSpecification({ source: SOURCE }),
  });
}, 120_000);
afterAll(async () => db?.cleanup(), 30_000);

describe('P-013 workload A fixture', () => {
  it('creates and completes matching 1 KiB direct items; blueprint arm leaves zero plan rows', async () => {
    const runArm = (arm: Arm, index: number) => runP013WorkloadA(db.adminSql, warmTools, arm, index);
    let sequence = 0;
    if (process.env.P013_COLD_PILOT === '1') {
      // Each cold sample owns a fresh Node process, module graph and PG client.
      // The parent retains the migrated database and checks all terminal rows.
      let coldStarts = 0;
      const benchmarkArm = (arm: Arm): BenchmarkArm => ({
        warmup: async () => { await runArm(arm, sequence++); },
        run: async () => (await runArm(arm, sequence++)).marks,
        coldStart: async () => {
          const child = spawn(process.execPath, [
            '--import', 'tsx', fileURLToPath(new URL('./operation-performance-child.ts', import.meta.url)),
          ], {
            cwd: process.cwd(),
            env: { ...process.env, P013_COLD_DSN: db.adminDsn, P013_COLD_ARM: arm,
              P013_COLD_SEQUENCE: String(sequence++), PAPERCUSP_WORKSPACE_ID: WS,
              HARNESS_ADMIN_DATABASE_URL: db.adminDsn, HARNESS_DATABASE_URL: db.appDsn },
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            signal: AbortSignal.timeout(90_000),
          });
          coldStarts++;
          let stderr = '';
          let stage = 'spawned';
          // stdio[2] is 'pipe', so stderr exists; fail loudly rather than lose diagnostics.
          if (!child.stderr) throw new Error('P-013 cold child spawned without a stderr pipe');
          child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4_000); });
          let sample: P013Sample | undefined;
          const exit = new Promise<void>((resolve, reject) => {
            child.once('error', (error) => reject(new Error(
              `P-013 cold child ${stage}: ${error.message}; stderr: ${stderr}`)));
            child.once('exit', (code, signal) => code === 0 ? resolve()
              : reject(new Error(`P-013 cold child ${stage} exited ${code}/${signal}: ${stderr}`)));
          });
          child.on('message', (message: { kind?: string; stage?: string; sample?: P013Sample }) => {
            if (message?.kind === 'p013-stage') stage = message.stage ?? stage;
            if (message?.kind === 'p013-sample') sample = message.sample;
          });
          return {
            run: async () => {
              await exit;
              expect(sample?.arm).toBe(arm);
              return sample!.marks;
            },
            close: async () => { if (!child.killed && child.exitCode === null) child.kill(); await exit; },
          };
        },
      });
      const trials = await runPairedBenchmark({ control: benchmarkArm('control'),
        candidate: benchmarkArm('candidate') }, {
        warmups: 0, repetitions: 1, warmSamples: 1, coldSamples: 1,
        concurrencies: [1], modes: ['cold'],
      });
      expect(coldStarts).toBe(2);
      expect(trials).toHaveLength(2);
      console.info('P-013 workload A process-isolated cold-boundary pilot; no D-016 grade',
        JSON.stringify(trials.map((trial) => ({ arm: trial.arm, mode: trial.mode,
          totalMs: +trial.phasesMs.total.p50.toFixed(2) }))));
    } else if (process.env.P013_PAIRED_SMOKE === '1') {
      const benchmarkArm = (arm: Arm): BenchmarkArm => ({
        warmup: async () => { await runArm(arm, sequence++); },
        run: async () => (await runArm(arm, sequence++)).marks,
      });
      const trials = await runPairedBenchmark({ control: benchmarkArm('control'),
        candidate: benchmarkArm('candidate') }, {
        warmups: 0, repetitions: 1, warmSamples: 1, coldSamples: 1, concurrencies: [1], modes: ['warm'],
      });
      expect(trials).toHaveLength(2);
      expect(trials.every((trial) => trial.persistence.dbRoundTrips === null &&
        trial.persistence.dbBytes === null && trial.persistence.durableSteps === null)).toBe(true);
      console.info('P-013 workload A warm-only paired-runner instrumentation smoke; no grade',
        JSON.stringify(trials.map((trial) => ({ arm: trial.arm, mode: trial.mode,
          totalMs: +trial.phasesMs.total.p50.toFixed(2) }))));
    } else {
      const pilot = process.env.P013_PILOT === '1';
      const order: Arm[] = pilot
        ? ['control', 'candidate', 'candidate', 'control']
        : ['control', 'candidate'];
      const samples: P013Sample[] = [];
      for (const arm of order) samples.push(await runArm(arm, sequence++));
      if (pilot) {
        console.info('P-013 workload A non-grading API-phase pilot (promoter excluded)', JSON.stringify({
          phases: ['create-or-submit', 'claim', 'complete', 'observe-terminal'],
          samples: samples.map(({ arm, phasesMs, eventLagMs }) => ({
            arm, ms: phasesMs.map((ms) => +ms.toFixed(2)), eventLagMs: +eventLagMs.toFixed(2),
          })),
        }));
      }
    }
    const [{ items, plans, runs }] = await db.adminSql<Array<{ items: number; plans: number; runs: number }>>`
      SELECT
        (SELECT count(*)::int FROM harness_shared.work_items
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}) AS items,
        (SELECT count(*)::int FROM harness_shared.harness_plans
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}) AS plans,
        (SELECT count(*)::int FROM harness_shared.plan_runs
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}) AS runs
    `;
    expect({ items, plans, runs }).toEqual({ items: sequence, plans: 0, runs: 0 });
  }, 180_000);
});
