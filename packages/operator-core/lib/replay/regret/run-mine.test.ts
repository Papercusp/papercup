import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GovernorVerdict } from '../../learning-governor/core';

vi.mock('./governor', () => ({ regretGovernorGate: vi.fn() }));
vi.mock('./mine', () => ({ regretOptionsFromPayload: vi.fn(), runRegretTick: vi.fn() }));
vi.mock('./replay-adapter', () => ({ governedRegretRunner: vi.fn() }));
vi.mock('./store', () => ({ defaultRegretDeps: vi.fn() }));

import { runRegretMine } from './run-mine';
import { regretOptionsFromPayload, runRegretTick } from './mine';

const REFUSE: GovernorVerdict = { allow: false, reason: 'exhausted', remainingUsd: 0 };
const INPUT = { workspaceId: 'ws-1', installSlug: 'inst-1', payload: {} };

beforeEach(() => vi.clearAllMocks());

describe('runRegretMine — flag → governor → cap-bounded tick', () => {
  it('flag OFF short-circuits before the governor or tick', async () => {
    const governorGate = vi.fn();
    const out = await runRegretMine(INPUT, { flag: async () => false, governorGate, tickDeps: {} as never });
    expect(out).toEqual({ ran: false, skipReason: 'flag-off' });
    expect(governorGate).not.toHaveBeenCalled();
    expect(runRegretTick).not.toHaveBeenCalled();
  });

  it('governor REFUSE skips with the verdict reason, tick never runs', async () => {
    const out = await runRegretMine(INPUT, {
      flag: async () => true,
      governorGate: async () => REFUSE,
      tickDeps: {} as never,
    });
    expect(out).toEqual({ ran: false, skipReason: 'governor-refused', governorReason: 'exhausted' });
    expect(runRegretTick).not.toHaveBeenCalled();
  });

  it('both gates pass → clamps the replay budget DOWN to the governor per-cycle cap', async () => {
    // payload asks for $999 but the governor only has $5 remaining → bounded to $5.
    vi.mocked(regretOptionsFromPayload).mockReturnValue({ replayBudgetUsd: 999 } as never);
    vi.mocked(runRegretTick).mockResolvedValue({ mined: 3 } as never);
    const tickDeps = { sentinel: 'td' } as never;
    const out = await runRegretMine(INPUT, {
      flag: async () => true,
      governorGate: async () => ({ allow: true, remainingUsd: 5 }),
      tickDeps,
    });
    expect(out).toEqual({ ran: true, result: { mined: 3 } });
    expect(runRegretTick).toHaveBeenCalledWith('ws-1', tickDeps, expect.objectContaining({ replayBudgetUsd: 5 }));
  });

  it('a payload that LOWERS the budget below the cap is kept (cap only bounds, never raises)', async () => {
    vi.mocked(regretOptionsFromPayload).mockReturnValue({ replayBudgetUsd: 2 } as never);
    vi.mocked(runRegretTick).mockResolvedValue({ mined: 0 } as never);
    await runRegretMine(INPUT, {
      flag: async () => true,
      governorGate: async () => ({ allow: true, remainingUsd: 5 }),
      tickDeps: {} as never,
    });
    expect(runRegretTick).toHaveBeenCalledWith('ws-1', expect.anything(), expect.objectContaining({ replayBudgetUsd: 2 }));
  });
});
