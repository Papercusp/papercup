import { describe, expect, it } from 'vitest';
import {
  coerceLevel,
  extractFinalAnswer,
  gaiaQuestionScorer,
  gradeGaia,
  gradeGaiaTask,
  isFloatStr,
  normalizeNumberStr,
  normalizeStr,
  pyFloat,
  splitGaiaList,
  type GaiaPrediction,
} from './gaia';

describe('gaia grader — pyFloat (Python float() fidelity)', () => {
  it('parses standard numeric forms', () => {
    expect(pyFloat('1')).toEqual({ ok: true, value: 1 });
    expect(pyFloat('1.5')).toEqual({ ok: true, value: 1.5 });
    expect(pyFloat('.5')).toEqual({ ok: true, value: 0.5 });
    expect(pyFloat('1.')).toEqual({ ok: true, value: 1 });
    expect(pyFloat('-2.5e-3')).toEqual({ ok: true, value: -0.0025 });
    expect(pyFloat('  42  ')).toEqual({ ok: true, value: 42 }); // float() strips surrounding whitespace
  });
  it('accepts inf/nan literals like CPython', () => {
    expect(pyFloat('inf').ok).toBe(true);
    expect(pyFloat('inf').value).toBe(Infinity);
    expect(pyFloat('-Infinity').value).toBe(-Infinity);
    expect(pyFloat('nan').ok).toBe(true);
    expect(Number.isNaN(pyFloat('nan').value)).toBe(true);
  });
  it('rejects thousands-commas, embedded units, hex, empty (no false numbers)', () => {
    expect(pyFloat('1,000').ok).toBe(false);
    expect(pyFloat('100000 dollars').ok).toBe(false);
    expect(pyFloat('0x10').ok).toBe(false);
    expect(pyFloat('').ok).toBe(false);
    expect(pyFloat('   ').ok).toBe(false);
    expect(pyFloat('5%').ok).toBe(false);
    expect(pyFloat('abc').ok).toBe(false);
  });
});

describe('gaia grader — normalizeNumberStr', () => {
  it('strips $ % and thousands commas then parses', () => {
    expect(normalizeNumberStr('$100,000')).toBe(100000);
    expect(normalizeNumberStr('1,234,567')).toBe(1234567);
    expect(normalizeNumberStr('5%')).toBe(5);
    expect(normalizeNumberStr('3.14')).toBe(3.14);
  });
  it('returns Infinity on a parse failure (faithful float("inf") fallback)', () => {
    expect(normalizeNumberStr('100000 dollars')).toBe(Infinity); // unit not stripped → unparseable
    expect(normalizeNumberStr('not a number')).toBe(Infinity);
  });
});

describe('gaia grader — normalizeStr', () => {
  it('lowercases, strips whitespace and (default) punctuation', () => {
    expect(normalizeStr('St. Petersburg')).toBe('stpetersburg');
    expect(normalizeStr('  The   Eiffel Tower! ')).toBe('theeiffeltower');
    expect(normalizeStr("O'Brien")).toBe('obrien');
  });
  it('keeps punctuation when removePunct=false (list-element path)', () => {
    expect(normalizeStr('U.S.A', false)).toBe('u.s.a');
    expect(normalizeStr(' New York ', false)).toBe('newyork');
  });
});

describe('gaia grader — gaiaQuestionScorer: numbers', () => {
  it('matches numbers regardless of $ , % formatting', () => {
    expect(gaiaQuestionScorer('100,000', '100000')).toBe(true);
    expect(gaiaQuestionScorer('$100,000', '100000')).toBe(true);
    expect(gaiaQuestionScorer('17', '17')).toBe(true);
    expect(gaiaQuestionScorer('17.0', '17')).toBe(true);
  });
  it('a model answer carrying units FAILS the number path (must omit units)', () => {
    expect(gaiaQuestionScorer('100000 dollars', '100000')).toBe(false);
    expect(gaiaQuestionScorer('5 percent', '5')).toBe(false);
  });
  it('wrong number fails', () => {
    expect(gaiaQuestionScorer('18', '17')).toBe(false);
  });
});

describe('gaia grader — gaiaQuestionScorer: strings', () => {
  it('is article / case / whitespace / punctuation insensitive', () => {
    expect(gaiaQuestionScorer('The Louvre', 'Louvre')).toBe(false); // "the" is NOT auto-stripped by the scorer…
    // …the model is INSTRUCTED to drop articles; the scorer only strips whitespace+punct+case.
    expect(gaiaQuestionScorer('louvre', 'Louvre')).toBe(true);
    expect(gaiaQuestionScorer('St. Petersburg', 'st petersburg')).toBe(true);
    expect(gaiaQuestionScorer('NEW YORK', 'new york')).toBe(true);
  });
  it('different strings fail', () => {
    expect(gaiaQuestionScorer('Paris', 'London')).toBe(false);
  });
});

describe('gaia grader — gaiaQuestionScorer: lists', () => {
  it('matches comma-separated lists element-wise (order matters)', () => {
    expect(gaiaQuestionScorer('apple, banana, cherry', 'apple, banana, cherry')).toBe(true);
    expect(gaiaQuestionScorer('apple,banana,cherry', 'apple, banana, cherry')).toBe(true); // whitespace-insensitive per element
    expect(gaiaQuestionScorer('banana, apple, cherry', 'apple, banana, cherry')).toBe(false); // order differs
  });
  it('different lengths fail', () => {
    expect(gaiaQuestionScorer('apple, banana', 'apple, banana, cherry')).toBe(false);
  });
  it('applies the number rule to numeric list elements', () => {
    expect(gaiaQuestionScorer('1,000, 2,000', '1000; 2000')).toBe(false); // commas split "1,000" into extra elems
    expect(gaiaQuestionScorer('1, 2, 3', '1, 2, 3')).toBe(true);
    expect(gaiaQuestionScorer('1.0, 2, 3', '1, 2, 3')).toBe(true);
  });
  it('handles semicolon-separated gold lists', () => {
    expect(gaiaQuestionScorer('a; b; c', 'a; b; c')).toBe(true);
    expect(gaiaQuestionScorer('a, b, c', 'a; b; c')).toBe(true); // both split on [,;]
  });
  it('list string elements keep punctuation (remove_punct=False)', () => {
    // "u.s.a" vs "usa" differ on the list path (punctuation retained), unlike the bare-string path.
    expect(gaiaQuestionScorer('U.S.A, Canada', 'USA, Canada')).toBe(false);
    expect(gaiaQuestionScorer('USA, Canada', 'usa, canada')).toBe(true);
  });
});

describe('gaia grader — extractFinalAnswer', () => {
  it('extracts the text after the marker', () => {
    expect(extractFinalAnswer('Reasoning here...\nFINAL ANSWER: Paris')).toBe('Paris');
  });
  it('is case-insensitive and tolerant of spacing', () => {
    expect(extractFinalAnswer('final answer:42')).toBe('42');
    expect(extractFinalAnswer('Final Answer :  7 ')).toBe('7');
  });
  it('takes the LAST marker when the template is restated', () => {
    expect(extractFinalAnswer('FINAL ANSWER: draft\nmore thought\nFINAL ANSWER: final')).toBe('final');
  });
  it('unwraps a literal [ ... ] echoed from the template', () => {
    expect(extractFinalAnswer('FINAL ANSWER: [Mercury]')).toBe('Mercury');
  });
  it('returns null when there is no marker (a formatting failure)', () => {
    expect(extractFinalAnswer('The answer is clearly Paris.')).toBeNull();
  });
  it('stops at a new paragraph after the answer', () => {
    expect(extractFinalAnswer('FINAL ANSWER: Paris\n\nThanks for the question!')).toBe('Paris');
  });
});

describe('gaia grader — coerceLevel', () => {
  it('coerces string / number / "Level N" forms', () => {
    expect(coerceLevel('1')).toBe(1);
    expect(coerceLevel(2)).toBe(2);
    expect(coerceLevel('Level 3')).toBe(3);
  });
  it('throws on an unparseable level', () => {
    expect(() => coerceLevel('hard')).toThrow();
  });
});

describe('gaia grader — gradeGaiaTask + gradeGaia aggregation', () => {
  it('grades a raw output by extracting FINAL ANSWER', () => {
    const g = gradeGaiaTask({ taskId: 't1', rawOutput: 'work...\nFINAL ANSWER: Paris', gold: 'Paris', level: 1 });
    expect(g.resolved).toBe(true);
    expect(g.extractedAnswer).toBe('Paris');
    expect(g.formatFail).toBe(false);
  });
  it('marks a missing FINAL ANSWER as a formatting failure (not resolved)', () => {
    const g = gradeGaiaTask({ taskId: 't2', rawOutput: 'I think it is Paris', gold: 'Paris', level: 1 });
    expect(g.resolved).toBe(false);
    expect(g.formatFail).toBe(true);
    expect(g.extractedAnswer).toBeNull();
  });
  it('accepts a pre-extracted modelAnswer', () => {
    const g = gradeGaiaTask({ taskId: 't3', modelAnswer: '42', gold: '42', level: 2 });
    expect(g.resolved).toBe(true);
    expect(g.formatFail).toBe(false);
  });
  it('excludes drift rows from scoring but surfaces them', () => {
    const g = gradeGaiaTask({ taskId: 't4', modelAnswer: 'x', gold: 'y', level: 3, excludeReason: 'source moved' });
    expect(g.excludeReason).toBe('source moved');
    expect(g.resolved).toBe(false);
  });

  it('aggregates per-level + overall accuracy, excluding drift rows from the denominator', () => {
    const preds: GaiaPrediction[] = [
      { taskId: 'l1a', modelAnswer: 'Paris', gold: 'Paris', level: 1 }, // resolved
      { taskId: 'l1b', modelAnswer: 'London', gold: 'Paris', level: 1 }, // wrong
      { taskId: 'l2a', rawOutput: 'no marker here', gold: '7', level: 2 }, // format fail
      { taskId: 'l2b', modelAnswer: '7', gold: '7', level: 2 }, // resolved
      { taskId: 'l3a', modelAnswer: 'x', gold: 'y', level: 3, excludeReason: 'live-web drift' }, // excluded
      { taskId: 'l3b', modelAnswer: 'cat, dog', gold: 'cat, dog', level: 3 }, // resolved
    ];
    const r = gradeGaia(preds);
    // 5 scored (one excluded), 3 resolved (l1a, l2b, l3b).
    expect(r.scored).toBe(5);
    expect(r.resolved).toBe(3);
    expect(r.excluded).toBe(1);
    expect(r.overallAccuracy).toBeCloseTo(3 / 5);
    expect(r.formatFails).toBe(1);
    expect(r.formatFailRate).toBeCloseTo(1 / 5);

    const l1 = r.byLevel.find((b) => b.level === 1)!;
    expect(l1).toMatchObject({ scored: 2, resolved: 1, accuracy: 0.5 });
    const l2 = r.byLevel.find((b) => b.level === 2)!;
    expect(l2).toMatchObject({ scored: 2, resolved: 1, formatFails: 1 });
    const l3 = r.byLevel.find((b) => b.level === 3)!;
    expect(l3).toMatchObject({ scored: 1, resolved: 1, excluded: 1 });
  });

  it('is deterministic (same input → identical report)', () => {
    const preds: GaiaPrediction[] = [{ taskId: 'a', modelAnswer: '1', gold: '1', level: 1 }];
    expect(JSON.stringify(gradeGaia(preds))).toBe(JSON.stringify(gradeGaia(preds)));
  });
});

describe('gaia grader — splitGaiaList / isFloatStr surface', () => {
  it('splits on comma and semicolon', () => {
    expect(splitGaiaList('a,b;c')).toEqual(['a', 'b', 'c']);
  });
  it('isFloatStr matches pyFloat.ok', () => {
    expect(isFloatStr('3.2')).toBe(true);
    expect(isFloatStr('3 apples')).toBe(false);
  });
});
