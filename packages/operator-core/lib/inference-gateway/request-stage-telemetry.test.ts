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
