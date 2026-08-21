/**
 * Gap 4 — clampRateLimitConfig malformed-input table (rate-limit-config.ts:49-60).
 *
 * The safety floor below the route validator: it must coerce ANY arbitrary input into a
 * valid `{ maxSimultaneousAgents, concurrencyFloor }` — null/undefined/{}, out-of-range,
 * non-integer, NaN, and a floor that exceeds max (clamped to max). The resource-profile
 * seed (the DEFAULT used when no value is present) is mocked to a fixed 8 so the
 * profile-default cases are deterministic regardless of the host this runs on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { PROFILE_DEFAULT_MAX } = vi.hoisted(() => ({ PROFILE_DEFAULT_MAX: 8 }));

// EI-18106936190883400 (cross-process NOTIFY): a fake NotifyBus whose `subscribe` just
// records the handler (so the test can fire it directly, standing in for a peer process's
// pg_notify) instead of opening a real PG LISTEN connection.
const h = vi.hoisted(() => ({
  notifySubscribers: new Map<string, (payload: string) => void>(),
  createNotifyBus: vi.fn((channel: string) => ({
    subscribe: (handler: (payload: string) => void) => {
      h.notifySubscribers.set(channel, handler);
      return () => h.notifySubscribers.delete(channel);
    },
    _stopForTests: async () => {},
  })),
  sqlTag: vi.fn(() => Promise.resolve([])),
  setGlobalConcurrencyCap: vi.fn(),
  storedConfig: null as unknown,
  readShouldThrow: false,
}));

vi.mock('@papercusp/sse', () => ({ getChannel: () => ({ onPublish: () => () => {}, publish: () => {} }) }));
vi.mock('@papercusp/papercusp-shared/agent', () => ({
  setGlobalConcurrencyCap: h.setGlobalConcurrencyCap,
  setGlobalConcurrencyFloor: () => {},
  setProviderFloorOverride: () => {},
  setAimdTuning: () => {},
  AIMD_CLEAN_TURNS_PER_STEP: 5,
}));
vi.mock('./operator-state-pg', () => ({
  readOperatorState: async () => {
    if (h.readShouldThrow) throw new Error('PG down');
    return h.storedConfig;
  },
  writeOperatorState: async (_key: string, value: unknown) => {
    h.storedConfig = value;
  },
}));
vi.mock('./resource-profile', () => ({
  getResourceProfile: () => ({ maxSimultaneousAgents: PROFILE_DEFAULT_MAX }),
}));
vi.mock('./pg-notify-bus', () => ({ createNotifyBus: h.createNotifyBus }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sqlTag }) }));

import {
  clampRateLimitConfig,
  RATE_LIMIT_MAX_CEILING,
  initRateLimitConfig,
  writeRateLimitConfig,
  getCachedRateLimitConfig,
  __resetRateLimitConfigForTest,
} from './rate-limit-config';

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

describe('cross-process NOTIFY propagation (EI-18106936190883400)', () => {
  const NOTIFY_CHANNEL = 'papercusp_rate_limit_config_changed';

  beforeEach(() => {
    __resetRateLimitConfigForTest();
    h.notifySubscribers.clear();
    h.setGlobalConcurrencyCap.mockClear();
    h.sqlTag.mockClear();
    h.createNotifyBus.mockClear();
    h.storedConfig = null;
  });

  it('initRateLimitConfig subscribes to the shared NOTIFY_CHANNEL', async () => {
    await initRateLimitConfig();
    expect(h.createNotifyBus).toHaveBeenCalledWith(NOTIFY_CHANNEL, expect.any(String));
    expect(h.notifySubscribers.has(NOTIFY_CHANNEL)).toBe(true);
  });

  it('writeRateLimitConfig pg_notify()s the channel after persisting (so peer processes resync)', async () => {
    await initRateLimitConfig();
    await writeRateLimitConfig({ maxSimultaneousAgents: 12 });
    expect(h.sqlTag).toHaveBeenCalledTimes(1);
    // tagged-template call: first arg is the strings array containing the SELECT pg_notify text.
    const [strings] = h.sqlTag.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('')).toContain('pg_notify');
  });

  it("a peer process's NOTIFY re-reads PG (not the stale local `cached`) and re-applies — this is the divergence fix", async () => {
    // Simulate THIS process booting with an already-stale cached value (its own last write).
    h.storedConfig = { maxSimultaneousAgents: 6, concurrencyFloor: 1 };
    await initRateLimitConfig();
    expect(getCachedRateLimitConfig().maxSimultaneousAgents).toBe(6);
    h.setGlobalConcurrencyCap.mockClear();

    // A PEER process now writes 24 directly to PG (bypassing this process's writeRateLimitConfig
    // entirely) and fires the NOTIFY this process is listening for.
    h.storedConfig = { maxSimultaneousAgents: 24, concurrencyFloor: 1 };
    const handler = h.notifySubscribers.get(NOTIFY_CHANNEL);
    expect(handler).toBeTypeOf('function');
    handler?.('');
    // The resync is async (readOperatorState().then(applyCached)) — flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(getCachedRateLimitConfig().maxSimultaneousAgents).toBe(24);
    expect(h.setGlobalConcurrencyCap).toHaveBeenLastCalledWith(24);
  });

  it('a resync failure (readOperatorState rejects) leaves the prior cached value in place — never throws', async () => {
    h.storedConfig = { maxSimultaneousAgents: 6, concurrencyFloor: 1 };
    await initRateLimitConfig();
    expect(getCachedRateLimitConfig().maxSimultaneousAgents).toBe(6);

    h.readShouldThrow = true;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = h.notifySubscribers.get(NOTIFY_CHANNEL);
    handler?.('');
    await Promise.resolve();
    await Promise.resolve();
    expect(getCachedRateLimitConfig().maxSimultaneousAgents).toBe(6); // unchanged
    expect(errSpy).toHaveBeenCalledWith('[rate-limit-config] cross-process resync failed:', expect.any(Error));
    errSpy.mockRestore();
    h.readShouldThrow = false;
  });
});
