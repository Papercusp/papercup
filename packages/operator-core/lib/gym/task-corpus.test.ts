/**
 * Gym task-corpus vocabulary + the release-gate predicate (plan
 * gym-real-fitness-signal-2026-07-27, P-003/P-011).
 *
 * The invariant under test is a SAFETY one: unknown or partial provenance must never
 * resolve to "real". Every gym champion before 2026-07-27 was earned on a synthetic
 * 4-line stub and read as indistinguishable from real work; these rules are what make
 * that unrepresentable.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GYM_TASK_CORPUS,
  asGymTaskCorpus,
  fitnessSignalIsReal,
  isGymTaskCorpus,
  judgedCorpusFromTasks,
} from './task-corpus';

describe('corpus vocabulary', () => {
  it('accepts only the two task corpora', () => {
    expect(isGymTaskCorpus('synthetic')).toBe(true);
    expect(isGymTaskCorpus('real')).toBe(true);
    expect(isGymTaskCorpus('mixed')).toBe(false); // a JUDGED value, not a task value
    expect(isGymTaskCorpus('REAL')).toBe(false);
    expect(isGymTaskCorpus(undefined)).toBe(false);
  });

  it('defaults unknown provenance to synthetic — NEVER to real', () => {
    expect(DEFAULT_GYM_TASK_CORPUS).toBe('synthetic');
    for (const v of [undefined, null, '', 'bogus', 42, {}]) {
      expect(asGymTaskCorpus(v)).toBe('synthetic');
    }
  });
});

describe('judgedCorpusFromTasks', () => {
  it('is synthetic for an empty task set (no tasks ⇒ no real signal)', () => {
    expect(judgedCorpusFromTasks([])).toBe('synthetic');
  });

  it('is real only when every task is real', () => {
    expect(judgedCorpusFromTasks([{ corpus: 'real' }, { corpus: 'real' }])).toBe('real');
  });

  it('is MIXED — not real — when any synthetic task is present', () => {
    expect(judgedCorpusFromTasks([{ corpus: 'real' }, { corpus: 'synthetic' }])).toBe('mixed');
    // the trap this prevents: one real task laundering a stub-heavy corpus
    expect(
      judgedCorpusFromTasks([
        { corpus: 'real' },
        { corpus: 'synthetic' },
        { corpus: 'synthetic' },
      ]),
    ).toBe('mixed');
  });

  it('treats an unlabelled task as synthetic, so legacy rows cannot claim real', () => {
    expect(judgedCorpusFromTasks([{ corpus: 'real' }, {}])).toBe('mixed');
    expect(judgedCorpusFromTasks([{}, {}])).toBe('synthetic');
  });
});

describe('fitnessSignalIsReal (the P-011 release-gate predicate)', () => {
  it('FAILS on the historical all-synthetic corpus, with counts for the gate message', () => {
    const v = fitnessSignalIsReal([
      { corpus: 'synthetic' }, // gym-loop-health
      { corpus: 'synthetic' }, // gym-loop-version
      { corpus: 'synthetic' }, // gym-loop-ready
    ]);
    expect(v.real).toBe(false);
    expect(v.judged).toBe('synthetic');
    expect(v).toMatchObject({ realCount: 0, syntheticCount: 3, total: 3 });
  });

  it('FAILS on an empty corpus (a gate must not pass on absence of evidence)', () => {
    expect(fitnessSignalIsReal([])).toMatchObject({ real: false, judged: 'synthetic', total: 0 });
  });

  it('FAILS while mixed, and reports the split so the gate reads as in-transition', () => {
    const v = fitnessSignalIsReal([{ corpus: 'real' }, { corpus: 'synthetic' }]);
    expect(v.real).toBe(false);
    expect(v.judged).toBe('mixed');
    expect(v).toMatchObject({ realCount: 1, syntheticCount: 1, total: 2 });
  });

  it('PASSES only for an all-real corpus', () => {
    const v = fitnessSignalIsReal([{ corpus: 'real' }, { corpus: 'real' }]);
    expect(v).toMatchObject({ real: true, judged: 'real', realCount: 2, syntheticCount: 0 });
  });
});
