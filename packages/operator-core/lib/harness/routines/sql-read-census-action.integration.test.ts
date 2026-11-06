import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { sqlMiningFixture } from '../../../test/_sql-mining-fixture';
import { runSqlIntentCensus, runSqlOpportunityCensus } from './sql-read-census-action';
let f: Awaited<ReturnType<typeof sqlMiningFixture>>;
beforeAll(async () => {
  f = await sqlMiningFixture();
  for (const name of ['1581-sql-intent-source-retention-boundary', '1582-sql-intent-retention-settlement-preserves-coverage',
    '1583-sql-intent-monitored-family-runs']) {
    const migration = new URL(`../../../../../libs/papercusp/libs/db/sql/${name}.sql`, import.meta.url);
    if (name.startsWith('1583') || !existsSync(migration))
      await f.db.adminSql.unsafe(readFileSync(existsSync(migration) ? migration : new URL(migration.href + '.DRAFT'), 'utf8'));
  }
}, 120_000);
afterAll(async () => { await f?.cleanup(); });
beforeEach(async () => {
  await f.clear();
  await f.db.adminSql`TRUNCATE harness_shared.sql_intent_runs CASCADE`;
  await f.db.adminSql`DELETE FROM harness_shared.agent_activity`;
});
it('R8 slow family does not starve other families', async () => {
  for (let i = 0; i < 3; i++) {
    await f.seed(undefined, `2026-10-24T12:00:0${i}.123456Z`);
    await f.db.adminSql`INSERT INTO harness_shared.agent_activity
      (workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,detail,status,created_at)
      VALUES ('sql-mining-test','mining-test','su-private-fairness-agent','codex','private-fairness-session',
        'tool','exec_command','pre',${'private-fairness-call-' + i},'{"cmd":"rg private-fairness-path src"}'::jsonb,
        'ok',${`2026-10-24T12:00:0${i}.123456Z`}::timestamptz)`;
  }
  // SQL's cap bounds the whole finite window; rowBudget is its per-wake slice.
  const opts = f.opts({ rowBudget: 1, windowRowBudget: 3, timeBudgetMs: 1000 });
  let release!: () => void;
  const lateContinuity = new Promise<void>(resolve => { release = resolve; });
  const result = await runSqlOpportunityCensus({ ...opts, routineId: 'system:sql-read-census' }, {
    monitoredReaders: { readContinuity: async ({ family }) => {
      if (family === 'search-reformulation') await lateContinuity;
      return 'unknown';
    } },
  });
  const run = result.monitored!;
  expect(run).toBeDefined();
  expect(result.sql).toMatchObject({ status: 'ok', rows: 1, more: true });
  expect(run.families.find(row => row.family === 'search-reformulation')).toMatchObject({ scanned: 0,
    coverage: 'UNKNOWN', diagnostics: { phase: 'continuity-before', reason: 'sql_mining_time_budget' } });
  for (const family of ['result-recovery', 'workaround-funnel', 'native-operation'])
    expect(run.families.find(row => row.family === family)).toMatchObject({ scanned: 3,
      diagnostics: { backlog: false, sourceCoverage: { windowExhausted: true } } });
  const before = await f.db.adminSql`SELECT family,scanned,diagnostics FROM harness_shared.sql_intent_family_runs
    WHERE run_id=${run.runId}::uuid ORDER BY family`;
  // Late IO must observe cancellation before fetching or publishing a page.
  release();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(await f.db.adminSql`SELECT family,scanned,diagnostics FROM harness_shared.sql_intent_family_runs
    WHERE run_id=${run.runId}::uuid ORDER BY family`).toEqual(before);
  expect(before.find(row => row.family === 'search-reformulation')!.diagnostics).not.toHaveProperty('progress');
  const next = await runSqlOpportunityCensus({ ...opts, timeBudgetMs: 30_000 });
  expect(next.sql.status, JSON.stringify(next.sql)).toBe('ok');
  expect(next.sql).toMatchObject({ status: 'ok', rows: 1, more: true, logicalCalls: 2 });
  for (const family of ['search-reformulation', 'result-recovery', 'workaround-funnel', 'native-operation'])
    expect(next.monitored!.families.find(row => row.family === family)).toMatchObject({ scanned: 3,
      diagnostics: { backlog: false, sourceCoverage: { windowExhausted: true } } });
  const completed = await runSqlOpportunityCensus({ ...opts, timeBudgetMs: 30_000 });
  expect(completed.sql).toMatchObject({ status: 'ok', rows: 1, more: false, logicalCalls: 3 });
  const [history] = await f.db.adminSql`SELECT summary FROM harness_shared.sql_intent_history`;
  expect(history!.summary.logicalCalls).toBe(3);
});
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
it('reviews eligible committed demand once and never reviews a rolled-back slice R5-CONTRACT', async () => {
  for (let i = 0; i < 12; i++) {
    const id = await f.seed('SELECT id FROM jobs', i % 2 ? '2026-10-23T12:00:00Z' : '2026-10-24T12:00:00Z');
    await f.db.adminSql`UPDATE harness_shared.tool_invocations SET coord_owner_id=${'su-agent-' + i % 3}
      WHERE id=${id}::bigint`;
  }
  const review = vi.fn(async (input: Parameters<NonNullable<import('./sql-read-census-action').SqlIntentCensusDeps['review']>>[0]) => {
    const [stored] = await f.db.adminSql`SELECT summary FROM harness_shared.sql_intent_history`;
    expect(stored!.summary.logicalCalls).toBe(12);
    expect(input).toMatchObject({ workspaceId: 'sql-mining-test', harnessSlug: 'mining-test',
      submittedBy: 'system:sql-read-census', candidate: { eligible: true, verifiedAgents: 3 } });
    return { status: 'pending' as const, lifecycleId: 'opaque', editionId: 'edition',
      workItemId: 'EI-1', owner: null, queue: 'agent-review' as const };
  });
  const opts = f.opts({ rowBudget: 100, timeBudgetMs: 30_000 });
  expect(await runSqlIntentCensus(opts, { review, beforeCommit: async () => { throw new Error('rollback'); } }))
    .toMatchObject({ status: 'UNKNOWN', stage: 'commit' });
  expect(review).not.toHaveBeenCalled();
  expect(await runSqlIntentCensus(opts, { review }))
    .toMatchObject({ status: 'ok', reviewIntake: { selected: 1, outsideBatch: 0 } });
  expect(await runSqlIntentCensus(opts, { review })).toMatchObject({ status: 'ok' });
  expect(review).toHaveBeenCalledTimes(1);
});
it('failed review delivery keeps the durable callback pending for retry R5-CONTRACT', async () => {
  for (let i = 0; i < 12; i++) {
    const id = await f.seed('SELECT id FROM jobs', i % 2 ? '2026-10-23T12:00:00Z' : '2026-10-24T12:00:00Z');
    await f.db.adminSql`UPDATE harness_shared.tool_invocations SET coord_owner_id=${'su-agent-' + i % 3}
      WHERE id=${id}::bigint`;
  }
  const opts = f.opts({ rowBudget: 100, timeBudgetMs: 30_000 });
  const review = vi.fn(async () => { throw new Error('review unavailable'); });
  expect(await runSqlIntentCensus(opts, { review })).toMatchObject({ status: 'UNKNOWN', stage: 'alert' });
  const [history] = await f.db.adminSql`SELECT alerted_revision FROM harness_shared.sql_intent_history`;
  expect(history!.alerted_revision).toBeNull();
  expect(await runSqlIntentCensus(opts, { review })).toMatchObject({ status: 'UNKNOWN', stage: 'alert' });
  expect(review).toHaveBeenCalledTimes(2);
});
