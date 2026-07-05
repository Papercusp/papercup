/**
 * rate_limit_config.test.ts — the operator:rate_limit_config HANDLER (read/write config
 * mocked). Pins: get returns the config; set is GUARDED twice — role must carry operator-
 * config write authority (operator | architect | queen, via isOperatorConfigWriteRole; else
 * throw) and at least one field must be provided (else throw); and a set MERGES with current
 * (an omitted field keeps its existing value). A regression that lets a bee throttle the
 * fleet, that drops the merge (zeroing an unspecified knob), OR that re-excludes the
 * operator-equivalent queen (EI-2204 — she could invoke but not `set`, blocking the clean
 * path to reset a jammed concurrency ceiling), is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/operator/rate_limit_config.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../rate-limit-config', () => ({
  RATE_LIMIT_MAX_CEILING: 64,
  // Mirrors the real export; the SUT imports it and the mock replaces the whole
  // module, so it must be present (it lagged when rate-limit-config.ts added it).
  GOVERNOR_PROVIDERS: ['anthropic', 'openai', 'unknown'] as const,
  readRateLimitConfig: vi.fn(),
  writeRateLimitConfig: vi.fn(),
}));

import { readRateLimitConfig, writeRateLimitConfig } from '../../rate-limit-config';
const readM = vi.mocked(readRateLimitConfig);
const writeM = vi.mocked(writeRateLimitConfig);
const tool = (await import('./rate_limit_config')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown>, role = 'operator') =>
  tool.handler(args as never, { role } as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  readM.mockResolvedValue({ maxSimultaneousAgents: 16, concurrencyFloor: 2 } as never);
  writeM.mockImplementation(async (c) => c as never);
});

describe('operator:rate_limit_config', () => {
  it('get returns the persisted config (no role gate)', async () => {
    const b = body(await call({ op: 'get' }, 'cup'));
    expect(b).toMatchObject({ config: { maxSimultaneousAgents: 16, concurrencyFloor: 2 } });
  });

  it('set rejects a role without operator-config write authority (e.g. bee)', async () => {
    await expect(call({ op: 'set', maxSimultaneousAgents: 4 }, 'cup')).rejects.toThrow(/operator, architect, or queen/);
    expect(writeM).not.toHaveBeenCalled();
  });

  it('set ACCEPTS the queen (operator-equivalent, EI-2204) — she is no longer rejected', async () => {
    const b = body(await call({ op: 'set', maxSimultaneousAgents: 4 }, 'mug'));
    expect(writeM).toHaveBeenCalledWith({ maxSimultaneousAgents: 4, concurrencyFloor: 2 });
    expect(b).toMatchObject({ ok: true, config: { maxSimultaneousAgents: 4, concurrencyFloor: 2 } });
  });

  it('set ACCEPTS architect (historical operator-config writer)', async () => {
    const b = body(await call({ op: 'set', concurrencyFloor: 3 }, 'architect'));
    expect(writeM).toHaveBeenCalledWith({ maxSimultaneousAgents: 16, concurrencyFloor: 3 });
    expect(b).toMatchObject({ ok: true });
  });

  it('set requires at least one field', async () => {
    await expect(call({ op: 'set' }, 'operator')).rejects.toThrow(/maxSimultaneousAgents/);
  });

  it('set merges with current — an omitted field keeps its existing value', async () => {
    const b = body(await call({ op: 'set', maxSimultaneousAgents: 4 }, 'operator'));
    expect(writeM).toHaveBeenCalledWith({ maxSimultaneousAgents: 4, concurrencyFloor: 2 });
    expect(b).toMatchObject({ ok: true, config: { maxSimultaneousAgents: 4, concurrencyFloor: 2 } });
  });
});
