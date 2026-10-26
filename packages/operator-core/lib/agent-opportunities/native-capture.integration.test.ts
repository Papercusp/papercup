import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sqlMiningFixture } from '../../test/_sql-mining-fixture';
import { reconcileNativeCapture } from './native-capture';
import { productionOpportunityReaders } from './source-readers';
import type { NativeProvider } from './native-operation';
import { readProductionMonitoredCandidate, runMonitoredCensus } from './census';

let f: Awaited<ReturnType<typeof sqlMiningFixture>>, root: string;
const envKeys = ['PAPERCUSP_SU_CODEX_HOMES_DIR', 'PAPERCUSP_SESSION_CLAUDE_DIR', 'PAPERCUSP_SU_OMP_HOMES_DIR'] as const;
let previous: (string | undefined)[];
const workspaceId = 'sql-mining-test', harnessSlug = 'mining-test', sourceBoundary = 'tool-ledger';
const options = () => ({ workspaceId, harnessSlug, sourceBoundary, client: f.db.adminSql,
  since: new Date(f.now - 1000).toISOString(), until: new Date(f.now).toISOString(), authorize: async () => true });
beforeAll(async () => {
  f = await sqlMiningFixture(); root = await mkdtemp(join(tmpdir(), 'native-capture-'));
  previous = envKeys.map(k => process.env[k]);
  envKeys.forEach((k, i) => { process.env[k] = join(root, String(i)); });
  const migration = new URL('../../../../libs/papercusp/libs/db/sql/1585-native-capture-reconciliation-receipt.sql', import.meta.url);
  await f.db.adminSql.unsafe(readFileSync(existsSync(migration) ? migration : new URL(migration.href + '.DRAFT'), 'utf8'));
  const runs = new URL('../../../../libs/papercusp/libs/db/sql/1583-sql-intent-monitored-family-runs.sql', import.meta.url);
  await f.db.adminSql.unsafe(readFileSync(existsSync(runs) ? runs : new URL(runs.href + '.DRAFT'), 'utf8'));
}, 120_000);
afterAll(async () => {
  envKeys.forEach((k, i) => { if (previous[i] === undefined) delete process.env[k]; else process.env[k] = previous[i]; });
  await f?.cleanup(); if (root) await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await f.clear();
  await f.db.adminSql`DELETE FROM harness_shared.adv_sessions`;
  await f.db.adminSql`DELETE FROM harness_shared.agent_activity`;
  await f.db.adminSql`DELETE FROM harness_shared.session_briefs WHERE workspace_id=${workspaceId}`;
  for (const k of envKeys) await rm(process.env[k]!, { recursive: true, force: true });
});
/** Test-only historical install state; production has no floor override. */
async function installed() {
  expect(await reconcileNativeCapture(options())).toBe('gap');
  await f.db.adminSql`UPDATE harness_shared.sql_intent_progress SET native_capture_from=${options().since}::timestamptz
    WHERE workspace_id=${workspaceId} AND scope_id LIKE 'native:%'`;
}
async function seed(provider: NativeProvider = 'codex', includeBrowser = false) {
  const owner = `su-${randomUUID()}`, current = randomUUID(), predecessor = randomUUID();
  const [adv] = await f.db.adminSql<{ id: string }[]>`INSERT INTO harness_shared.adv_sessions
    (workspace_id,mode,coord_owner_id,agent,session_id,first_seen_at)
    VALUES (${workspaceId},'console',${owner},${provider},${current},${new Date(f.now - 2000).toISOString()}::timestamptz) RETURNING id::text`;
  await f.db.adminSql`INSERT INTO harness_shared.session_briefs (owner_id,workspace_id,harness_slug)
    VALUES (${owner},${workspaceId},${harnessSlug})`;
  const dir = provider === 'codex' ? join(process.env.PAPERCUSP_SU_CODEX_HOMES_DIR!, `session-${adv!.id}`, 'sessions', '2026', '10', '25')
    : provider === 'claude' ? join(process.env.PAPERCUSP_SESSION_CLAUDE_DIR!, owner, 'projects', 'repo')
      : join(process.env.PAPERCUSP_SU_OMP_HOMES_DIR!, `session-${adv!.id}`, 'agent', 'sessions', 'repo');
  await mkdir(dir, { recursive: true });
  const paths: string[] = [];
  for (const session of [predecessor, current]) {
    const timestamp = new Date(f.now - 100).toISOString();
    const header = provider === 'codex' ? { type: 'session_meta', payload: { id: session } }
      : provider === 'omp' ? { type: 'session', id: session } : { type: 'system', sessionId: session };
    const call = provider === 'codex' ? { type: 'response_item', timestamp,
      payload: { type: 'function_call', name: 'exec_command', call_id: `call-${session}`, arguments: '{"cmd":"rg private-source src"}' } }
      : provider === 'claude' ? { type: 'assistant', timestamp, sessionId: session,
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id: `call-${session}`, input: { command: 'rg private-source src' } }] } }
        : { type: 'message', timestamp, message: { role: 'assistant', content: [
          { type: 'toolCall', name: 'bash', id: `call-${session}`, arguments: { command: 'rg private-source src' } }] } };
    const result = provider === 'codex' ? { type: 'response_item', timestamp,
      payload: { type: 'function_call_output', call_id: `call-${session}`, output: '{"exit_code":0}' } }
      : provider === 'claude' ? { type: 'user', timestamp, sessionId: session,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call-${session}`, content: '{"exit_code":0}' }] } }
        : { type: 'message', timestamp, message: { role: 'toolResult', toolCallId: `call-${session}`,
          content: [{ type: 'text', text: '{"exit_code":0}' }] } };
    const path = join(dir, provider === 'codex' ? `rollout-time-${session}.jsonl` : provider === 'omp' ? `time_${session}.jsonl` : `${session}.jsonl`);
    const records: unknown[] = [header, call, result];
    if (includeBrowser) {
      const callId = `browser-${session}`, args = { action: 'click', selector: '#save' }, body = { ok: true };
      if (provider === 'codex') records.push(
        { type: 'response_item', timestamp, payload: { type: 'function_call', name: 'browser', call_id: callId, arguments: JSON.stringify(args) } },
        { type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: callId, output: JSON.stringify(body) } });
      else if (provider === 'claude') records.push(
        { type: 'assistant', timestamp, sessionId: session, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'browser', id: callId, input: args }] } },
        { type: 'user', timestamp, sessionId: session, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: JSON.stringify(body) }] } });
      else records.push(
        { type: 'message', timestamp, message: { role: 'assistant', content: [{ type: 'toolCall', name: 'browser', id: callId, arguments: args }] } },
        { type: 'message', timestamp, message: { role: 'toolResult', toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(body) }] } });
    }
    await writeFile(path, records.map(r => JSON.stringify(r)).join('\n') + '\n'); paths.push(path);
  }
  return { owner, current, predecessor, paths, advId: adv!.id, provider };
}

it('R13-NATIVE prospective production reader never backdates a new installation or accepts a future window', async () => {
  await seed();
  const reader = productionOpportunityReaders({ ...options(), authorize: async () => true });
  expect(await reader.readContinuity({ family: 'native-operation', since: options().since, until: options().until })).toBe('gap');
  expect(await reconcileNativeCapture({ ...options(), until: new Date(Date.now() + 86400_000).toISOString() })).toBe('unknown');
  const [row] = await f.db.adminSql`SELECT native_capture_receipt, native_capture_from > ${options().until}::timestamptz AS prospective
    FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`;
  expect(row).toMatchObject({ native_capture_receipt: { baseline: true }, prospective: true });
});

it('R13-NATIVE reconciles real canonical carry sources for all providers without a hook or injected completeness callback', async () => {
  const seeds = [];
  for (const provider of ['codex', 'claude', 'omp'] as const) seeds.push(await seed(provider));
  await installed();
  expect(await reconcileNativeCapture(options())).toBe('complete');
  expect(await reconcileNativeCapture(options())).toBe('complete');
  const rows = await f.db.adminSql`SELECT id::text,agent,owner_id,session_id,tool_use_id,summary,detail FROM harness_shared.agent_activity ORDER BY id`;
  expect(rows).toHaveLength(6);
  expect(rows.every(r => r.summary === 'Canonical native operation' && JSON.stringify(r.detail) === '{}')).toBe(true);
  const [receipt] = await f.db.adminSql`SELECT native_capture_receipt FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`;
  expect(receipt!.native_capture_receipt).toMatchObject({ version: 1, sources: 6, runtimes: 3, calls: 6 });
  expect(JSON.stringify(receipt)).not.toMatch(/private-source|session-|su-|jsonl/);
  const reader = productionOpportunityReaders({ ...options(), authorize: async () => true });
  for (const s of seeds) {
    const row = rows.find(r => r.session_id === s.predecessor)!;
    const hydrated = await reader.readTranscript({ id: row.id, actor: s.owner, provider: s.provider,
      sessionId: s.predecessor, callId: row.tool_use_id });
    expect(hydrated?.sources[0]?.result?.body).toEqual({ exit_code: 0 });
  }
});

it('R13-NATIVE census composes canonical capture across all six cells and revokes eligibility after predecessor loss', async () => {
  const seeds = [];
  for (const provider of ['codex', 'claude', 'omp'] as const) seeds.push(await seed(provider, true));
  await installed();
  // Fixture-only older installation: the production census still uses its fixed
  // seven-day window, and no caller can pass a historical native receipt.
  await f.db.adminSql`UPDATE harness_shared.sql_intent_progress
    SET native_capture_from=${new Date(f.now - 7 * 86400_000).toISOString()}::timestamptz
    WHERE workspace_id=${workspaceId} AND scope_id LIKE 'native:%'`;
  const opts = f.opts({ rowBudget: 2, timeBudgetMs: 30_000 });
  const run = () => runMonitoredCensus(opts, async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }));
  const measured = await run(), native = measured.families.find(row => row.family === 'native-operation')!;
  expect(native).toMatchObject({ coverage: 'measured', scanned: 12, diagnostics: {
    continuity: { before: 'complete', after: 'complete' }, reviewEligible: true,
    sourceCoverage: { incomplete: 0, denied: 0, pages: 6, windowExhausted: true } } });
  const matrix = (native.diagnostics.sourceCoverage as { matrix: { source: string; status: string }[] }).matrix;
  expect(matrix).toHaveLength(12);
  const transcripts = matrix.filter(cell => cell.source === 'transcript');
  expect(transcripts).toHaveLength(6); expect(transcripts.every(cell => cell.status === 'measured')).toBe(true);
  const candidates = native.diagnostics.candidates as { id: string; reviewEligible: boolean }[];
  expect(candidates).toHaveLength(2); expect(candidates.every(candidate => candidate.reviewEligible)).toBe(true);
  const read = () => readProductionMonitoredCandidate({ ...opts, family: 'native-operation',
    runId: measured.runId, candidateId: candidates[0]!.id });
  expect(await read()).toMatchObject({ reviewEligible: true });
  const [stored] = await f.db.adminSql`SELECT coverage,diagnostics FROM harness_shared.sql_intent_family_runs
    WHERE workspace_id=${workspaceId} AND run_id=${measured.runId}::uuid AND family='native-operation'`;
  expect(stored).toMatchObject({ coverage: 'measured', diagnostics: { reviewEligible: true } });
  await rm(seeds[2]!.paths[0]!);
  expect(await read()).toBeNull();
  expect((await run()).families.find(row => row.family === 'native-operation')).toMatchObject({
    coverage: 'UNKNOWN', diagnostics: { reviewEligible: false } });
});

it.each(['DELETE FROM harness_shared.agent_activity',
  "UPDATE harness_shared.agent_activity SET tool_name='rewritten'", 'TRUNCATE harness_shared.agent_activity'])(
  'R13-NATIVE invalidates the source receipt under replication-role loss: %s', async statement => {
  await seed(); await installed(); expect(await reconcileNativeCapture(options())).toBe('complete');
  await f.db.adminSql`SET session_replication_role=replica`;
  try { await f.db.adminSql.unsafe(statement); }
  finally { await f.db.adminSql`SET session_replication_role=origin`; }
  const [row] = await f.db.adminSql`SELECT native_capture_revision,native_capture_receipt FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`;
  expect(Number(row!.native_capture_revision)).toBeGreaterThan(0); expect(row!.native_capture_receipt).toBeNull();
  expect(await reconcileNativeCapture(options())).not.toBe('complete');
});

it('R13-NATIVE detects absent detectors and a deleted or rebound runtime population', async () => {
  const s = await seed(); await installed(); expect(await reconcileNativeCapture(options())).toBe('complete');
  await f.db.adminSql`ALTER TABLE harness_shared.agent_activity DISABLE TRIGGER native_capture_index_delete`;
  try { expect(await reconcileNativeCapture(options())).toBe('unknown'); }
  finally { await f.db.adminSql`ALTER TABLE harness_shared.agent_activity ENABLE ALWAYS TRIGGER native_capture_index_delete`; }
  await f.db.adminSql`UPDATE harness_shared.adv_sessions SET coord_owner_id='su-rebound' WHERE id=${s.advId}::bigint`;
  expect(await reconcileNativeCapture(options())).toBe('unknown');
  const [row] = await f.db.adminSql`SELECT native_capture_receipt FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`;
  expect(row!.native_capture_receipt).toBeNull();
});

it('R13-NATIVE refuses missing, truncated, malformed, symlinked and mismatched canonical sources', async () => {
  const s = await seed(); await installed();
  const path = s.paths[0]!, original = await readFile(path);
  for (const bytes of [original.subarray(0, original.length - 1), Buffer.from('not-json\n'),
    Buffer.from(original.toString().replace(s.predecessor, randomUUID()))]) {
    await writeFile(path, bytes); expect(await reconcileNativeCapture(options())).toBe('unknown');
  }
  await rm(path); expect(await reconcileNativeCapture(options())).toBe('unknown');
  const outside = join(root, 'outside'); await writeFile(outside, original); await symlink(outside, path);
  expect(await reconcileNativeCapture(options())).toBe('unknown');
});

it('R13-NATIVE refuses ambiguous attribution, wrong same-ID index copies and revoked authorization', async () => {
  const s = await seed(); await installed();
  await f.db.adminSql`INSERT INTO harness_shared.agent_activity
    (workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,tool_use_id)
    VALUES (${workspaceId},${harnessSlug},${s.owner},'codex',${s.predecessor},'tool','wrong-tool',${`call-${s.predecessor}`})`;
  expect(await reconcileNativeCapture(options())).toBe('unknown');
  expect(await reconcileNativeCapture({ ...options(), authorize: async () => false })).toBe('unknown');
  await f.db.adminSql`DELETE FROM harness_shared.session_briefs WHERE owner_id=${s.owner}`;
  expect(await reconcileNativeCapture(options())).toBe('unknown');
});
