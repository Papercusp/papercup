import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GovernorVerdict } from '../learning-governor/core';

vi.mock('./scan', () => ({
  defaultFleetEkgDeps: vi.fn(),
  ekgOptionsFromPayload: vi.fn(),
  runFleetEkgTick: vi.fn(),
}));
vi.mock('./governor', () => ({ fleetEkgGovernorGate: vi.fn() }));

import { runFleetEkgScan } from './run';
import { ekgOptionsFromPayload, runFleetEkgTick } from './scan';

const ALLOW: GovernorVerdict = { allow: true, remainingUsd: 5 };
const REFUSE: GovernorVerdict = { allow: false, reason: 'exhausted', remainingUsd: 0 };
const INPUT = { workspaceId: 'ws-1', installSlug: 'inst-1', payload: null };

beforeEach(() => vi.clearAllMocks());

describe('runFleetEkgScan — flag → governor → tick gating', () => {
  it('flag OFF short-circuits before the governor or tick', async () => {
    const governorGate = vi.fn();
    const out = await runFleetEkgScan(INPUT, { flag: async () => false, governorGate, tickDeps: {} as never });
    expect(out).toEqual({ ran: false, skipReason: 'flag-off' });
    expect(governorGate).not.toHaveBeenCalled();
    expect(runFleetEkgTick).not.toHaveBeenCalled();
  });

  it('governor REFUSE skips with the verdict reason, tick never runs', async () => {
    const out = await runFleetEkgScan(INPUT, {
      flag: async () => true,
      governorGate: async () => REFUSE,
      tickDeps: {} as never,
    });
    expect(out).toEqual({ ran: false, skipReason: 'governor-refused', governorReason: 'exhausted' });
    expect(runFleetEkgTick).not.toHaveBeenCalled();
  });

  it('both gates pass → runs the tick with (workspaceId, injected tickDeps, derived opts)', async () => {
    const opts = { sample: 10 } as never;
    vi.mocked(ekgOptionsFromPayload).mockReturnValue(opts);
    vi.mocked(runFleetEkgTick).mockResolvedValue({ scanned: 3 } as never);
    const tickDeps = { sentinel: 'td' } as never;
    const out = await runFleetEkgScan(
      { ...INPUT, payload: { sample: 10 } },
      { flag: async () => true, governorGate: async () => ALLOW, tickDeps },
    );
    expect(out).toEqual({ ran: true, result: { scanned: 3 } });
    expect(runFleetEkgTick).toHaveBeenCalledWith('ws-1', tickDeps, opts);
  });
});
