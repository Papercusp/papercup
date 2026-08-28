import { describe, expect, it } from 'vitest';
import type { HealthResource, HealthSeverity, HealthVerdict } from '../resource-governor/health-analysis';
import { HEALTH_ANALYSIS_SCHEMA_VERSION } from '../resource-governor/health-analysis';
import {
  CAPLESS_GATEWAY_ADAPTER_SCHEMA_VERSION,
  InMemoryCaplessGatewayStateStore,
  CaplessGatewayAdmissionAdapter,
} from './capless-adapter';

const START = 1_700_000_000_000;

function verdict(input: {
  state?: HealthVerdict['state'];
  severity?: HealthSeverity;
  resource?: HealthResource;
  atMs?: number;
} = {}): HealthVerdict {
  const state = input.state ?? 'healthy';
  const severity = input.severity ?? 'none';
  const resource = input.resource;
  const actionable = state === 'degraded' && resource !== undefined;
  return {
    schemaVersion: HEALTH_ANALYSIS_SCHEMA_VERSION,
    scopeId: 'gateway-test',
    evaluatedAtMs: input.atMs ?? START,
    state,
    severity,
    actionable,
    evidence: actionable
      ? [{
          objectiveId: 'gateway-test-objective',
          signal: resource === 'provider' ? 'provider.rateLimited' : 'cpu.psiSomePct',
          resource,
          readingState: 'measured',
          value: 100,
          confidence: 1,
          baseline: null,
          warningBoundary: 20,
          criticalBoundary: 50,
          inflationRatio: 10,
          breached: true,
          severity,
          quality: 'actionable',
          reason: 'test',
        }]
      : [],
    attributions: actionable
      ? [{
          objectiveId: 'gateway-test-objective',
          outcomeSignal: resource === 'provider' ? 'provider.rateLimited' : 'cpu.psiSomePct',
          causeSignal: resource === 'provider' ? 'provider.rateLimited' : 'cpu.psiSomePct',
          resource,
          confidence: 1,
          correlation: 1,
          temporallyAligned: true,
          actionable: true,
          reason: 'test',
        }]
      : [],
    actionableResources: resource ? [resource] : [],
    ignoredCapacitySignals: [],
    reasons: ['test'],
  };
}

function lane(adapter: CaplessGatewayAdmissionAdapter, name: string) {
  const found = adapter.latest?.classes.find((item) => item.admissionClass === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
}

describe('capless inference-gateway adapter', () => {
  it('uses a legacy value only as a seed and probes beyond 24/64/256/300', async () => {
    const store = new InMemoryCaplessGatewayStateStore();
    const adapter = new CaplessGatewayAdmissionAdapter({
      stateStore: store,
      legacyInitialWindow: 24,
      healthySamplesPerIncrease: 1,
      now: () => START,
    });
    let decision = await adapter.step({
      verdict: verdict(),
      requests: [{ kind: 'claude', idempotencyKey: 'seed:0' }],
    });
    for (let i = 1; i <= 300; i += 1) {
      decision = await adapter.step({
        verdict: verdict({ atMs: START + i }),
        requests: [{ kind: 'claude', idempotencyKey: `seed:${i}` }],
      });
    }
    expect(decision.classes.find((item) => item.admissionClass === 'inference')?.desiredWindow).toBe(325);
    expect(adapter.state().controller).not.toHaveProperty('cap');
    expect(adapter.state().legacySeed?.window).toBe(24);
  });

  it('persists desired/effective state and restores it without a permanent cap', async () => {
    const store = new InMemoryCaplessGatewayStateStore();
    let now = START;
    const first = new CaplessGatewayAdmissionAdapter({
      stateStore: store,
      legacyInitialWindow: 24,
      healthySamplesPerIncrease: 1,
      contractionCooldownMs: 0,
      now: () => now,
    });
    await first.step({
      verdict: verdict({ state: 'degraded', severity: 'critical', resource: 'provider' }),
      classes: [
        { admissionClass: 'inference', inFlight: 9, demand: { providerRequests: 1 } },
        { admissionClass: 'embedding', inFlight: 1, demand: { providerRequests: 1 } },
        { admissionClass: 'control', inFlight: 1, demand: { providerRequests: 1 } },
      ],
    });
    expect(lane(first, 'inference').desiredWindow).toBe(13);
    expect(lane(first, 'embedding').desiredWindow).toBe(22);
    expect(lane(first, 'control').desiredWindow).toBe(24);

    now += 1_000;
    const restored = new CaplessGatewayAdmissionAdapter({
      stateStore: store,
      healthySamplesPerIncrease: 1,
      contractionCooldownMs: 0,
      now: () => now,
    });
    await restored.ready();
    expect(restored.decisionFor('inference')).toBeNull();
    const recovered = await restored.step({
      verdict: verdict({ atMs: now }),
      classes: [{ admissionClass: 'inference', demand: { providerRequests: 1 } }],
    });
    expect(recovered.classes.find((item) => item.admissionClass === 'inference')?.desiredWindow).toBe(14);
    expect(recovered.classes.find((item) => item.admissionClass === 'control')?.protected).toBe(true);
  });

  it('drops compatibility seed metadata after its expiry while retaining learned state', async () => {
    const store = new InMemoryCaplessGatewayStateStore();
    let now = START;
    const adapter = new CaplessGatewayAdmissionAdapter({
      stateStore: store,
      legacyInitialWindow: 64,
      legacySeedTtlMs: 10,
      healthySamplesPerIncrease: 1,
      now: () => now,
    });
    await adapter.step({
      verdict: verdict(),
      classes: [{ admissionClass: 'inference', demand: { providerRequests: 1 } }],
    });
    now += 11;
    await adapter.persist(now);
    const saved = await store.load(adapter.stateKey);
    expect(saved?.schemaVersion).toBe(CAPLESS_GATEWAY_ADAPTER_SCHEMA_VERSION);
    expect(saved).not.toHaveProperty('legacySeed');
    expect(saved?.controller.classes[0]?.desiredWindow).toBe(65);
  });
});
