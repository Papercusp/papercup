import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runNegativeSpaceMine } from './mine';
import { runNegativeSpaceTick } from './scan';
import { demandOptionsFromPayload } from './miner-core';

// Unit: the tick / governor / miner-core have their own suites; this pins the
// SHARED orchestration's two gates (flag → governor) and the tick pass-through —
// the sibling of runNeologismMine (deterministic-blueprints-migration P-010, D-004).
vi.mock('./scan', () => ({ runNegativeSpaceTick: vi.fn(), defaultNegativeSpaceDeps: vi.fn() }));
vi.mock('./miner-core', () => ({ demandOptionsFromPayload: vi.fn(() => ({ opt: 1 })) }));

const mockTick = vi.mocked(runNegativeSpaceTick);
const mockOpts = vi.mocked(demandOptionsFromPayload);

const INPUT = { workspaceId: 'ws-1', installSlug: 'papercup', payload: { a: 1 } };
const TICK_DEPS = { sentinel: 'tickDeps' } as never;

describe('runNegativeSpaceMine — flag → governor → tick orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTick.mockResolvedValue({ filed: ['x'] } as unknown as Awaited<ReturnType<typeof runNegativeSpaceTick>>);
    mockOpts.mockReturnValue({ opt: 1 } as unknown as ReturnType<typeof demandOptionsFromPayload>);
  });

  it('skips with flag-off when the miner flag is off (governor never consulted)', async () => {
    const gate = vi.fn();
    const out = await runNegativeSpaceMine(INPUT, { flag: async () => false, governorGate: gate, tickDeps: TICK_DEPS });
    expect(out).toEqual({ ran: false, skipReason: 'flag-off' });
    expect(gate).not.toHaveBeenCalled();
    expect(mockTick).not.toHaveBeenCalled();
  });

  it('skips with governor-refused (carrying the reason)', async () => {
    const out = await runNegativeSpaceMine(INPUT, {
      flag: async () => true,
      governorGate: async () => ({ allow: false, reason: 'budget exhausted' }) as never,
      tickDeps: TICK_DEPS,
    });
    expect(out).toEqual({ ran: false, skipReason: 'governor-refused', governorReason: 'budget exhausted' });
    expect(mockTick).not.toHaveBeenCalled();
  });

  it('runs the tick past both gates and returns its result', async () => {
    const out = await runNegativeSpaceMine(INPUT, {
      flag: async () => true,
      governorGate: async () => ({ allow: true }) as never,
      tickDeps: TICK_DEPS,
    });
    expect(mockOpts).toHaveBeenCalledWith({ a: 1 });
    expect(mockTick).toHaveBeenCalledWith('ws-1', TICK_DEPS, { opt: 1 });
    expect(out).toEqual({ ran: true, result: { filed: ['x'] } });
  });
});
