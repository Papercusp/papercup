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
