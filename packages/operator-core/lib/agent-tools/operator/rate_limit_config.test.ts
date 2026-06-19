/**
 * rate_limit_config.test.ts — the operator:rate_limit_config HANDLER (read/write config
 * mocked). Pins: get returns the config; set is GUARDED twice — role must be operator|
 * architect (else throw) and at least one field must be provided (else throw); and a set
 * MERGES with current (an omitted field keeps its existing value). A regression that lets
 * a bee throttle the fleet, or drops the merge (zeroing an unspecified knob), is what
 * this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/operator/rate_limit_config.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../rate-limit-config', () => ({
  RATE_LIMIT_MAX_CEILING: 64,
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
    const b = body(await call({ op: 'get' }, 'bee'));
    expect(b).toMatchObject({ config: { maxSimultaneousAgents: 16, concurrencyFloor: 2 } });
  });

  it('set requires operator|architect role', async () => {
    await expect(call({ op: 'set', maxSimultaneousAgents: 4 }, 'bee')).rejects.toThrow(/operator or architect/);
    expect(writeM).not.toHaveBeenCalled();
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
