import { describe, it, expect, vi } from 'vitest';
import { runWaveAdvanceTick, type WaveSweepDeps, type StartedPlan } from './wave-advance-sweep';
import type { WaveFeature, WaveForAdvance } from './waves';

const PLAN: StartedPlan = { slug: 'p', harnessSlug: 'restart', currentWave: null };
const WAVES: WaveForAdvance[] = [{ id: 't1', needsItems: false }, { id: 't2', needsItems: true }];
const ft = (wave: string, status: string): WaveFeature => ({ wave, status });

function makeDeps(over: Partial<WaveSweepDeps> = {}) {
  const calls: string[] = [];
  const deps: WaveSweepDeps = {
    listStartedPlans: vi.fn(async () => [PLAN]),
    getPlanWaves: vi.fn(async () => WAVES),
    getPlanFeatures: vi.fn(async () => []),
    promoteWave: vi.fn(async (p) => { calls.push(`promote:${p.wave}`); }),
    setCursor: vi.fn(async (p) => { calls.push(`cursor:${p.wave}`); }),
    onBlocked: vi.fn(async (p) => { calls.push(`blocked:${p.wave}`); }),
    ...over,
  };
  return { deps, calls };
}

describe('runWaveAdvanceTick', () => {
  it('no started plans → all zero', async () => {
    const { deps } = makeDeps({ listStartedPlans: vi.fn(async () => []) });
    expect(await runWaveAdvanceTick(deps)).toEqual({ promoted: 0, blocked: 0, waiting: 0, skipped: 0, errors: 0 });
  });

  it('plan with no `## Promote` policy → skipped (no-op)', async () => {
    const { deps, calls } = makeDeps({ getPlanWaves: vi.fn(async () => null) });
    const s = await runWaveAdvanceTick(deps);
    expect(s.skipped).toBe(1);
    expect(calls).toEqual([]);
  });

  it('cursor null → promotes the first wave, THEN sets the cursor (idempotency order)', async () => {
    const { deps, calls } = makeDeps();
    const s = await runWaveAdvanceTick(deps);
    expect(s.promoted).toBe(1);
    expect(calls).toEqual(['promote:t1', 'cursor:t1']); // launch before cursor
    expect(deps.promoteWave).toHaveBeenCalledWith({ slug: 'p', harnessSlug: 'restart', wave: 't1', needsItems: false });
  });

  it('current wave drained → promotes the next wave (carrying needsItems)', async () => {
    const { deps, calls } = makeDeps({
      listStartedPlans: vi.fn(async () => [{ ...PLAN, currentWave: 't1' }]),
      getPlanFeatures: vi.fn(async () => [ft('t1', 'passed'), ft('t1', 'deprecated')]),
    });
    await runWaveAdvanceTick(deps);
    expect(calls).toEqual(['promote:t2', 'cursor:t2']);
    expect(deps.promoteWave).toHaveBeenCalledWith(expect.objectContaining({ wave: 't2', needsItems: true }));
  });

  it('un-populated current wave (promote in flight) → waits, no re-promote', async () => {
    const { deps, calls } = makeDeps({
      listStartedPlans: vi.fn(async () => [{ ...PLAN, currentWave: 't1' }]),
      getPlanFeatures: vi.fn(async () => []), // t1 has no features yet
    });
    const s = await runWaveAdvanceTick(deps);
    expect(s.waiting).toBe(1);
    expect(calls).toEqual([]);
  });

  it('blocked current wave → onBlocked, no promote', async () => {
    const { deps, calls } = makeDeps({
      listStartedPlans: vi.fn(async () => [{ ...PLAN, currentWave: 't1' }]),
      getPlanFeatures: vi.fn(async () => [ft('t1', 'failing'), ft('t1', 'passed')]),
    });
    const s = await runWaveAdvanceTick(deps);
    expect(s.blocked).toBe(1);
    expect(calls).toEqual(['blocked:t1']);
  });

  it('a failed promote does NOT advance the cursor (retries next tick)', async () => {
    const { deps, calls } = makeDeps({ promoteWave: vi.fn(async () => { throw new Error('launch failed'); }) });
    const s = await runWaveAdvanceTick(deps);
    expect(s.errors).toBe(1);
    expect(s.promoted).toBe(0);
    expect(calls).toEqual([]); // neither promote-call-logged nor cursor set
    expect(deps.setCursor).not.toHaveBeenCalled();
  });
});
