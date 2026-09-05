import { describe, it, expect } from 'vitest';
import type { CarryBrief } from './carry-brief';
import {
  STALE_CHECKPOINT_WARN_MS,
  staleCheckpointWarnings,
  detectFlushTripwires,
  decideFlushGate,
  renderFlushRefusal,
  armedLoopNeedsCarryNote,
} from './enforcement-gate';

const NOW = 1_800_000_000_000;

function brief(over: Partial<CarryBrief> = {}): CarryBrief {
  return {
    ownerId: 'su-test',
    loop: null,
    heldItems: [],
    directives: [],
    directivesTotalOpen: 0,
    walls: [],
    facts: [],
    awaits: [],
    fleet: null,
    ...over,
  };
}

function held(over: Partial<CarryBrief['heldItems'][number]> = {}): CarryBrief['heldItems'][number] {
  return { id: 'WI-1', title: 't', body: null, harness: 'papercusp', checkpoint: 'ok', checkpointUpdatedAtMs: NOW, ...over };
}

describe('staleCheckpointWarnings', () => {
  it('flags a missing checkpoint', () => {
    const w = staleCheckpointWarnings(brief({ heldItems: [held({ id: 'WI-9', checkpoint: null })] }), NOW);
    expect(w).toEqual([{ id: 'WI-9', title: 't', reason: 'missing' }]);
  });

  it('flags a checkpoint older than the stale window, with age minutes', () => {
    const old = NOW - (STALE_CHECKPOINT_WARN_MS + 5 * 60_000);
    const w = staleCheckpointWarnings(brief({ heldItems: [held({ checkpointUpdatedAtMs: old })] }), NOW);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ id: 'WI-1', reason: 'stale', ageMinutes: 20 });
  });

  it('does not flag a fresh checkpoint', () => {
    expect(staleCheckpointWarnings(brief({ heldItems: [held()] }), NOW)).toEqual([]);
  });

  it('returns [] for a null brief', () => {
    expect(staleCheckpointWarnings(null, NOW)).toEqual([]);
  });
});

describe('detectFlushTripwires', () => {
  it('is empty on a clean brief', () => {
    expect(detectFlushTripwires(brief({ heldItems: [held()] }), NOW)).toEqual([]);
  });

  it('emits missing- and stale-checkpoint tripwires', () => {
    const old = NOW - 2 * STALE_CHECKPOINT_WARN_MS;
    const t = detectFlushTripwires(
      brief({ heldItems: [held({ id: 'WI-A', checkpoint: null }), held({ id: 'WI-B', checkpointUpdatedAtMs: old })] }),
      NOW,
    );
    expect(t.map((x) => x.kind).sort()).toEqual(['missing-checkpoint', 'stale-checkpoint']);
    expect(t.find((x) => x.kind === 'missing-checkpoint')?.subject).toBe('WI-A');
  });

  it('emits armed-loop-no-carry-note when a COLD loop is active with no note', () => {
    const t = detectFlushTripwires(
      brief({ loop: { harness: 'papercusp', active: true, intervalSec: 60, carry: 'cold', goal: null, carryNote: '  ', carryNoteUpdatedAtMs: null } }),
      NOW,
    );
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ kind: 'armed-loop-no-carry-note', subject: 'papercusp' });
  });

  it('does NOT flag an armed COLD loop that HAS a carry-note', () => {
    const t = detectFlushTripwires(
      brief({ loop: { harness: 'papercusp', active: true, intervalSec: 60, carry: 'cold', goal: null, carryNote: '## Next\ngo', carryNoteUpdatedAtMs: NOW } }),
      NOW,
    );
    expect(t).toEqual([]);
  });

  it('does NOT flag an armed WARM loop with no carry-note', () => {
    const t = detectFlushTripwires(
      brief({ loop: { harness: 'papercusp', active: true, intervalSec: 60, carry: 'warm', goal: null, carryNote: null, carryNoteUpdatedAtMs: null } }),
      NOW,
    );
    expect(t).toEqual([]);
  });

  it('does NOT flag an INACTIVE loop with no note', () => {
    const t = detectFlushTripwires(
      brief({ loop: { harness: 'papercusp', active: false, intervalSec: null, goal: null, carryNote: null, carryNoteUpdatedAtMs: null } }),
      NOW,
    );
    expect(t).toEqual([]);
  });

  // EI-21874665446367942: an active COLD loop whose note already names a next
  // action, but the caller supplies CONFIRMED zero real tool calls since the
  // note was written.
  const coldLoopWithNote = (): CarryBrief =>
    brief({
      loop: {
        harness: 'papercusp',
        active: true,
        intervalSec: 60,
        carry: 'cold',
        goal: null,
        carryNote: '## Next action\nRun the exact recipe on WI-9.',
        carryNoteUpdatedAtMs: NOW - 10 * 60_000,
      },
    });

  it('emits cold-successor-no-progress when zero tool calls landed since the note', () => {
    const t = detectFlushTripwires(coldLoopWithNote(), NOW, 0);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ kind: 'cold-successor-no-progress', subject: 'papercusp' });
    expect(t[0].detail).toContain('Run the exact recipe on WI-9.');
  });

  it('does NOT fire cold-successor-no-progress when evidence is unavailable (undefined)', () => {
    expect(detectFlushTripwires(coldLoopWithNote(), NOW)).toEqual([]);
  });

  it('does NOT fire cold-successor-no-progress when evidence is unavailable (null)', () => {
    expect(detectFlushTripwires(coldLoopWithNote(), NOW, null)).toEqual([]);
  });

  it('does NOT fire cold-successor-no-progress when at least one real tool call landed', () => {
    expect(detectFlushTripwires(coldLoopWithNote(), NOW, 1)).toEqual([]);
    expect(detectFlushTripwires(coldLoopWithNote(), NOW, 3)).toEqual([]);
  });

  it('does NOT fire cold-successor-no-progress for a WARM loop even at zero tool calls', () => {
    const t = detectFlushTripwires(
      brief({
        loop: {
          harness: 'papercusp',
          active: true,
          intervalSec: 60,
          carry: 'warm',
          goal: null,
          carryNote: '## Next action\ngo',
          carryNoteUpdatedAtMs: NOW - 10 * 60_000,
        },
      }),
      NOW,
      0,
    );
    expect(t).toEqual([]);
  });

  it('does NOT fire cold-successor-no-progress when the note names no next action', () => {
    const t = detectFlushTripwires(
      brief({
        loop: {
          harness: 'papercusp',
          active: true,
          intervalSec: 60,
          carry: 'cold',
          goal: null,
          carryNote: '## Did\nsome investigation',
          carryNoteUpdatedAtMs: NOW - 10 * 60_000,
        },
      }),
      NOW,
      0,
    );
    expect(t).toEqual([]);
  });

  it('does NOT fire cold-successor-no-progress while a deliberate event await is live', () => {
    const loopBrief = coldLoopWithNote();
    const t = detectFlushTripwires(
      {
        ...loopBrief,
        awaits: [{ eventKey: 'fleet:item-completed:inbox-ladder', note: 'wait for the item' }],
      },
      NOW,
      0,
    );
    expect(t).toEqual([]);
  });
});

describe('decideFlushGate', () => {
  const tw = [{ kind: 'missing-checkpoint' as const, subject: 'WI-1', detail: 'x' }];
  it('clears when there are no tripwires', () => {
    expect(decideFlushGate({ tripwires: [], alreadyRefused: false })).toBe('clear');
    expect(decideFlushGate({ tripwires: [], alreadyRefused: true })).toBe('clear');
  });
  it('refuses on the first encounter with tripwires', () => {
    expect(decideFlushGate({ tripwires: tw, alreadyRefused: false })).toBe('refuse');
  });
  it('escalates to mechanical-fallback when already refused and still not flushed', () => {
    expect(decideFlushGate({ tripwires: tw, alreadyRefused: true })).toBe('mechanical-fallback');
  });
});

describe('renderFlushRefusal', () => {
  it('names the exact flush command per tripwire kind and the escape', () => {
    const text = renderFlushRefusal('compaction', [
      { kind: 'missing-checkpoint', subject: 'WI-1', detail: 'x' },
      { kind: 'stale-checkpoint', subject: 'WI-2', detail: 'x', ageMinutes: 40 },
      { kind: 'armed-loop-no-carry-note', subject: 'papercusp', detail: 'x' },
    ]);
    expect(text).toContain('Compaction is HELD');
    expect(text).toContain('work_items:checkpoint');
    expect(text).toContain('WI-1');
    expect(text).toContain('WI-2 (40m old)');
    expect(text).toContain('loop:checkpoint');
    expect(text).toContain('mechanical fallback');
  });

  it('includes the cold-successor-no-progress detail verbatim', () => {
    const text = renderFlushRefusal('compaction', [
      {
        kind: 'cold-successor-no-progress',
        subject: 'papercusp',
        detail: 'your carry-note already names a next action ("do the thing") but you have made ZERO tool calls',
      },
    ]);
    expect(text).toContain('Compaction is HELD');
    expect(text).toContain('do the thing');
    expect(text).toContain('ZERO tool calls');
  });

  it('labels the handoff boundary', () => {
    expect(renderFlushRefusal('handoff', [{ kind: 'missing-checkpoint', subject: 'WI-1', detail: 'x' }])).toContain(
      'This handoff is HELD',
    );
  });
});

/**
 * EI-20218251557859818 — `armedLoopNeedsCarryNote` was extracted so the BOUNDARY gate
 * (this file) and the PRE-boundary flush-gate line (inbox-flush-gate.ts) ask the same
 * question. They previously did not: the pre-boundary line classified work-item claims
 * only, so the loop prerequisite was first discovered from a REFUSED boundary call.
 */
describe('armedLoopNeedsCarryNote (the shared carry-note predicate)', () => {
  const loop = (over: Partial<NonNullable<CarryBrief['loop']>> = {}): NonNullable<CarryBrief['loop']> => ({
    harness: 'papercusp',
    active: true,
    intervalSec: 60,
    carry: 'cold',
    goal: null,
    carryNote: null,
    carryNoteUpdatedAtMs: null,
    ...over,
  });

  it('is TRUE only for an active COLD loop with no note', () => {
    expect(armedLoopNeedsCarryNote(loop())).toBe(true);
    expect(armedLoopNeedsCarryNote(loop({ carryNote: '   ' }))).toBe(true); // whitespace is no note
  });

  it('is FALSE for warm, inactive, already-noted, absent-mode, and absent loops', () => {
    expect(armedLoopNeedsCarryNote(loop({ carry: 'warm' }))).toBe(false); // warm carries its transcript
    expect(armedLoopNeedsCarryNote(loop({ active: false }))).toBe(false);
    expect(armedLoopNeedsCarryNote(loop({ carryNote: '## Did\nreal note' }))).toBe(false);
    expect(armedLoopNeedsCarryNote(loop({ carry: undefined }))).toBe(false); // fails OPEN
    expect(armedLoopNeedsCarryNote(null)).toBe(false);
    expect(armedLoopNeedsCarryNote(undefined)).toBe(false);
  });

  /**
   * THE ANTI-DRIFT GUARD. The predicate and the boundary tripwire must agree on every
   * shape — that agreement is the whole reason the predicate was extracted. If someone
   * changes one without the other (re-inlining the condition, or widening only the
   * tripwire), this fails rather than letting the warning and the refusal diverge again.
   */
  it('AGREES with the armed-loop tripwire on every loop shape', () => {
    const shapes: Array<NonNullable<CarryBrief['loop']>> = [
      loop(),
      loop({ carryNote: '   ' }),
      loop({ carry: 'warm' }),
      loop({ active: false }),
      loop({ carryNote: '## Did\nreal note' }),
      loop({ carry: undefined }),
      loop({ carry: 'warm', carryNote: '## Did\nreal note' }),
      loop({ active: false, carry: 'warm' }),
    ];
    for (const l of shapes) {
      const tripwireFired = detectFlushTripwires(brief({ loop: l }), NOW).some(
        (t) => t.kind === 'armed-loop-no-carry-note',
      );
      expect(
        armedLoopNeedsCarryNote(l),
        `predicate and boundary tripwire disagree for ${JSON.stringify(l)}`,
      ).toBe(tripwireFired);
    }
  });

  it('CONTROL: a deliberately-wrong predicate breaks that agreement (the check discriminates)', () => {
    // Ignores `carry`, i.e. would flag WARM loops too — the most likely wrong widening.
    const wrong = (l: NonNullable<CarryBrief['loop']>) => Boolean(l.active && !(l.carryNote ?? '').trim());
    const warmNoNote = loop({ carry: 'warm' });
    const tripwireFired = detectFlushTripwires(brief({ loop: warmNoNote }), NOW).some(
      (t) => t.kind === 'armed-loop-no-carry-note',
    );
    expect(wrong(warmNoNote)).toBe(true);
    expect(tripwireFired).toBe(false);
    expect(armedLoopNeedsCarryNote(warmNoNote)).toBe(tripwireFired); // the real one still agrees
  });
});
