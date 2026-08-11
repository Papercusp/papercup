/**
 * turn-start-orientation — the pure composition half (P-004 / D-004 ruling 3).
 *
 * The IO half is a Promise.all of already-tested readers; what is worth pinning
 * here is the behaviour that decides whether an agent is oriented at all, and the
 * behaviour that decides what it COSTS every turn.
 */
import { describe, it, expect } from 'vitest';
import {
  composeOrientationBlock,
  fingerprintOrientation,
  orientationUnchanged,
  isEmptyOrientation,
  renderOrientationLines,
  ORIENTATION_BUDGET_CHARS,
  type OrientationState,
} from './turn-start-orientation';

const base: OrientationState = { held: [], unansweredDirected: 0, loopArmed: false };
const withWork: OrientationState = {
  held: [{ id: 'WI-1', status: 'wip' }],
  unansweredDirected: 2,
  loopArmed: true,
};

describe('turn-start-orientation — when it speaks', () => {
  it('says NOTHING when there is nothing to say (no held work, no mail, no loop)', () => {
    expect(isEmptyOrientation(base)).toBe(true);
    expect(composeOrientationBlock({ state: base, committed: null })).toBe('');
  });

  it('speaks in full on the FIRST turn (no committed cursor = baseline)', () => {
    const out = composeOrientationBlock({ state: withWork, committed: null });
    expect(out).toContain('Orientation');
    expect(out).toContain('WI-1 (wip)');
    expect(out).toContain('2 directed msg(s) awaiting YOUR reply');
  });

  it('says NOTHING on a turn where nothing changed — the whole economy of the fold', () => {
    const committed = fingerprintOrientation(withWork);
    expect(composeOrientationBlock({ state: withWork, committed })).toBe('');
  });

  it('speaks again the moment ANY tracked field changes', () => {
    const committed = fingerprintOrientation(withWork);
    for (const changed of [
      { ...withWork, unansweredDirected: 3 },
      { ...withWork, loopArmed: false },
      { ...withWork, held: [{ id: 'WI-1', status: 'blocked' }] },
      { ...withWork, held: [{ id: 'WI-2', status: 'wip' }] },
    ] as OrientationState[]) {
      expect(composeOrientationBlock({ state: changed, committed })).not.toBe('');
    }
  });

  it('re-emits the WHOLE block on a change, never a partial diff', () => {
    // Binding-context surface: an agent shown only the changed line would read the
    // elided lines as absent state. orient-list-delta.ts made the same call for
    // orient's claimable/facts folds; this mirrors it deliberately.
    const committed = fingerprintOrientation(withWork);
    const out = composeOrientationBlock({
      state: { ...withWork, unansweredDirected: 3 },
      committed,
    });
    expect(out).toContain('WI-1 (wip)'); // unchanged line still present
    expect(out).toContain('engine loop'); // unchanged line still present
  });

  it('a held-item STATUS change re-emits, not just an id change', () => {
    const a = fingerprintOrientation({ ...base, held: [{ id: 'WI-1', status: 'wip' }] });
    const b = fingerprintOrientation({ ...base, held: [{ id: 'WI-1', status: 'blocked' }] });
    expect(orientationUnchanged(a, b)).toBe(false);
  });

  it('held-item ORDER does not count as a change (the fingerprint sorts)', () => {
    const a = fingerprintOrientation({
      ...base,
      held: [{ id: 'WI-1', status: 'wip' }, { id: 'WI-2', status: 'wip' }],
    });
    const b = fingerprintOrientation({
      ...base,
      held: [{ id: 'WI-2', status: 'wip' }, { id: 'WI-1', status: 'wip' }],
    });
    expect(orientationUnchanged(a, b)).toBe(true);
  });

  it('treats an unrecognizable committed value as CHANGED (fail-open, never silent)', () => {
    // A delta must never make orientation worse than no delta — same posture as
    // idListUnchanged. Anything unparseable ⇒ deliver in full.
    for (const junk of [null, undefined, 'nope', 42, {}] as unknown[]) {
      expect(orientationUnchanged(junk as never, fingerprintOrientation(withWork))).toBe(false);
    }
  });
});

describe('turn-start-orientation — what it says', () => {
  it('leads with unanswered directed mail — it outranks the agent’s own work', () => {
    const [first] = renderOrientationLines(withWork);
    expect(first).toContain('awaiting YOUR reply');
  });

  it('warns explicitly when NO wake source is armed', () => {
    const out = composeOrientationBlock({
      state: { ...withWork, loopArmed: false },
      committed: null,
    });
    expect(out).toContain('not armed');
    expect(out).toContain('halt silently');
  });

  it('tells an agent holding nothing to claim before editing', () => {
    const out = composeOrientationBlock({
      state: { ...base, unansweredDirected: 1 },
      committed: null,
    });
    expect(out).toContain('holding: nothing');
  });
});

describe('turn-start-orientation — what it costs', () => {
  it('never exceeds its budget, even with an absurd number of held items', () => {
    const state: OrientationState = {
      held: Array.from({ length: 200 }, (_, i) => ({ id: `WI-${i}`, status: 'wip' })),
      unansweredDirected: 4,
      loopArmed: false,
    };
    const out = composeOrientationBlock({ state, committed: null });
    expect(out.length).toBeLessThanOrEqual(ORIENTATION_BUDGET_CHARS);
  });

  it('drops the LOWEST-priority line under pressure, keeping unanswered mail', () => {
    const state: OrientationState = {
      held: [{ id: `WI-${'x'.repeat(120)}`, status: 'wip' }],
      unansweredDirected: 4,
      loopArmed: false,
    };
    const out = composeOrientationBlock({ state, committed: null, budgetChars: 160 });
    expect(out).toContain('awaiting YOUR reply');
    expect(out).not.toContain('engine loop');
  });

  it('emits NOTHING rather than a bare header when the budget fits no real line', () => {
    const out = composeOrientationBlock({ state: withWork, committed: null, budgetChars: 10 });
    expect(out).toBe('');
  });
});
