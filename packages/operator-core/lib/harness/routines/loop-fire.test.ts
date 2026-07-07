import { describe, it, expect, vi } from 'vitest';
import {
  fireLoopWake,
  defaultLoopKickoff,
  spliceCurrentLoopCheckpoint,
  renderLoopCheckpointBlock,
  renderLoopWakeText,
  loopCheckpointStaleMs,
  LOOP_WAKE_FULL_TEMPLATE_EVERY,
  type LoopFireDeps,
} from './loop-fire';

/** A fresh set of injected deps with sensible "allow + woke 1" defaults; override per test. */
function mkDeps(
  over: Partial<LoopFireDeps> = {},
): Required<
  Pick<
    LoopFireDeps,
    | 'checkFireGate'
    | 'recordFire'
    | 'wake'
    | 'costCap'
    | 'getLoopCarryNoteWithMeta'
    | 'deactivateLoop'
    | 'readFireCount'
    | 'incrementFireCount'
  >
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
    getLoopCarryNoteWithMeta: vi.fn(async () => ({ note: null, updatedAtMs: null })) as never,
    deactivateLoop: vi.fn(async () => true) as never,
    readFireCount: vi.fn(async () => 0) as never,
    incrementFireCount: vi.fn(async () => {}) as never,
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
      getLoopCarryNoteWithMeta: vi.fn(async () => ({
        note: '## Did\nclosed WI-1\n\n## Next action\nclaim_next again',
        updatedAtMs: Date.now() - 60_000,
      })) as never,
    });
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: 'arm-time goal text' } }, deps);

    expect(deps.getLoopCarryNoteWithMeta).toHaveBeenCalledWith({
      harness: 'papercusp',
      ownerId: 'su-pinned',
      workspaceId: 'papercusp-workspace',
    });
    const [, opts] = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.summary).toContain('arm-time goal text');
    expect(opts.summary).toContain('Current loop:checkpoint');
    expect(opts.summary).toContain('this is the authority for what to do this wake');
    expect(opts.summary).toContain('## Next action\nclaim_next again');
  });

  it('a legacy getLoopCarryNote dep (no meta) still splices the note, with no age claim (back-compat)', async () => {
    const deps = mkDeps({
      getLoopCarryNoteWithMeta: undefined,
      getLoopCarryNote: vi.fn(async () => '## Next action\nresume the edit') as never,
    } as never);
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: 'arm-time goal text' } }, deps);
    const [, opts] = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.summary).toContain('you wrote it earlier');
    expect(opts.summary).toContain('## Next action\nresume the edit');
  });

  it('keeps the wake prompt byte-equivalent when no loop:checkpoint exists or the read fails', async () => {
    const depsNoNote = mkDeps();
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: 'work plan X' } }, depsNoNote);
    expect((depsNoNote.wake as ReturnType<typeof vi.fn>).mock.calls[0][1].summary).toBe('work plan X');

    const depsReadFail = mkDeps({
      getLoopCarryNoteWithMeta: vi.fn(async () => {
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

    const block = renderLoopCheckpointBlock('y'.repeat(3_100), {});
    expect(block).toContain('loop:checkpoint truncated in wake prompt');
    expect(block!.length).toBeLessThan(3_400);
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

  it('the fire counter is incremented UNCONDITIONALLY after a reached fire (P-001b — the full/short wake cadence reads it), but never on a non-reached one', async () => {
    // Plain warm loop, no maxFires, no cold — the previously-stuck-at-0 case.
    const deps = mkDeps({ deadMan: vi.fn(async () => ({ breach: false })) as never });
    await fireLoopWake({ ...baseInput, payloadTemplate: { maxDurationSec: 3600 } }, deps);
    expect(deps.incrementFireCount).toHaveBeenCalledTimes(1);
    await fireLoopWake(baseInput, deps);
    expect(deps.incrementFireCount).toHaveBeenCalledTimes(2);

    // A fire that reaches NO session consumes no slot.
    const depsMissed = mkDeps({
      wake: vi.fn(async () => ({ targets: ['su-pinned'], keys: [], woken: 0, staged: 0 })) as never,
    });
    await fireLoopWake(baseInput, depsMissed);
    expect(depsMissed.incrementFireCount).not.toHaveBeenCalled();
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

  it('a WARM loop stamps NO payload marker, but its fire counter still advances (P-001b: the wake cadence needs it)', async () => {
    const readFireCount = vi.fn(async () => 3);
    const incrementFireCount = vi.fn(async () => {});
    const deps = mkDeps({ readFireCount: readFireCount as never, incrementFireCount: incrementFireCount as never });
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: 'x' } }, deps); // carry absent → warm
    const [, opts] = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.payload).toBeUndefined();
    expect(readFireCount).toHaveBeenCalledTimes(1);
    expect(incrementFireCount).toHaveBeenCalledTimes(1);
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

// ── compaction-continuity-hardening-2026-07-07 P-001 (wake diet) + P-002 (staleness stamp) ──
//
// Measured: the ~3KB arm-time kickoff was re-delivered verbatim on all 263 wakes of one
// live session (~200k tokens of repeated boilerplate), and the spliced checkpoint claimed
// "fresh at fire time" when only its READ was fresh — a stale note kept instructing an
// already-done next action after compaction (the re-report trap).

const FULL_KICKOFF = ['🔁 Loop wake toward: goal G', '', 'Each wake:', '1. do things', '2. more things'].join('\n');

describe('renderLoopWakeText — the full/short wake cadence (P-001b)', () => {
  const note = '## Next action\ncontinue the edit';

  it('fire 1 gets the FULL kickoff + checkpoint block', () => {
    const out = renderLoopWakeText({ kickoff: FULL_KICKOFF, fireNumber: 1, checkpoint: note });
    expect(out).toContain('Each wake:');
    expect(out).toContain('## Next action');
  });

  it('fires 2..N-1 get the SHORT form: first kickoff line + checkpoint + footer, NOT the full contract', () => {
    for (const fireNumber of [2, 5, LOOP_WAKE_FULL_TEMPLATE_EVERY]) {
      const out = renderLoopWakeText({ kickoff: FULL_KICKOFF, fireNumber, checkpoint: note });
      expect(out).toContain('🔁 Loop wake toward: goal G');
      expect(out).toContain(`(wake #${fireNumber}; short form`);
      expect(out).not.toContain('Each wake:');
      expect(out).toContain('## Next action');
      expect(out).toContain('refresh loop:checkpoint, then END YOUR TURN');
    }
  });

  it(`every ${LOOP_WAKE_FULL_TEMPLATE_EVERY}th wake after the first (11, 21, …) re-delivers the FULL contract as a refresher`, () => {
    for (const fireNumber of [LOOP_WAKE_FULL_TEMPLATE_EVERY + 1, 2 * LOOP_WAKE_FULL_TEMPLATE_EVERY + 1]) {
      const out = renderLoopWakeText({ kickoff: FULL_KICKOFF, fireNumber, checkpoint: note });
      expect(out).toContain('Each wake:');
    }
  });

  it('NO checkpoint ⇒ the full kickoff regardless of fire number (it is the only brief the agent has)', () => {
    const out = renderLoopWakeText({ kickoff: FULL_KICKOFF, fireNumber: 5, checkpoint: null });
    expect(out).toBe(FULL_KICKOFF);
  });

  it('a warm fireLoopWake threads the fire number: prior fires 4 ⇒ wake #5 short form', async () => {
    const deps = mkDeps({
      readFireCount: vi.fn(async () => 4) as never,
      getLoopCarryNoteWithMeta: vi.fn(async () => ({ note, updatedAtMs: Date.now() - 30_000 })) as never,
    });
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: FULL_KICKOFF } }, deps);
    const [, opts] = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.summary).toContain('(wake #5; short form');
    expect(opts.summary).not.toContain('Each wake:');
  });
});

describe('renderLoopCheckpointBlock — the write-age staleness stamp (P-002)', () => {
  const note = '## Next action\nre-report the fix to the owner';

  it('a FRESH note is stamped with its write age and asserted as the wake authority', () => {
    const out = renderLoopCheckpointBlock(note, { updatedAtMs: Date.now() - 90_000, intervalSec: 120 });
    expect(out).toContain('you wrote it');
    expect(out).toContain('this is the authority for what to do this wake');
    expect(out).not.toContain('STALE');
  });

  it('a STALE note (older than max(3 intervals, 30min)) is demoted to a LEAD with a do-not-re-execute warning', () => {
    const out = renderLoopCheckpointBlock(note, { updatedAtMs: Date.now() - 45 * 60_000, intervalSec: 120 });
    expect(out).toContain('⚠ Your loop:checkpoint is STALE');
    expect(out).toContain('Treat it as a LEAD');
    expect(out).toContain('do NOT re-execute its "next action" verbatim');
    expect(out).toContain('Refresh it with loop:checkpoint');
  });

  it('the staleness ceiling scales with the loop interval: max(3×interval, 30min)', () => {
    expect(loopCheckpointStaleMs(120)).toBe(30 * 60_000); // 3×120s < 30min floor
    expect(loopCheckpointStaleMs(3600)).toBe(3 * 3600 * 1000); // 3h for an hourly loop
    expect(loopCheckpointStaleMs(null)).toBe(30 * 60_000); // no interval ⇒ the floor
    // The same 45min-old note is NOT stale under an hourly loop's 3h ceiling.
    const out = renderLoopCheckpointBlock(note, { updatedAtMs: Date.now() - 45 * 60_000, intervalSec: 3600 });
    expect(out).not.toContain('STALE');
  });

  it('no write instant available ⇒ no age claim, no false "fresh at fire time" assertion of content freshness', () => {
    const out = renderLoopCheckpointBlock(note, {});
    expect(out).toContain('you wrote it earlier');
    expect(out).not.toContain('STALE');
  });
});
