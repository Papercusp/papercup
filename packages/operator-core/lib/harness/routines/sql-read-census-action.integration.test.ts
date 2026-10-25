import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { sqlMiningFixture } from '../../../test/_sql-mining-fixture';
import { runSqlIntentCensus } from './sql-read-census-action';
let f: Awaited<ReturnType<typeof sqlMiningFixture>>;
beforeAll(async () => { f = await sqlMiningFixture(); }, 120_000);
afterAll(async () => { await f?.cleanup(); });
beforeEach(async () => { await f.clear(); });
it('R6-CONTRACT', async () => {
  await f.seed(); await f.seed(); await f.seed();
  expect(await runSqlIntentCensus(f.opts())).toMatchObject({ status: 'ok', rows: 2, more: true });
  expect(await runSqlIntentCensus(f.opts())).toMatchObject({ status: 'ok', rows: 1, more: false, logicalCalls: 3 });
});
it('OUTCOME-P-004', async () => {
  const id = await f.seed();
  expect(await runSqlIntentCensus(f.opts(), { beforeCommit: async () => { throw new Error('persistence failure'); } }))
    .toMatchObject({ status: 'UNKNOWN', stage: 'commit' });
  expect(await runSqlIntentCensus(f.opts())).toMatchObject({ status: 'ok', rows: 1, logicalCalls: 1, cursor: { id } });
  const [stored] = await f.db.adminSql`SELECT count(*)::int AS n FROM harness_shared.sql_intent_operations`;
  expect(stored!.n).toBe(1);
});
it('R17-DURABLE', async () => {
  await f.seed();
  const alert = vi.fn(async () => {
    const [stored] = await f.db.adminSql`SELECT summary FROM harness_shared.sql_intent_history`;
    expect(stored!.summary.logicalCalls).toBe(1); // visible from another connection only AFTER commit
  });
  expect(await runSqlIntentCensus(f.opts(), { alert, beforeCommit: async () => { throw new Error('rollback'); } }))
    .toMatchObject({ status: 'UNKNOWN', stage: 'commit' });
  expect(alert).not.toHaveBeenCalled();
  expect(await runSqlIntentCensus(f.opts(), { alert })).toMatchObject({ status: 'ok' });
  expect(await runSqlIntentCensus(f.opts(), { alert })).toMatchObject({ status: 'ok' });
  expect(alert).toHaveBeenCalledTimes(1);
});
