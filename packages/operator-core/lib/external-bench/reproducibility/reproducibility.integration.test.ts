/**
 * Integration tests for the reproducibility harness (BRIEF 8 / P-010) against a
 * real (testcontainer) Postgres: migration 291 applies, emitRollout writes the
 * run_result + rollout pair, the prereg firewall refuses orphan rows, re-emit is
 * idempotent, the store maps rows → P-011's TaskRunResult, cost is DERIVED via
 * priceRun, and the emitFromAttempt infra-failure path nulls `resolved`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { substrateSignalRates, type CoordEvent, type FleetRunSummary } from '@papercusp/bench-metrics';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import type { OrgSql } from './db';
import { preregister, computePreregHash } from './prereg';
import { emitRollout, emitFromAttempt } from './emit';
import { listRunResults, listSuites, getRollout, getPrereg } from './store';
import { emitFleetRun, fleetRunIdFor, listFleetRuns, getCoordTrace } from './fleet';
import { exportRunBundle } from './export';
import type { EmitRolloutInput } from './schema';
import type { ArmAttempt, BenchTask, GradeResult } from '../types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../../libs/papercusp/libs/db/sql');
// 302 adds benchmark_run_result.score (standalone ALTER, no dep on 296) — emitRollout
// now writes it, so the fresh-container schema must include it or the test errors with
// `column "score" of relation "benchmark_run_result" does not exist`.
const MIGRATIONS = [
  '291-benchmark-reproducibility.sql',
  '292-benchmark-hive-layer.sql',
  '302-bench-run-score.sql',
];
const WS = 'bench-repro-test-ws';
const RUN = 'run-pilot-1';

/** Read a migration, stripping GRANTs (roles absent) + psql meta + tx wrappers. */
function migrationSql(file: string): string {
  return readFileSync(resolve(SQL_DIR, file), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l) && !/\bGRANT\b/.test(l) && !/^\s*(BEGIN|COMMIT);\s*$/.test(l))
    .join('\n');
}

let db: FreshPgDb;
let sql: OrgSql;
let repoRoot: string;

const baseConfig = {
  arms: ['papercusp', 'baseline-a-ablation', 'baseline-b-native', 'baseline-c-bestofn'],
  suites: ['swe-bench-pro'],
  seeds: 3,
  model: 'claude-opus-4-8[1m]',
  budgetTokens: 2_000_000,
  graderFamily: 'swe-bench-pro',
  graderVersion: 'sweap-2026-06',
};

function input(overrides: Partial<EmitRolloutInput> & { preregHash: string }): EmitRolloutInput {
  return {
    runId: RUN,
    suite: 'swe-bench-pro',
    taskId: 'instance_astropy__astropy-12345',
    arm: 'papercusp',
    seed: 0,
    modality: 'diff',
    generation: {
      status: 'completed',
      tokensIn: 1_000_000,
      tokensOut: 200_000,
      tokensTotal: 1_200_000,
      wallClockMs: 90_000,
      turns: 12,
      budgetTokens: 2_000_000,
      capped: false,
      modelId: 'claude-opus-4-8[1m]',
      harnessVersion: 'external-bench@1+abc123',
      submission: 'diff --git a/x b/x',
    },
    grading: {
      resolved: true,
      status: 'passed',
      family: 'swe-bench-pro',
      version: 'sweap-2026-06',
      failToPass: [{ test: 't1', passed: true }],
      passToPass: [{ test: 't2', passed: true }],
      rawOutput: '{"resolved": true}',
      structuredOutput: { resolved: true },
    },
    ...overrides,
  };
}

beforeAll(async () => {
  db = await createFreshPgDb('benchrepro');
  sql = db.sql as unknown as OrgSql;
  for (const m of MIGRATIONS) await db.sql.unsafe(migrationSql(m));
  // Superuser bypasses RLS, but disable it so the test is role-agnostic.
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.benchmark_prereg      DISABLE ROW LEVEL SECURITY;
    ALTER TABLE harness_shared.benchmark_rollout     DISABLE ROW LEVEL SECURITY;
    ALTER TABLE harness_shared.benchmark_run_result  DISABLE ROW LEVEL SECURITY;
    ALTER TABLE harness_shared.benchmark_fleet_run   DISABLE ROW LEVEL SECURITY;
    ALTER TABLE harness_shared.benchmark_coord_event DISABLE ROW LEVEL SECURITY;
  `);
  repoRoot = mkdtempSync(join(tmpdir(), 'bench-repro-'));
}, 120_000);

afterAll(async () => {
  if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
  await db?.cleanup();
});

describe('preregister', () => {
  it('writes the config file + a PG row whose hash matches the config', async () => {
    const { preregHash, filePath } = await preregister({
      runId: RUN,
      label: 'pilot',
      suites: ['swe-bench-pro'],
      config: baseConfig,
      sql,
      workspaceId: WS,
      repoRoot,
    });
    expect(preregHash).toBe(computePreregHash(baseConfig));
    expect(filePath).toBe('benchmarks/preregistrations/run-pilot-1.json');

    const onDisk = JSON.parse(readFileSync(join(repoRoot, filePath), 'utf8'));
    expect(onDisk.config).toEqual(baseConfig);
    expect(onDisk.preregHash).toBe(preregHash);

    const row = await getPrereg({ runId: RUN }, { sql, workspaceId: WS });
    expect(row?.preregHash).toBe(preregHash);
    expect(row?.suites).toEqual(['swe-bench-pro']);
  });
});

describe('emitRollout', () => {
  it('refuses a row with no matching prereg (tune-to-test firewall)', async () => {
    await expect(
      emitRollout(input({ preregHash: 'deadbeef-not-registered' }), { sql, workspaceId: WS }),
    ).rejects.toThrow(/no benchmark_prereg/);
  });

  it('writes the run_result + rollout, derives cost via priceRun, maps to TaskRunResult', async () => {
    const preregHash = computePreregHash(baseConfig);
    const { rolloutId } = await emitRollout(input({ preregHash }), { sql, workspaceId: WS });
    expect(rolloutId).toMatch(/^[0-9a-f]{64}$/);

    const rows = await listRunResults({ runId: RUN, sql, workspaceId: WS });
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.arm).toBe('papercusp');
    expect(r.resolved).toBe(true);
    expect(r.graderStatus).toBe('passed');
    expect(r.generationStatus).toBe('completed');
    expect(r.tokensTotal).toBe(1_200_000);
    // opus 4.8 = $5/Mtok in, $25/Mtok out → 1M*5/1M + 200k*25/1M = 5 + 5 = 10.
    expect(r.costUsd).toBeCloseTo(10, 6);
    expect(r.priceTableVersion).toBe('price-table-v1');
    expect(r.budgetTokens).toBe(2_000_000);
    expect(r.capped).toBe(false);
    expect(r.preregHash).toBe(preregHash);
    expect(r.failToPass).toEqual([{ test: 't1', passed: true }]);

    const rollout = await getRollout(rolloutId, { sql, workspaceId: WS });
    expect(rollout?.rawGraderOutput).toBe('{"resolved": true}');
    expect(rollout?.submission).toBe('diff --git a/x b/x');
  });

  it('is idempotent on re-emit of the same (run, task, arm, seed)', async () => {
    const preregHash = computePreregHash(baseConfig);
    await emitRollout(input({ preregHash, grading: { ...input({ preregHash }).grading, resolved: false, status: 'failed' } }), {
      sql,
      workspaceId: WS,
    });
    const rows = await listRunResults({ runId: RUN, suite: 'swe-bench-pro', sql, workspaceId: WS });
    // still ONE row for this attempt — the re-emit UPSERTed, not duplicated.
    expect(rows.filter((r) => r.taskId === 'instance_astropy__astropy-12345' && r.seed === 0)).toHaveLength(1);
    expect(rows.find((r) => r.seed === 0)?.resolved).toBe(false);
  });
});

describe('emitFromAttempt — infra failure nulls resolved (METR discipline)', () => {
  it('a generation error → resolved null, generationStatus error, graderStatus error', async () => {
    const preregHash = computePreregHash(baseConfig);
    const task: BenchTask = {
      benchmark: 'swe-bench-pro',
      instanceId: 'instance_crashed__x-1',
      problemStatement: 'fix it',
      graderMeta: {},
    };
    const attempt: ArmAttempt = {
      arm: 'baseline-a-ablation',
      blueprintId: 'coding-solo',
      instanceId: 'instance_crashed__x-1',
      seed: '1',
      diff: '',
      tokensIn: 50_000,
      tokensOut: 1_000,
      costUsd: 0,
      turns: 2,
      wallClockMs: 5_000,
      trajectoryRef: 'spawn:abc',
      stopReason: 'error',
      generationError: 'harness crashed',
    };
    const grade: GradeResult = {
      instanceId: 'instance_crashed__x-1',
      prefix: '1',
      resolved: false,
      rawGraderOutput: null,
      graderFamily: 'swe-bench-pro',
      graderVersion: 'sweap-2026-06',
    };
    await emitFromAttempt(
      {
        runId: RUN,
        preregHash,
        arm: 'baseline-a-ablation',
        seed: 1,
        task,
        attempt,
        grade,
        modelId: 'claude-opus-4-8[1m]',
        harnessVersion: 'coding-solo@1+abc123',
      },
      { sql, workspaceId: WS },
    );

    const rows = await listRunResults({ runId: RUN, sql, workspaceId: WS });
    const failed = rows.find((r) => r.taskId === 'instance_crashed__x-1');
    expect(failed?.resolved).toBeNull();
    expect(failed?.generationStatus).toBe('error');
    expect(failed?.graderStatus).toBe('error');
  });
});

describe('listSuites', () => {
  it('summarises a suite: runs, attempts, resolved, infra (resolved IS NULL)', async () => {
    const suites = await listSuites({ runId: RUN, sql, workspaceId: WS });
    const s = suites.find((x) => x.suite === 'swe-bench-pro');
    expect(s).toBeTruthy();
    expect(s!.attempts).toBeGreaterThanOrEqual(2);
    // the crashed attempt is infra (resolved NULL) → counted separately, not as a fail.
    expect(s!.infra).toBeGreaterThanOrEqual(1);
  });
});

describe('L2 fleet layer — fleet run + coordination trace (MAST)', () => {
  const summary: FleetRunSummary = {
    runId: RUN,
    suite: 'swe-bench-pro',
    arm: 'hive',
    tasks: 5,
    resolved: 4,
    wallClockMs: 120_000,
    costUsd: 12.5,
    tokensTotal: 3_000_000,
    tasksZeroHumanGate: 5,
    peakConcurrency: 4,
  };
  const coordEvents: CoordEvent[] = [
    { kind: 'spawn', agent: 'queen' },
    { kind: 'placement', agent: 'queen', taskId: 't1' },
    { kind: 'claim', agent: 'bee-1', taskId: 't1' },
    { kind: 'complete', agent: 'bee-1', taskId: 't1' },
    { kind: 'duplicate_completion', agent: 'bee-2', taskId: 't1', detail: 'two bees finished t1' },
    { kind: 'orphaned_claim', agent: 'bee-3', taskId: 't2' },
  ];

  it('emitFleetRun persists the summary + trace; reads map to FleetRunSummary + CoordTrace', async () => {
    const preregHash = computePreregHash(baseConfig);
    const { fleetRunId } = await emitFleetRun(
      {
        summary,
        preregHash,
        backlogId: 'backlog-A',
        seed: 0,
        modelId: 'claude-opus-4-8[1m]',
        harnessVersion: 'hive@1+abc123',
        coordEvents,
      },
      { sql, workspaceId: WS },
    );
    expect(fleetRunId).toBe(fleetRunIdFor(RUN, 'swe-bench-pro', 'backlog-A', 'hive', 0));

    const fleets = await listFleetRuns({ runId: RUN, sql, workspaceId: WS });
    const hive = fleets.find((f) => f.arm === 'hive');
    expect(hive).toMatchObject({ tasks: 5, resolved: 4, tasksZeroHumanGate: 5, tokensTotal: 3_000_000 });
    expect(hive!.costUsd).toBeCloseTo(12.5, 6);

    const trace = await getCoordTrace(fleetRunId, { sql, workspaceId: WS });
    expect(trace?.arm).toBe('hive');
    expect(trace?.events).toHaveLength(6);
    expect(trace?.agents).toEqual(expect.arrayContaining(['queen', 'bee-1', 'bee-2', 'bee-3']));

    // P-026's objective counter reads the trace P-010 captured.
    const rates = substrateSignalRates(trace!.events, summary.tasks);
    expect(rates.counts.duplicate).toBe(1);
    expect(rates.counts.breakdown).toBe(1);
    expect(rates.duplicationRate).toBeCloseTo(1 / 5, 6);
    expect(rates.coordinationBreakdownRate).toBeCloseTo(1 / 5, 6);
  });

  it('an L1 task row carries its fleet_run_id (placement attribution)', async () => {
    const preregHash = computePreregHash(baseConfig);
    const fleetRunId = fleetRunIdFor(RUN, 'swe-bench-pro', 'backlog-A', 'hive', 0);
    const { rolloutId } = await emitRollout(
      input({ preregHash, taskId: 't1', fleetRunId }),
      { sql, workspaceId: WS },
    );
    const linked = await sql<{ fleet_run_id: string | null }[]>`
      SELECT fleet_run_id FROM harness_shared.benchmark_run_result WHERE rollout_id = ${rolloutId}
    `;
    expect(linked[0]?.fleet_run_id).toBe(fleetRunId);
  });
});

describe('exportRunBundle — publishes L1 rollout cards + L2 fleet runs/traces', () => {
  it('writes a manifest + rollout files + fleet files under benchmarks/', async () => {
    const res = await exportRunBundle(RUN, { repoRoot, sql, workspaceId: WS });
    expect(res.count).toBeGreaterThanOrEqual(2);
    expect(res.fleetFiles.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(repoRoot, res.manifestPath))).toBe(true);
    for (const f of [...res.rolloutFiles, ...res.fleetFiles]) {
      expect(existsSync(join(repoRoot, f))).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(join(repoRoot, res.manifestPath), 'utf8'));
    expect(manifest.runId).toBe(RUN);
    expect(manifest.fleetArms).toContain('hive');
    expect(manifest.preregHash).toBe(computePreregHash(baseConfig));
  });
});
