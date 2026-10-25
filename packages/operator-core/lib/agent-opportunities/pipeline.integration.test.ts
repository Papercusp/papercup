import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { sqlMiningFixture } from '../../test/_sql-mining-fixture';
import { mineSqlCandidateSlice } from '../bash-substitution/sql-tool-candidates';
let f: Awaited<ReturnType<typeof sqlMiningFixture>>;
beforeAll(async () => { f = await sqlMiningFixture(); }, 120_000);
afterAll(async () => { await f?.cleanup(); });
beforeEach(async () => { await f.clear(); });
it('R18-UNKNOWN', async () => {
  await f.seed(); await mineSqlCandidateSlice(f.opts());
  const [before] = await f.db.adminSql`SELECT cursor_id::text FROM harness_shared.sql_intent_progress`;
  const result = await mineSqlCandidateSlice(f.opts(), { fetch: async () => { throw new Error('private query detail'); } });
  expect(result).toMatchObject({ status: 'UNKNOWN', stage: 'source', reason: 'dependency-error' });
  const [after] = await f.db.adminSql`SELECT cursor_id::text FROM harness_shared.sql_intent_progress`;
  expect(after).toEqual(before);
  const [failure] = await f.db.adminSql`SELECT stage,status,reason FROM harness_shared.sql_intent_stages WHERE stage='source'`;
  expect(failure).toMatchObject({ status: 'UNKNOWN', reason: 'dependency-error' });
});
it('R20-ISOLATION', async () => {
  let started!: () => void, release!: () => void;
  const pending = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { started = r; });
  const mining = mineSqlCandidateSlice(f.opts(), { fetch: async () => { started(); await pending; throw new Error('failed mining'); } });
  await ready;
  const id = await f.seed(); // canonical recording progresses while the miner is blocked
  expect(id).toMatch(/^\d+$/); release();
  expect(await mining).toMatchObject({ status: 'UNKNOWN', stage: 'source' });
});
it('R25-PASSIVE', async () => {
  await f.seed("SELECT set_config('mining_must_not_run','executed',false)");
  await f.seed('DROP TABLE harness_shared.sql_intent_history');
  expect(await mineSqlCandidateSlice(f.opts())).toMatchObject({ status: 'ok', logicalCalls: 0 });
  const [effect] = await f.db.adminSql`SELECT current_setting('mining_must_not_run',true) AS value,
    to_regclass('harness_shared.sql_intent_history') IS NOT NULL AS history`;
  expect(effect!.value).toBeNull(); expect(effect!.history).toBe(true);
});
