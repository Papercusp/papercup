import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runNeologismMine } from './mine';
import { runNeologismTick } from './scan';
import { neologismOptionsFromPayload } from './miner-core';

// Unit: the tick / governor / miner-core each have their own suites; this pins the
// SHARED orchestration's two gates (flag → governor) and the pass-through to the
// tick (deterministic-blueprints-migration-2026-06-13 P-011, D-004 behavior-neutral).
vi.mock('./scan', () => ({ runNeologismTick: vi.fn(), defaultNeologismDeps: vi.fn() }));
vi.mock('./miner-core', () => ({ neologismOptionsFromPayload: vi.fn(() => ({ opt: 1 })) }));

const mockTick = vi.mocked(runNeologismTick);
const mockOpts = vi.mocked(neologismOptionsFromPayload);

const INPUT = { workspaceId: 'ws-1', installSlug: 'papercup', payload: { a: 1 } };
const TICK_DEPS = { sentinel: 'tickDeps' } as never;

describe('runNeologismMine — flag → governor → tick orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTick.mockResolvedValue({ minted: 2 } as unknown as Awaited<ReturnType<typeof runNeologismTick>>);
    mockOpts.mockReturnValue({ opt: 1 } as unknown as ReturnType<typeof neologismOptionsFromPayload>);
  });

  it('skips with flag-off when the miner flag is off (governor never consulted)', async () => {
    const gate = vi.fn();
    const out = await runNeologismMine(INPUT, { flag: async () => false, governorGate: gate, tickDeps: TICK_DEPS });
    expect(out).toEqual({ ran: false, skipReason: 'flag-off' });
    expect(gate).not.toHaveBeenCalled();
    expect(mockTick).not.toHaveBeenCalled();
  });

  it('skips with governor-refused (carrying the reason) when the governor declines', async () => {
    const out = await runNeologismMine(INPUT, {
      flag: async () => true,
      governorGate: async () => ({ allow: false, reason: 'budget exhausted' }) as never,
      tickDeps: TICK_DEPS,
    });
    expect(out).toEqual({ ran: false, skipReason: 'governor-refused', governorReason: 'budget exhausted' });
    expect(mockTick).not.toHaveBeenCalled();
  });

  it('runs the tick past both gates and returns its result', async () => {
    const out = await runNeologismMine(INPUT, {
      flag: async () => true,
      governorGate: async () => ({ allow: true }) as never,
      tickDeps: TICK_DEPS,
    });
    expect(mockOpts).toHaveBeenCalledWith({ a: 1 });
    expect(mockTick).toHaveBeenCalledWith('ws-1', TICK_DEPS, { opt: 1 });
    expect(out).toEqual({ ran: true, result: { minted: 2 } });
  });

  it('passes the install slug to the flag check', async () => {
    const flag = vi.fn(async () => false);
    await runNeologismMine(INPUT, { flag, tickDeps: TICK_DEPS });
    expect(flag).toHaveBeenCalledWith('papercup');
  });
});
