import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { sqlMiningFixture } from '../test/_sql-mining-fixture';
import { mineSqlCandidateSlice } from './bash-substitution/sql-tool-candidates';
import { readSqlToolCandidateEvidence, readSqlToolCandidateWorklist } from './sql-tool-candidate-worklist';
let f: Awaited<ReturnType<typeof sqlMiningFixture>>;
beforeAll(async () => { f = await sqlMiningFixture(); }, 120_000);
afterAll(async () => { await f?.cleanup(); });
beforeEach(async () => { await f.clear(); });
it('R15 R23 realPG worklist and evidence enforce revoke, restore, unavailable and delete', async () => {
  const ids = [await f.seed(), await f.seed()];
  await mineSqlCandidateSlice(f.opts());
  const opts = { ...f.opts(), authorizeSource: async (_id: string) => true };
  const allowed = await readSqlToolCandidateWorklist(opts, { history: async () => [] });
  expect(allowed.status).toBe('ok'); expect(allowed.candidates).toHaveLength(1);
  const id = allowed.candidates[0]!.candidate.id;
  expect((await readSqlToolCandidateEvidence(opts, id)).examples).toHaveLength(2);
  for (const authorizeSource of [async (source: string) => source !== ids[1],
    async () => { throw new Error('authority unavailable'); }]) {
    expect(await readSqlToolCandidateWorklist({ ...opts, authorizeSource }, { history: async () => [] }))
      .toMatchObject({ status: 'UNKNOWN', candidates: [], population: { candidates: 0 } });
    expect(await readSqlToolCandidateEvidence({ ...opts, authorizeSource }, id))
      .toEqual({ status: 'UNKNOWN', examples: [], evidenceRefs: [], evidenceRefsOmitted: 0 });
  }
  expect((await readSqlToolCandidateWorklist(opts, { history: async () => [] })).candidates).toHaveLength(1);
  await f.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${ids[0]!}::bigint`;
  expect((await readSqlToolCandidateWorklist(opts, { history: async () => [] })).candidates).toEqual([]);
  expect((await readSqlToolCandidateEvidence(opts, id)).examples).toEqual([]);
});
it('OUTCOME-P-008 realPG harness scope excludes candidates and evidence from another harness', async () => {
  await f.seed(); await mineSqlCandidateSlice(f.opts());
  const result = await readSqlToolCandidateWorklist({ ...f.opts({ harnessSlug: 'another-harness' }),
    authorizeSource: async () => true }, { history: async () => [] });
  expect(result).toMatchObject({ status: 'UNKNOWN', candidates: [], snapshots: [] });
  const denied = await readSqlToolCandidateWorklist({ ...f.opts(), authorize: async () => false,
    authorizeSource: async () => true }, { history: async () => [] });
  expect(denied).toEqual(result);
});
