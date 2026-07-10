import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./cadence-tick', () => ({ runHiveEvalCadenceTick: vi.fn() }));

import { runHiveEvalGen } from './gen-loop';
import { runHiveEvalCadenceTick } from './cadence-tick';

beforeEach(() => vi.clearAllMocks());

describe('runHiveEvalGen — cadence-tick passthrough', () => {
  it('threads the injected deps + (installSlug, payload) into the cadence tick', async () => {
    vi.mocked(runHiveEvalCadenceTick).mockResolvedValue({ ran: false } as never);
    const currentCodeSha = () => 'sha-xyz';
    const generationExists = vi.fn(async () => false);
    const runBattery = vi.fn(async () => {});
    const log = vi.fn();
    const out = await runHiveEvalGen(
      { workspaceId: 'ws-1', installSlug: 'inst-1', payload: { budgetUsd: 25 } },
      { currentCodeSha, generationExists, runBattery, log },
    );
    expect(out).toEqual({ ran: false });
    expect(runHiveEvalCadenceTick).toHaveBeenCalledTimes(1);
    const [deps, tickInput] = vi.mocked(runHiveEvalCadenceTick).mock.calls[0];
    expect(deps).toEqual(expect.objectContaining({ currentCodeSha, generationExists, runBattery, log }));
    expect(tickInput).toEqual({ installSlug: 'inst-1', payload: { budgetUsd: 25 } });
  });

  it('defaults a missing payload to null', async () => {
    vi.mocked(runHiveEvalCadenceTick).mockResolvedValue({ ran: false } as never);
    await runHiveEvalGen(
      { workspaceId: 'ws-1', installSlug: 'inst-1' },
      { currentCodeSha: () => 's', generationExists: async () => false, runBattery: async () => {}, log: vi.fn() },
    );
    const [, tickInput] = vi.mocked(runHiveEvalCadenceTick).mock.calls[0];
    expect(tickInput).toEqual({ installSlug: 'inst-1', payload: null });
  });
});
