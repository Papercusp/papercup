import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BASELINE_ID, resetTestRegistry } from '@papercusp/eval-battery';
import type { ReplayBatteryResult } from '../replay/battery';
import { _resetExperimentRegistration } from './descriptors';
import { runExperiment, type RunExperimentDeps, type RunExperimentInput } from './run-core';
import type { ExperimentLedger, ExperimentLedgerRow } from './ledger';

function canned(): ReplayBatteryResult {
  return {
    batteryId: 'b1',
    outcomes: [],
    perVariant: [
      { variantId: BASELINE_ID, label: 'historical baseline', cells: 1, scored: 1, meanComposite: 5, meanTokenJaccard: null, costUsd: 0 },
      { variantId: 'cand', label: 'terser', cells: 1, scored: 1, meanComposite: 7, meanTokenJaccard: 0.4, costUsd: 0.01 },
    ],
    comparison: {
      primaryScorer: 'composite',
      baseline: { variantId: BASELINE_ID, metrics: { composite: 5 } },
      candidates: [],
      selected: 'cand',
      selectionReason: '+2.0',
    },
    totalCostUsd: 0.01,
    rubricHash: 'rh',
    budgetExhausted: false,
  };
}

function deps(over: Partial<RunExperimentDeps> = {}): RunExperimentDeps {
  return {
    runGovernedReplay: vi.fn(async () => ({ verdict: { allow: true, remainingUsd: null }, result: canned() })) as unknown as RunExperimentDeps['runGovernedReplay'],
    replayRunner: (async () => ({ outputText: '', costUsd: 0, inputTokens: 0, outputTokens: 0, replayed: true })) as unknown as RunExperimentDeps['replayRunner'],
    judge: (async () => ({ text: '', costUsd: 0, inputTokens: 0, outputTokens: 0 })) as unknown as RunExperimentDeps['judge'],
    now: () => 0,
    ...over,
  };
}

const input = (over: Partial<RunExperimentInput> = {}): RunExperimentInput => ({
  testId: 'replay',
  batteryId: 'b1',
  arms: [{ id: 'cand', knobs: { 'overlay.systemOverlay': 'Be terse.' } }],
  cases: [{ caseId: 'c1', context: 'context so far', intent: 'do the task' }],
  repeats: 1,
  ...over,
});

describe('runExperiment', () => {
  beforeEach(() => {
    resetTestRegistry();
    _resetExperimentRegistration();
  });

  it('runs offline replay through the governed substrate + normalizes the result', async () => {
    const d = deps();
    const out = await runExperiment(input(), { workspaceId: 'ws' }, d);
    expect(out.ok).toBe(true);
    expect(out.result?.testId).toBe('replay');
    expect(out.result?.winner).toBe('cand');
    // baseline auto-prepended (caller gave only a candidate); synthetic case built.
    const cfg = (d.runGovernedReplay as unknown as { mock: { calls: any[][] } }).mock.calls[0]![0].config;
    expect(cfg.variants[0].variantId).toBe(BASELINE_ID);
    expect(cfg.variants[1]).toMatchObject({ variantId: 'cand', policy: { systemOverlay: 'Be terse.' } });
    expect(cfg.cases[0].kind).toBe('synthetic');
  });

  it('surfaces a governed refusal as ok:false refused, never a spend', async () => {
    const out = await runExperiment(
      input(),
      { workspaceId: 'ws' },
      deps({ runGovernedReplay: vi.fn(async () => ({ verdict: { allow: false, reason: 'replay-dark', remainingUsd: null }, result: null })) as unknown as RunExperimentDeps['runGovernedReplay'] }),
    );
    expect(out.ok).toBe(false);
    expect(out.refused?.reason).toBe('replay-dark');
  });

  it('rejects an arm outside the replay slice before calling the substrate', async () => {
    const d = deps();
    const out = await runExperiment(input({ arms: [{ id: 'bad', knobs: { 'genome.config.wake.x': 1 } }] }), { workspaceId: 'ws' }, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/outside the "replay" slice/);
    expect(d.runGovernedReplay).not.toHaveBeenCalled();
  });

  it('rejects a safety-excluded knob before any spend', async () => {
    const d = deps();
    const out = await runExperiment(input({ arms: [{ id: 'evil', knobs: { 'budget.cap': 0 } }] }), { workspaceId: 'ws' }, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/safety-excluded/);
    expect(d.runGovernedReplay).not.toHaveBeenCalled();
  });

  it('refuses a non-offline (staged) test with a clear message', async () => {
    const out = await runExperiment(input({ testId: 'gym' }), { workspaceId: 'ws' }, deps());
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not yet executable/);
  });

  it('refuses an unknown test id', async () => {
    const out = await runExperiment(input({ testId: 'nope' }), { workspaceId: 'ws' }, deps());
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/unknown test descriptor: nope/);
  });
});

describe('runExperiment ledger write (P-050)', () => {
  beforeEach(() => {
    resetTestRegistry();
    _resetExperimentRegistration();
  });

  it('records the run-level summary row on success', async () => {
    const rows: ExperimentLedgerRow[] = [];
    const ledger: ExperimentLedger = { record: async (r) => void rows.push(r) };
    const out = await runExperiment(input(), { workspaceId: 'ws' }, deps({ ledger }));
    expect(out.ok).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: 'ws', batteryId: 'b1', testId: 'replay', tier: 'offline', winner: 'cand' });
    expect(rows[0]!.arms.map((a) => a.id)).toEqual([BASELINE_ID, 'cand']);
  });

  it('a ledger write failure never fails the run (best-effort)', async () => {
    const ledger: ExperimentLedger = { record: async () => { throw new Error('pg down'); } };
    const out = await runExperiment(input(), { workspaceId: 'ws' }, deps({ ledger }));
    expect(out.ok).toBe(true);
    expect(out.result?.winner).toBe('cand');
  });
});

describe('runExperiment dryRun (P-064)', () => {
  beforeEach(() => {
    resetTestRegistry();
    _resetExperimentRegistration();
  });

  it('returns the battery plan without calling the substrate (no spend)', async () => {
    const d = deps();
    const out = await runExperiment(
      input({
        dryRun: true,
        arms: [{ id: 'opus', knobs: { 'model.agent': 'claude-opus-4-8' } }],
        cases: [
          { caseId: 'c1', context: 'x', intent: 'y' },
          { caseId: 'c2', context: 'x', intent: 'y' },
        ],
        repeats: 3,
      }),
      { workspaceId: 'ws' },
      d,
    );
    expect(out.ok).toBe(true);
    expect(d.runGovernedReplay).not.toHaveBeenCalled();
    expect(out.result).toBeUndefined();
    // baseline auto-prepended → 2 variants × 2 cases × 3 repeats = 12 cells.
    expect(out.plan?.totalCells).toBe(12);
    expect(out.plan?.arms.map((a) => a.id)).toEqual([BASELINE_ID, 'opus']);
    expect(out.plan?.arms.find((a) => a.id === 'opus')?.model).toBe('claude-opus-4-8');
  });

  it('still rejects an out-of-slice arm on a dryRun (validation before expansion)', async () => {
    const d = deps();
    const out = await runExperiment(
      input({ dryRun: true, arms: [{ id: 'bad', knobs: { 'genome.config.wake.x': 1 } }] }),
      { workspaceId: 'ws' },
      d,
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/outside the "replay" slice/);
    expect(d.runGovernedReplay).not.toHaveBeenCalled();
  });
});
