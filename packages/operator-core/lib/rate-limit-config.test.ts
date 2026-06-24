/**
 * Gap 4 — clampRateLimitConfig malformed-input table (rate-limit-config.ts:49-60).
 *
 * The safety floor below the route validator: it must coerce ANY arbitrary input into a
 * valid `{ maxSimultaneousAgents, concurrencyFloor }` — null/undefined/{}, out-of-range,
 * non-integer, NaN, and a floor that exceeds max (clamped to max). The resource-profile
 * seed (the DEFAULT used when no value is present) is mocked to a fixed 8 so the
 * profile-default cases are deterministic regardless of the host this runs on.
 */
import { describe, it, expect, vi } from 'vitest';

const { PROFILE_DEFAULT_MAX } = vi.hoisted(() => ({ PROFILE_DEFAULT_MAX: 8 }));

vi.mock('@papercusp/sse', () => ({ getChannel: () => ({ onPublish: () => () => {}, publish: () => {} }) }));
vi.mock('@papercusp/papercusp-shared/agent', () => ({
  setGlobalConcurrencyCap: () => {},
  setGlobalConcurrencyFloor: () => {},
  setProviderFloorOverride: () => {},
  setAimdTuning: () => {},
  AIMD_CLEAN_TURNS_PER_STEP: 5,
}));
vi.mock('./operator-state-pg', () => ({ readOperatorState: async () => null, writeOperatorState: async () => {} }));
vi.mock('./resource-profile', () => ({
  getResourceProfile: () => ({ maxSimultaneousAgents: PROFILE_DEFAULT_MAX }),
}));

import { clampRateLimitConfig, RATE_LIMIT_MAX_CEILING } from './rate-limit-config';

describe('clampRateLimitConfig (Gap 4 — malformed-input coercion)', () => {
  const cases: Array<{ name: string; input: unknown; expect: { maxSimultaneousAgents: number; concurrencyFloor: number } }> = [
    { name: 'null → profile defaults', input: null, expect: { maxSimultaneousAgents: PROFILE_DEFAULT_MAX, concurrencyFloor: 1 } },
    { name: 'undefined → profile defaults', input: undefined, expect: { maxSimultaneousAgents: PROFILE_DEFAULT_MAX, concurrencyFloor: 1 } },
    { name: 'empty object → profile defaults', input: {}, expect: { maxSimultaneousAgents: PROFILE_DEFAULT_MAX, concurrencyFloor: 1 } },
    { name: 'max:0 clamps up to the floor of 1', input: { maxSimultaneousAgents: 0 }, expect: { maxSimultaneousAgents: 1, concurrencyFloor: 1 } },
    { name: 'max:1000 clamps down to the ceiling (64)', input: { maxSimultaneousAgents: 1000 }, expect: { maxSimultaneousAgents: RATE_LIMIT_MAX_CEILING, concurrencyFloor: 1 } },
    { name: 'max:NaN → profile default', input: { maxSimultaneousAgents: Number.NaN }, expect: { maxSimultaneousAgents: PROFILE_DEFAULT_MAX, concurrencyFloor: 1 } },
    { name: 'max:3.7 floors to 3 (Math.floor)', input: { maxSimultaneousAgents: 3.7 }, expect: { maxSimultaneousAgents: 3, concurrencyFloor: 1 } },
    { name: 'concurrencyFloor:-5 clamps up to 1', input: { concurrencyFloor: -5 }, expect: { maxSimultaneousAgents: PROFILE_DEFAULT_MAX, concurrencyFloor: 1 } },
    { name: 'floor that exceeds max is clamped down to max', input: { maxSimultaneousAgents: 4, concurrencyFloor: 10 }, expect: { maxSimultaneousAgents: 4, concurrencyFloor: 4 } },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(clampRateLimitConfig(c.input as never)).toEqual(c.expect);
    });
  }

  it('a non-number max (string) → profile default (typeof guard, not Number coercion)', () => {
    expect(clampRateLimitConfig({ maxSimultaneousAgents: '12' } as never).maxSimultaneousAgents).toBe(PROFILE_DEFAULT_MAX);
  });
});

describe('clampRateLimitConfig — P-021 providerFloors + aimd', () => {
  it('omits providerFloors / aimd entirely when absent (byte-identical base config)', () => {
    const cfg = clampRateLimitConfig({ maxSimultaneousAgents: 4 });
    expect(cfg).toEqual({ maxSimultaneousAgents: 4, concurrencyFloor: 1 });
    expect('providerFloors' in cfg).toBe(false);
    expect('aimd' in cfg).toBe(false);
  });

  it('keeps valid per-provider floors and drops invalid fields / empty entries', () => {
    const cfg = clampRateLimitConfig({
      providerFloors: {
        anthropic: { maxConcurrent: 2, rpm: 30 },
        openai: { rpm: -5 }, // invalid → entry dropped
        unknown: { maxConcurrent: 3.9 }, // floors to 3
      },
    } as never);
    expect(cfg.providerFloors).toEqual({ anthropic: { maxConcurrent: 2, rpm: 30 }, unknown: { maxConcurrent: 3 } });
  });

  it('clamps aimd: keeps a valid decreaseFactor ∈ (0,1) + cleanTurnsPerStep, drops out-of-range', () => {
    expect(clampRateLimitConfig({ aimd: { decreaseFactor: 0.25, cleanTurnsPerStep: 3 } } as never).aimd).toEqual({
      decreaseFactor: 0.25,
      cleanTurnsPerStep: 3,
    });
    // decreaseFactor must be strictly inside (0,1); 1 and 0 are rejected → aimd dropped.
    expect('aimd' in clampRateLimitConfig({ aimd: { decreaseFactor: 1 } } as never)).toBe(false);
  });
});
