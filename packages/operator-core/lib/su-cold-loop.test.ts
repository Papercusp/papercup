/**
 * su-cold-loop.test.ts — the cold-auto wake DECISION (su-cold-auto-mode-2026-07-03
 * Phase 2; P-005 cadence + P-006 carry-note precondition). Pure — no DB / spawn.
 */
import { describe, expect, it } from 'vitest';
import {
  readColdLoopMarker,
  coldWakeMode,
  decideColdWake,
  renderColdWakeInjection,
  DEFAULT_COLD_LOOP_CAPS,
} from './su-cold-loop';

describe('readColdLoopMarker', () => {
  it('returns null for a payload with neither cold field (an ordinary warm wake)', () => {
    expect(readColdLoopMarker(null)).toBeNull();
    expect(readColdLoopMarker(undefined)).toBeNull();
    expect(readColdLoopMarker({})).toBeNull();
    expect(readColdLoopMarker({ kickoff: 'do the thing' })).toBeNull();
    expect(readColdLoopMarker('a string')).toBeNull();
  });
  it('reads carry + wakeCount when present, ignoring wrong types', () => {
    expect(readColdLoopMarker({ carry: 'cold', wakeCount: 3 })).toEqual({ carry: 'cold', wakeCount: 3 });
    expect(readColdLoopMarker({ carry: 'warm' })).toEqual({ carry: 'warm', wakeCount: undefined });
    expect(readColdLoopMarker({ wakeCount: 5 })).toEqual({ carry: undefined, wakeCount: 5 });
    // wrong types are dropped, not coerced
    expect(readColdLoopMarker({ carry: 7, wakeCount: 'x' })).toBeNull();
    expect(readColdLoopMarker({ carry: 'cold', wakeCount: Number.NaN })).toEqual({ carry: 'cold', wakeCount: undefined });
  });
});

describe('coldWakeMode — the HYBRID cadence (reset each wake, recycle every Nth)', () => {
  it('resets on the non-Nth wakes and recycles on the Nth (default N=8)', () => {
    const modes = Array.from({ length: 16 }, (_, i) => coldWakeMode(i + 1));
    // wakes 1..7 reset, 8 recycles, 9..15 reset, 16 recycles
    expect(modes).toEqual([
      'reset', 'reset', 'reset', 'reset', 'reset', 'reset', 'reset', 'recycle',
      'reset', 'reset', 'reset', 'reset', 'reset', 'reset', 'reset', 'recycle',
    ]);
  });
  it('an unknown / zero / negative wakeCount is a plain reset (never a surprise recycle)', () => {
    expect(coldWakeMode(0)).toBe('reset');
    expect(coldWakeMode(-3)).toBe('reset');
    expect(coldWakeMode(Number.NaN)).toBe('reset');
  });
  it('a non-positive cap disables recycle entirely (reset-only)', () => {
    expect(coldWakeMode(8, { recycleEveryNWakes: 0 })).toBe('reset');
    expect(coldWakeMode(16, { recycleEveryNWakes: -1 })).toBe('reset');
  });
  it('honours a custom cadence', () => {
    expect(coldWakeMode(3, { recycleEveryNWakes: 3 })).toBe('recycle');
    expect(coldWakeMode(4, { recycleEveryNWakes: 3 })).toBe('reset');
  });
  it('the default cadence matches the bee transcript-cap default (8)', () => {
    expect(DEFAULT_COLD_LOOP_CAPS.recycleEveryNWakes).toBe(8);
  });
});

describe('decideColdWake — the three-gate cold precondition', () => {
  const coldPayload = (wakeCount?: number) => ({ carry: 'cold', ...(wakeCount != null ? { wakeCount } : {}) });

  it('WARM when the loop is not cold (opt-in gate, D-001/P-003)', () => {
    expect(decideColdWake({ payload: { carry: 'warm' }, coldEnabled: true, carryNote: 'note' })).toEqual({
      cold: false,
      reason: 'warm loop (or not a cold loop wake)',
    });
    // not a loop wake at all
    expect(decideColdWake({ payload: { kickoff: 'x' }, coldEnabled: true, carryNote: 'note' }).cold).toBe(false);
  });

  it('WARM when cold-auto is disabled at the master gate (P-007), even for a cold loop', () => {
    expect(decideColdWake({ payload: coldPayload(3), coldEnabled: false, carryNote: 'note' })).toEqual({
      cold: false,
      reason: 'cold-auto disabled (master gate off)',
    });
  });

  it('WARM when there is NO carry-note to reconstruct from (P-006 — the key safety)', () => {
    expect(decideColdWake({ payload: coldPayload(3), coldEnabled: true, carryNote: null }).cold).toBe(false);
    expect(decideColdWake({ payload: coldPayload(3), coldEnabled: true, carryNote: '   ' })).toEqual({
      cold: false,
      reason: 'no carry-note anchor — cannot safely cold-start (P-006)',
    });
  });

  it('COLD reset on a normal cold wake with a carry-note (trimmed)', () => {
    expect(decideColdWake({ payload: coldPayload(3), coldEnabled: true, carryNote: '  the note  ' })).toEqual({
      cold: true,
      mode: 'reset',
      carryNote: 'the note',
    });
  });

  it('COLD recycle on the Nth cold wake (cadence flows through)', () => {
    expect(decideColdWake({ payload: coldPayload(8), coldEnabled: true, carryNote: 'note' })).toEqual({
      cold: true,
      mode: 'recycle',
      carryNote: 'note',
    });
  });

  it('all three gates must pass — any one failing is warm', () => {
    // cold loop + enabled + note ⇒ cold; drop any one ⇒ warm
    expect(decideColdWake({ payload: coldPayload(1), coldEnabled: true, carryNote: 'n' }).cold).toBe(true);
    expect(decideColdWake({ payload: { carry: 'warm', wakeCount: 1 }, coldEnabled: true, carryNote: 'n' }).cold).toBe(false);
    expect(decideColdWake({ payload: coldPayload(1), coldEnabled: false, carryNote: 'n' }).cold).toBe(false);
    expect(decideColdWake({ payload: coldPayload(1), coldEnabled: true, carryNote: '' }).cold).toBe(false);
  });
});

describe('renderColdWakeInjection — the cold-wake injected text (P-002 producer)', () => {
  it('carries the carry-note verbatim', () => {
    const note = '## Did\nwired the producer\n\n## Next action\nrun the tests';
    expect(renderColdWakeInjection(note)).toContain(note);
  });

  it('frames the note as the working continuity (transcript is gone)', () => {
    const out = renderColdWakeInjection('some note');
    expect(out).toContain('COLD LOOP WAKE');
    expect(out.toLowerCase()).toContain('transcript');
    expect(out).toContain('Next action');
  });

  it('appends the STANDING re-checkpoint mandate so the next cold wake has a fresh anchor', () => {
    const out = renderColdWakeInjection('note');
    // the exact tool + the structured shape the agent must re-write
    expect(out).toContain('loop:checkpoint');
    for (const f of ['did', 'left', 'insight', 'next']) expect(out).toContain(f);
    // and the escape hatch when there is nothing left to do
    expect(out).toContain('loop:end');
  });

  it('trims surrounding whitespace on the note (a padded note injects clean)', () => {
    expect(renderColdWakeInjection('   padded   ')).toContain('\npadded\n');
  });

  it('tolerates an empty note without throwing (the P-006 guard means this is unreachable in practice, but stays safe)', () => {
    expect(() => renderColdWakeInjection('')).not.toThrow();
    expect(renderColdWakeInjection('')).toContain('loop:checkpoint');
  });
});
