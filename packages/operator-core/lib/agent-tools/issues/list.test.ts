/**
 * issues:list — plan sql-escape-tool-routing-2026-08-12 P-006.
 *
 * The scope normaliser is the piece with a documented silent-failure mode:
 * `harness_shared.engineer_issues.scope` is 'harness:<slug>' | 'operator' and
 * has NO counterpart on the underlying work_items table, so a bare slug
 * matches ZERO rows instead of erroring. Every other filter is passed straight
 * through to the already-tested listIssues layer.
 */

import { describe, it, expect } from 'vitest';
import { issueBaseRateCensus, normalizeScope } from './list';
import { describeCensus, type PopulationMeta } from '../../population-census';

const META: PopulationMeta = {
  population: 'issue-family rows',
  basis: 'bug+change rows in harness:papercusp',
  withheldReason: 'narrowed by state, q',
  reveal: 're-run without state/q',
};

describe('normalizeScope', () => {
  it('prefixes a bare harness slug — a bare slug silently matches nothing on this view', () => {
    expect(normalizeScope('papercusp')).toBe('harness:papercusp');
  });

  it('leaves an already-qualified scope alone', () => {
    expect(normalizeScope('harness:papercusp')).toBe('harness:papercusp');
  });

  it("leaves the non-harness scope 'operator' alone", () => {
    // 'operator' is a real scope value, NOT a harness slug — prefixing it
    // would turn a valid filter into one that matches nothing.
    expect(normalizeScope('operator')).toBe('operator');
  });

  it('leaves any other already-namespaced scope alone', () => {
    expect(normalizeScope('hive:something')).toBe('hive:something');
  });

  it('tolerates surrounding whitespace', () => {
    expect(normalizeScope('  papercusp  ')).toBe('harness:papercusp');
  });
});

/**
 * The base rate (P-021, silent-wrong-answers-2026-08-01).
 *
 * `total` alone cannot say whether a number is remarkable, and the documented
 * failure is not a MISSING denominator but a confidently wrong one: a floor
 * printed as a total, or an unmeasurable corpus reported as zero. These cover
 * every branch that decides which of those a caller gets.
 */
describe('issueBaseRateCensus', () => {
  const never = () => {
    throw new Error('countPopulation must not be called');
  };

  it('does not query at all when nothing was narrowed — the filtered count IS the population', async () => {
    const census = await issueBaseRateCensus(42, {
      narrowedBy: [],
      meta: META,
      countPopulation: never,
    });
    expect(census.candidatesStatus).toBe('measured');
    expect(census.candidates).toBe(42);
    expect(census.withheld).toBe(0);
    // Withheld zero must not carry a reason — a reason attached to nothing
    // trains readers to discount the field when it finally matters.
    expect(census.withheldReason).toBeNull();
  });

  it('reports the corpus size and what the filter withheld', async () => {
    const census = await issueBaseRateCensus(8, {
      narrowedBy: ['state', 'q'],
      meta: META,
      countPopulation: async () => 392,
    });
    expect(census.candidatesStatus).toBe('measured');
    expect(census.candidates).toBe(392);
    expect(census.counted).toBe(8);
    expect(census.withheld).toBe(384);
    expect(census.reveal).toBe('re-run without state/q');
    expect(describeCensus(census)).toBe('matched 8 of 392 issue-family rows');
  });

  it('never publishes a negative withheld: a corpus that moved between the two COUNTs yields a FLOOR', async () => {
    // The population query and the filtered query are separate statements at
    // separate instants. Rows arriving in between can make the population read
    // SMALLER than the slice it contains. Reporting that difference as a total
    // would print `withheld: -3` — arithmetic nobody reads as "these two
    // numbers disagree", which is precisely what it means.
    const census = await issueBaseRateCensus(20, {
      narrowedBy: ['state'],
      meta: META,
      countPopulation: async () => 17,
    });
    expect(census.candidatesStatus).toBe('bounded');
    expect(census.candidatesAreFloor).toBe(true);
    expect(census.candidates).toBe(20);
    expect(census.withheld).toBe(0);
    expect(census.withheld).toBeGreaterThanOrEqual(0);
    expect(census.candidatesNote).toContain('lower bound');
    expect(describeCensus(census)).toContain('AT LEAST 20');
  });

  it('a failed probe degrades IN-BAND — never to a zero denominator', async () => {
    const census = await issueBaseRateCensus(8, {
      narrowedBy: ['q'],
      meta: META,
      countPopulation: async () => {
        throw new Error('statement timeout');
      },
    });
    expect(census.candidatesStatus).toBe('not-measured');
    // The whole point: a zero here would assert the corpus is EMPTY, which is
    // the one reading guaranteed to be wrong when the probe merely failed.
    expect(census.candidates).toBeNull();
    expect(census.candidates).not.toBe(0);
    expect(census.candidatesNote).toContain('statement timeout');
    expect(census.measureWith).toBe('issues:list with only scope/kinds/lane set');
    // `withheld` must be null, not 0: an unmeasured read cannot know that the
    // filter hid nothing.
    expect(census.withheld).toBeNull();
    expect(describeCensus(census)).toContain('UNKNOWN total');
  });

  it('still reports the count it does have when the base rate is unmeasurable', async () => {
    const census = await issueBaseRateCensus(8, {
      narrowedBy: ['assignee'],
      meta: META,
      countPopulation: async () => {
        throw new Error('boom');
      },
    });
    // Degrading the denominator must not degrade the measurement that succeeded.
    expect(census.counted).toBe(8);
  });

  it('a non-Error rejection still produces a readable reason', async () => {
    const census = await issueBaseRateCensus(1, {
      narrowedBy: ['topic'],
      meta: META,
      // eslint-disable-next-line prefer-promise-reject-errors
      countPopulation: () => Promise.reject('pool exhausted'),
    });
    expect(census.candidatesStatus).toBe('not-measured');
    expect(census.candidatesNote).toContain('pool exhausted');
  });
});
