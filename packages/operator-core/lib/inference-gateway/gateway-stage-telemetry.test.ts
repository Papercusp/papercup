import http from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { resetGovernorRegistry } from '@papercusp/papercusp-shared/agent';
import { createFailoverPool } from './account-failover';
import { createInferenceGateway, type GatewayStats } from './gateway';

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

  const ownerResponse = await fetch(
    `http://127.0.0.1:${port}/admin/owner-report?owner=${encodeURIComponent(owner)}`,
  );
  const ownerReport = await ownerResponse.json() as {
    stageTelemetry: { ownerId: string; finalized: number; outcomes: { ok: number }; recent: unknown[] };
  };
  expect(ownerReport.stageTelemetry).toMatchObject({ ownerId: owner, finalized: 1, outcomes: { ok: 1 } });
  expect(ownerReport.stageTelemetry.recent).toHaveLength(1);

  const serialized = JSON.stringify({ stages, ownerReport });
  expect(serialized).not.toContain('PROMPT_SECRET_MUST_NOT_SURFACE');
  expect(serialized).not.toContain('BEARER_SECRET_MUST_NOT_SURFACE');
});
