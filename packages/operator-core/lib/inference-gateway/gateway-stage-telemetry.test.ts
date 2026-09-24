import http from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { resetGovernorRegistry } from '@papercusp/papercusp-shared/agent';
import { createFailoverPool } from './account-failover';
import { createInferenceGateway, type GatewayStats } from './gateway';
import { CACHE_POLICY_VERSION } from './cache-policy';

let gateway: ReturnType<typeof createInferenceGateway> | undefined;
let upstream: http.Server | undefined;

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
  upstream = undefined;
  resetGovernorRegistry();
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

it('publishes one reconciled, privacy-safe stage timeline through /stats and the existing owner report', async () => {
  resetGovernorRegistry();
  upstream = http.createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"msg-stage","type":"message","role":"assistant","content":[]}');
    });
  });
  const upstreamPort = await listen(upstream);
  const pool = createFailoverPool([
    { accountId: 'stage-account', token: async () => 'BEARER_SECRET_MUST_NOT_SURFACE' },
  ]);
  gateway = createInferenceGateway({
    pool,
    upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    concurrency: 2,
    maxQueueWaitMs: 2_000,
    requestAbsorbMs: 0,
  });
  const port = await gateway.listen(0);
  const owner = 'su-stage-owner';
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-papercusp-owner': owner,
    },
    body: JSON.stringify({
      model: 'claude-opus-4',
      max_tokens: 8,
      stream: false,
      messages: [{ role: 'user', content: 'PROMPT_SECRET_MUST_NOT_SURFACE' }],
    }),
  });
  expect(response.status).toBe(200);
  await response.arrayBuffer();

  const statsResponse = await fetch(`http://127.0.0.1:${port}/stats`);
  const stats = (await statsResponse.json()) as GatewayStats;
  expect(stats.cachePolicy?.policyVersion).toBe(CACHE_POLICY_VERSION);
  const stages = stats.requestStages!;
  expect(stages.requests).toEqual({
    started: 1,
    finalized: 1,
    active: 0,
    sampled: 1,
    coverage: 1,
    reconciled: true,
    outcomeReconciled: true,
    missingStageTimelines: 0,
    cacheUsageObserved: 0,
    cacheWriteObserved: 0,
    cacheUsageCoverage: 0,
  });
  expect(stages.outcomes.ok).toBe(1);
  expect(stages.outcomes.unclassified).toBe(0);
  for (const stage of ['routeSelection', 'queueWait', 'bodyRead', 'auth', 'upstreamTtfb', 'total'] as const) {
    expect(stages.stages[stage].count, stage).toBe(1);
  }
  const timeline = stages.recent[0]!;
  expect(timeline).toMatchObject({
    ownerId: owner,
    provider: 'claude',
    protocol: 'anthropic-messages',
    transport: 'oauth-http',
    model: 'claude-opus-4',
    attempts: 1,
    failovers: 0,
    finalStatus: 200,
    outcome: 'ok',
    missingStages: [],
  });
  expect(['unchanged', 'rewritten']).toContain(timeline.cacheRouting);
  expect(timeline.admission.durable).toMatchObject({
    queued: expect.objectContaining({ priority: expect.any(Number) }),
    admitted: expect.objectContaining({ priority: expect.any(Number) }),
    waitMs: expect.any(Number),
  });
  expect(timeline.admission.provider).toMatchObject({
    queued: expect.objectContaining({
      priority: expect.any(Number),
      tier: null,
      running: expect.any(Number),
      queued: expect.any(Number),
      maxConcurrent: expect.any(Number),
      tier1Reserve: null,
      tierInFlight: null,
      tierQueued: null,
    }),
    admitted: expect.objectContaining({
      priority: expect.any(Number),
      tier: null,
      running: expect.any(Number),
      queued: expect.any(Number),
      maxConcurrent: expect.any(Number),
    }),
    waitMs: expect.any(Number),
  });

  const ownerResponse = await fetch(
    `http://127.0.0.1:${port}/admin/owner-report?owner=${encodeURIComponent(owner)}`,
  );
  const ownerReport = await ownerResponse.json() as {
    stageTelemetry: {
      ownerId: string;
      finalized: number;
      outcomes: { ok: number };
      recent: Array<{ admission: typeof timeline.admission }>;
    };
  };
  expect(ownerReport.stageTelemetry).toMatchObject({ ownerId: owner, finalized: 1, outcomes: { ok: 1 } });
  expect(ownerReport.stageTelemetry.recent).toHaveLength(1);
  expect(ownerReport.stageTelemetry.recent[0]?.admission).toEqual(timeline.admission);

  const serialized = JSON.stringify({ stages, ownerReport });
  expect(serialized).not.toContain('PROMPT_SECRET_MUST_NOT_SURFACE');
  expect(serialized).not.toContain('BEARER_SECRET_MUST_NOT_SURFACE');
});

// ---------------------------------------------------------------------------
// codex cli-exec bridge — the span must describe the WIRE, not the transport's
// buffered implementation (WI-42457).
//
// The `cli-exec` transport descriptor declares `streaming: false` because it drives a nested
// `codex exec` to completion, but `serveCodexCliBridge` ADAPTS that completed run back onto
// Responses SSE whenever the client sent `stream:true` — which is how every gateway-routed
// Codex agent session is served. The handler used to stamp `setStreaming(false)` unconditionally,
// before the body was even parsed, which disarmed the ONE detector covering this path:
// `finish()` only requires the `stream` stage when the span says the request streamed. The
// result was that an SSE request which opened a stream and never terminated it was recorded
// identically to a non-streaming request that correctly had no stream — `ok`, no missing stage.
// ---------------------------------------------------------------------------

/** Boot a gateway with ONLY a codex-cli (ChatGPT-subscription) account, so `/v1/responses`
 *  routes to the cli-exec bridge. The upstream is inert — the bridge never forwards HTTP. */
async function bootCliBridge(run: () => Promise<{ text: string; inputTokens: number; outputTokens: number }>) {
  upstream = http.createServer((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  const upstreamPort = await listen(upstream);
  gateway = createInferenceGateway({
    // The Anthropic credential is only here because the constructor requires one; the codex
    // lane below has no bearer pool, which is what routes /v1/responses to the cli bridge.
    accountId: 'test-acct',
    token: async () => 'test-token',
    upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    concurrency: 2,
    maxQueueWaitMs: 2_000,
    requestAbsorbMs: 0,
    codexCliAccounts: () => [{ accountId: 'chatgpt-sub', home: '/tmp/sub-home' }],
    codexCliRun: run,
  });
  return gateway.listen(0);
}

async function recentTimeline(port: number) {
  const stats = (await (await fetch(`http://127.0.0.1:${port}/stats`)).json()) as GatewayStats;
  const stages = stats.requestStages!;
  return { stages, timeline: stages.recent[0]! };
}

it('records a stream:true cli-exec request as STREAMING, with a real stream stage', async () => {
  resetGovernorRegistry();
  const port = await bootCliBridge(async () => ({ text: 'BRIDGED', inputTokens: 7, outputTokens: 3 }));
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.4', input: 'hello', stream: true }),
  });
  expect(response.status).toBe(200);
  const wire = await response.text();
  // Precondition: this really was served as SSE. Without it the assertions below could pass
  // for a request that never streamed at all, which is the opposite bug.
  expect(wire).toMatch(/event: response\.completed\n/);

  const { stages, timeline } = await recentTimeline(port);
  expect(timeline).toMatchObject({ transport: 'cli-exec', outcome: 'ok', streaming: true });
  // The stage the `streaming` flag arms. Before the fix this was 0 on every gateway-routed
  // Codex agent request, and `missingStages` stayed empty because nothing required it.
  expect(stages.stages.stream.count).toBe(1);
  expect(timeline.missingStages).toEqual([]);
});

it('leaves a NON-streaming cli-exec request non-streaming (the flag tracks the body, not the handler)', async () => {
  resetGovernorRegistry();
  const port = await bootCliBridge(async () => ({ text: 'BUFFERED', inputTokens: 1, outputTokens: 1 }));
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.4', input: 'hello' }),
  });
  expect(response.status).toBe(200);
  await response.arrayBuffer();

  const { stages, timeline } = await recentTimeline(port);
  expect(timeline).toMatchObject({ transport: 'cli-exec', outcome: 'ok', streaming: false });
  expect(stages.stages.stream.count).toBe(0);
  // A non-streaming request has no stream stage BY CONSTRUCTION, so requiring one would make
  // the guard above fire on every buffered call and be turned off again.
  expect(timeline.missingStages).toEqual([]);
});

it('does NOT finalize a post-200 cli-exec SSE failure as ok', async () => {
  resetGovernorRegistry();
  // `stream:true` commits the 200 (and the SSE headers) BEFORE the nested CLI run, so a run that
  // then fails can only report in-band. `classifyGatewayTelemetryOutcome` reads res.statusCode,
  // which is that committed 200 — so this request was finalized `ok` while the client received
  // nothing but `event: error`. That is the same records-success-from-a-partial-signal shape the
  // bridge's own `codexCliResponsesBody` comment documents, one layer up.
  const port = await bootCliBridge(async () => {
    throw new Error('codex exited 1: auth expired');
  });
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.4', input: 'hello', stream: true }),
  });
  expect(response.status).toBe(200); // already committed — this is the trap, not the bug
  const wire = await response.text();
  expect(wire).toMatch(/event: error\n/);
  expect(wire).toMatch(/codex-cli bridge failed/);

  const { stages, timeline } = await recentTimeline(port);
  expect(timeline.outcome).toBe('gateway-error');
  expect(timeline.streaming).toBe(true);
  expect(stages.outcomes.ok).toBe(0);
});
