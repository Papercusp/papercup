/**
 * unanswered-directed.test.ts — fleet-reliability-verification-2026-07-10 P-007.
 */
import { describe, it, expect } from 'vitest';
import {
  rowsToUnansweredMap,
  rowsToOpenAsksMap,
  partitionUnansweredByLiveness,
  UNANSWERED_NEWEST_CAP,
  type UnansweredDirectedRow,
  type UnansweredDirectedSummary,
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

/**
 * EI-20085805220385722 — the live/stale split. The defect: `unanswered_directed`
 * counted a 31h-old ack-request from a sender that had been DEAD for a day, and
 * the playbook says that counter OUTRANKS the agent's own work. Nobody was
 * behind that ask.
 *
 * The invariant every test below defends: ONLY a positive 'ended' verdict
 * demotes a message. Unknown, missing, over-cap, and a THROWING probe all leave
 * it counting — suppressing a genuinely blocked peer because a liveness probe
 * failed is strictly worse than the noise this fixes.
 */
describe('per-sender rollup fold (pure)', () => {
  const rollupRow = (overrides: Partial<UnansweredDirectedRow> = {}): UnansweredDirectedRow =>
    row({
      cnt: 3,
      oldest_ts_ms: NOW - 300_000,
      sender_total: 2,
      sender_ids: ['su-dead', 'su-live'],
      sender_cnts: [2, 1],
      sender_oldest_ts_ms: [NOW - 300_000, NOW - 60_000],
      ...overrides,
    });

  it('folds the rollup arrays into `senders`, and reports the TOTAL as count (liveness-blind)', () => {
    const s = rowsToUnansweredMap([rollupRow()], NOW).get('su-a');
    expect(s?.count).toBe(3);
    expect(s?.staleCount).toBe(0);
    expect(s?.senders).toEqual([
      { from: 'su-dead', count: 2, oldestAgeMs: 300_000 },
      { from: 'su-live', count: 1, oldestAgeMs: 60_000 },
    ]);
    expect(s?.sendersTruncated).toBeUndefined();
  });

  it('marks `sendersTruncated` when the rollup dropped a sender past the cap', () => {
    const s = rowsToUnansweredMap([rollupRow({ sender_total: 9 })], NOW).get('su-a');
    expect(s?.sendersTruncated).toBe(true);
  });

  it('a row carrying no rollup at all folds to an empty `senders`, never a partial one', () => {
    // Backwards compatibility: every pre-existing hand-built row and any row
    // from a seam that predates the rollup must still fold, with `count` intact.
    const s = rowsToUnansweredMap([row({ cnt: 4 })], NOW).get('su-a');
    expect(s?.count).toBe(4);
    expect(s?.senders).toEqual([]);
    expect(s?.sendersTruncated).toBeUndefined();
  });

  it('skips rollup entries with a missing id or a non-positive count', () => {
    const s = rowsToUnansweredMap(
      [
        rollupRow({
          sender_total: 3,
          sender_ids: ['su-dead', null, 'su-zero'],
          sender_cnts: [2, 5, 0],
          sender_oldest_ts_ms: [NOW - 300_000, NOW - 1000, NOW - 1000],
        }),
      ],
      NOW,
    ).get('su-a');
    expect(s?.senders.map((x) => x.from)).toEqual(['su-dead']);
  });
});

describe('partitionUnansweredByLiveness (pure)', () => {
  const summary = (overrides: Partial<UnansweredDirectedSummary> = {}): UnansweredDirectedSummary =>
    rowsToUnansweredMap(
      [
        row({
          cnt: 3,
          oldest_ts_ms: NOW - 300_000,
          newest_ids: ['m-dead', 'm-live'],
          newest_from: ['su-dead', 'su-live'],
          newest_summary: [null, null],
          newest_ts_ms: [NOW - 300_000, NOW - 60_000],
          sender_total: 2,
          sender_ids: ['su-dead', 'su-live'],
          sender_cnts: [2, 1],
          sender_oldest_ts_ms: [NOW - 300_000, NOW - 60_000],
        }),
      ],
      NOW,
    ).get('su-a')!;

  it('DEMOTES a positively-ended sender out of `count` without losing it', () => {
    const out = partitionUnansweredByLiveness(summary(), (id) =>
      id === 'su-dead' ? 'ended' : 'live',
    );
    expect(out.count).toBe(1); // only su-live's ask still preempts
    expect(out.staleCount).toBe(2); // su-dead's two are reported, not dropped
    expect(out.staleOldestAgeMs).toBe(300_000);
    expect(out.staleCountBounded).toBeUndefined();
  });

  it('`oldestAgeMs` follows `count`s population — not the dead sender it just demoted', () => {
    // The whole point of the filed defect: a 31h age reported for a message
    // nobody is waiting on. It must now report the LIVE oldest.
    const out = partitionUnansweredByLiveness(summary(), (id) =>
      id === 'su-dead' ? 'ended' : 'live',
    );
    expect(out.oldestAgeMs).toBe(60_000);
  });

  it('stamps `senderState` on the newest entries so both populations stay readable', () => {
    const out = partitionUnansweredByLiveness(summary(), (id) =>
      id === 'su-dead' ? 'ended' : 'live',
    );
    expect(out.newest.map((e) => [e.msgId, e.senderState])).toEqual([
      ['m-dead', 'ended'],
      ['m-live', 'live'],
    ]);
  });

  // ── FAIL-OPEN: the load-bearing invariant, in every direction it can fail ──

  it('an UNKNOWN verdict (null) keeps the message counting', () => {
    const out = partitionUnansweredByLiveness(summary(), () => null);
    expect(out.count).toBe(3);
    expect(out.staleCount).toBe(0);
    expect(out.senders.every((s) => s.senderState === 'unknown')).toBe(true);
  });

  it('a MISSING verdict (undefined) keeps the message counting', () => {
    const out = partitionUnansweredByLiveness(summary(), () => undefined);
    expect(out.count).toBe(3);
    expect(out.staleCount).toBe(0);
  });

  it('a THROWING liveness probe keeps every message counting', () => {
    const out = partitionUnansweredByLiveness(summary(), () => {
      throw new Error('oracle exploded');
    });
    expect(out.count).toBe(3);
    expect(out.staleCount).toBe(0);
    expect(out.oldestAgeMs).toBe(300_000);
  });

  it('only `ended` demotes — parked/suspect/draining/recorded all still count', () => {
    for (const state of ['parked', 'suspect', 'draining', 'recorded', 'live'] as const) {
      const out = partitionUnansweredByLiveness(summary(), () => state);
      expect(out.count, `${state} must not demote`).toBe(3);
      expect(out.staleCount, `${state} must not demote`).toBe(0);
    }
  });

  it('messages the rollup could not account for stay in `count` and mark the floor', () => {
    // A recipient with senders past UNANSWERED_SENDER_CAP: cnt=10 but the
    // rollup only explains 3. The 7 unaccounted are UNKNOWN, so they keep
    // counting, and `staleCount` is reported as the floor it is.
    const bounded = { ...summary(), count: 10, sendersTruncated: true as const };
    const out = partitionUnansweredByLiveness(bounded, (id) =>
      id === 'su-dead' ? 'ended' : 'live',
    );
    expect(out.count).toBe(8); // 1 live + 7 unaccounted
    expect(out.staleCount).toBe(2);
    expect(out.staleCountBounded).toBe(true);
    // Unaccounted ages are unknown, so the age falls back to the whole
    // population's oldest rather than under-reporting it.
    expect(out.oldestAgeMs).toBe(300_000);
  });

  it('marks the floor even when the bounded partition found NOTHING stale', () => {
    // A zero computed over a capped sender set is still a floor — reading it as
    // a total is exactly the error the marker exists to prevent.
    const bounded = { ...summary(), sendersTruncated: true as const };
    const out = partitionUnansweredByLiveness(bounded, () => 'live');
    expect(out.staleCount).toBe(0);
    expect(out.staleCountBounded).toBe(true);
  });

  it('a fully-live recipient keeps its original numbers untouched', () => {
    const before = summary();
    const out = partitionUnansweredByLiveness(before, () => 'live');
    expect(out.count).toBe(before.count);
    expect(out.oldestAgeMs).toBe(before.oldestAgeMs);
    expect(out.newest).toEqual(before.newest); // not restamped when nothing moved
    expect(out.staleCountBounded).toBeUndefined();
  });

  it('a summary with no rollup is a no-op — never a silent demotion to zero', () => {
    // The seam-swapped / legacy path: `senders` is empty, so EVERY message is
    // unaccounted. It must all stay in `count`, whatever the oracle says.
    const legacy = rowsToUnansweredMap([row({ cnt: 5 })], NOW).get('su-a')!;
    const out = partitionUnansweredByLiveness(legacy, () => 'ended');
    expect(out.count).toBe(5);
    expect(out.staleCount).toBe(0);
  });
});
