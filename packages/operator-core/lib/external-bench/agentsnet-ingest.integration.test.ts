/**
 * Integration test for the AgentsNet ingest (plan benchmark-suite-agentsnet-2026-06-17,
 * P-004) against a real (testcontainer) Postgres: migrations 291/292/302 apply (302 adds
 * the `score` column), ingestAgentsnetResults pre-registers + emits suite='agentsnet' rows,
 * the store maps them back to TaskRunResult carrying the BINARY resolved + CONTINUOUS score,
 * cost is derived via priceRun, and the suite scoreboard counts the binary headline.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import type { OrgSql } from './reproducibility/db';
import { listRunResults, listSuites } from './reproducibility/store';
import { ingestAgentsnetResults } from './agentsnet-ingest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const MIGRATIONS = [
  '291-benchmark-reproducibility.sql',
  '292-benchmark-hive-layer.sql',
  '302-bench-run-score.sql',
];
const WS = 'agentsnet-ingest-test-ws';
const RUN = 'run-agentsnet-1';

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
let resultsDir: string;

function writeResult(name: string, r: Record<string, unknown>) {
  writeFileSync(join(resultsDir, name), JSON.stringify(r));
}

beforeAll(async () => {
  db = await createFreshPgDb('agentsnetingest');
  sql = db.sql as unknown as OrgSql;
  for (const m of MIGRATIONS) await db.sql.unsafe(migrationSql(m));
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.benchmark_prereg      DISABLE ROW LEVEL SECURITY;
    ALTER TABLE harness_shared.benchmark_rollout     DISABLE ROW LEVEL SECURITY;
    ALTER TABLE harness_shared.benchmark_run_result  DISABLE ROW LEVEL SECURITY;
  `);
  repoRoot = mkdtempSync(join(tmpdir(), 'agentsnet-repo-'));
  resultsDir = mkdtempSync(join(tmpdir(), 'agentsnet-results-'));

  // A perfect network (consensus), a partial network (coloring), and a failed run (matching).
  writeResult('r1.json', {
    task: 'consensus', num_nodes: 4, graph_generator: 'ws', graph_index: 0,
    rounds: 3, model_name: 'claude-opus-4-8', score: 1.0, successful: true,
    tokens_in: 38303, tokens_out: 9748,
  });
  writeResult('r2.json', {
    task: 'coloring', num_nodes: 4, graph_generator: 'ws', graph_index: 1,
    rounds: 4, model_name: 'claude-opus-4-8', score: 0.5, successful: true,
    tokens_in: 40000, tokens_out: 12000,
  });
  writeResult('r3.json', {
    task: 'matching', num_nodes: 8, graph_generator: 'ba', graph_index: 2,
    rounds: 5, model_name: 'claude-opus-4-8', score: null, successful: false,
    error_message: 'KeyError', tokens_in: 0, tokens_out: 0,
  });
}, 120_000);

afterAll(async () => {
  if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
  if (resultsDir) rmSync(resultsDir, { recursive: true, force: true });
  await db?.cleanup();
});

describe('ingestAgentsnetResults', () => {
  it('emits suite=agentsnet rows carrying binary resolved + continuous score, derives cost', async () => {
    const res = await ingestAgentsnetResults({
      resultsDir,
      runId: RUN,
      arm: 'baseline-b-native',
      modelId: 'claude-opus-4-8',
      harnessVersion: 'agentsnet@test',
      sql,
      workspaceId: WS,
      repoRoot,
    });
    expect(res.ingested).toBe(3);

    const rows = await listRunResults({ runId: RUN, suite: 'agentsnet', sql, workspaceId: WS });
    expect(rows).toHaveLength(3);
    const byTask = Object.fromEntries(rows.map((r) => [r.taskId, r]));

    const perfect = byTask['agentsnet_ws_4_0_consensus'];
    expect(perfect.suite).toBe('agentsnet');
    expect(perfect.arm).toBe('baseline-b-native');
    expect(perfect.resolved).toBe(true); // binary headline
    expect(perfect.score).toBe(1.0); // continuous
    expect(perfect.graderStatus).toBe('passed');
    expect(perfect.tokensTotal).toBe(38303 + 9748);
    // opus 4.8 = $5/Mtok in, $25/Mtok out → 38303*5/1e6 + 9748*25/1e6 ≈ 0.1915 + 0.2437 = 0.4352
    expect(perfect.costUsd).toBeCloseTo(0.4352, 3);

    const partial = byTask['agentsnet_ws_4_1_coloring'];
    expect(partial.resolved).toBe(false); // partial network is not fully correct
    expect(partial.score).toBeCloseTo(0.5); // but the continuous score is preserved

    const failed = byTask['agentsnet_ba_8_2_matching'];
    expect(failed.resolved).toBeNull(); // infra/failed → excluded from accuracy
    expect(failed.score).toBeNull();
    expect(failed.graderStatus).toBe('error');
  });

  it('the suite scoreboard counts the binary headline (resolved) + infra separately', async () => {
    const suites = await listSuites({ runId: RUN, sql, workspaceId: WS });
    const s = suites.find((x) => x.suite === 'agentsnet');
    expect(s).toBeTruthy();
    expect(s!.attempts).toBe(3);
    expect(s!.resolved).toBe(1); // only the perfect network
    expect(s!.infra).toBe(1); // the failed run (resolved IS NULL)
  });

  it('is idempotent on re-ingest (deterministic rolloutId upserts)', async () => {
    await ingestAgentsnetResults({
      resultsDir, runId: RUN, arm: 'baseline-b-native',
      modelId: 'claude-opus-4-8', harnessVersion: 'agentsnet@test',
      sql, workspaceId: WS, repoRoot,
    });
    const rows = await listRunResults({ runId: RUN, suite: 'agentsnet', sql, workspaceId: WS });
    expect(rows).toHaveLength(3); // still 3 — upserted, not duplicated
  });
});
