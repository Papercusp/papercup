import { describe, it, expect } from 'vitest';
import { resolveGovernorPauseOutcome } from './worker-chunk-loop-runner';

/**
 * EI-6503 — unit coverage for the governor-pause abort decision, without
 * exercising `defaultRunWorkerChunkLoop`'s heavy mock-only dependency graph
 * (resolveProject/getOrgPg/buildChunkLockCoordinator/governorForBackend).
 */
describe('resolveGovernorPauseOutcome', () => {
  it('aborts when there is no gateway egress anywhere', () => {
    const out = resolveGovernorPauseOutcome({});
    expect(out).toEqual({ abort: true, gatewayEgress: false });
  });

  it('proceeds (does not abort) when extraSpawnEnv carries the gateway base URL', () => {
    const out = resolveGovernorPauseOutcome({ extraSpawnEnvBaseUrl: 'https://gateway.internal' });
    expect(out).toEqual({ abort: false, gatewayEgress: true });
  });

  it('proceeds when only process.env carries the gateway base URL', () => {
    const out = resolveGovernorPauseOutcome({ processEnvBaseUrl: 'https://gateway.internal' });
    expect(out).toEqual({ abort: false, gatewayEgress: true });
  });

  it('extraSpawnEnv takes precedence but either source alone is sufficient', () => {
    const out = resolveGovernorPauseOutcome({
      extraSpawnEnvBaseUrl: 'https://gateway.internal',
      processEnvBaseUrl: 'https://other',
    });
    expect(out.abort).toBe(false);
    expect(out.gatewayEgress).toBe(true);
  });

  it('treats an empty-string base URL as absent (falsy), matching the !! coercion', () => {
    const out = resolveGovernorPauseOutcome({ extraSpawnEnvBaseUrl: '', processEnvBaseUrl: '' });
    expect(out).toEqual({ abort: true, gatewayEgress: false });
  });
});
