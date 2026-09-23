import { describe, expect, it } from 'vitest';
import {
  GatewayRequestTelemetry,
  assertCompleteGatewayRequestTimeline,
  classifyGatewayTelemetryOutcome,
} from './request-stage-telemetry';

function completeCloudSpan(telemetry: GatewayRequestTelemetry, advance: (ms: number) => void, owner = 'su-test') {
  const span = telemetry.begin({
    ownerId: owner,
    provider: 'claude',
    protocol: 'anthropic-messages',
    transport: 'oauth-http',
  });
  advance(1);
  span.routeSelected();
  advance(2);
  span.admitted();
  span.beginStage('bodyRead');
  advance(3);
  span.endStage('bodyRead');
  span.beginStage('auth');
  advance(4);
  span.endStage('auth');
  span.setModel('claude-opus-4');
  span.setCacheRouting('rewritten');
  span.recordAttempt();
  span.beginStage('upstreamTtfb');
  advance(5);
  span.endStage('upstreamTtfb');
  span.setStreaming(true);
  span.beginStage('stream');
  advance(6);
  span.endStage('stream');
  return span.finish('ok', 200)!;
}

describe('GatewayRequestTelemetry', () => {
  it('reports observed account/cache usage with explicit unknown miss cause and bounded coverage', () => {
    const telemetry = new GatewayRequestTelemetry();
    expect(telemetry.snapshot().requests.cacheUsageCoverage).toBeNull();
    const span = telemetry.begin({ provider: 'claude', protocol: 'anthropic-messages' });
    span.setServingAccount('actually-served');
    span.recordFailover();
    span.recordCacheUsage(10, 0, 20, 'msg-native');
    span.finish('ok', 200);
    telemetry.begin({ provider: 'codex', protocol: 'openai-responses' }).finish('shed', 503);
    const snapshot = telemetry.snapshot();
    expect(snapshot.requests).toMatchObject({ finalized: 2, cacheUsageObserved: 1, cacheUsageCoverage: 0.5 });
    expect(snapshot.recent[0].cache).toMatchObject({ servingAccountId: 'actually-served', providerRequestId: 'msg-native',
      inputTokens: 10, cacheWriteTokens: 20, cacheReadTokens: 0, reuse: 'zero-read', missReason: 'unknown' });
    expect(snapshot.recent[1].cache.reuse).toBe('unobserved');
    expect(snapshot.recent[1].cache.servingAccountId).toBeNull();
  });

  it('fingerprints tools and instructions without retaining their content or the dynamic conversation', () => {
    const telemetry = new GatewayRequestTelemetry();
    const body = (message: string) => Buffer.from(JSON.stringify({ tools: [{ name: 'private-tool', description: 'not-for-logs' }],
      instructions: 'secret-instructions', input: message }));
    const first = telemetry.begin({ ownerId: 'su-test', provider: 'codex', protocol: 'openai-responses' });
    first.setCacheShape(body('first dynamic message'));
    first.recordCacheUsage(20, 80, 0);
    first.finish('ok', 200);
    const second = telemetry.begin({ ownerId: 'su-test', provider: 'codex', protocol: 'openai-responses' });
    second.setCacheShape(body('different dynamic message'));
    second.recordCacheUsage(0, 100, 0);
    second.finish('ok', 200);
    const snapshot = telemetry.snapshot();
    expect(snapshot.recent[0].cache.tools).toEqual(snapshot.recent[1].cache.tools);
    expect(snapshot.recent[0].cache.instructions).toEqual(snapshot.recent[1].cache.instructions);
    expect(snapshot.recent[0].cache.reuse).toBe('partial-hit');
    expect(snapshot.recent[1].cache.reuse).toBe('full-hit');
    expect(snapshot.recent[1].previousObservedRequestGapMs).not.toBeNull();
    expect(JSON.stringify(snapshot)).not.toMatch(/private-tool|not-for-logs|secret-instructions|dynamic message/);
    snapshot.recent[0].cache.tools!.sha256 = 'corrupted-caller-copy';
    expect(telemetry.snapshotForOwner('su-test').recent[0].cache.tools!.sha256).not.toBe('corrupted-caller-copy');
  });

  it('bounds fingerprint work and does not call partial or missing observations exact', () => {
    const telemetry = new GatewayRequestTelemetry({ recentCapacity: 1 });
    const capped = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
    capped.setCacheShape(Buffer.from(JSON.stringify({ instructions: 'x'.repeat(100_000) })));
    const first = capped.finish('ok', 200)!;
    expect(first.cache.instructions).toMatchObject({ bytes: 100_002, hashedBytes: 65_536 });
    const oversized = telemetry.begin({ provider: 'claude', protocol: 'anthropic-messages' });
    oversized.setCacheShape(Buffer.alloc(2_097_153));
    oversized.recordCacheUsage(Number.NaN, 0, 0);
    expect(oversized.finish('ok', 200)?.cache).toMatchObject({ shape: 'oversized', reuse: 'unobserved', instructions: null });
    expect(telemetry.snapshot().recent).toHaveLength(1);
  });

  it('publishes bounded p50/p95/p99 samples with exact request/outcome reconciliation', () => {
    let now = 1_000;
    const telemetry = new GatewayRequestTelemetry({ now: () => now, sampleCapacity: 3, recentCapacity: 2 });
    const advance = (ms: number) => { now += ms; };

    for (let i = 0; i < 5; i++) {
      const timeline = completeCloudSpan(telemetry, (ms) => advance(ms + i), `su-${i}`);
      assertCompleteGatewayRequestTimeline(timeline);
    }
    const active = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
    active.routeSelected();

    const snapshot = telemetry.snapshot();
    expect(snapshot.requests).toMatchObject({
      started: 6,
      finalized: 5,
      active: 1,
      sampled: 5,
      coverage: 1,
      reconciled: true,
      outcomeReconciled: true,
      missingStageTimelines: 0,
    });
    expect(snapshot.outcomes.ok).toBe(5);
    expect(snapshot.outcomes.unclassified).toBe(0);
    expect(snapshot.stages.upstreamTtfb).toMatchObject({ count: 5, retained: 3 });
    expect(snapshot.stages.upstreamTtfb.p50).not.toBeNull();
    expect(snapshot.stages.upstreamTtfb.p95).not.toBeNull();
    expect(snapshot.stages.upstreamTtfb.p99).not.toBeNull();
    expect(snapshot.recent).toHaveLength(2);
  });

  it('makes a missing required stage a loud validation failure and counted telemetry defect', () => {
    let now = 10;
    const telemetry = new GatewayRequestTelemetry({ now: () => now });
    const span = telemetry.begin({ provider: 'claude', protocol: 'anthropic-messages' });
    now += 1;
    span.routeSelected();
    now += 1;
    span.admitted();
    // Deliberately omit body/auth/upstream stages.
    const timeline = span.finish('ok', 200)!;

    expect(() => assertCompleteGatewayRequestTimeline(timeline)).toThrow(/bodyRead.*upstreamTtfb.*auth/);
    const snapshot = telemetry.snapshot();
    expect(snapshot.requests.missingStageTimelines).toBe(1);
    expect(snapshot.missingStageByName.bodyRead).toBe(1);
    expect(snapshot.missingStageByName.auth).toBe(1);
    expect(snapshot.missingStageByName.upstreamTtfb).toBe(1);
  });

  it('attributes aggregate queueWait to typed durable/provider admission segments with queue state', () => {
    let now = 1_000;
    const telemetry = new GatewayRequestTelemetry({ now: () => now });
    const span = telemetry.begin({
      ownerId: 'su-latency',
      provider: 'codex',
      protocol: 'openai-responses',
      transport: 'oauth-http',
    });
    span.routeSelected();

    span.admissionQueued('payloadSpool');
    now += 5;
    span.admissionAdmitted('payloadSpool');

    span.admissionQueued('durable', { priority: 20 });
    now += 12;
    span.admissionAdmitted('durable', { priority: 20 });

    span.admissionQueued('provider', {
      priority: 20,
      tier: 2,
      queue: {
        running: 849,
        queued: 17,
        maxConcurrent: 850,
        tier1Reserve: 128,
        byTier: [{ tier: 2, minShare: 1, inFlight: 721, queued: 16 }],
      },
    });
    now += 66_110;
    span.admissionAdmitted('provider', {
      priority: 20,
      tier: 2,
      queue: {
        running: 850,
        queued: 16,
        maxConcurrent: 850,
        tier1Reserve: 128,
        byTier: [{ tier: 2, minShare: 1, inFlight: 722, queued: 15 }],
      },
    });
    span.admitted();
    span.beginStage('bodyRead');
    span.endStage('bodyRead');
    span.beginStage('auth');
    span.endStage('auth');
    span.recordAttempt();
    span.beginStage('upstreamTtfb');
    now += 3;
    span.endStage('upstreamTtfb');
    const timeline = span.finish('ok', 200)!;
    assertCompleteGatewayRequestTimeline(timeline);

    expect(timeline.durationsMs.queueWait).toBe(66_127);
    expect(timeline.admission).toEqual({
      payloadSpool: {
        queued: expect.objectContaining({ offsetMs: 0 }),
        admitted: expect.objectContaining({ offsetMs: 5 }),
        waitMs: 5,
      },
      durable: {
        queued: expect.objectContaining({ offsetMs: 5, priority: 20 }),
        admitted: expect.objectContaining({ offsetMs: 17, priority: 20 }),
        waitMs: 12,
      },
      provider: {
        queued: {
          offsetMs: 17,
          priority: 20,
          tier: 2,
          running: 849,
          queued: 17,
          maxConcurrent: 850,
          tier1Reserve: 128,
          tierMinShare: 1,
          tierInFlight: 721,
          tierQueued: 16,
        },
        admitted: {
          offsetMs: 66_127,
          priority: 20,
          tier: 2,
          running: 850,
          queued: 16,
          maxConcurrent: 850,
          tier1Reserve: 128,
          tierMinShare: 1,
          tierInFlight: 722,
          tierQueued: 15,
        },
        waitMs: 66_110,
      },
    });
    expect(telemetry.snapshotForOwner('su-latency').recent[0]?.admission.provider?.waitMs).toBe(66_110);
  });

  it('never retains arbitrary bodies, credentials, headers, URLs, or error prose', () => {
    let now = 100;
    const telemetry = new GatewayRequestTelemetry({ now: () => now });
    const seed = {
      ownerId: 'su safe owner\nBearer SECRET_TOKEN',
      provider: 'local' as const,
      protocol: 'openai-chat' as const,
      transport: 'local-http' as const,
      requestBody: 'PROMPT_SECRET',
      authorization: 'Bearer SECRET_TOKEN',
      url: 'https://secret.invalid/private',
    };
    const span = telemetry.begin(seed);
    span.routeSelected();
    span.admitted();
    span.beginStage('bodyRead');
    now += 1;
    span.endStage('bodyRead');
    span.setModel('model\nSECRET_MODEL_SUFFIX');
    span.recordAttempt();
    span.beginStage('upstreamTtfb');
    now += 1;
    span.endStage('upstreamTtfb');
    const timeline = span.finish('ok', 200)!;
    assertCompleteGatewayRequestTimeline(timeline);

    const serialized = JSON.stringify(telemetry.snapshot());
    expect(serialized).not.toContain('PROMPT_SECRET');
    expect(serialized).not.toContain('SECRET_TOKEN');
    expect(serialized).not.toContain('secret.invalid');
    expect(timeline.ownerId).toBe('su');
    expect(timeline.model).toBe('model?SECRET_MODEL_SUFFIX');
  });

  it('classifies one stable final outcome from status and terminal conditions', () => {
    expect(classifyGatewayTelemetryOutcome(200)).toBe('ok');
    expect(classifyGatewayTelemetryOutcome(400)).toBe('client-error');
    expect(classifyGatewayTelemetryOutcome(429)).toBe('upstream-429');
    expect(classifyGatewayTelemetryOutcome(503)).toBe('upstream-error');
    expect(classifyGatewayTelemetryOutcome(null, { cancelled: true })).toBe('cancelled');
    expect(classifyGatewayTelemetryOutcome(429, { shed: true })).toBe('shed');
    expect(classifyGatewayTelemetryOutcome(500, { gatewayError: true })).toBe('gateway-error');
    expect(classifyGatewayTelemetryOutcome(null)).toBe('unclassified');
  });

  it('adds owner summaries to the existing per-owner read without unbounded per-owner state', () => {
    let now = 1_000;
    const telemetry = new GatewayRequestTelemetry({ now: () => now, recentCapacity: 3 });
    for (const owner of ['su-a', 'su-b', 'su-a']) {
      completeCloudSpan(telemetry, (ms) => { now += ms; }, owner);
    }
    const owner = telemetry.snapshotForOwner('su-a');
    expect(owner.finalized).toBe(2);
    expect(owner.outcomes.ok).toBe(2);
    expect(owner.stages.total.count).toBe(2);
    expect(owner.recent.every((timeline) => timeline.ownerId === 'su-a')).toBe(true);
  });
});
