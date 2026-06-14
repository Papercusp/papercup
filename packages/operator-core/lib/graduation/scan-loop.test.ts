import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GovernorVerdict } from '../learning-governor/core';

vi.mock('./scan', () => ({
  defaultGraduationTickDeps: vi.fn(),
  graduationOptionsFromPayload: vi.fn(),
  runGraduationTick: vi.fn(),
}));
vi.mock('./governor', () => ({ graduationGovernorGate: vi.fn() }));

import { runGraduationScan } from './scan-loop';
import { graduationOptionsFromPayload, runGraduationTick } from './scan';

const ALLOW: GovernorVerdict = { allow: true, remainingUsd: 5 };
const REFUSE: GovernorVerdict = { allow: false, reason: 'exhausted', remainingUsd: 0 };
const INPUT = { workspaceId: 'ws-1', installSlug: 'inst-1', payload: null };

beforeEach(() => vi.clearAllMocks());

describe('runGraduationScan — flag → governor → tick gating', () => {
  it('flag OFF short-circuits before the governor or tick', async () => {
    const governorGate = vi.fn();
    const out = await runGraduationScan(INPUT, { flag: async () => false, governorGate, tickDeps: {} as never });
    expect(out).toEqual({ ran: false, skipReason: 'flag-off' });
    expect(governorGate).not.toHaveBeenCalled();
    expect(runGraduationTick).not.toHaveBeenCalled();
  });

  it('governor REFUSE skips with the verdict reason, tick never runs', async () => {
    const out = await runGraduationScan(INPUT, {
      flag: async () => true,
      governorGate: async () => REFUSE,
      tickDeps: {} as never,
    });
    expect(out).toEqual({ ran: false, skipReason: 'governor-refused', governorReason: 'exhausted' });
    expect(runGraduationTick).not.toHaveBeenCalled();
  });

  it('both gates pass → derives options from the payload + runs the tick with injected tickDeps', async () => {
    const opts = { widenAuto: false } as never;
    vi.mocked(graduationOptionsFromPayload).mockReturnValue(opts);
    vi.mocked(runGraduationTick).mockResolvedValue({ reports: 0 } as never);
    const tickDeps = { sentinel: 'td' } as never;
    const out = await runGraduationScan(
      { ...INPUT, payload: { dryRun: true } },
      { flag: async () => true, governorGate: async () => ALLOW, tickDeps },
    );
    expect(out).toEqual({ ran: true, result: { reports: 0 } });
    expect(graduationOptionsFromPayload).toHaveBeenCalledWith({ dryRun: true });
    expect(runGraduationTick).toHaveBeenCalledWith(tickDeps, opts);
  });
});
