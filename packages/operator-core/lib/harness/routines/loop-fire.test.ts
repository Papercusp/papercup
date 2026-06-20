import { describe, it, expect, vi } from 'vitest';
import { fireLoopWake, defaultLoopKickoff, type LoopFireDeps } from './loop-fire';

/** A fresh set of injected deps with sensible "allow + woke 1" defaults; override per test. */
function mkDeps(over: Partial<LoopFireDeps> = {}): Required<Pick<LoopFireDeps, 'checkFireGate' | 'recordFire' | 'wake' | 'costCap'>> {
  return {
    checkFireGate: vi.fn(async () => ({ allow: true, consecutiveErrors: 0 })) as never,
    recordFire: vi.fn(async () => {}) as never,
    wake: vi.fn(async () => ({ targets: ['su-pinned'], keys: ['coord:inbox-wake:su-pinned'], woken: 1, staged: 0 })) as never,
    costCap: vi.fn(async () => ({ breach: false, spendCents: 0, capCents: null })) as never,
    ...over,
  };
}

const baseInput = {
  routineId: 'rt_papercusp_loop_su-pinned',
  routineName: 'loop-su-pinned',
  workspaceId: 'papercusp-workspace',
  installSlug: 'papercusp',
  targetOwnerId: 'su-pinned',
  payloadTemplate: null as Record<string, unknown> | null,
};

describe('fireLoopWake — the warm-wake fire (B-LOOP-3)', () => {
  it('wakes the SAME pinned session warm (the loop-continuity invariant)', async () => {
    const deps = mkDeps();
    const res = await fireLoopWake(baseInput, deps);

    expect(res).toMatchObject({ fired: true, woken: 1 });
    // Exactly one warm wake, to exactly the bound owner (never a broadcast).
    expect(deps.wake).toHaveBeenCalledTimes(1);
    const [recipients, opts] = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(recipients).toEqual(['su-pinned']);
    expect(opts).toMatchObject({ source: 'loop:rt_papercusp_loop_su-pinned', workspaceId: 'papercusp-workspace' });
    // Fire history: a pre-fire attempt (preserves the streak) then an 'ok' (resets it).
    expect(deps.recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-pinned', 'firing', 'attempt');
    expect(deps.recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-pinned', 'ok', 'ok');
  });

  it('delivers the routine kickoff as the wake-turn text, falling back to the default', async () => {
    // Explicit kickoff from payload_template.
    const deps1 = mkDeps();
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: 'work plan X' } }, deps1);
    expect((deps1.wake as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ summary: 'work plan X' });

    // No kickoff → the default self-assign-work-items prompt.
    const deps2 = mkDeps();
    await fireLoopWake(baseInput, deps2);
    expect((deps2.wake as ReturnType<typeof vi.fn>).mock.calls[0][1].summary).toBe(defaultLoopKickoff(baseInput.routineId));
  });

  it('FAILURE-STREAK gate trips → fire WITHHELD, no wake', async () => {
    const deps = mkDeps({
      checkFireGate: vi.fn(async () => ({ allow: false, reason: 'backoff', consecutiveErrors: 4, retryAfterSec: 120 })) as never,
    });
    const res = await fireLoopWake(baseInput, deps);

    expect(res).toMatchObject({ fired: false, reason: 'fire-gate' });
    expect(deps.wake).not.toHaveBeenCalled();
    // No wake recorded — the gate withheld before any fire attempt.
    expect(deps.recordFire).not.toHaveBeenCalled();
  });

  it('COST-CAP breach → fire WITHHELD, no wake, recorded as an error', async () => {
    const deps = mkDeps({
      costCap: vi.fn(async () => ({ breach: true, spendCents: 750, capCents: 500 })) as never,
    });
    const res = await fireLoopWake({ ...baseInput, payloadTemplate: { costCapCents: 500 } }, deps);

    expect(res).toMatchObject({ fired: false, reason: 'cost-cap' });
    expect(deps.wake).not.toHaveBeenCalled();
    expect(deps.costCap).toHaveBeenCalledWith(expect.objectContaining({ routineId: baseInput.routineId, capCents: 500 }));
    expect(deps.recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-pinned', expect.stringContaining('cost-cap'), 'error');
  });

  it('no cost-cap configured → the cost guard is never consulted', async () => {
    const deps = mkDeps();
    await fireLoopWake(baseInput, deps); // payloadTemplate null → no costCapCents
    expect(deps.costCap).not.toHaveBeenCalled();
  });

  it('a missed wake (woke 0, staged 0) is NOT a failure — recorded as attempt, not error', async () => {
    // The inbox row persisted; a busy/parked session sees it next turn. Only a genuinely dead
    // session (DROPped by the wake layer) or the cost-cap should advance the streak.
    const deps = mkDeps({
      wake: vi.fn(async () => ({ targets: ['su-pinned'], keys: ['coord:inbox-wake:su-pinned'], woken: 0, staged: 0 })) as never,
    });
    const res = await fireLoopWake(baseInput, deps);

    expect(res).toMatchObject({ fired: true, woken: 0 });
    expect(deps.recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-pinned', 'no-session-now', 'attempt');
    expect(deps.recordFire).not.toHaveBeenCalledWith('papercusp', 'loop-su-pinned', expect.anything(), 'error');
  });

  it('a staged wake (manual wake-mode / hive pause) counts as reached → ok', async () => {
    const deps = mkDeps({
      wake: vi.fn(async () => ({ targets: ['su-pinned'], keys: [], woken: 0, staged: 1 })) as never,
    });
    const res = await fireLoopWake(baseInput, deps);
    expect(res).toMatchObject({ fired: true, staged: 1 });
    expect(deps.recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-pinned', 'ok', 'ok');
  });

  it('no target_owner_id → withheld with no gate/wake calls', async () => {
    const deps = mkDeps();
    const res = await fireLoopWake({ ...baseInput, targetOwnerId: '' }, deps);
    expect(res).toMatchObject({ fired: false, reason: 'no-target' });
    expect(deps.checkFireGate).not.toHaveBeenCalled();
    expect(deps.wake).not.toHaveBeenCalled();
  });
});
