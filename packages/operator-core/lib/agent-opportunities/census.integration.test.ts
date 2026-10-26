import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sqlMiningFixture } from '../../test/_sql-mining-fixture';
import { mineSqlCandidateSlice } from '../bash-substitution/sql-tool-candidates';
import { runMonitoredCensus } from './census';
import { MONITORED_FAMILIES } from './pipeline';
import { runSqlOpportunityCensus } from '../harness/routines/sql-read-census-action';
import { buildScratchUri, safeScratchFilesystemPath } from '../scratch-uri';
import { writeScratchReference } from '../scratch-reference';
let f: Awaited<ReturnType<typeof sqlMiningFixture>>, dir: string, oldRoot: string | undefined;
beforeAll(async () => {
  f = await sqlMiningFixture();
  dir = await mkdtemp(join(tmpdir(), 'monitored-census-'));
  oldRoot = process.env.PAPERCUSP_SCRATCH_ROOT; process.env.PAPERCUSP_SCRATCH_ROOT = dir;
  const migration = new URL('../../../../libs/papercusp/libs/db/sql/1583-sql-intent-monitored-family-runs.sql', import.meta.url);
  await f.db.adminSql.unsafe(readFileSync(existsSync(migration) ? migration : new URL(migration.href + '.DRAFT'), 'utf8'));
}, 120_000);
afterAll(async () => {
  if (oldRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = oldRoot;
  await f?.cleanup(); if (dir) await rm(dir, { recursive: true, force: true });
});
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
  const sqlEvidence = result.families[0]!.diagnostics.candidates as Array<{ id: string; sourceRefs: string[]; operationRefs: string[] }>;
  expect(sqlEvidence).toHaveLength(1);
  expect(sqlEvidence[0]).toMatchObject({ id: expect.stringMatching(/^[a-f0-9]{64}$/),
    sourceRefs: [expect.stringMatching(/^[a-f0-9]{64}$/)], operationRefs: [expect.stringMatching(/^[a-f0-9]{64}$/)] });
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
  expect(stored!.diagnostics.candidates).toEqual([expect.objectContaining({
    id: expect.stringMatching(/^[a-f0-9]{64}$/), sourceRefs: expect.any(Array), operationRefs: expect.any(Array),
    metrics: { logicalDemand: 3, reformulations: 2, fallbacks: 0 }, reviewEligible: false,
  })]);
  expect(stored!.diagnostics.candidates[0].sourceRefs).toHaveLength(3);
  expect(stored!.diagnostics.candidates[0].operationRefs).toHaveLength(3);
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

async function ledgerEvidence(tool: string, args: unknown, body: unknown, at: string,
  status = 'ok', metadata: unknown = {}) {
  const id = await f.seed('unused', at);
  const uri = buildScratchUri({ workspaceId: 'sql-mining-test', toolName: tool, runId: randomUUID(), basename: 'result.spill' });
  writeScratchReference({ filePath: safeScratchFilesystemPath(uri), payload: JSON.stringify(body),
    workspaceId: 'sql-mining-test', ownerId: 'su-private-actor', mediaType: 'application/json', bodyOffsetInPayload: 0 });
  await f.db.adminSql`UPDATE harness_shared.tool_invocations SET tool_name=${tool},args_json=${JSON.stringify(args)}::jsonb,
    status=${status},metadata_json=${JSON.stringify(metadata)}::jsonb,output_ref=${uri} WHERE id=${id}::bigint`;
  return id;
}
it('persists recovery and workaround candidate membership from exact real output sources without private semantics', async () => {
  for (const episode of [0, 1]) {
    const start = Date.parse('2026-10-24T12:00:00Z') + episode * 600_000;
    const at = (offset: number) => new Date(start + offset * 1000).toISOString();
    const uri = `papercusp://scratch/private-recovery-${episode}`;
    await ledgerEvidence('plans:get', { slug: 'private-recovery' }, { ok: true }, at(0), 'ok',
      { spillUri: uri, returnedContextBytes: 6000, spilledBytes: 90000, spillFailed: false });
    await ledgerEvidence('capability:read', { uri }, { ok: true }, at(1));
    await ledgerEvidence('docs:get', { slug: 'private-repair' }, { ok: false, error: 'invalid_args' }, at(10), 'error');
    await ledgerEvidence('docs:get', { slug: 'private-repair', corrected: true }, { ok: true }, at(11));
  }
  // The exposure denominator contributes authority even without a recovery episode.
  await ledgerEvidence('plans:get', { slug: 'private-small-result' }, { ok: true }, '2026-10-24T13:00:00Z');
  const result = await runMonitoredCensus(f.opts({ rowBudget: 1, windowRowBudget: 20, timeBudgetMs: 30_000 }),
    async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }));
  const rows = await f.db.adminSql`SELECT family,diagnostics FROM harness_shared.sql_intent_family_runs
    WHERE run_id=${result.runId}::uuid AND family IN ('result-recovery','workaround-funnel')`;
  for (const row of rows) {
    expect(row.diagnostics.candidates).toHaveLength(1);
    const c = row.diagnostics.candidates[0];
    expect(c).toMatchObject({ id: expect.stringMatching(/^[a-f0-9]{64}$/), reviewEligible: false });
    const contributing = row.family === 'result-recovery' ? 5 : 4;
    expect(c.sourceRefs).toHaveLength(contributing); expect(c.operationRefs).toHaveLength(contributing);
    if (row.family === 'result-recovery') expect(c.metrics.exposure).toBe(3);
    expect([...c.sourceRefs, ...c.operationRefs].every((t: string) => /^[a-f0-9]{64}$/.test(t))).toBe(true);
  }
  expect(JSON.stringify(rows)).not.toMatch(/private-recovery|private-repair|su-private-actor|papercusp:\/\//);
  const firstIds = rows.map(r => [r.family, r.diagnostics.candidates[0].id]).sort();
  const again = await runMonitoredCensus(f.opts({ rowBudget: 2, windowRowBudget: 20, timeBudgetMs: 30_000 }),
    async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }));
  expect(again.families.filter(r => ['result-recovery','workaround-funnel'].includes(r.family))
    .map(r => [r.family, (r.diagnostics.candidates as Array<{ id: string }>)[0]!.id]).sort()).toEqual(firstIds);
  const rotatedOpts = f.opts({ rowBudget: 20, timeBudgetMs: 30_000 });
  rotatedOpts.scope = { ...rotatedOpts.scope, epoch: 'rotated-private-scope' };
  const rotated = await runMonitoredCensus(rotatedOpts, async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }));
  for (const row of rotated.families.filter(r => ['result-recovery','workaround-funnel'].includes(r.family)))
    expect((row.diagnostics.candidates as Array<{ id: string }>)[0]!.id).not.toBe(firstIds.find(([family]) => family === row.family)![1]);
});
it('binds a qualifying SQL candidate to the exact source set and fails closed if that set disappears', async () => {
  for (let i = 0; i < 12; i++) {
    const id = await f.seed(undefined, i < 6 ? '2026-10-23T12:00:00Z' : '2026-10-24T12:00:00Z');
    await f.db.adminSql`UPDATE harness_shared.tool_invocations SET coord_owner_id=${'su-private-agent-' + i % 3}
      WHERE id=${id}::bigint`;
  }
  const opts = f.opts({ rowBudget: 100, timeBudgetMs: 30_000 });
  const first = await runMonitoredCensus(opts, () => mineSqlCandidateSlice(opts));
  expect(first.families[0]).toMatchObject({ qualifying: 1, coverage: 'measured', diagnostics: {
    candidates: [expect.objectContaining({ reviewEligible: true,
      metrics: { successful: 12, error: 0, refused: 0, unknown: 0, verifiedAgents: 3, activeDays: 2 } })],
  } });
  const candidates = first.families[0]!.diagnostics.candidates as Array<{ sourceRefs: string[]; operationRefs: string[] }>;
  expect(candidates[0]!.sourceRefs).toHaveLength(12); expect(candidates[0]!.operationRefs).toHaveLength(12);
  const missing = await runMonitoredCensus(opts, async () => {
    const result = await mineSqlCandidateSlice(opts);
    await f.db.adminSql`DELETE FROM harness_shared.sql_intent_operations`;
    return result;
  });
  expect(missing.families[0]).toMatchObject({ coverage: 'UNKNOWN', qualifying: 0,
    diagnostics: { reviewEligible: false, candidates: [], reason: 'sql_mining_source_missing' } });
  expect(JSON.stringify(first.families[0])).not.toMatch(/private-one|su-private-agent/);
});
it('persists native candidate identities from bound provider transcripts and retains UNKNOWN without settled evidence', async () => {
  const session = randomUUID(), actor = 'su-native-private';
  await f.db.adminSql`INSERT INTO harness_shared.adv_sessions (workspace_id,mode,coord_owner_id,agent,session_id)
    VALUES ('sql-mining-test','console',${actor},'codex',${session})`;
  const lines: unknown[] = [];
  for (const i of [0, 1]) {
    const callId = `private-call-${i}`;
    await f.db.adminSql`INSERT INTO harness_shared.agent_activity
      (workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,detail,status,created_at)
      VALUES ('sql-mining-test','mining-test',${actor},'codex',${session},'tool','exec_command','pre',${callId},
        '{"cmd":"rg private-path src"}'::jsonb,'ok','2026-10-24T12:00:00Z')`;
    lines.push({ timestamp: '2026-10-24T12:00:00Z', type: 'response_item', payload: {
      type: 'function_call', name: 'exec_command', call_id: callId, arguments: '{"cmd":"rg private-path src"}' } },
    { timestamp: '2026-10-24T12:00:01Z', type: 'response_item', payload: {
      type: 'function_call_output', call_id: callId, output: '{"exit_code":0}' } });
  }
  const path = join(dir, 'native.jsonl'); await writeFile(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const opts = f.opts({ rowBudget: 1, timeBudgetMs: 30_000 });
  const result = await runMonitoredCensus(opts, async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }),
    { locateTranscript: async () => path });
  const [row] = await f.db.adminSql`SELECT diagnostics FROM harness_shared.sql_intent_family_runs
    WHERE run_id=${result.runId}::uuid AND family='native-operation'`;
  expect(row!.diagnostics.candidates).toEqual([expect.objectContaining({
    id: expect.stringMatching(/^[a-f0-9]{64}$/), reviewEligible: false,
    metrics: { logicalDemand: 2, successful: 2, unknown: 0 },
  })]);
  expect(row!.diagnostics.candidates[0].sourceRefs).toHaveLength(4);
  expect(row!.diagnostics.candidates[0].operationRefs).toHaveLength(2);
  expect(JSON.stringify(row)).not.toMatch(/private-path|private-call|su-native-private|native.jsonl/);
  await rm(path);
  const missing = await runMonitoredCensus(opts, async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }),
    { locateTranscript: async () => path });
  const unknown = missing.families.find(r => r.family === 'native-operation')!;
  expect(unknown).toMatchObject({ coverage: 'UNKNOWN', diagnostics: { reviewEligible: false,
    candidates: [expect.objectContaining({ reviewEligible: false, metrics: { logicalDemand: 2, successful: 0, unknown: 2 } })] } });
  const evidence = (unknown.diagnostics.candidates as Array<{ sourceRefs: string[] }>)[0]!;
  expect(evidence.sourceRefs).toHaveLength(2);
});
