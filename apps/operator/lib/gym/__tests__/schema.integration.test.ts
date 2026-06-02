/**
 * Live-PG regression sentinel for the harness_gym schema (P-012). The gym schema
 * is gym-PG-resident (D-018) — applied by ensureGymSchema against the dedicated
 * gym database, NOT the auto-applied sql/<NNN> sequence (which targets the live
 * operator DB). Parametrized schema name so the suite isolates on the shared
 * testcontainer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { withTestSchema, teardownTestPg } from '@papercusp/test-config';
import { ensureGymSchema } from '../schema';

let sql: postgres.Sql;
const G = `gym_t_${randomBytes(4).toString('hex')}`;

beforeAll(async () => {
  const handle = await withTestSchema();
  sql = postgres(handle.connectionUri, { max: 4, onnotice: () => {} });
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('ensureGymSchema', () => {
  it('creates the gym schema with all six tables', async () => {
    await ensureGymSchema(sql, G);
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = ${G} ORDER BY table_name`;
    expect(rows.map((r) => r.table_name)).toEqual([
      'gym_cycles',
      'gym_runs',
      'gym_runs_params',
      'gym_scores',
      'gym_tasks',
      'gym_variants',
    ]);
  });

  it('is idempotent — a second apply does not throw', async () => {
    await ensureGymSchema(sql, G);
    await expect(ensureGymSchema(sql, G)).resolves.toBeUndefined();
  });

  it('enforces the task-pool CHECK (the five defined pools only)', async () => {
    await sql.unsafe(
      `INSERT INTO ${G}.gym_tasks (task_id, pool, repo_url, repo_commit, spec, intent)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      ['t-ok', 'dev-anchor', '/r', 'abc1234', 'spec', 'intent'],
    );
    await expect(
      sql.unsafe(
        `INSERT INTO ${G}.gym_tasks (task_id, pool, repo_url, repo_commit, spec, intent)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        ['t-bad', 'bogus-pool', '/r', 'abc1234', 'spec', 'intent'],
      ),
    ).rejects.toThrow();
  });

  it('cascades scores + params when their run is deleted (FK + ON DELETE CASCADE)', async () => {
    await sql.unsafe(`INSERT INTO ${G}.gym_variants (variant_id, label) VALUES ($1,$2)`, ['v1', 'baseline']);
    await sql.unsafe(
      `INSERT INTO ${G}.gym_tasks (task_id, pool, repo_url, repo_commit, spec, intent) VALUES ($1,$2,$3,$4,$5,$6)`,
      ['task-c', 'train', '/r', 'abc1234', 's', 'i'],
    );
    await sql.unsafe(
      `INSERT INTO ${G}.gym_runs (run_id, variant_id, task_id, cycle) VALUES ($1,$2,$3,$4)`,
      ['run-c', 'v1', 'task-c', 0],
    );
    await sql.unsafe(
      `INSERT INTO ${G}.gym_scores (run_id, judge_model, rubric_hash, weights, d1, d2, d3, composite)
       VALUES ($1,$2,$3,'{"d1":0.5}'::jsonb,$4,$5,$6,$7)`,
      ['run-c', 'claude-opus-4-8', 'rh1', 8, 7, 9, 8.1],
    );
    await sql.unsafe(
      `INSERT INTO ${G}.gym_runs_params (run_id, harness_commit, substrate_commit) VALUES ($1,$2,$3)`,
      ['run-c', 'fed1234', 'abc1234'],
    );

    await sql.unsafe(`DELETE FROM ${G}.gym_runs WHERE run_id = $1`, ['run-c']);
    const scores = await sql.unsafe(`SELECT 1 FROM ${G}.gym_scores WHERE run_id = $1`, ['run-c']);
    const params = await sql.unsafe(`SELECT 1 FROM ${G}.gym_runs_params WHERE run_id = $1`, ['run-c']);
    expect(scores).toHaveLength(0);
    expect(params).toHaveLength(0);
  });

  it('allows a run to carry multiple scores under distinct rubric_hash (re-judge-from-cache)', async () => {
    await sql.unsafe(`INSERT INTO ${G}.gym_variants (variant_id, label) VALUES ($1,$2)`, ['v2', 'cand']);
    await sql.unsafe(
      `INSERT INTO ${G}.gym_tasks (task_id, pool, repo_url, repo_commit, spec, intent) VALUES ($1,$2,$3,$4,$5,$6)`,
      ['task-r', 'train', '/r', 'abc1234', 's', 'i'],
    );
    await sql.unsafe(`INSERT INTO ${G}.gym_runs (run_id, variant_id, task_id, cycle) VALUES ($1,$2,$3,$4)`, [
      'run-r', 'v2', 'task-r', 0,
    ]);
    for (const rh of ['rubric-A', 'rubric-B']) {
      await sql.unsafe(
        `INSERT INTO ${G}.gym_scores (run_id, judge_model, rubric_hash, weights, d1, d2, d3, composite)
         VALUES ($1,$2,$3,'{}'::jsonb,$4,$5,$6,$7)`,
        ['run-r', 'claude-opus-4-8', rh, 5, 5, 5, 5],
      );
    }
    const rows = await sql.unsafe(`SELECT rubric_hash FROM ${G}.gym_scores WHERE run_id = $1 ORDER BY rubric_hash`, ['run-r']);
    expect(rows.map((r) => (r as { rubric_hash: string }).rubric_hash)).toEqual(['rubric-A', 'rubric-B']);
  });

  it('rejects an unsafe schema name', async () => {
    await expect(ensureGymSchema(sql, 'bad-name; DROP TABLE x')).rejects.toThrow();
  });
});
