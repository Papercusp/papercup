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

describe('runIqBatteryGen — EI-13049 notifyOutcome paging', () => {
  const baseDeps = () => ({
    currentCodeSha: () => 'sha-abc',
    generationExists: vi.fn(async () => false),
    runBattery: vi.fn(async () => {}),
    log: vi.fn(),
  });

  it("pages via notifyOutcome on a 'failed' outcome", async () => {
    vi.mocked(runBenchmarkCadenceTick).mockResolvedValue({ action: 'failed', codeSha: 'sha-abc', error: 'boom' } as never);
    const notifyOutcome = vi.fn(async () => {});
    const out = await runIqBatteryGen(
      { workspaceId: 'ws-1', installSlug: 'inst-1', payload: { budgetUsd: 10 } },
      { ...baseDeps(), notifyOutcome },
    );
    expect(out).toEqual({ action: 'failed', codeSha: 'sha-abc', error: 'boom' });
    expect(notifyOutcome).toHaveBeenCalledTimes(1);
    expect(notifyOutcome).toHaveBeenCalledWith(
      { action: 'failed', codeSha: 'sha-abc', error: 'boom' },
      { installSlug: 'inst-1' },
    );
  });

  it("pages via notifyOutcome on a 'refused' outcome", async () => {
    vi.mocked(runBenchmarkCadenceTick).mockResolvedValue({ action: 'refused', reason: 'no budget' } as never);
    const notifyOutcome = vi.fn(async () => {});
    await runIqBatteryGen(
      { workspaceId: 'ws-1', installSlug: 'inst-1', payload: {} },
      { ...baseDeps(), notifyOutcome },
    );
    expect(notifyOutcome).toHaveBeenCalledTimes(1);
    expect(notifyOutcome).toHaveBeenCalledWith({ action: 'refused', reason: 'no budget' }, { installSlug: 'inst-1' });
  });

  it.each([
    { action: 'ran', codeSha: 'sha-abc', capUsd: 5 },
    { action: 'skipped', codeSha: 'sha-abc', reason: 'unchanged' },
  ])('does NOT page notifyOutcome on a %s outcome', async (outcome) => {
    vi.mocked(runBenchmarkCadenceTick).mockResolvedValue(outcome as never);
    const notifyOutcome = vi.fn(async () => {});
    await runIqBatteryGen(
      { workspaceId: 'ws-1', installSlug: 'inst-1', payload: { budgetUsd: 10 } },
      { ...baseDeps(), notifyOutcome },
    );
    expect(notifyOutcome).not.toHaveBeenCalled();
  });

  it('the DEFAULT notifyOutcome (no dep injected) is a no-op for a non-paging outcome — never imports attention-notify', async () => {
    vi.mocked(runBenchmarkCadenceTick).mockResolvedValue({ action: 'ran', codeSha: 'sha-abc', capUsd: 5 } as never);
    // No notifyOutcome injected — exercises the real default. If it ever imported
    // attention-notify unconditionally this would throw (no live workspace/PG in
    // this unit test), so a clean resolve proves the action-gate runs BEFORE import.
    await expect(
      runIqBatteryGen({ workspaceId: 'ws-1', installSlug: 'inst-1', payload: { budgetUsd: 10 } }, baseDeps()),
    ).resolves.toEqual({ action: 'ran', codeSha: 'sha-abc', capUsd: 5 });
  });
});
