import { describe, it, expect, vi } from 'vitest';
import { fireLoopWake, defaultLoopKickoff, spliceCurrentLoopCheckpoint, type LoopFireDeps } from './loop-fire';

/** A fresh set of injected deps with sensible "allow + woke 1" defaults; override per test. */
function mkDeps(
  over: Partial<LoopFireDeps> = {},
): Required<
  Pick<LoopFireDeps, 'checkFireGate' | 'recordFire' | 'wake' | 'costCap' | 'getLoopCarryNote' | 'deactivateLoop'>
> {
  return {
    checkFireGate: vi.fn(async () => ({ allow: true, consecutiveErrors: 0 })) as never,
    recordFire: vi.fn(async () => {}) as never,
    wake: vi.fn(async () => ({
      targets: ['su-pinned'],
      keys: ['coord:inbox-wake:su-pinned'],
      woken: 1,
      staged: 0,
    })) as never,
    costCap: vi.fn(async () => ({ breach: false, spendCents: 0, capCents: null })) as never,
    getLoopCarryNote: vi.fn(async () => null) as never,
    deactivateLoop: vi.fn(async () => true) as never,
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
    // Fire history (loop-wake-rate-limit-robustness P0b): a pre-fire 'attempt' then a
    // 'queued' 'attempt' — both PRESERVE the streak. The enqueue is NOT an 'ok': a queued
    // wake is not a survived turn. The turn OUTCOME owns ok/error (reconcile records 'ok' on
    // completion; the resume-exit handler / stuck-park backstop record 'error' on a death).
    expect(deps.recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-pinned', 'firing', 'attempt');
    expect(deps.recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-pinned', 'queued', 'attempt');
    // Crucially, the enqueue NEVER records an 'ok' outcome (that would prematurely reset the streak).
    expect(deps.recordFire).not.toHaveBeenCalledWith('papercusp', 'loop-su-pinned', expect.anything(), 'ok');
  });

  it('delivers the routine kickoff as the wake-turn text, falling back to the default', async () => {
    // Explicit kickoff from payload_template.
    const deps1 = mkDeps();
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: 'work plan X' } }, deps1);
    expect((deps1.wake as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ summary: 'work plan X' });

    // No kickoff → the default self-assign-work-items prompt.
    const deps2 = mkDeps();
    await fireLoopWake(baseInput, deps2);
    expect((deps2.wake as ReturnType<typeof vi.fn>).mock.calls[0][1].summary).toBe(
      defaultLoopKickoff(baseInput.routineId),
    );
  });

  it('splices the CURRENT loop:checkpoint into the wake-turn text at fire time (EI-7809)', async () => {
    const deps = mkDeps({
      getLoopCarryNote: vi.fn(async () => '## Did\nclosed WI-1\n\n## Next action\nclaim_next again') as never,
    });
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: 'arm-time goal text' } }, deps);

    expect(deps.getLoopCarryNote).toHaveBeenCalledWith({
      harness: 'papercusp',
      ownerId: 'su-pinned',
      workspaceId: 'papercusp-workspace',
    });
    const [, opts] = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.summary).toContain('arm-time goal text');
    expect(opts.summary).toContain('Current loop:checkpoint');
    expect(opts.summary).toContain('prefer this over any stale arm-time goal text');
    expect(opts.summary).toContain('## Next action\nclaim_next again');
  });

  it('keeps the wake prompt byte-equivalent when no loop:checkpoint exists or the read fails', async () => {
    const depsNoNote = mkDeps({ getLoopCarryNote: vi.fn(async () => null) as never });
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: 'work plan X' } }, depsNoNote);
    expect((depsNoNote.wake as ReturnType<typeof vi.fn>).mock.calls[0][1].summary).toBe('work plan X');

    const depsReadFail = mkDeps({
      getLoopCarryNote: vi.fn(async () => {
        throw new Error('carry store down');
      }) as never,
    });
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: 'work plan Y' } }, depsReadFail);
    expect((depsReadFail.wake as ReturnType<typeof vi.fn>).mock.calls[0][1].summary).toBe('work plan Y');
  });

  it('caps an oversized checkpoint before putting it in the wake prompt', () => {
    const out = spliceCurrentLoopCheckpoint('kickoff', 'x'.repeat(3_100));
    expect(out).toContain('kickoff');
    expect(out).toContain('loop:checkpoint truncated in wake prompt');
    expect(out.length).toBeLessThan(3_300);
  });

  it('FAILURE-STREAK gate trips → fire WITHHELD, no wake', async () => {
    const deps = mkDeps({
      checkFireGate: vi.fn(async () => ({
        allow: false,
        reason: 'backoff',
        consecutiveErrors: 4,
        retryAfterSec: 120,
      })) as never,
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
    expect(deps.costCap).toHaveBeenCalledWith(
      expect.objectContaining({ routineId: baseInput.routineId, capCents: 500 }),
    );
    expect(deps.recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-pinned',
      expect.stringContaining('cost-cap'),
      'error',
    );
  });

  it('no cost-cap configured → the cost guard is never consulted', async () => {
    const deps = mkDeps();
    await fireLoopWake(baseInput, deps); // payloadTemplate null → no costCapCents
    expect(deps.costCap).not.toHaveBeenCalled();
  });

  it('a missed wake (woke 0, staged 0) auto-ends the orphaned loop instead of leaving it parked', async () => {
    const deps = mkDeps({
      wake: vi.fn(async () => ({
        targets: ['su-pinned'],
        keys: ['coord:inbox-wake:su-pinned'],
        woken: 0,
        staged: 0,
      })) as never,
    });
    const res = await fireLoopWake(baseInput, deps);

    expect(res).toMatchObject({ fired: false, reason: 'no-session-now', woken: 0 });
    expect(deps.deactivateLoop).toHaveBeenCalledWith({
      sql: undefined,
      installSlug: 'papercusp',
      routineName: 'loop-su-pinned',
    });
    expect(deps.recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-pinned', 'no-session-now:auto-ended', 'error');
  });

  it('a staged wake (manual wake-mode / hive pause) counts as reached → queued (attempt, streak preserved)', async () => {
    const deps = mkDeps({
      wake: vi.fn(async () => ({ targets: ['su-pinned'], keys: [], woken: 0, staged: 1 })) as never,
    });
    const res = await fireLoopWake(baseInput, deps);
    expect(res).toMatchObject({ fired: true, staged: 1 });
    // Reached (staged) ⇒ 'queued'/'attempt' (preserve the streak), NOT 'ok' — the turn outcome owns ok.
    expect(deps.recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-pinned', 'queued', 'attempt');
    expect(deps.recordFire).not.toHaveBeenCalledWith('papercusp', 'loop-su-pinned', expect.anything(), 'ok');
  });

  it('Guard 3 (dead-man): a breach auto-pauses + withholds the wake + records an error (P2a)', async () => {
    const deadMan = vi.fn(async () => ({ breach: true, reason: 'max-duration 7200s > 3600s (since arm)' }));
    const deps = mkDeps({ deadMan: deadMan as never, incrementFireCount: vi.fn(async () => {}) as never });
    const res = await fireLoopWake({ ...baseInput, payloadTemplate: { maxDurationSec: 3600 } }, deps);
    expect(res).toMatchObject({ fired: false, reason: 'dead-man' });
    expect(deps.wake).not.toHaveBeenCalled(); // the wake was withheld
    expect(deps.recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-pinned',
      expect.stringContaining('dead-man'),
      'error',
    );
  });

  it('the fire counter is incremented ONLY when maxFires is configured (P2a)', async () => {
    const incrementFireCount = vi.fn(async () => {});
    const deps = mkDeps({
      deadMan: vi.fn(async () => ({ breach: false })) as never,
      incrementFireCount: incrementFireCount as never,
    });
    // A duration-only bound fires but does NOT count (no maxFires).
    await fireLoopWake({ ...baseInput, payloadTemplate: { maxDurationSec: 3600 } }, deps);
    expect(incrementFireCount).not.toHaveBeenCalled();
    // A maxFires bound increments after the fire.
    await fireLoopWake({ ...baseInput, payloadTemplate: { maxFires: 100 } }, deps);
    expect(incrementFireCount).toHaveBeenCalledTimes(1);
  });

  it('no target_owner_id → withheld with no gate/wake calls', async () => {
    const deps = mkDeps();
    const res = await fireLoopWake({ ...baseInput, targetOwnerId: '' }, deps);
    expect(res).toMatchObject({ fired: false, reason: 'no-target' });
    expect(deps.checkFireGate).not.toHaveBeenCalled();
    expect(deps.wake).not.toHaveBeenCalled();
  });
});

describe('fireLoopWake — cold-auto marker (su-cold-auto-mode-2026-07-03 P-003)', () => {
  it('a COLD loop stamps a {carry, wakeCount, harness} marker on the wake (wakeCount = priorFires+1) and advances the counter', async () => {
    const readFireCount = vi.fn(async () => 7); // 7 prior fires → this is the 8th
    const incrementFireCount = vi.fn(async () => {});
    const deps = mkDeps({ readFireCount: readFireCount as never, incrementFireCount: incrementFireCount as never });
    const res = await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: 'work plan X', carry: 'cold' } }, deps);

    expect(res).toMatchObject({ fired: true, woken: 1 });
    const [, opts] = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0];
    // harness = the loop's install_slug (the carry-note scope key); wakeCount = 8 → the
    // consumer's HYBRID cadence recycles this wake (8 % 8 === 0).
    expect(opts.payload).toEqual({ carry: 'cold', wakeCount: 8, harness: 'papercusp' });
    // Counter advances so the NEXT cold wake's wakeCount is monotonic.
    expect(incrementFireCount).toHaveBeenCalledTimes(1);
  });

  it('the first cold fire (no prior fires) is wakeCount 1 (a RESET)', async () => {
    const deps = mkDeps({
      readFireCount: vi.fn(async () => 0) as never,
      incrementFireCount: vi.fn(async () => {}) as never,
    });
    await fireLoopWake({ ...baseInput, payloadTemplate: { carry: 'cold' } }, deps);
    expect((deps.wake as ReturnType<typeof vi.fn>).mock.calls[0][1].payload).toMatchObject({
      carry: 'cold',
      wakeCount: 1,
    });
  });

  it('a fire-count read miss fails soft to wakeCount 1 — never a throw', async () => {
    const deps = mkDeps({
      readFireCount: vi.fn(async () => {
        throw new Error('pg down');
      }) as never,
      incrementFireCount: vi.fn(async () => {}) as never,
    });
    const res = await fireLoopWake({ ...baseInput, payloadTemplate: { carry: 'cold' } }, deps);
    expect(res).toMatchObject({ fired: true });
    expect((deps.wake as ReturnType<typeof vi.fn>).mock.calls[0][1].payload).toMatchObject({
      carry: 'cold',
      wakeCount: 1,
    });
  });

  it('a WARM loop stamps NO payload marker (byte-identical to today) and never touches the fire counter', async () => {
    const readFireCount = vi.fn(async () => 3);
    const incrementFireCount = vi.fn(async () => {});
    const deps = mkDeps({ readFireCount: readFireCount as never, incrementFireCount: incrementFireCount as never });
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: 'x' } }, deps); // carry absent → warm
    const [, opts] = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.payload).toBeUndefined();
    expect(readFireCount).not.toHaveBeenCalled();
    expect(incrementFireCount).not.toHaveBeenCalled();
  });

  it('an explicit carry:"warm" is also treated as warm (no marker)', async () => {
    const deps = mkDeps({
      readFireCount: vi.fn(async () => 5) as never,
      incrementFireCount: vi.fn(async () => {}) as never,
    });
    await fireLoopWake({ ...baseInput, payloadTemplate: { carry: 'warm' } }, deps);
    expect((deps.wake as ReturnType<typeof vi.fn>).mock.calls[0][1].payload).toBeUndefined();
  });

  it('a COLD fire that does NOT reach a session does NOT advance the counter (no wakeCount slot consumed)', async () => {
    const incrementFireCount = vi.fn(async () => {});
    const deps = mkDeps({
      wake: vi.fn(async () => ({ targets: ['su-pinned'], keys: [], woken: 0, staged: 0 })) as never,
      readFireCount: vi.fn(async () => 2) as never,
      incrementFireCount: incrementFireCount as never,
      deactivateLoop: vi.fn(async () => true) as never,
    });
    const res = await fireLoopWake({ ...baseInput, payloadTemplate: { carry: 'cold' } }, deps);
    expect(res).toMatchObject({ fired: false, reason: 'no-session-now' });
    expect(incrementFireCount).not.toHaveBeenCalled();
  });
});
