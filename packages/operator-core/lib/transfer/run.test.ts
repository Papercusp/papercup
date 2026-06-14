import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GovernorVerdict } from '../learning-governor/core';

vi.mock('./tick', () => ({ runTransferTick: vi.fn() }));
vi.mock('./gate', () => ({ transferOptionsFromPayload: vi.fn() }));
vi.mock('./governor', () => ({ transferGovernorGate: vi.fn() }));

import { runTransferDistill } from './run';
import { transferOptionsFromPayload } from './gate';
import { runTransferTick } from './tick';

const ALLOW: GovernorVerdict = { allow: true, remainingUsd: 5 };
const REFUSE: GovernorVerdict = { allow: false, reason: 'exhausted', remainingUsd: 0 };
const INPUT = { workspaceId: 'ws-1', installSlug: 'inst-1' };

beforeEach(() => vi.clearAllMocks());

describe('runTransferDistill — flag → governor → tick gating', () => {
  it('flag OFF short-circuits before the governor or tick', async () => {
    const governorGate = vi.fn();
    const out = await runTransferDistill(INPUT, { flag: async () => false, governorGate, tickDeps: {} as never });
    expect(out).toEqual({ ran: false, skipReason: 'flag-off' });
    expect(governorGate).not.toHaveBeenCalled();
    expect(runTransferTick).not.toHaveBeenCalled();
  });

  it('governor REFUSE skips with the verdict reason, tick never runs', async () => {
    const out = await runTransferDistill(INPUT, {
      flag: async () => true,
      governorGate: async () => REFUSE,
      tickDeps: {} as never,
    });
    expect(out).toEqual({ ran: false, skipReason: 'governor-refused', governorReason: 'exhausted' });
    expect(runTransferTick).not.toHaveBeenCalled();
  });

  it('both gates pass → runs the tick with (workspaceId, injected tickDeps, derived opts)', async () => {
    const opts = { repeats: 1 } as never;
    vi.mocked(transferOptionsFromPayload).mockReturnValue(opts);
    vi.mocked(runTransferTick).mockResolvedValue({ distilled: true } as never);
    const tickDeps = { sentinel: 'td' } as never;
    const out = await runTransferDistill(
      { ...INPUT, payload: { repeats: 1 } },
      { flag: async () => true, governorGate: async () => ALLOW, tickDeps },
    );
    expect(out).toEqual({ ran: true, result: { distilled: true } });
    expect(transferOptionsFromPayload).toHaveBeenCalledWith({ repeats: 1 });
    expect(runTransferTick).toHaveBeenCalledWith('ws-1', tickDeps, opts);
  });
});
