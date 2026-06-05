/**
 * Boundary / edge-case unit coverage for `operator-fuzzy-dedup.ts`.
 *
 * The sibling `operator-fuzzy-dedup.test.ts` covers the happy path
 * (identical, paraphrase, unrelated). This file pins the load-bearing
 * edges the algorithm depends on:
 *   - the bounded-distance early-exit (`|len(a)-len(b)| > maxLen*0.4`
 *     → distance jumps to maxLen → similarity 0)
 *   - `normalize()` punctuation + whitespace collapse + casefold
 *   - the 0.82 SIMILARITY_THRESHOLD boundary (just-above vs just-below)
 *   - both-empty → similarity 1 (and one-empty → 0)
 *   - best-match selection among multiple candidates in findFuzzyDuplicate
 *
 * All assertions are derived from the real source (zero-dep, pure fns),
 * not from a guessed expected value.
 */
import { describe, expect, it } from 'vitest';
import { similarity, findFuzzyDuplicate, FUZZY_THRESHOLD } from './operator-fuzzy-dedup';

describe('FUZZY_THRESHOLD constant', () => {
  it('is the 0.82 project threshold', () => {
    expect(FUZZY_THRESHOLD).toBe(0.82);
  });
});

describe('similarity — empty handling', () => {
  it('both empty → 1 (identity short-circuit)', () => {
    expect(similarity('', '')).toBe(1);
  });

  it('both normalize to empty (pure punctuation) → 1', () => {
    // normalize strips everything non-alphanumeric, so "!!!" and "..." both
    // collapse to '' → the `!na && !nb` branch returns 1.
    expect(similarity('!!!', '...')).toBe(1);
  });

  it('one empty, one non-empty → 0 (distance equals the whole length)', () => {
    expect(similarity('', 'validator')).toBe(0);
    expect(similarity('validator', '')).toBe(0);
  });
});

describe('similarity — normalize() collapsing', () => {
  it('lowercases, strips punctuation, and collapses runs of whitespace', () => {
    // "Run   VALIDATOR!!!" and "run validator" both normalize to "run validator".
    expect(similarity('Run   VALIDATOR!!!', 'run validator')).toBe(1);
  });

  it('treats punctuation as a single space, not a deletion', () => {
    // "F-001" → "f 001"; "F 001" → "f 001". Identical after normalize.
    expect(similarity('F-001', 'F 001')).toBe(1);
  });

  it('trims leading/trailing whitespace', () => {
    expect(similarity('  hello  ', 'hello')).toBe(1);
  });
});

describe('similarity — bounded-distance early-exit', () => {
  it('returns 0 when the length gap exceeds maxLen*0.4 (no quadratic work)', () => {
    // a normalizes to "ab" (len 2); b normalizes to "abcdefghij" (len 10).
    // maxLen=10, |2-10|=8 > 10*0.4=4 → levenshtein returns maxLen (10) for free,
    // so similarity = 1 - 10/10 = 0 even though "ab" is a prefix of b.
    const s = similarity('ab', 'abcdefghij');
    expect(s).toBe(0);
  });

  it('does NOT early-exit when the length gap is within maxLen*0.4', () => {
    // "abcde" (5) vs "abcdef" (6): maxLen=6, gap=1 ≤ 6*0.4=2.4 → real distance 1,
    // similarity = 1 - 1/6 ≈ 0.833 (above threshold), NOT the early-exit 0.
    const s = similarity('abcde', 'abcdef');
    expect(s).toBeGreaterThan(0.8);
    expect(s).toBeCloseTo(1 - 1 / 6, 10);
  });
});

describe('findFuzzyDuplicate — 0.82 threshold boundary', () => {
  // Construct titles whose normalized forms give a similarity straddling 0.82.
  // "0123456789" (10 chars) vs "012345678X" differs in 1 char → 1-1/10 = 0.90 (above).
  // "0123456789" vs "012XXXX789" differs in 4 chars (positions 3..6) within equal
  // length 10 → 1-4/10 = 0.60 (below). And a tuned just-below case at exactly
  // one char shy of the threshold.
  it('matches when similarity is just ABOVE 0.82', () => {
    const existing = [{ id: 'hit', title: '0123456789' }];
    // 1 substitution in 10 → 0.90 ≥ 0.82.
    const m = findFuzzyDuplicate('012345678x', existing);
    expect(m).not.toBeNull();
    expect(m?.matchedId).toBe('hit');
    expect(m?.similarity).toBeCloseTo(0.9, 10);
  });

  it('does NOT match when similarity is just BELOW 0.82', () => {
    const existing = [{ id: 'miss', title: '0123456789' }];
    // 2 substitutions in 10 → 0.80 < 0.82.
    const m = findFuzzyDuplicate('01234567xy', existing);
    expect(m).toBeNull();
  });

  it('exactly at the threshold (0.82) is NOT a strict-less-than reject', () => {
    // Build a pair whose similarity is exactly the threshold: lev/maxLen = 0.18.
    // Use maxLen 50 with 9 substitutions → 1-9/50 = 0.82 exactly. The guard is
    // `s < SIMILARITY_THRESHOLD → continue`, so s === 0.82 is accepted.
    const base = '0123456789'.repeat(5); // 50 chars, all alphanumeric → normalize keeps them
    const mutated = base.split('');
    for (let i = 0; i < 9; i++) mutated[i] = mutated[i] === 'a' ? 'b' : 'a'; // 9 substitutions
    const existing = [{ id: 'edge', title: base }];
    const m = findFuzzyDuplicate(mutated.join(''), existing);
    // sanity: confirm we actually hit 0.82 (not 0.80 / 0.84) before asserting accept
    expect(similarity(mutated.join(''), base)).toBeCloseTo(0.82, 10);
    expect(m).not.toBeNull();
    expect(m?.matchedId).toBe('edge');
  });
});

describe('findFuzzyDuplicate — best-match selection', () => {
  it('returns the highest-similarity candidate, not merely the first over threshold', () => {
    const existing = [
      // First over threshold but NOT identical: one extra word → ~0.84.
      { id: 'good', title: 'Run validator now on F 001' },
      // Exact normalized match → 1.0, the true best.
      { id: 'better', title: 'Run validator on F-001' },
    ];
    const candidate = 'Run validator on F-001';
    // sanity: the second is strictly more similar than the first
    expect(similarity(candidate, existing[1].title)).toBeGreaterThan(
      similarity(candidate, existing[0].title),
    );
    const m = findFuzzyDuplicate(candidate, existing);
    expect(m?.matchedId).toBe('better');
    expect(m?.similarity).toBe(1); // normalizes identical → exact 1.0
  });

  it('returns null on an empty candidate list', () => {
    expect(findFuzzyDuplicate('anything', [])).toBeNull();
  });

  it('keeps the first candidate when two tie on similarity', () => {
    // Ties resolve to the first seen, because the update is strict `>`.
    const existing = [
      { id: 'first', title: 'alpha beta' },
      { id: 'second', title: 'alpha beta' },
    ];
    const m = findFuzzyDuplicate('alpha beta', existing);
    expect(m?.matchedId).toBe('first');
  });
});
