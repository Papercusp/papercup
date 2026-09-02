/**
 * unanswered-directed.test.ts — fleet-reliability-verification-2026-07-10 P-007.
 */
import { describe, it, expect } from 'vitest';
import {
  rowsToUnansweredMap,
  rowsToOpenAsksMap,
  UNANSWERED_NEWEST_CAP,
  type UnansweredDirectedRow,
  type OpenAskRow,
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

  // EI-13159 (coord:inbox unanswered_only filter): a caller reading for ONE
  // recipient passes a larger `cap` to recover every unanswered msg_id, not
  // just the display-capped newest 3.
  it('a caller-supplied `cap` overrides UNANSWERED_NEWEST_CAP', () => {
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
      many.length, // cap = exactly the row count → every entry survives
    );
    expect(map.get('su-a')?.newest.length).toBe(many.length);
    expect(map.get('su-a')?.newest.map((e) => e.msgId)).toEqual(many);
  });
});

// WI-2142142: fetchOpenAsks / rowsToOpenAsksMap — the SENDER-side mirror of
// fetchUnansweredDirected/rowsToUnansweredMap above. Same fold shape (count,
// oldestAgeMs, capped `newest`), plus one field neither of them shares:
// `oldestTo`, computed directly in SQL rather than derived from the capped
// list so it survives `count` exceeding any display cap.
function openAskRow(overrides: Partial<OpenAskRow>): OpenAskRow {
  return {
    sender: 'su-a',
    cnt: 1,
    oldest_ts_ms: NOW - 60_000,
    oldest_to: 'su-b',
    newest_ids: ['m1'],
    newest_to: ['su-b'],
    newest_summary: ['hello'],
    newest_ts_ms: [NOW - 60_000],
    ...overrides,
  };
}

describe('rowsToOpenAsksMap (pure)', () => {
  it('empty rows → empty map', () => {
    expect(rowsToOpenAsksMap([], NOW).size).toBe(0);
  });

  it('maps a single sender row into count/oldestAgeMs/oldestTo/newest', () => {
    const map = rowsToOpenAsksMap([openAskRow({})], NOW);
    const entry = map.get('su-a');
    expect(entry).toBeDefined();
    expect(entry?.count).toBe(1);
    expect(entry?.oldestAgeMs).toBe(60_000);
    expect(entry?.oldestTo).toBe('su-b');
    expect(entry?.newest).toEqual([{ msgId: 'm1', to: 'su-b', summary: 'hello', ageMs: 60_000 }]);
  });

  it('drops a zero/invalid count row entirely (defensive — should never happen post-GROUP-BY)', () => {
    const map = rowsToOpenAsksMap([openAskRow({ cnt: 0 })], NOW);
    expect(map.has('su-a')).toBe(false);
  });

  it('omits summary when null (no bare `summary: undefined` key)', () => {
    const map = rowsToOpenAsksMap([openAskRow({ newest_summary: [null] })], NOW);
    expect(map.get('su-a')?.newest[0]).toEqual({ msgId: 'm1', to: 'su-b', ageMs: 60_000 });
    expect('summary' in (map.get('su-a')?.newest[0] ?? {})).toBe(false);
  });

  it('caps `newest` at UNANSWERED_NEWEST_CAP even if more ids came back', () => {
    const many = Array.from({ length: UNANSWERED_NEWEST_CAP + 5 }, (_, i) => `m${i}`);
    const map = rowsToOpenAsksMap(
      [
        openAskRow({
          cnt: many.length,
          newest_ids: many,
          newest_to: many.map(() => 'su-b'),
          newest_summary: many.map(() => null),
          newest_ts_ms: many.map((_, i) => NOW - i * 1000),
        }),
      ],
      NOW,
    );
    expect(map.get('su-a')?.newest.length).toBe(UNANSWERED_NEWEST_CAP);
    expect(map.get('su-a')?.count).toBe(many.length);
  });

  it('multiple senders each get their own entry', () => {
    const map = rowsToOpenAsksMap(
      [
        openAskRow({ sender: 'su-a' }),
        openAskRow({ sender: 'su-c', cnt: 2, newest_ids: ['m2'], oldest_to: 'su-d' }),
      ],
      NOW,
    );
    expect(map.size).toBe(2);
    expect(map.get('su-c')?.count).toBe(2);
  });

  it('skips an entry whose msgId/to is missing (defensive against a ragged array_agg)', () => {
    const map = rowsToOpenAsksMap(
      [
        openAskRow({
          newest_ids: [null, 'm2'],
          newest_to: [null, 'su-b'],
          newest_summary: [null, null],
          newest_ts_ms: [null, NOW - 1000],
        }),
      ],
      NOW,
    );
    expect(map.get('su-a')?.newest).toEqual([{ msgId: 'm2', to: 'su-b', ageMs: 1000 }]);
  });

  // EI-13159-style: a caller reading for ONE sender can pass a larger `cap` to
  // recover every open msg_id, not just the display-capped newest 3.
  it('a caller-supplied `cap` overrides UNANSWERED_NEWEST_CAP', () => {
    const many = Array.from({ length: UNANSWERED_NEWEST_CAP + 5 }, (_, i) => `m${i}`);
    const map = rowsToOpenAsksMap(
      [
        openAskRow({
          cnt: many.length,
          newest_ids: many,
          newest_to: many.map(() => 'su-b'),
          newest_summary: many.map(() => null),
          newest_ts_ms: many.map((_, i) => NOW - i * 1000),
        }),
      ],
      NOW,
      many.length, // cap = exactly the row count → every entry survives
    );
    expect(map.get('su-a')?.newest.length).toBe(many.length);
    expect(map.get('su-a')?.newest.map((e) => e.msgId)).toEqual(many);
  });

  // The one fold-shape difference from rowsToUnansweredMap: `oldestTo` is a
  // SEPARATE SQL column (not derived from `newest`), so it must stay correct
  // even when the row is otherwise degenerate.
  it('degrades oldestTo to the first newest entry’s recipient when oldest_to is null', () => {
    const map = rowsToOpenAsksMap([openAskRow({ oldest_to: null })], NOW);
    expect(map.get('su-a')?.oldestTo).toBe('su-b'); // newest[0].to
  });

  it('degrades oldestTo to an empty string when both oldest_to and newest are unusable', () => {
    const map = rowsToOpenAsksMap(
      [
        openAskRow({
          oldest_to: null,
          newest_ids: [null],
          newest_to: [null],
          newest_summary: [null],
          newest_ts_ms: [null],
        }),
      ],
      NOW,
    );
    expect(map.get('su-a')?.oldestTo).toBe('');
  });
});
