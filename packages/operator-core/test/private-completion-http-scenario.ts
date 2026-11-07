/** EI-27984315103577037: real report-only completion on the existing private API. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { getWorkItem } from '../lib/work-items';
import { TERMINAL_COMPLETION_EVIDENCE_KEY } from '../lib/coord-lifecycle/records';
import { connectAgentMcp } from '../lib/agent-mcp-client';
import { readSuperuserToken } from '../lib/superuser-token';

type Options = { workspace: string; harness: string; base: string;
  headers: Record<string, string>; evidenceDir: string; expectedSha: string;
  transport?: 'palette' | 'mcp-proxy' };

const reportBody = '# Private completion control\n\n'
  + 'This disposable report verifies publication and exact readback before a report-only work-item close.\n';
const createArgs = { kind: 'task', title: 'Private report-only completion control',
  body: 'Publish the disposable report, verify its exact body, then record completion. No source changes.',
  assign_to: 'self', state: 'wip', changeKinds: ['no-code-change'] };
const publishArgs = { title: 'Private completion control', body_md: reportBody,
  visibility: 'workspace' };
const completion = { summary: 'Published and read back the disposable report.',
  testsRun: 'HTTP reports:publish followed by reports:get with exact body comparison',
  testResult: 'The complete report body and workspace visibility matched.',
  verifiedHow: 'manual', filesChanged: [] };

/** Catch caller-contract mistakes before starting the private PG/API build. */
export async function validatePrivateCompletionRequests() {
  const [create, publish, complete] = await Promise.all([
    import('../lib/agent-tools/work_items/create'), import('../lib/agent-tools/reports/publish'),
    import('../lib/agent-tools/work_items/complete'),
  ]);
  (create.default.args as { parse(value: unknown): unknown }).parse(createArgs);
  (publish.default.args as { parse(value: unknown): unknown }).parse(publishArgs);
  (complete.default.args as { parse(value: unknown): unknown }).parse({ id: 'WI-private-control',
    state: 'done', assumptions: 'none', completion });
}

export async function measurePrivateCompletionScenario(o: Options) {
  assert.match(o.workspace, /^test-runtime-/);
  const transport = o.transport ?? 'palette';
  let proxy: import('node:http').Server | undefined;
  let client: Awaited<ReturnType<typeof connectAgentMcp>>['client'] | undefined;
  const priorFailureLog = process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
  const proxyLogs: string[] = [];
  let invalidBearerStatus: number | undefined;
  try {
  if (transport === 'mcp-proxy') {
    const token = readSuperuserToken();
    assert.ok(token, 'private MCP bearer must exist before host boot');
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = join(o.evidenceDir, 'completion-proxy.jsonl');
    const { createMcpProxy } = await import('../../../apps/operator/lib/mcp-proxy/proxy');
    proxy = createMcpProxy({ listenPort: 0, targetHost: '127.0.0.1',
      targetPort: Number(new URL(o.base).port), retryWindowMs: 10_000, controlPlaneReserve: 2,
      log: line => proxyLogs.push(line) });
    await new Promise<void>((done, reject) => {
      proxy!.once('error', reject);
      proxy!.listen(0, '127.0.0.1', done);
    });
    const address = proxy.address();
    assert.ok(address && typeof address !== 'string');
    const url = new URL(`http://127.0.0.1:${address.port}/api/mcp`);
    for (const [key, value] of Object.entries({ superuser: '1', workspace: o.workspace,
      harness: o.harness, client: 'su-private-completion-' + randomUUID(), structured: '1', format: 'json' }))
      url.searchParams.set(key, value);
    // Exercise the operator's auth boundary directly: a loopback proxy may
    // independently attach its maintained local bearer on forwarded requests.
    const refused = await fetch(o.base + url.pathname + url.search, { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: 'Bearer invalid-private-completion-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'private-invalid-control', version: '1' } } }),
      signal: AbortSignal.timeout(10_000) });
    await refused.arrayBuffer();
    invalidBearerStatus = refused.status;
    assert.ok([401, 403].includes(refused.status), 'invalid bearer must be refused');
    ({ client } = await connectAgentMcp({ url: url.href, mode: 'http',
      name: 'private-completion-proxy', headers: { Authorization: `Bearer ${token}` } }));
    await client.listTools();
  }
  const requests: Array<{ name: string; status: number; elapsedMs: number }> = [];
  const callerSid = 'private-completion-' + randomUUID();
  let completionKey: string | undefined;
  let completionResult: any;
  function decode(result: any) {
    assert.notEqual(result?.isError, true, JSON.stringify(result));
    const text = result?.content?.find((part: any) => part.type === 'text' && part.text.trim().startsWith('{'));
    const data = result?.structuredContent ?? (text ? JSON.parse(text.text) : result?.data);
    assert.ok(data, 'a structured dispatch receipt is required');
    return data;
  }
  async function invoke(name: string, args: Record<string, unknown>, replayKey?: string) {
    const startedAtMs = performance.now();
    if (client) {
      const key = replayKey ?? randomUUID();
      const result = await client.callTool({ name: 'tools:invoke', arguments: { name, args },
        _meta: { idempotencyKey: key } }, undefined, { timeout: 30_000 });
      const elapsedMs = performance.now() - startedAtMs;
      await writeFile(join(o.evidenceDir, `completion-request-${requests.length}.json`),
        JSON.stringify({ name, args, elapsedMs, result }), { flag: 'wx' });
      requests.push({ name, status: 200, elapsedMs });
      if (name === 'work_items:complete') { completionKey = key; completionResult = result; }
      return decode(result);
    }
    const response = await fetch(o.base + '/api/agent-mcp/run-tool', {
      method: 'POST', headers: o.headers,
      body: JSON.stringify({ name, args, harness: o.harness, callerSid, confirmed: true }),
      signal: AbortSignal.timeout(30_000),
    });
    const envelope = await response.json() as any;
    // Includes complete response-body drainage, measured on one monotonic clock.
    const elapsedMs = performance.now() - startedAtMs;
    await writeFile(join(o.evidenceDir, `completion-request-${requests.length}.json`),
      JSON.stringify({ name, args, status: response.status, elapsedMs, envelope }), { flag: 'wx' });
    assert.equal(response.status, 200, JSON.stringify(envelope));
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    assert.notEqual(envelope.result?.isError, true, JSON.stringify(envelope));
    requests.push({ name, status: response.status, elapsedMs });
    return decode(envelope.result);
  }
  async function health() {
    const response = await fetch(o.base + '/api/health', { headers: o.headers,
      signal: AbortSignal.timeout(2_000) });
    const body = await response.json() as { service: string; sha: string; bundleStale?: unknown };
    assert.equal(response.status, 200);
    assert.equal(body.service, 'papercusp-operator');
    assert.equal(body.sha, o.expectedSha);
    assert.equal(body.bundleStale, undefined);
    return body;
  }
  const healthBefore = await health();
  const identity = await invoke('coord:whoami', {});
  assert.ok(identity.ownerId, 'use the server-qualified actor, never callerSid as authority');
  const created = await invoke('work_items:create', createArgs);
  const item = created.results?.find((row: any) => row.ok === true);
  assert.ok(item?.id, JSON.stringify(created));
  assert.equal(item.workItem.assignee, identity.ownerId);
  assert.equal(item.changeKinds?.recorded, true, JSON.stringify(item));

  const published = await invoke('reports:publish', { ...publishArgs, request_key: callerSid });
  assert.equal(published.ok, true, JSON.stringify(published));
  const report = await invoke('reports:get', { id: published.report_id });
  const readback = report.results?.find((row: any) => row.id === published.report_id);
  assert.equal(readback?.ok, true, JSON.stringify(report));
  assert.equal(readback.report.body_md, reportBody);
  assert.equal(readback.report.visibility, 'workspace');
  const verifiedBeforeCloseAtMs = performance.now();
  const expectedCompletion = { ...completion,
    summary: `Published and read back disposable report ${published.report_id}.` };
  const closeStartedAtMs = performance.now();
  const closed = await invoke('work_items:complete', { id: item.id, state: 'done',
    assumptions: 'none', completion: expectedCompletion });
  const closeCompletedAtMs = performance.now();
  const close = closed.results?.find((row: any) => row.id === item.id);
  assert.equal(close?.ok, true, JSON.stringify(closed));
  assert.equal(close.stateError, undefined, JSON.stringify(close));
  const stored = await getWorkItem(item.id, o.harness);
  assert.ok(stored, 'terminal state must be read independently from PostgreSQL');
  assert.equal(stored.state, 'done');
  assert.equal(stored.assignee, null, 'the terminal transition must release the claim');
  const payload = stored.payload as Record<string, unknown> | undefined;
  const evidence = payload?.[TERMINAL_COMPLETION_EVIDENCE_KEY] as Record<string, unknown> | undefined;
  await writeFile(join(o.evidenceDir, 'completion-readback.json'),
    JSON.stringify({ itemId: stored.id, state: stored.state, assignee: stored.assignee, evidence }), { flag: 'wx' });
  assert.equal(evidence?.summary, expectedCompletion.summary);
  // completionEvidenceFromRecord deliberately omits empty file arrays. The
  // request receipt retains the explicit [], and storage must name no paths.
  assert.deepEqual(evidence?.filesChanged ?? [], []);
  assert.equal(evidence?.testResult, completion.testResult);
  const completionElapsedMs = requests.at(-1)!.elapsedMs;
  let replay: { tagged: boolean; originalHandlerExecutions: number; elapsedMs: number } | undefined;
  if (client) {
    assert.ok(completionKey);
    const firstResult = completionResult;
    const replayStarted = performance.now();
    const repeated = await invoke('work_items:complete', { id: item.id, state: 'done',
      assumptions: 'none', completion: expectedCompletion }, completionKey);
    assert.equal(completionResult._meta?.replayed, true, 'same-key retry must be explicitly tagged');
    assert.equal(firstResult._meta?.replayed, undefined, 'initial result must execute');
    assert.equal(repeated.results?.find((row: any) => row.id === item.id)?.ok, true);
    const { sql } = getOrgPg();
    // recordInvocation writes the inner tool name on execution; a replay of
    // tools:invoke returns before that inner completion can run again.
    const executions = await sql`SELECT id FROM harness_shared.tool_invocations
      WHERE workspace_id = ${o.workspace} AND tool_name = 'work_items:complete'
        AND args_json->>'id' = ${item.id} AND status = 'ok'`;
    assert.equal(executions.length, 1, 'same logical close must execute the completion handler once');
    const afterReplay = await getWorkItem(item.id, o.harness);
    assert.equal(afterReplay?.closedAt, stored.closedAt, 'replay must not close the item again');
    replay = { tagged: true, originalHandlerExecutions: executions.length,
      elapsedMs: performance.now() - replayStarted };
  }
  const healthAfter = await health();
  const receipt = { workspace: o.workspace, harness: o.harness, itemId: item.id,
    actor: identity.ownerId, state: stored.state, claimReleased: stored.assignee === null,
    reportId: published.report_id, reportBodySha256: createHash('sha256').update(reportBody).digest('hex'),
    reportVerifiedBeforeClose: verifiedBeforeCloseAtMs <= closeStartedAtMs,
    verifiedBeforeCloseAtMs, closeStartedAtMs, closeCompletedAtMs,
    transport, completionElapsedMs, replay, invalidBearerStatus, healthBefore, healthAfter, requests,
    scope: transport === 'mcp-proxy'
      ? 'Current-build production MCP proxy and bearer-authenticated MCP host with private PostgreSQL; excludes historical shared-database pressure and native CLI launch.'
      : 'Current-build palette HTTP dispatch with private PostgreSQL; excludes original MCP proxy/native-auth queue.' };
  await writeFile(join(o.evidenceDir, 'completion-observation.json'), JSON.stringify(receipt), { flag: 'wx' });
  assert.ok(receipt.completionElapsedMs < 20_000,
    `private report-only completion exceeded the existing interactive latency budget: ${receipt.completionElapsedMs}ms`);
  return receipt;
  } finally {
    await client?.close();
    if (proxy) await new Promise<void>(done => { proxy!.close(() => done()); proxy!.closeAllConnections(); });
    if (transport === 'mcp-proxy') await writeFile(join(o.evidenceDir, 'completion-proxy.log'), proxyLogs.join('\n'));
    if (priorFailureLog === undefined) delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
    else process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = priorFailureLog;
  }
}
