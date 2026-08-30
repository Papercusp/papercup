import { beforeEach, describe, expect, it } from 'vitest';
import {
  configureSelectionPolicies,
  hasSelectionPolicy,
  listSelectionPolicies,
  outranks,
  resetSelectionPolicies,
  selectRanked,
  selectionPolicy,
  selectionProvenance,
  UnknownSelectionPolicyError,
  type SelectionBounds,
  type Selected,
  type SelectionVia,
} from './index';

interface Cand {
  id: string;
  score: number;
  reachable?: boolean;
}

const c = (id: string, score: number, reachable = true): Cand => ({ id, score, reachable });
const identity = (x: Cand): string => x.id;
const ids = (sel: Array<Selected<Cand>>): string[] => sel.map((s) => s.candidate.id);
const vias = (sel: Array<Selected<Cand>>): SelectionVia[] => sel.map((s) => s.via);

// ── falsifiability controls ────────────────────────────────────────────────
// Deliberately-wrong implementations kept PERMANENTLY beside the real subject.
// A guard that has never failed is a guard nobody has tested, and the safe way
// to prove these assertions can fail is to run them against an implementation
// that is wrong in exactly the way the real one must not be — never by mutating
// the shared tree (git-sync sweeps it on a schedule, so a temporarily-mutated
// file can be committed even when nothing goes wrong).

/** WRONG: fills to `max` instead of `min` — the cap-becomes-quota bug. */
function selectFillingToMax<C>(params: {
  qualified: readonly C[];
  allCandidates: readonly C[];
  bounds: SelectionBounds;
  identity: (x: C) => string;
  isSelectable?: (x: C) => boolean;
}): Array<Selected<C>> {
  const ok = params.isSelectable ?? ((): boolean => true);
  const picked: Array<Selected<C>> = [];
  const seen = new Set<string>();
  for (const x of params.qualified) {
    if (picked.length >= params.bounds.max) break;
    if (seen.has(params.identity(x)) || !ok(x)) continue;
    picked.push({ candidate: x, via: 'floor' });
    seen.add(params.identity(x));
  }
  for (const x of params.allCandidates) {
    if (picked.length >= params.bounds.max) break;
    if (seen.has(params.identity(x)) || !ok(x)) continue;
    picked.push({ candidate: x, via: 'minimum' });
    seen.add(params.identity(x));
  }
  return picked;
}

/** WRONG: labels every pick 'floor' — the silent-blend bug. */
function selectBlendingProvenance<C>(params: {
  qualified: readonly C[];
  allCandidates: readonly C[];
  bounds: SelectionBounds;
  identity: (x: C) => string;
}): Array<Selected<C>> {
  return selectRanked(params).map((s) => ({ candidate: s.candidate, via: 'floor' as SelectionVia }));
}

describe('selectRanked — qualified picks', () => {
  it('takes qualified candidates best-first up to max', () => {
    const q = [c('a', 9), c('b', 8), c('c', 7)];
    const out = selectRanked({ qualified: q, allCandidates: q, bounds: { min: 1, max: 2 }, identity });
    expect(ids(out)).toEqual(['a', 'b']);
    expect(vias(out)).toEqual(['floor', 'floor']);
  });

  it('never exceeds max even when many qualify', () => {
    const q = [c('a', 9), c('b', 8), c('c', 7), c('d', 6)];
    const out = selectRanked({ qualified: q, allCandidates: q, bounds: { min: 0, max: 2 }, identity });
    expect(out).toHaveLength(2);
  });

  it('max:0 selects nobody', () => {
    const q = [c('a', 9)];
    expect(selectRanked({ qualified: q, allCandidates: q, bounds: { min: 0, max: 0 }, identity })).toEqual([]);
  });
});

describe('selectRanked — minimum fill', () => {
  const qualified: Cand[] = [];
  const pool = [c('x', 5), c('y', 4), c('z', 3)];

  it('fills from the full pool when nobody qualifies, labelled minimum', () => {
    const out = selectRanked({ qualified, allCandidates: pool, bounds: { min: 1, max: 2 }, identity });
    expect(ids(out)).toEqual(['x']);
    expect(vias(out)).toEqual(['minimum']);
  });

  it('fills to MIN, not to MAX — a cap is not a quota', () => {
    const out = selectRanked({ qualified, allCandidates: pool, bounds: { min: 1, max: 3 }, identity });
    expect(out).toHaveLength(1);

    // CONTROL: the fills-to-max implementation takes three, and this same
    // assertion catches it. Without this the test above passes trivially for a
    // pool that happened to be short.
    const wrong = selectFillingToMax({ qualified, allCandidates: pool, bounds: { min: 1, max: 3 }, identity });
    expect(wrong).toHaveLength(3);
  });

  it('tops a short qualified set up to min and no further', () => {
    const out = selectRanked({
      qualified: [c('a', 9)],
      allCandidates: [c('a', 9), ...pool],
      bounds: { min: 2, max: 3 },
      identity,
    });
    expect(ids(out)).toEqual(['a', 'x']);
    expect(vias(out)).toEqual(['floor', 'minimum']);
  });

  it('does not fill when the qualified set already meets min', () => {
    const out = selectRanked({
      qualified: [c('a', 9), c('b', 8)],
      allCandidates: [c('a', 9), c('b', 8), ...pool],
      bounds: { min: 2, max: 3 },
      identity,
    });
    expect(vias(out)).toEqual(['floor', 'floor']);
  });

  it('min:0 disables filling entirely', () => {
    const out = selectRanked({ qualified, allCandidates: pool, bounds: { min: 0, max: 3 }, identity });
    expect(out).toEqual([]);
  });
});

describe('selectRanked — labelling is the whole point', () => {
  it('a fill is distinguishable from a qualified pick', () => {
    const out = selectRanked({
      qualified: [c('a', 9)],
      allCandidates: [c('a', 9), c('x', 5)],
      bounds: { min: 2, max: 2 },
      identity,
    });
    expect(selectionProvenance(out)).toEqual(['floor', 'minimum']);

    // CONTROL: an implementation that blends provenance reports one class, and
    // this assertion is what catches it.
    const wrong = selectBlendingProvenance({
      qualified: [c('a', 9)],
      allCandidates: [c('a', 9), c('x', 5)],
      bounds: { min: 2, max: 2 },
      identity,
    });
    expect(selectionProvenance(wrong)).toEqual(['floor']);
  });
});

describe('selectRanked — de-duplication and selectability', () => {
  it('never selects the same identity twice across the two pools', () => {
    const out = selectRanked({
      qualified: [c('a', 9)],
      allCandidates: [c('a', 9), c('a', 9), c('b', 8)],
      bounds: { min: 2, max: 2 },
      identity,
    });
    expect(ids(out)).toEqual(['a', 'b']);
  });

  it('skips unselectable candidates in the qualified pass', () => {
    const out = selectRanked({
      qualified: [c('a', 9, false), c('b', 8)],
      allCandidates: [c('a', 9, false), c('b', 8)],
      bounds: { min: 1, max: 2 },
      identity,
      isSelectable: (x) => x.reachable !== false,
    });
    expect(ids(out)).toEqual(['b']);
  });

  it('leaves the minimum UNFILLED when only unselectable candidates remain', () => {
    // An honest short menu beats an unusable pick — the caller can tell the
    // difference between "nobody" and "somebody unreachable".
    const out = selectRanked({
      qualified: [],
      allCandidates: [c('x', 5, false), c('y', 4, false)],
      bounds: { min: 2, max: 2 },
      identity,
      isSelectable: (x) => x.reachable !== false,
    });
    expect(out).toEqual([]);
  });
});

describe('selectRanked — bounds normalisation', () => {
  const pool = [c('a', 9), c('b', 8), c('c', 7)];

  it('clamps min down to max rather than over-filling', () => {
    const out = selectRanked({ qualified: [], allCandidates: pool, bounds: { min: 5, max: 2 }, identity });
    expect(out).toHaveLength(2);
  });

  it('treats a negative max as zero', () => {
    const out = selectRanked({ qualified: pool, allCandidates: pool, bounds: { min: -3, max: -1 }, identity });
    expect(out).toEqual([]);
  });

  it('floors fractional bounds', () => {
    const out = selectRanked({ qualified: pool, allCandidates: pool, bounds: { min: 0, max: 2.9 }, identity });
    expect(out).toHaveLength(2);
  });
});

describe('outranks', () => {
  it('a qualified pick strictly outranks a below-floor fill', () => {
    expect(outranks('floor', 'minimum')).toBe(true);
  });

  it('is not symmetric and ties are not outranking', () => {
    expect(outranks('minimum', 'floor')).toBe(false);
    expect(outranks('floor', 'floor')).toBe(false);
    expect(outranks('minimum', 'minimum')).toBe(false);
  });
});

describe('selection policy registry', () => {
  beforeEach(() => resetSelectionPolicies());

  it('reads back what was registered', () => {
    configureSelectionPolicies({ 'rubric-vetting': { min: 1, max: 2 } });
    expect(selectionPolicy('rubric-vetting')).toEqual({ min: 1, max: 2 });
  });

  it('merges across calls so one key can be overridden alone', () => {
    configureSelectionPolicies({ a: { min: 1, max: 2 }, b: { min: 1, max: 3 } });
    configureSelectionPolicies({ b: { min: 1, max: 2 } });
    expect(listSelectionPolicies()).toEqual({ a: { min: 1, max: 2 }, b: { min: 1, max: 2 } });
  });

  it('THROWS on an unknown key rather than defaulting', () => {
    configureSelectionPolicies({ known: { min: 1, max: 2 } });
    // A silent default would reintroduce the per-call-site drift the registry
    // exists to remove, while looking like it worked.
    expect(() => selectionPolicy('missing')).toThrow(UnknownSelectionPolicyError);
    expect(() => selectionPolicy('missing')).toThrow(/registered: known/);
  });

  it('names the empty case distinctly', () => {
    expect(() => selectionPolicy('anything')).toThrow(/no policies are registered at all/);
  });

  it('hasSelectionPolicy does not throw', () => {
    expect(hasSelectionPolicy('nope')).toBe(false);
    configureSelectionPolicies({ nope: { min: 0, max: 1 } });
    expect(hasSelectionPolicy('nope')).toBe(true);
  });

  it('rejects min > max at registration, not at selection time', () => {
    expect(() => configureSelectionPolicies({ bad: { min: 3, max: 1 } })).toThrow(/can never be honoured/);
  });

  it('rejects negative and non-finite bounds', () => {
    expect(() => configureSelectionPolicies({ neg: { min: -1, max: 2 } })).toThrow(RangeError);
    expect(() => configureSelectionPolicies({ nan: { min: 0, max: Number.NaN } })).toThrow(TypeError);
  });

  it('returns a copy so a caller cannot mutate the registry through it', () => {
    configureSelectionPolicies({ k: { min: 1, max: 2 } });
    const got = selectionPolicy('k');
    got.max = 99;
    expect(selectionPolicy('k')).toEqual({ min: 1, max: 2 });
  });

  it('drives selectRanked end-to-end', () => {
    configureSelectionPolicies({ 'acceptance-grading': { min: 1, max: 2 } });
    const pool = [c('a', 9), c('b', 8), c('c', 7)];
    const out = selectRanked({
      qualified: pool,
      allCandidates: pool,
      bounds: selectionPolicy('acceptance-grading'),
      identity,
    });
    expect(ids(out)).toEqual(['a', 'b']);
  });
});
