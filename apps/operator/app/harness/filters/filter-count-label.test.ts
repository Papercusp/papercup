import { describe, expect, it } from 'vitest';
import { countEvidenceScopeText } from './count-evidence';
import { filterCountLabel } from './filter-count-label';

describe('filterCountLabel evidence variants', () => {
  it('formats an exact corpus total, including zero and singular nouns', () => {
    expect(filterCountLabel({ kind: 'corpus', count: 0 }, 'result')).toEqual({
      title: '0',
      summary: '0 results',
      ariaLabel: '0 results in the full corpus',
      evidence: 'corpus',
    });
    expect(filterCountLabel({ kind: 'corpus', count: 1 }, 'result').summary).toBe('1 result');
  });

  it('formats an exact corpus match without accepting a page numerator implicitly', () => {
    const label = filterCountLabel({
      kind: 'corpus',
      count: 305,
      total: 36_096,
      population: 'the observation corpus',
    });
    expect(label.title).toBe('305 of 36,096');
    expect(label.ariaLabel).toBe('305 of 36,096 match in the observation corpus');
  });

  it('names an exact window and may pair it with an independent corpus total', () => {
    const label = filterCountLabel({
      kind: 'window',
      count: 10,
      windowTotal: 200,
      window: 'latest 200 observations',
      corpusTotal: 36_096,
    }, 'observation');
    expect(label.title).toBe('10 of 200 · latest 200 observations');
    expect(label.summary).toBe(
      '10 of 200 match in latest 200 observations; 36,096 in the full corpus',
    );
    expect(label.evidence).toBe('window');
  });

  it('renders bounded page evidence as explicit shown/total copy', () => {
    expect(filterCountLabel({
      kind: 'window',
      count: 250,
      window: 'loaded run history',
      corpusTotal: 2_051,
    }, 'run')).toEqual({
      title: '250 of 2,051',
      summary: 'Showing 250 of 2,051 runs',
      ariaLabel: 'Showing 250 of 2,051 runs from loaded run history',
      evidence: 'window',
    });
  });

  it('renders a floor as a lower bound rather than an exact number', () => {
    const label = filterCountLabel({ kind: 'floor', count: 500, population: 'events' }, 'event');
    expect(label.title).toBe('500+');
    expect(label.summary).toBe('500+ events');
    expect(label.ariaLabel).toContain('incomplete population of at least 500 events');
  });

  it('suppresses numeric fallbacks for loading, updating, and failed summaries', () => {
    expect(filterCountLabel({ kind: 'unknown', reason: 'loading' }).summary).toBe('Count loading…');
    expect(filterCountLabel({ kind: 'unknown', reason: 'updating' }).summary).toBe('Count updating…');
    expect(filterCountLabel({ kind: 'unknown', reason: 'failed' })).toEqual({
      title: '—',
      summary: 'Count unavailable',
      ariaLabel: 'Count unavailable',
      evidence: 'unknown',
    });
  });

  it('keeps transition outputs distinct so stale mixed evidence cannot look exact', () => {
    const exact = filterCountLabel({ kind: 'corpus', count: 8, total: 10 });
    const updating = filterCountLabel({ kind: 'unknown', reason: 'updating' });
    const nextExact = filterCountLabel({ kind: 'corpus', count: 9, total: 11 });
    expect([exact.title, updating.title, nextExact.title]).toEqual(['8 of 10', '—', '9 of 11']);
  });

  it('rejects invalid or internally contradictory evidence', () => {
    expect(() => filterCountLabel({ kind: 'corpus', count: -1 })).toThrow(RangeError);
    expect(() => filterCountLabel({ kind: 'corpus', count: 11, total: 10 })).toThrow(RangeError);
    expect(() => filterCountLabel({ kind: 'window', count: 4, windowTotal: 3, window: 'page 1' })).toThrow(RangeError);
    expect(() => filterCountLabel({ kind: 'window', count: 4, corpusTotal: 3, window: 'page 1' })).toThrow(RangeError);
  });

  it('describes facet scopes accessibly for every evidence class', () => {
    expect(countEvidenceScopeText({ kind: 'corpus', count: 2 })).toBe('the full corpus');
    expect(countEvidenceScopeText({ kind: 'window', count: 2, window: 'latest 2 rows' })).toBe('latest 2 rows');
    expect(countEvidenceScopeText({ kind: 'floor', count: 2 })).toContain('at least 2 records');
    expect(countEvidenceScopeText({ kind: 'unknown', reason: 'failed' })).toContain('unavailable');
  });
});
