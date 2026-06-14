import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GovernorVerdict } from '../learning-governor/core';

vi.mock('./refit', () => ({ defaultDeferralRefitDeps: vi.fn(), runDeferralInterestRefit: vi.fn() }));
vi.mock('./governor', () => ({ deferralInterestGovernorGate: vi.fn() }));

import { runDeferralInterestRefitGated } from './refit-loop';
import { runDeferralInterestRefit } from './refit';

const ALLOW: GovernorVerdict = { allow: true, remainingUsd: 5 };
const REFUSE: GovernorVerdict = { allow: false, reason: 'exhausted', remainingUsd: 0 };
const INPUT = { workspaceId: 'ws-1', installSlug: 'inst-1' };

beforeEach(() => vi.clearAllMocks());

describe('runDeferralInterestRefitGated — flag → governor → tick gating', () => {
  it('flag OFF short-circuits before the governor or tick', async () => {
    const governorGate = vi.fn();
    const out = await runDeferralInterestRefitGated(INPUT, {
      flag: async () => false,
      governorGate,
      tickDeps: {} as never,
    });
    expect(out).toEqual({ ran: false, skipReason: 'flag-off' });
    expect(governorGate).not.toHaveBeenCalled();
    expect(runDeferralInterestRefit).not.toHaveBeenCalled();
  });

  it('governor REFUSE skips with the verdict reason, tick never runs', async () => {
    const out = await runDeferralInterestRefitGated(INPUT, {
      flag: async () => true,
      governorGate: async () => REFUSE,
      tickDeps: {} as never,
    });
    expect(out).toEqual({ ran: false, skipReason: 'governor-refused', governorReason: 'exhausted' });
    expect(runDeferralInterestRefit).not.toHaveBeenCalled();
  });

  it('both gates pass → runs the refit tick with the injected tickDeps', async () => {
    vi.mocked(runDeferralInterestRefit).mockResolvedValue({ refit: 2 } as never);
    const tickDeps = { sentinel: 'td' } as never;
    const out = await runDeferralInterestRefitGated(INPUT, {
      flag: async () => true,
      governorGate: async () => ALLOW,
      tickDeps,
    });
    expect(out).toEqual({ ran: true, result: { refit: 2 } });
    expect(runDeferralInterestRefit).toHaveBeenCalledWith(tickDeps);
  });
});
