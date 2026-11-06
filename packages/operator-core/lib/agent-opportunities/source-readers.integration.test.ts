import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sqlMiningFixture } from '../../test/_sql-mining-fixture';
import { buildScratchUri, safeScratchFilesystemPath } from '../scratch-uri';
import { writeScratchReference } from '../scratch-reference';
import { productionOpportunityReaders } from './source-readers';

let f: Awaited<ReturnType<typeof sqlMiningFixture>>, dir: string, oldRoot: string | undefined;
const workspaceId = 'sql-mining-test', harnessSlug = 'mining-test', sourceBoundary = 'tool-ledger';
let permitted = true;
beforeAll(async () => {
  f = await sqlMiningFixture(); dir = await mkdtemp(join(tmpdir(), 'opportunity-readers-'));
  oldRoot = process.env.PAPERCUSP_SCRATCH_ROOT; process.env.PAPERCUSP_SCRATCH_ROOT = dir;
}, 120_000);
afterAll(async () => {
  if (oldRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = oldRoot;
  await f?.cleanup(); if (dir) await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => { await f.clear(); permitted = true;
  await f.db.adminSql`DELETE FROM harness_shared.agent_activity`;
  await f.db.adminSql`DELETE FROM harness_shared.adv_sessions`;
});
const readers = (locateTranscript?: NonNullable<Parameters<typeof productionOpportunityReaders>[1]>['locateTranscript']) =>
  productionOpportunityReaders({ workspaceId, harnessSlug, sourceBoundary, client: f.db.adminSql,
    authorize: async () => permitted }, { locateTranscript });
async function output(over: { ownerId?: string; workspaceId?: string; nowMs?: number; boundary?: boolean } = {}) {
  const uri = buildScratchUri({ workspaceId, toolName: 'dev:pg_query', runId: randomUUID(), basename: 'result.spill' });
  const path = safeScratchFilesystemPath(uri), id = await f.seed();
  writeScratchReference({ filePath: path, payload: 'preamble\n{"hits":[{"tool":"docs:get"}]}',
    workspaceId: over.workspaceId ?? workspaceId, ownerId: over.ownerId ?? 'su-private-actor',
    mediaType: 'application/json', ...(over.boundary === false ? {} : { bodyOffsetInPayload: 9 }), nowMs: over.nowMs });
  await f.db.adminSql`UPDATE harness_shared.tool_invocations SET output_ref=${uri} WHERE id=${id}::bigint`;
  return { path, input: { id, outputRef: uri, tool: 'dev:pg_query', metadata: {} } };
}
it('hydrates only the exact ledger-linked, integrity-checked and currently authorized result body', async () => {
  const { input } = await output();
  expect(await readers().readOutput(input)).toEqual({ callId: `invocation:${input.id}`, provider: 'ledger',
    namespace: 'operator-dispatch', complete: true, body: { hits: [{ tool: 'docs:get' }] } });
  expect(await readers().readOutput({ ...input, id: '999999999' })).toBeNull();
  expect(await readers().readOutput({ ...input, tool: 'docs:get' })).toBeNull();
  permitted = false; expect(await readers().readOutput(input)).toBeNull();
  permitted = true; await f.db.adminSql`UPDATE harness_shared.tool_invocations SET output_ref=NULL WHERE id=${input.id}::bigint`;
  expect(await readers().readOutput(input)).toBeNull();
});

const managedScope = { workspaceId, sourceBoundary, epoch: 'managed-test', key: new Uint8Array(32).fill(91) };
async function managedRow(callId: string, over: Record<string, unknown> = {}) {
  const id = await f.seed();
  const receipt = { version: 1, callId, parentCallId: 'host:parent', handlerEntered: true,
    role: 'operation', disposition: 'ok', outcome: { status: 'success', final: true }, ...over };
  await f.db.adminSql`UPDATE harness_shared.tool_invocations SET tool_name='capability:bash',
    args_json=${JSON.stringify({ command: 'echo PRIVATE', cwd: '/private', env: { TOKEN: 'secret' } })}::jsonb,
    metadata_json=${JSON.stringify({ managedOperation: receipt })}::jsonb WHERE id=${id}::bigint`;
  return { id, receipt };
}
it('P005 hydrates exact host receipts into shared evidence and excludes missing, foreign and truncated sources', async () => {
  const { id } = await managedRow('host:actual');
  const input = { ids: [id], scope: managedScope };
  const evidence = await readers().readManagedOperations(input);
  expect(evidence).toHaveLength(1);
  expect(evidence[0]).toMatchObject({ family: 'shell', source: { choice: 'agent' }, outcome: { status: 'success', final: true } });
  expect(JSON.stringify(evidence)).not.toMatch(/PRIVATE|private|secret|su-private-actor|host:/);
  expect(await readers().readManagedOperations({ ...input, ids: [id, '999999999'] })).toEqual([]);
  expect(await readers().readManagedOperations({ ...input, scope: { ...managedScope, workspaceId: 'foreign' } })).toEqual([]);
  permitted = false; expect(await readers().readManagedOperations(input)).toEqual([]); permitted = true;
  await f.db.adminSql`UPDATE harness_shared.tool_invocations SET args_json='{"_truncated":true,"command":"echo incomplete"}'::jsonb WHERE id=${id}::bigint`;
  expect(await readers().readManagedOperations(input)).toEqual([]);
});

it('P005 exact code:run child selection requires the real parent, caller and execution window', async () => {
  await managedRow('host:child');
  const input = { callIds: ['host:child'], scope: managedScope, actor: 'su-private-actor', parentCallId: 'host:parent',
    since: '2026-10-24T11:59:59Z', until: '2026-10-24T12:00:01Z' };
  expect(await readers().readManagedOperations(input)).toHaveLength(1);
  for (const wrong of [{ actor: 'su-foreign' }, { parentCallId: 'host:guessed' }, { callIds: ['host:absent'] },
    { since: '2026-10-24T12:00:00.9Z' }, { until: '2026-10-25T12:00:01Z' }])
    expect(await readers().readManagedOperations({ ...input, ...wrong })).toEqual([]);
});

it('P005 managed hydration rechecks ACL and source content after awaited reads', async () => {
  const { id } = await managedRow('host:actual');
  const input = { ids: [id], scope: managedScope };
  let reads = 0;
  const revoking = productionOpportunityReaders({ workspaceId, harnessSlug, sourceBoundary, client: f.db.adminSql,
    authorize: async () => ++reads < 3 });
  expect(await revoking.readManagedOperations(input)).toEqual([]);
  reads = 0;
  const changing = productionOpportunityReaders({ workspaceId, harnessSlug, sourceBoundary, client: f.db.adminSql,
    authorize: async () => {
      if (++reads === 3) await f.db.adminSql`UPDATE harness_shared.tool_invocations SET args_json='{"command":"changed"}'::jsonb WHERE id=${id}::bigint`;
      return true;
    } });
  expect(await changing.readManagedOperations(input)).toEqual([]);
});

it('P005 a yielded managed job and its final poll produce one failed operation, without copying output', async () => {
  const job = { bashId: 'job-exact', taskId: 'task-exact' };
  const first = await managedRow('host:start', { yielded: true, job, outcome: { status: 'running', final: false } });
  const poll = await managedRow('host:poll', { role: 'poll', job, outcome: { status: 'error', final: true } });
  await f.db.adminSql`UPDATE harness_shared.tool_invocations SET tool_name='capability:bash_output',
    invoked_at='2026-10-24T12:00:01Z',args_json='{"task_id":"task-exact"}'::jsonb WHERE id=${poll.id}::bigint`;
  const operations = await readers().readManagedOperations({ ids: [first.id, poll.id], scope: managedScope });
  expect(operations).toHaveLength(1);
  expect(operations[0]).toMatchObject({ outcome: { status: 'error', final: true }, lifecycle: { yielded: true, polls: [expect.any(Object)] } });
});
it('leaves expired, foreign-owner, foreign-workspace, unframed and corrupted output UNKNOWN', async () => {
  for (const over of [{ nowMs: 1 }, { ownerId: 'su-other' }, { workspaceId: 'other' }, { boundary: false }]) {
    expect(await readers().readOutput((await output(over)).input)).toBeNull();
  }
  const { input, path } = await output();
  const bytes = await readFile(path); bytes[bytes.length - 1] ^= 1; await writeFile(path, bytes);
  expect(await readers().readOutput(input)).toBeNull();
});
it('rejects scratch symlink escapes and oversized evidence without reading an arbitrary path', async () => {
  const { input, path } = await output();
  const outside = join(dir, 'outside'); await writeFile(outside, '{"ok":true}');
  await rm(path); await symlink(outside, path);
  expect(await readers().readOutput(input)).toBeNull();
  await rm(path); await writeFile(path, Buffer.alloc(2 * 1024 * 1024 + 1));
  expect(await readers().readOutput(input)).toBeNull();
});

const nativeCells = (['claude', 'codex', 'omp'] as const).flatMap(provider =>
  (['shell', 'browser'] as const).map(kind => ({ provider, kind })));
async function native(provider: 'claude' | 'codex' | 'omp' = 'codex', kind: 'shell' | 'browser' = 'shell') {
  const actor = 'su-reader-test', sessionId = randomUUID(), callId = 'call-exact';
  const tool = kind === 'browser' ? 'browser_click'
    : provider === 'claude' ? 'Bash' : provider === 'omp' ? 'bash' : 'exec_command';
  const args = kind === 'browser' ? { selector: '#save' } : { command: 'rg private src' };
  const body = kind === 'browser' ? { success: true } : { exit_code: 0 };
  const [adv] = await f.db.adminSql<{ id: string }[]>`INSERT INTO harness_shared.adv_sessions
    (workspace_id,mode,coord_owner_id,agent,session_id,omp_thread_id)
    VALUES (${workspaceId},'console',${actor},${provider},${provider === 'omp' ? null : sessionId},
      ${provider === 'omp' ? sessionId : null}) RETURNING id::text`;
  const [activity] = await f.db.adminSql<{ id: string }[]>`INSERT INTO harness_shared.agent_activity
    (workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,detail,status)
    VALUES (${workspaceId},${harnessSlug},${actor},${provider},${sessionId},'tool',${tool},'pre',${callId},'{}','ok') RETURNING id::text`;
  const lines = provider === 'codex' ? [
    { timestamp: '2026-10-24T12:00:00Z', type: 'response_item', payload: { type: 'function_call', name: tool, call_id: callId, arguments: JSON.stringify(args) } },
    { timestamp: '2026-10-24T12:00:01Z', type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: JSON.stringify(body) } },
  ] : provider === 'claude' ? [
    { type: 'assistant', timestamp: '2026-10-24T12:00:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: callId, name: tool, input: args }] } },
    { type: 'user', timestamp: '2026-10-24T12:00:01Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: JSON.stringify(body) }] } },
  ] : [
    { type: 'message', timestamp: '2026-10-24T12:00:00Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: callId, name: tool, arguments: args }] } },
    { type: 'message', timestamp: '2026-10-24T12:00:01Z', message: { role: 'toolResult', toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(body) }] } },
  ];
  const path = join(dir, `${sessionId}.jsonl`); await writeFile(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return { input: { id: activity!.id, actor, provider, sessionId, callId }, path, advId: adv!.id, tool, args, body };
}
it.each(nativeCells)('pairs the $provider $kind candidate with its exact request and result', async ({ provider, kind }) => {
  const { input, path, tool, args, body } = await native(provider, kind);
  const result = await readers(async () => path).readTranscriptCandidate(input);
  expect(result?.sources).toHaveLength(1);
  expect(result?.sources[0]).toMatchObject({ callId: input.callId, provider, namespace: input.sessionId, tool, args,
    result: { callId: input.callId, provider, namespace: input.sessionId, complete: true, body } });
});
it.each(nativeCells)('D030 $provider $kind candidate pairing never authorizes production hydration', async ({ provider, kind }) => {
  const { input, path } = await native(provider, kind);
  let bodyReads = 0;
  const reader = readers(async () => { bodyReads++; return path; });
  expect(await reader.readTranscript(input)).toBeNull();
  expect(bodyReads).toBe(0);
  expect((await reader.readTranscriptCandidate(input))?.sources).toHaveLength(1);
  expect(bodyReads).toBe(1);
  // A successful candidate read cannot cache or mint protected source authority.
  expect(await reader.readTranscript(input)).toBeNull();
  expect(bodyReads).toBe(1);
});
it('refuses source or session mismatches and rechecks authorization after transcript IO', async () => {
  const { input, path, advId } = await native();
  let reads = 0;
  const reader = readers(async () => { reads++; return path; });
  for (const wrong of [{ actor: 'su-other' }, { sessionId: randomUUID() }, { provider: 'omp' as const }, { callId: 'wrong' }])
    expect(await reader.readTranscriptCandidate({ ...input, ...wrong })).toBeNull();
  expect(reads).toBe(0);
  expect(await readers(async () => { permitted = false; return path; }).readTranscriptCandidate(input)).toBeNull();
  permitted = true;
  expect(await readers(async () => {
    await f.db.adminSql`UPDATE harness_shared.adv_sessions SET session_id='changed' WHERE id=${advId}::bigint`;
    return path;
  }).readTranscriptCandidate(input)).toBeNull();
});
it('keeps incomplete, missing and oversized transcripts UNKNOWN instead of certifying a partial snapshot', async () => {
  const { input, path } = await native();
  const reader = readers(async () => path);
  const original = await readFile(path); await writeFile(path, original.subarray(0, original.length - 1));
  expect(await reader.readTranscriptCandidate(input)).toBeNull();
  await writeFile(path, Buffer.alloc(4 * 1024 * 1024 + 1)); expect(await reader.readTranscriptCandidate(input)).toBeNull();
  await rm(path); expect(await reader.readTranscriptCandidate(input)).toBeNull();
});
