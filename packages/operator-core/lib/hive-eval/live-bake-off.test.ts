import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getFlag: vi.fn(),
  setFlagOverride: vi.fn(),
  runGen: vi.fn(),
}));

vi.mock('@papercusp/flags/server', () => ({ getFlag: h.getFlag, setFlagOverride: h.setFlagOverride }));
vi.mock('./generation-runner', () => ({ runHiveEvalGeneration: h.runGen }));

import { liveBakeoffDeps } from './live-bake-off';

// Minimal stub config — the heavy machinery (runHiveEvalGeneration) is mocked.
const cfg = {
  battery: {
    instance: {},
    scenarios: [{ id: 'serial-pipeline' }, { id: 'wide-fanout' }],
    repeats: 1,
    seed: 1,
    budgetUsdCap: 1,
    beeCap: 1,
  },
  deps: { extractor: {} },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

beforeEach(() => {
  h.getFlag.mockReset();
  h.setFlagOverride.mockReset();
  h.runGen.mockReset();
});

describe('liveBakeoffDeps', () => {
  it('getFlag delegates to the real getFlag with the system distinctId', async () => {
    h.getFlag.mockResolvedValue(true);
    expect(await liveBakeoffDeps(cfg).getFlag('papercusp-x')).toBe(true);
    expect(h.getFlag).toHaveBeenCalledWith('papercusp-x', 'system');
  });

  it('setFlag writes a flag override and throws on failure', async () => {
    h.setFlagOverride.mockResolvedValueOnce({ ok: true });
    const deps = liveBakeoffDeps(cfg);
    await deps.setFlag('papercusp-x', false);
    expect(h.setFlagOverride).toHaveBeenCalledWith('papercusp-x', false);

    h.setFlagOverride.mockResolvedValueOnce({ ok: false, reason: 'override-store-not-configured' });
    await expect(deps.setFlag('papercusp-x', true)).rejects.toThrow(/override-store-not-configured/);
  });

  it('runBattery delegates to runHiveEvalGeneration and maps ScoredRun → ArmScore (canonical scores)', async () => {
    h.runGen.mockResolvedValue({
      scores: [
        { runId: 'r1', scenarioId: 'serial-pipeline', score: { composite: 7.5, outcomeGatePassed: true } },
        { runId: 'r2', scenarioId: 'wide-fanout', score: { composite: 0, outcomeGatePassed: false } },
      ],
    });
    const arm = await liveBakeoffDeps(cfg).runBattery({ repeats: 2 });
    expect(arm).toEqual([
      { scenarioId: 'serial-pipeline', composite: 7.5, gatePassed: true },
      { scenarioId: 'wide-fanout', composite: 0, gatePassed: false },
    ]);
    expect(h.runGen).toHaveBeenCalledWith(expect.objectContaining({ repeats: 2 }), cfg.deps);
  });

  it('runBattery filters the corpus by scenarioIds', async () => {
    h.runGen.mockResolvedValue({ scores: [] });
    await liveBakeoffDeps(cfg).runBattery({ scenarioIds: ['wide-fanout'] });
    const passedConfig = h.runGen.mock.calls[0][0];
    expect(passedConfig.scenarios.map((sc: { id: string }) => sc.id)).toEqual(['wide-fanout']);
  });
});
