/**
 * run — unit coverage for runScoutCycleTick, the SHARED scout autonomous-tick
 * orchestration both the routine action and the deterministic blueprint step run.
 * The structural self-gates live inside runScoutTick (mocked here); what's tested
 * is run.ts's own orchestration: the single-runner gate, the workspace-ceiling
 * gate (incl. its governor mirror on a held cycle), and the fired/no-op mirror.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sched = vi.hoisted(() => ({ runScoutTick: vi.fn(), buildScoutTickDeps: vi.fn(() => ({})) }));
vi.mock('./scheduler', () => sched);

import { runScoutCycleTick, parseScoutCycleConfig, type ScoutCycleDeps } from './run';

const baseInput = { workspaceId: 'ws', installSlug: 'h', payloadTemplate: null };
const runCycle = vi.fn();
const recordTick = vi.fn();
const buildDeps = vi.fn(() => ({ recordTick })); // fake tick deps — the mocked runScoutTick ignores them

function mkDeps(over: Record<string, unknown> = {}): ScoutCycleDeps {
  return { runCycle, buildDeps, ...over } as unknown as ScoutCycleDeps;
}

beforeEach(() => {
  sched.runScoutTick.mockReset().mockResolvedValue({ fired: true, costUsd: 1.5, cycleId: 'c1' });
  runCycle.mockReset();
  buildDeps.mockClear();
  recordTick.mockReset();
});

describe('parseScoutCycleConfig', () => {
  it('returns {} for a null / non-object / array payload', () => {
    expect(parseScoutCycleConfig(null)).toEqual({});
    expect(parseScoutCycleConfig('nope' as never)).toEqual({});
    expect(parseScoutCycleConfig([] as never)).toEqual({});
  });

  it('extracts the cadence + budget objects, dropping unknown / bad-shape keys', () => {
    expect(parseScoutCycleConfig({ cadence: { x: 1 }, budget: { maxCostUsd: 2 }, cycleTimeoutMs: 1500, junk: 5 } as never)).toEqual({
      cadence: { x: 1 },
      budget: { maxCostUsd: 2 },
      cycleTimeoutMs: 1500,
    });
    expect(parseScoutCycleConfig({ cadence: 'bad', budget: 7, cycleTimeoutMs: 0 } as never)).toEqual({}); // bad shapes → dropped
  });
});

describe('runScoutCycleTick — gates + governor mirror', () => {
  it('hiveRunnerGate refusal short-circuits as not-hive-runner and records a gated tick', async () => {
    const recordGovernor = vi.fn();
    const res = await runScoutCycleTick(baseInput, mkDeps({ recordGovernor, hiveRunnerGate: async () => ({ run: false, reason: 'standby' }) }));
    expect(res).toEqual({ fired: false, reason: 'not-hive-runner' });
    expect(sched.runScoutTick).not.toHaveBeenCalled();
    expect(recordGovernor).not.toHaveBeenCalled();
    expect(recordTick).toHaveBeenCalledWith({
      status: 'gated',
      gate: 'not-hive-runner',
      detail: { reason: 'standby' },
    });
  });

  it('workspaceCeilingGate refusal records a gated tick and mirrors the per-cycle cap (fired:null)', async () => {
    const recordGovernor = vi.fn();
    const res = await runScoutCycleTick(
      baseInput,
      mkDeps({
        recordGovernor,
        workspaceCeilingGate: async () => ({
          allow: false,
          totalScoutSpentUsd: 9,
          ceilingUsd: 8,
          remainingUsd: 0,
          scoutLoopCount: 3,
        }),
      }),
    );
    expect(res).toEqual({ fired: false, reason: 'workspace-ceiling' });
    expect(sched.runScoutTick).not.toHaveBeenCalled();
    expect(recordTick).toHaveBeenCalledWith({
      status: 'gated',
      gate: 'workspace-ceiling',
      detail: {
        reason: 'workspace-ceiling',
        totalScoutSpentUsd: 9,
        ceilingUsd: 8,
        scoutLoopCount: 3,
      },
    });
    expect(recordGovernor).toHaveBeenCalledTimes(1);
    expect(recordGovernor.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws', harnessSlug: 'h', fired: null });
  });

  it('runs the tick when both gates allow and mirrors a FIRED cycle (costUsd + cycleId) to the governor', async () => {
    sched.runScoutTick.mockResolvedValue({ fired: true, costUsd: 2.25, cycleId: 'cyc-9' });
    const recordGovernor = vi.fn();
    const res = await runScoutCycleTick(
      baseInput,
      mkDeps({ recordGovernor, hiveRunnerGate: async () => ({ run: true }), workspaceCeilingGate: async () => ({ allow: true }) }),
    );
    expect(res).toMatchObject({ fired: true, costUsd: 2.25 });
    expect(sched.runScoutTick).toHaveBeenCalledTimes(1);
    expect(recordGovernor.mock.calls[0][0]).toMatchObject({ fired: { costUsd: 2.25, cycleId: 'cyc-9' } });
  });

  it('passes a configured cycle timeout through to runScoutTick', async () => {
    await runScoutCycleTick(
      { ...baseInput, payloadTemplate: { cycleTimeoutMs: 2500 } },
      mkDeps(),
    );
    expect(sched.runScoutTick.mock.calls[0][1]).toMatchObject({ cycleTimeoutMs: 2500 });
  });

  it('mirrors a NO-OP (un-fired) tick as fired:null', async () => {
    sched.runScoutTick.mockResolvedValue({ fired: false, reason: 'cadence' });
    const recordGovernor = vi.fn();
    await runScoutCycleTick(baseInput, mkDeps({ recordGovernor }));
    expect(recordGovernor.mock.calls[0][0]).toMatchObject({ fired: null });
  });

  it('is hermetic with no governor wired — runs the tick, no governor IO', async () => {
    const res = await runScoutCycleTick(baseInput, mkDeps());
    expect(res).toMatchObject({ fired: true });
    expect(sched.runScoutTick).toHaveBeenCalledTimes(1);
  });
});
