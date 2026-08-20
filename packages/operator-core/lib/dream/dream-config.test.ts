import { describe, expect, it } from 'vitest';
import { DEFAULT_DREAM_SAMPLER_CONFIG, DREAM_FRAGMENT_KINDS, resolveDreamSamplerConfig } from './dream-config';

describe('resolveDreamSamplerConfig', () => {
  it('ships the manual-cycle sampler defaults from the REM design', () => {
    expect(DREAM_FRAGMENT_KINDS).toEqual(['observation', 'work_item', 'memory', 'stat']);
    expect(DEFAULT_DREAM_SAMPLER_CONFIG).toMatchObject({
      recentWindowMs: 48 * 60 * 60 * 1_000,
      remoteMinAgeMs: 7 * 24 * 60 * 60 * 1_000,
      maxTextChars: 1_200,
      randomPartnerRate: 0.15,
    });
  });

  it('merges an override without mutating the defaults', () => {
    const resolved = resolveDreamSamplerConfig({ maxFragmentsPerKind: 8 });

    expect(resolved.maxFragmentsPerKind).toBe(8);
    expect(DEFAULT_DREAM_SAMPLER_CONFIG.maxFragmentsPerKind).toBe(64);
  });

  it.each([
    [{ recentWindowMs: 0 }, 'recentWindowMs'],
    [{ remoteMinAgeMs: 1 }, 'remoteMinAgeMs'],
    [{ maxTextChars: 1.5 }, 'maxTextChars'],
    [{ randomPartnerRate: 1.1 }, 'randomPartnerRate'],
    [{ minSimilarity: 0.9, maxSimilarity: 0.8 }, 'minSimilarity'],
  ] as const)('rejects invalid config %o', (override, message) => {
    expect(() => resolveDreamSamplerConfig(override)).toThrow(message);
  });
});
