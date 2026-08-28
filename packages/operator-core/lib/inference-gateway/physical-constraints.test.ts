import { describe, expect, it } from 'vitest';
import {
  adaptGatewayPhysicalConstraints,
  adaptGatewayTransport,
  adaptLocalBackendTelemetry,
  adaptOperationalHealth,
  adaptProviderHeaders,
  adaptProviderOutcome,
  attributeProviderOutcome,
  evaluatePhysicalConstraints,
  physicalConstraintsToHealthFrame,
  parseProviderReset,
  type PhysicalConstraintObservation,
} from './physical-constraints';

const NOW = 1_700_000_000_000;

function rowsFor(rows: readonly PhysicalConstraintObservation[], key: PhysicalConstraintObservation['key']) {
  return rows.filter((row) => row.key === key);
}

describe('inference-gateway physical-constraint adapters', () => {
  it('uses the canonical Anthropic header parsers and carries measured utilization/reset freshness', () => {
    const result = adaptProviderHeaders({
      provider: 'anthropic',
      accountId: 'acct-a',
      headers: {
        'anthropic-ratelimit-unified-5h-utilization': '0.81',
        'anthropic-ratelimit-unified-5h-reset': String((NOW + 60_000) / 1000),
        'anthropic-ratelimit-unified-7d-utilization': '0.24',
      },
      observedAtMs: NOW,
      nowMs: NOW + 1_000,
    });
    expect(result.windows).toEqual([
      expect.objectContaining({ window: '5h', utilization: 0.81, resetAtMs: NOW + 60_000, state: 'measured' }),
      expect.objectContaining({ window: '7d', utilization: 0.24, resetAtMs: null, state: 'measured' }),
    ]);
    expect(rowsFor(result.observations, 'provider.utilization')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          window: '5h',
          state: 'measured',
          value: 0.81,
          binding: 'external-physical-contract',
        }),
      ]),
    );
    expect(rowsFor(result.observations, 'provider.reset')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ window: '5h', state: 'measured', value: NOW + 60_000, unit: 'epoch-ms' }),
        expect.objectContaining({ window: '7d', state: 'unknown', value: null }),
      ]),
    );
  });

  it('keeps absent and old provider headers unknown/stale instead of defaulting to zero', () => {
    const absent = adaptProviderHeaders({ provider: 'codex', headers: {}, observedAtMs: NOW, nowMs: NOW });
    expect(absent.observations.every((row) => row.state === 'unknown' && row.value === null)).toBe(true);

    const stale = adaptProviderHeaders({
      provider: 'openai',
      headers: { 'x-ratelimit-limit-requests': '100', 'x-ratelimit-remaining-requests': '1' },
      observedAtMs: NOW,
      nowMs: NOW + 31_000,
    });
    expect(rowsFor(stale.observations, 'provider.utilization')[0]).toMatchObject({
      state: 'stale',
      value: null,
      reason: 'freshness-window-expired',
    });
  });

  it('parses OpenAI reset values without confusing duration, epoch seconds, and epoch milliseconds', () => {
    expect(parseProviderReset('10s', NOW)).toBe(NOW + 10_000);
    expect(parseProviderReset('10', NOW)).toBe(NOW + 10_000);
    expect(parseProviderReset('0', NOW)).toBe(NOW);
    expect(parseProviderReset('1.5', NOW)).toBe(NOW + 1_500);
    expect(parseProviderReset(String((NOW + 20_000) / 1000), NOW)).toBe(NOW + 20_000);
    expect(parseProviderReset(String(NOW + 30_000), NOW)).toBe(NOW + 30_000);
    expect(parseProviderReset('2m 3s', NOW)).toBe(NOW + 123_000);
    expect(parseProviderReset('2026-08-28T00:00:00Z', NOW)).toBe(Date.parse('2026-08-28T00:00:00Z'));
  });

  it('keeps reset-only windows measured while utilization is warming', () => {
    const result = adaptProviderHeaders({
      provider: 'openai',
      headers: { 'x-ratelimit-reset-requests': '10' },
      observedAtMs: NOW,
      nowMs: NOW,
    });
    expect(result.windows).toEqual([
      expect.objectContaining({ window: 'requests', utilization: null, resetAtMs: NOW + 10_000, state: 'measured' }),
    ]);
  });

  it('does not treat Codex inactive zero-reset sentinels as a live window', () => {
    const result = adaptProviderHeaders({
      provider: 'codex',
      headers: {
        'x-codex-primary-window-minutes': '0',
        'x-codex-primary-reset-at': '0',
        'x-codex-secondary-window-minutes': '0',
        'x-codex-secondary-reset-after-seconds': '0',
      },
      nowMs: NOW,
    });
    expect(result.windows).toEqual([
      expect.objectContaining({ window: 'unknown', state: 'unknown', utilization: null, resetAtMs: null }),
    ]);
    expect(result.observations.every((row) => row.state === 'unknown')).toBe(true);
  });

  it('attributes one bad account separately from a pool-wide provider pressure event', () => {
    const one = attributeProviderOutcome({
      provider: 'anthropic',
      accountId: 'acct-a',
      status: 429,
      usageCap: true,
      pool: { accountIds: ['acct-a', 'acct-b'], healthyAccountIds: ['acct-b'] },
    });
    expect(one).toMatchObject({
      scope: 'account',
      subjectId: 'acct-a',
      externalPhysicalContract: true,
      actionable: true,
    });

    const pool = attributeProviderOutcome({
      provider: 'anthropic',
      accountId: 'acct-a',
      status: 429,
      pool: { accountIds: ['acct-a', 'acct-b'], healthyAccountIds: [], allAccountsFailed: true },
    });
    expect(pool).toMatchObject({ scope: 'pool', subjectId: null, externalPhysicalContract: true, actionable: true });
  });

  it('distinguishes a dead proxy, a 529 upstream overload, and synthetic local policy', () => {
    const proxy = adaptProviderOutcome({
      provider: 'codex',
      accountId: 'acct-a',
      proxyId: 'proxy-a',
      outcome: 'stall',
      error: new Error('socket timeout'),
      nowMs: NOW,
    });
    expect(proxy.attribution).toMatchObject({ scope: 'proxy', subjectId: 'proxy-a', actionable: true });
    expect(proxy.observations).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'transport.stall', state: 'measured' })]),
    );

    const overload = adaptProviderOutcome({ provider: 'anthropic', status: 529, accountId: 'acct-a', nowMs: NOW });
    expect(overload.attribution).toMatchObject({ scope: 'provider', externalPhysicalContract: true });
    expect(overload.observations).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'provider.overload', constraint: true })]),
    );

    const synthetic = adaptProviderOutcome({
      provider: 'anthropic',
      status: 429,
      origin: 'gateway',
      synthetic: true,
      nowMs: NOW,
    });
    expect(synthetic.attribution).toMatchObject({
      scope: 'local-policy',
      externalPhysicalContract: false,
      actionable: false,
    });
    expect(synthetic.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'gateway.policy', actionable: false, binding: 'local-policy' }),
      ]),
    );
  });

  it('treats engine-reported local slots as physical, but registered maxConcurrent as policy only', () => {
    const measured = adaptLocalBackendTelemetry({
      backend: { id: 'llama-a', kind: 'llama-server', enabled: true, maxConcurrent: 4 },
      health: { healthy: true, lastCheckedAt: NOW, latencyMs: 8, error: null, consecutiveFailures: 0 },
      inFlight: 4,
      engine: {
        reported: true,
        authoritative: true,
        totalSlots: 4,
        freeSlots: 0,
        contextTokens: 131_072,
        observedAtMs: NOW,
        source: '/props',
      },
      nowMs: NOW,
    });
    expect(rowsFor(measured, 'backend.slots')[0]).toMatchObject({
      state: 'measured',
      value: 0,
      constraint: true,
      binding: 'external-physical-contract',
      actionable: true,
    });
    expect(rowsFor(measured, 'backend.policySlots')[0]).toMatchObject({
      value: 4,
      constraint: false,
      binding: 'local-policy',
      actionable: false,
    });

    const noEngine = adaptLocalBackendTelemetry({
      backend: { id: 'llama-b', kind: 'llama-server', enabled: true, maxConcurrent: 4 },
      nowMs: NOW,
    });
    expect(rowsFor(noEngine, 'backend.slots')[0]).toMatchObject({
      state: 'unknown',
      value: null,
      binding: 'external-physical-contract',
    });
  });

  it('does not turn a first cumulative counter sample into a false stall/429, then reports deltas', () => {
    const first = adaptGatewayTransport({
      stats: { upstreamErrors: 4, upstream429: 2, shed429: 1, stallsRecorded: 1 },
      nowMs: NOW,
    });
    expect(
      first
        .filter((row) => row.key === 'transport.stall' || row.key === 'provider.rateLimit')
        .every((row) => row.state === 'unknown'),
    ).toBe(true);

    const second = adaptGatewayTransport({
      stats: { upstreamErrors: 7, upstream429: 3, shed429: 2, stallsRecorded: 1 },
      prior: { upstreamErrors: 4, upstream429: 2, shed429: 1, stallsRecorded: 1 },
      nowMs: NOW + 2_000,
    });
    expect(second).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'transport.stall', state: 'measured', value: 3, constraint: true }),
        expect.objectContaining({ key: 'provider.rateLimit', state: 'measured', value: 1, constraint: true }),
        expect.objectContaining({
          key: 'gateway.policy',
          state: 'measured',
          value: 1,
          binding: 'local-policy',
          actionable: false,
        }),
      ]),
    );
  });

  it('keeps unconfigured proxy reachability unknown and identifies a configured all-down pool', () => {
    const absent = adaptGatewayTransport({ stats: {}, nowMs: NOW });
    expect(rowsFor(absent, 'transport.proxyReachability')[0]).toMatchObject({ state: 'unknown', value: null });
    const down = adaptGatewayTransport({
      stats: { egressProxyHealth: { configured: true, totalProxyEntries: 2, reachableProxyEntries: 0, allDown: true } },
      nowMs: NOW,
    });
    expect(rowsFor(down, 'transport.proxyReachability')[0]).toMatchObject({
      state: 'measured',
      value: false,
      constraint: true,
      actionable: true,
    });
  });

  it('rejects impossible negative counters/slots instead of turning them into pressure', () => {
    const counter = adaptGatewayTransport({
      stats: { upstream429: -1 },
      prior: { upstream429: -2 },
      nowMs: NOW,
    }).find((row) => row.key === 'provider.rateLimit');
    expect(counter).toMatchObject({ state: 'unknown', value: null });

    const slots = adaptLocalBackendTelemetry({
      backend: { id: 'bad', kind: 'llama-server', enabled: true, maxConcurrent: 4 },
      engine: { reported: true, freeSlots: -1, observedAtMs: NOW },
      nowMs: NOW,
    });
    expect(rowsFor(slots, 'backend.slots')[0]).toMatchObject({ state: 'unknown', value: null, actionable: false });

    const proxy = adaptGatewayTransport({
      stats: { egressProxyHealth: { configured: true, totalProxyEntries: 2, reachableProxyEntries: 3 } },
      nowMs: NOW,
    });
    expect(rowsFor(proxy, 'transport.proxyReachability')[0]).toMatchObject({ state: 'unknown', value: null });
  });

  it('marks queue depth as context-only while preserving direct DB/service/queue/governor failures', () => {
    const rows = adaptOperationalHealth({
      nowMs: NOW,
      database: { ok: false, observedAtMs: NOW, waitP95Ms: 40 },
      service: { ok: true, observedAtMs: NOW, waitP95Ms: 3 },
      queue: { ok: true, observedAtMs: NOW, writerLatencyP95Ms: 5, writerFailureRate: 0, depth: 10_000 },
      governor: {
        ok: true,
        observedAtMs: NOW,
        admissionLatencyP95Ms: 2,
        decisionLatencyP95Ms: 1,
        persistLatencyP95Ms: 3,
      },
    });
    expect(rowsFor(rows, 'database.health')[0]).toMatchObject({
      state: 'measured',
      value: false,
      constraint: true,
      actionable: true,
    });
    expect(rowsFor(rows, 'queue.depth')[0]).toMatchObject({
      value: 10_000,
      constraint: false,
      binding: 'context-only',
      actionable: false,
    });
    expect(rowsFor(rows, 'queue.writerFailureRate')[0]).toMatchObject({ value: 0, constraint: false });
  });

  it('aggregates freshness-aware rows and feeds the canonical health frame without inventing absent signals', () => {
    const physical = adaptGatewayPhysicalConstraints({
      nowMs: NOW,
      providerOutcomes: [{ provider: 'anthropic', accountId: 'acct-a', status: 429, usageCap: true, nowMs: NOW }],
      operational: { nowMs: NOW, service: { ok: true, observedAtMs: NOW, waitP95Ms: 4 } },
    });
    expect(physical.state).toBe('constrained');
    expect(physical.actionable).toBe(true);
    const frame = physicalConstraintsToHealthFrame(physical.observations, 'gateway', NOW);
    expect(frame.signals['provider.rateLimited']).toMatchObject({ state: 'measured', value: true });
    expect(frame.signals['service.waitP95Ms']).toMatchObject({ state: 'measured', value: 4 });
    expect(frame.signals['queue.writerLatencyP95Ms']).toBeUndefined();

    const contextOnly = evaluatePhysicalConstraints(
      [...adaptOperationalHealth({ nowMs: NOW, queue: { depth: 999, observedAtMs: NOW } })],
      [],
      NOW,
    );
    expect(contextOnly.state).toBe('unknown');
    expect(contextOnly.actionable).toBe(false);
  });

  it('does not call local policy evidence healthy and separates unscoped pressure from actionable pressure', () => {
    const policyOnly = evaluatePhysicalConstraints(
      adaptOperationalHealth({ nowMs: NOW, queue: { depth: 999, observedAtMs: NOW } }),
      [],
      NOW,
    );
    expect(policyOnly).toMatchObject({ state: 'unknown', constrained: false, actionable: false });

    const unscoped = adaptGatewayPhysicalConstraints({
      nowMs: NOW,
      providerOutcomes: [{ provider: 'anthropic', status: 429, nowMs: NOW }],
    });
    expect(unscoped).toMatchObject({ state: 'constrained', constrained: true, actionable: false });
  });

  it('preserves writer-scoped live-health observations and their units even without compact signals', () => {
    const reading = {
      state: 'measured',
      value: 2,
      unit: 'requests-per-second',
      writerId: 'queue-writer-a',
      observedAtMs: NOW,
      collectedAtMs: NOW,
      window: { kind: 'rolling', durationMs: 1_000, startedAtMs: NOW - 1_000, endedAtMs: NOW },
      confidence: 1,
      reason: null,
      lastMeasuredAtMs: NOW,
    };
    const rows = adaptOperationalHealth({
      nowMs: NOW,
      liveHealth: {
        signals: {},
        observations: { 'queue.arrivalRate': { 'queue-writer-a': reading } },
      } as never,
    });
    expect(rowsFor(rows, 'queue.depth')[0]).toMatchObject({
      state: 'measured',
      value: 2,
      unit: 'requests-per-second',
      binding: 'context-only',
    });
  });
});
