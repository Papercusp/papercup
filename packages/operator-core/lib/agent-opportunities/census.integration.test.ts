import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { sqlMiningFixture } from '../../test/_sql-mining-fixture';
import { mineSqlCandidateSlice } from '../bash-substitution/sql-tool-candidates';
import { runMonitoredCensus } from './census';
import { MONITORED_FAMILIES } from './pipeline';
import { runSqlOpportunityCensus } from '../harness/routines/sql-read-census-action';
let f: Awaited<ReturnType<typeof sqlMiningFixture>>;
beforeAll(async () => {
  f = await sqlMiningFixture();
  const migration = new URL('../../../../libs/papercusp/libs/db/sql/1583-sql-intent-monitored-family-runs.sql', import.meta.url);
  await f.db.adminSql.unsafe(readFileSync(existsSync(migration) ? migration : new URL(migration.href + '.DRAFT'), 'utf8'));
}, 120_000);
afterAll(async () => { await f?.cleanup(); });
beforeEach(async () => {
  await f.clear(); await f.db.adminSql`TRUNCATE harness_shared.sql_intent_runs CASCADE`;
  await f.db.adminSql`DELETE FROM harness_shared.agent_activity`;
});
it('persists exactly five normalized family outcomes from real adapters and preserves unknown source coverage', async () => {
  await f.seed();
  const opts = f.opts({ rowBudget: 100, timeBudgetMs: 30_000 });
  const result = await runMonitoredCensus({ ...opts, routineId: 'canonical-routine', workflowId: 'workflow-one' },
    () => mineSqlCandidateSlice(opts));
  expect(result.families.map(f => f.family)).toEqual(MONITORED_FAMILIES);
  expect(result.families[0]).toMatchObject({ family: 'sql', coverage: 'measured', scanned: 1 });
  expect(result.families.slice(1).every(f => f.coverage === 'UNKNOWN')).toBe(true);
  const rows = await f.db.adminSql`SELECT family,coverage,scanned,diagnostics FROM harness_shared.sql_intent_family_runs
    WHERE run_id=${result.runId}::uuid ORDER BY family`;
  expect(rows).toHaveLength(5);
  expect(rows.filter(r => r.family !== 'native-operation').every(r => r.scanned === 1)).toBe(true);
  const [parent] = await f.db.adminSql`SELECT routine_id,workflow_id,finished_at IS NOT NULL AS finished FROM harness_shared.sql_intent_runs`;
  expect(parent).toMatchObject({ routine_id: 'canonical-routine', workflow_id: 'workflow-one', finished: true });
  expect(JSON.stringify(rows)).not.toMatch(/private-one|SELECT id|su-private-actor/);
  expect(result.coverage.checked).toEqual(['sql']);
  expect(result.coverage.notChecked).toHaveLength(4);
});
it('records failed SQL stage separately and still measures the other four families', async () => {
  await f.seed(); const opts = f.opts({ rowBudget: 100 });
  const result = await runMonitoredCensus(opts, async () => {
    const error = new Error('private query secret'); Object.assign(error, { code: '42P01' }); throw error;
  });
  expect(result.families[0]).toMatchObject({ coverage: 'UNKNOWN', diagnostics: { reason: 'database-42P01' } });
  expect(result.families[1]).toMatchObject({ family: 'search-reformulation', scanned: 1 });
  expect(JSON.stringify(result)).not.toContain('private query secret');
  expect(await f.db.adminSql`SELECT 1 FROM harness_shared.sql_intent_family_runs`).toHaveLength(5);
});
it('denied scope produces unknown stages without exposing evidence and never becomes measured empty demand', async () => {
  await f.seed(); const opts = f.opts({ authorize: async () => false });
  const result = await runMonitoredCensus(opts, () => mineSqlCandidateSlice(opts));
  expect(result.families.every(f => f.coverage === 'UNKNOWN' && f.qualifying === 0)).toBe(true);
  expect(result.coverage.checked).toEqual([]);
  expect(result.coverage.notChecked).toEqual(MONITORED_FAMILIES);
});
it('rejects completed-workflow replay and runtime drift instead of relabeling new evidence with an old build', async () => {
  const opts = { ...f.opts(), workflowId: 'same-workflow' };
  const first = await runMonitoredCensus(opts, () => mineSqlCandidateSlice(opts));
  await expect(runMonitoredCensus(opts, () => mineSqlCandidateSlice(opts))).rejects.toThrow('sql_mining_run_identity_or_replay');
  await f.db.adminSql`UPDATE harness_shared.sql_intent_runs SET finished_at=NULL,runtime_id='other-loaded-process'`;
  await expect(runMonitoredCensus(opts, () => mineSqlCandidateSlice(opts))).rejects.toThrow('sql_mining_run_identity_or_replay');
  expect(await f.db.adminSql`SELECT 1 FROM harness_shared.sql_intent_family_runs WHERE run_id=${first.runId}::uuid`).toHaveLength(5);
});
it('wires the production census facade through SQL intake and all four passive adapters on the same workflow', async () => {
  await f.seed();
  const result = await runSqlOpportunityCensus({ ...f.opts({ rowBudget: 100, timeBudgetMs: 30_000 }),
    routineId: 'production-facade', workflowId: 'production-workflow' });
  expect(result.sql).toMatchObject({ status: 'ok', rows: 1 });
  expect(result.monitored?.families.map(f => f.family)).toEqual(MONITORED_FAMILIES);
  const [parent] = await f.db.adminSql`SELECT routine_id,workflow_id FROM harness_shared.sql_intent_runs`;
  expect(parent).toMatchObject({ routine_id: 'production-facade', workflow_id: 'production-workflow' });
});
it('drains a fixed activity window across equal-timestamp keyset pages before grouping a search chain', async () => {
  for (const query of ['job queue', 'job status', 'job owner']) {
    const id = await f.seed();
    await f.db.adminSql`UPDATE harness_shared.tool_invocations SET tool_name='tools:find',
      args_json=${JSON.stringify({ query })}::jsonb WHERE id=${id}::bigint`;
  }
  const result = await runMonitoredCensus(f.opts({ rowBudget: 1, windowRowBudget: 10, timeBudgetMs: 30_000 }),
    async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }));
  const search = result.families.find(row => row.family === 'search-reformulation')!;
  expect(search).toMatchObject({ scanned: 3, qualifying: 1, coverage: 'UNKNOWN', diagnostics: {
    reviewEligible: false, sourceCoverage: { scanned: 3, denied: 0, pages: 3,
      windowExhausted: true, stop: 'window-exhausted', unmeasuredProviders: ['claude', 'codex', 'omp'] },
  } });
  for (const family of ['result-recovery', 'workaround-funnel']) expect(result.families.find(row => row.family === family))
    .toMatchObject({ scanned: 3, coverage: 'UNKNOWN', diagnostics: { sourceCoverage: { pages: 3, windowExhausted: true } } });
  const [stored] = await f.db.adminSql`SELECT diagnostics FROM harness_shared.sql_intent_family_runs
    WHERE run_id=${result.runId}::uuid AND family='search-reformulation'`;
  expect(stored!.diagnostics.sourceCoverage).toMatchObject({ scanned: 3, pages: 3, windowExhausted: true });
  expect(JSON.stringify(stored)).not.toMatch(/job queue|job status|job owner|su-private-actor/);
});
it('caps activity scans without upgrading a partial window to measured or exposing a raw cursor', async () => {
  for (let i = 0; i < 4; i++) await f.seed();
  const result = await runMonitoredCensus(f.opts({ rowBudget: 1, windowRowBudget: 2, timeBudgetMs: 30_000 }),
    async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }));
  for (const family of ['search-reformulation', 'result-recovery', 'workaround-funnel']) {
    const row = result.families.find(row => row.family === family)!;
    expect(row).toMatchObject({ scanned: 2, coverage: 'truncated', diagnostics: { reviewEligible: false,
      sourceCoverage: { pages: 2, windowExhausted: false, stop: 'row-cap' } } });
    expect(JSON.stringify(row)).not.toContain('2026-10-24T12:00:00.123456Z');
  }
  expect(result.coverage.checked).toEqual([]);
  expect(result.coverage.residue).toContain('search-reformulation:truncated');
});
it('drains native activity pages while retaining earlier provider cells and explicit missing transcripts', async () => {
  for (const provider of ['codex', 'claude']) await f.db.adminSql`INSERT INTO harness_shared.agent_activity
    (workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,detail,status,created_at)
    VALUES ('sql-mining-test','mining-test','su-native-test',${provider},${provider + '-session'},'tool','browser',
      'pre',${provider + '-call'},'{"action":"click","selector":"#private-target"}'::jsonb,'ok',
      '2026-10-24T12:00:00.123456Z'::timestamptz)`;
  const result = await runMonitoredCensus(f.opts({ rowBudget: 1, windowRowBudget: 10, timeBudgetMs: 30_000 }),
    async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }));
  const native = result.families.find(row => row.family === 'native-operation')!;
  expect(native).toMatchObject({ scanned: 2, coverage: 'UNKNOWN', diagnostics: { reviewEligible: false,
    sourceCoverage: { pages: 2, windowExhausted: true, complete: false, matrix: expect.arrayContaining([
      { provider: 'codex', kind: 'browser', source: 'activity', status: 'truncated' },
      { provider: 'claude', kind: 'browser', source: 'activity', status: 'truncated' },
      { provider: 'omp', kind: 'browser', source: 'activity', status: 'missing' },
      { provider: 'codex', kind: 'browser', source: 'transcript', status: 'missing' },
    ]) },
  } });
  expect(JSON.stringify(native)).not.toMatch(/private-target|su-native-test|codex-session|claude-session/);
});
it('keeps existing SQL mining live when the monitored-run persistence dependency is unavailable', async () => {
  await f.seed();
  await f.db.adminSql`ALTER TABLE harness_shared.sql_intent_runs RENAME TO sql_intent_runs_unavailable`;
  try {
    const result = await runSqlOpportunityCensus(f.opts({ rowBudget: 100, timeBudgetMs: 30_000 }));
    expect(result).toMatchObject({ sql: { status: 'ok', rows: 1 }, monitored: null, reason: 'database-42P01' });
    expect(await f.db.adminSql`SELECT 1 FROM harness_shared.sql_intent_history`).toHaveLength(1);
    expect(await f.db.adminSql`SELECT 1 FROM harness_shared.sql_intent_operations`).toHaveLength(1);
  } finally {
    await f.db.adminSql`ALTER TABLE harness_shared.sql_intent_runs_unavailable RENAME TO sql_intent_runs`;
  }
});
