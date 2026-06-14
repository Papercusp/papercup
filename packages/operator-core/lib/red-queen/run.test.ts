import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GovernorVerdict } from '../learning-governor/core';

// Keep importing run.ts hermetic: the tick + governor graphs pull PG/sandbox.
vi.mock('./sandbox', () => ({ runRedQueenTick: vi.fn(), defaultDrillCycleDeps: vi.fn() }));
vi.mock('./governor', () => ({ redQueenGovernorGate: vi.fn() }));

import { runRedQueenDrill } from './run';
import { runRedQueenTick } from './sandbox';

const ALLOW: GovernorVerdict = { allow: true, remainingUsd: 5 };
const REFUSE: GovernorVerdict = { allow: false, reason: 'exhausted', remainingUsd: 0 };
const INPUT = { workspaceId: 'ws-1', installSlug: 'inst-1' };

beforeEach(() => vi.clearAllMocks());

describe('runRedQueenDrill — flag → governor → tick gating', () => {
  it('flag OFF short-circuits before the governor or tick', async () => {
    const governorGate = vi.fn();
    const out = await runRedQueenDrill(INPUT, { flag: async () => false, governorGate, cycleDeps: {} as never });
    expect(out).toEqual({ ran: false, skipReason: 'flag-off' });
    expect(governorGate).not.toHaveBeenCalled();
    expect(runRedQueenTick).not.toHaveBeenCalled();
  });

  it('governor REFUSE skips with the verdict reason, tick never runs', async () => {
    const out = await runRedQueenDrill(INPUT, {
      flag: async () => true,
      governorGate: async () => REFUSE,
      cycleDeps: {} as never,
    });
    expect(out).toEqual({ ran: false, skipReason: 'governor-refused', governorReason: 'exhausted' });
    expect(runRedQueenTick).not.toHaveBeenCalled();
  });

  it('both gates pass → runs the tick with the injected cycleDeps + payload classId', async () => {
    vi.mocked(runRedQueenTick).mockResolvedValue({ ok: true } as never);
    const cycleDeps = { sentinel: 'cd' } as never;
    const out = await runRedQueenDrill(
      { ...INPUT, payload: { classId: 'class-7' } },
      { flag: async () => true, governorGate: async () => ALLOW, cycleDeps },
    );
    expect(out).toEqual({ ran: true, result: { ok: true } });
    expect(runRedQueenTick).toHaveBeenCalledWith(cycleDeps, { classId: 'class-7' });
  });

  it('coerces a non-string payload.classId to undefined', async () => {
    vi.mocked(runRedQueenTick).mockResolvedValue({ ok: true } as never);
    await runRedQueenDrill(
      { ...INPUT, payload: { classId: 123 } },
      { flag: async () => true, governorGate: async () => ALLOW, cycleDeps: {} as never },
    );
    expect(runRedQueenTick).toHaveBeenCalledWith(expect.anything(), { classId: undefined });
  });
});
