/**
 * unanswered-directed.test.ts — fleet-reliability-verification-2026-07-10 P-007.
 */
import { describe, it, expect } from 'vitest';
import {
  rowsToUnansweredMap,
  UNANSWERED_NEWEST_CAP,
  type UnansweredDirectedRow,
} from './unanswered-directed';

const NOW = Date.parse('2026-07-10T12:00:00.000Z');

function row(overrides: Partial<UnansweredDirectedRow>): UnansweredDirectedRow {
  return {
    recipient: 'su-a',
    cnt: 1,
    oldest_ts_ms: NOW - 60_000,
    newest_ids: ['m1'],
    newest_from: ['su-b'],
    newest_summary: ['hello'],
    newest_ts_ms: [NOW - 60_000],
    ...overrides,
  };
}

describe('rowsToUnansweredMap (pure)', () => {
  it('empty rows → empty map', () => {
    expect(rowsToUnansweredMap([], NOW).size).toBe(0);
  });

  it('maps a single recipient row into count/oldestAgeMs/newest', () => {
    const map = rowsToUnansweredMap([row({})], NOW);
    const entry = map.get('su-a');
    expect(entry).toBeDefined();
    expect(entry?.count).toBe(1);
    expect(entry?.oldestAgeMs).toBe(60_000);
    expect(entry?.newest).toEqual([{ msgId: 'm1', from: 'su-b', summary: 'hello', ageMs: 60_000 }]);
  });

  it('drops a zero/invalid count row entirely (defensive — should never happen post-GROUP-BY)', () => {
    const map = rowsToUnansweredMap([row({ cnt: 0 })], NOW);
    expect(map.has('su-a')).toBe(false);
  });

  it('omits summary when null (no bare `summary: undefined` key)', () => {
    const map = rowsToUnansweredMap([row({ newest_summary: [null] })], NOW);
    expect(map.get('su-a')?.newest[0]).toEqual({ msgId: 'm1', from: 'su-b', ageMs: 60_000 });
    expect('summary' in (map.get('su-a')?.newest[0] ?? {})).toBe(false);
  });

  it('caps `newest` at UNANSWERED_NEWEST_CAP even if more ids came back', () => {
    const many = Array.from({ length: UNANSWERED_NEWEST_CAP + 5 }, (_, i) => `m${i}`);
    const map = rowsToUnansweredMap(
      [
        row({
          cnt: many.length,
          newest_ids: many,
          newest_from: many.map(() => 'su-b'),
          newest_summary: many.map(() => null),
          newest_ts_ms: many.map((_, i) => NOW - i * 1000),
        }),
      ],
      NOW,
    );
    expect(map.get('su-a')?.newest.length).toBe(UNANSWERED_NEWEST_CAP);
    expect(map.get('su-a')?.count).toBe(many.length);
  });

  it('multiple recipients each get their own entry', () => {
    const map = rowsToUnansweredMap(
      [row({ recipient: 'su-a' }), row({ recipient: 'su-b', cnt: 2, newest_ids: ['m2'] })],
      NOW,
    );
    expect(map.size).toBe(2);
    expect(map.get('su-b')?.count).toBe(2);
  });

  it('skips an entry whose msgId/from is missing (defensive against a ragged array_agg)', () => {
    const map = rowsToUnansweredMap(
      [row({ newest_ids: [null, 'm2'], newest_from: [null, 'su-b'], newest_summary: [null, null], newest_ts_ms: [null, NOW - 1000] })],
      NOW,
    );
    expect(map.get('su-a')?.newest).toEqual([{ msgId: 'm2', from: 'su-b', ageMs: 1000 }]);
  });
});
