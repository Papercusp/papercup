import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./cadence-tick', () => ({ runBenchmarkCadenceTick: vi.fn() }));

import { runIqBatteryGen } from './gen-loop';
import { runBenchmarkCadenceTick } from './cadence-tick';

beforeEach(() => vi.clearAllMocks());

describe('runIqBatteryGen — cadence-tick passthrough', () => {
  it('threads the injected deps + (installSlug, payload) into the cadence tick', async () => {
    vi.mocked(runBenchmarkCadenceTick).mockResolvedValue({ ran: false } as never);
    const currentCodeSha = () => 'sha-abc';
    const generationExists = vi.fn(async () => false);
    const runBattery = vi.fn(async () => {});
    const log = vi.fn();
    const out = await runIqBatteryGen(
      { workspaceId: 'ws-1', installSlug: 'inst-1', payload: { budgetUsd: 10 } },
      { currentCodeSha, generationExists, runBattery, log },
    );
    expect(out).toEqual({ ran: false });
    expect(runBenchmarkCadenceTick).toHaveBeenCalledTimes(1);
    const [deps, tickInput] = vi.mocked(runBenchmarkCadenceTick).mock.calls[0];
    expect(deps).toEqual(expect.objectContaining({ currentCodeSha, generationExists, runBattery, log }));
    expect(tickInput).toEqual({ installSlug: 'inst-1', payload: { budgetUsd: 10 } });
  });

  it('defaults a missing payload to null', async () => {
    vi.mocked(runBenchmarkCadenceTick).mockResolvedValue({ ran: false } as never);
    await runIqBatteryGen(
      { workspaceId: 'ws-1', installSlug: 'inst-1' },
      { currentCodeSha: () => 's', generationExists: async () => false, runBattery: async () => {}, log: vi.fn() },
    );
    const [, tickInput] = vi.mocked(runBenchmarkCadenceTick).mock.calls[0];
    expect(tickInput).toEqual({ installSlug: 'inst-1', payload: null });
  });
});
