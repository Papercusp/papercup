import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getFlag: vi.fn(),
  setFlagOverride: vi.fn(),
  runGen: vi.fn(),
}));

vi.mock('@papercusp/flags/server', () => ({ getFlag: h.getFlag, setFlagOverride: h.setFlagOverride }));
vi.mock('./generation-runner', () => ({ runHiveEvalGeneration: h.runGen }));

import { liveBakeoffDeps, buildBakeoffBatteryConfig } from './live-bake-off';

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

describe('buildBakeoffBatteryConfig', () => {
  const manifest = { codeSha: 'abc123', createdAt: new Date(0) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scenarios = [{ id: 's1' }, { id: 's2' }] as any;

  it('builds a bakeoff-scoped instance + splits the budget across BOTH arms', () => {
    const out = buildBakeoffBatteryConfig(
      { workspaceId: 'ws', flagKey: 'papercusp-x', beeCap: 4, capUsd: 80, repeats: 2 },
      scenarios,
      manifest,
    );
    expect(out.instance.instanceId).toBe('bakeoff-papercusp-x-abc123-ws');
    expect(out.instance.batterySliceId).toBe('framework-bakeoff');
    expect(out.scenarios).toHaveLength(2);
    expect(out.repeats).toBe(2);
    // 2 scenarios × 2 repeats × 2 arms = 8 runs; 80 / 8 = 10
    expect(out.budgetUsdCap).toBe(10);
    expect(out.beeCap).toBe(4);
  });

  it('filters scenarios by scenarioIds', () => {
    const out = buildBakeoffBatteryConfig(
      { workspaceId: 'ws', flagKey: 'f', beeCap: 1, capUsd: 4, scenarioIds: ['s2'] },
      scenarios,
      manifest,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(out.scenarios.map((s: any) => s.id)).toEqual(['s2']);
  });
});
