/**
 * watermark.test.ts — the per-agent read-cursor value shape + pure merge. A wrong
 * normalise/merge either re-surfaces already-read messages (storms) or skips
 * unread ones (missed). Pinned: a corrupt/partial parsed doc degrades to "never
 * read anything" (never throws), partial patches keep omitted fields,
 * subscriptions_fired is REPLACED (not appended), and a `false` patch on
 * snapshot_rebootstrap_pending overrides (?? is nullish, so false still wins).
 *
 * Borrowable-lib unit test (pubsub-substrate, node env) — tab-neutral, genuine.
 * Run: cd libs/generic/pubsub-substrate && npx vitest run src/core/watermark.test.ts
 */
import { describe, expect, it } from 'vitest';
import { emptyWatermark, normaliseWatermark, mergeWatermark } from './watermark';

describe('emptyWatermark', () => {
  it('is everything-unread', () => {
    expect(emptyWatermark()).toEqual({
      messages_since_ts: '',
      messages_shown_ts: '',
      escalations_since_ts: '',
      plan_events_since_ts: '',
      subscriptions_fired: [],
      snapshot_rebootstrap_pending: false,
      cursors: {},
    });
  });
});

describe('normaliseWatermark', () => {
  it('degrades null / undefined / non-object to empty', () => {
    expect(normaliseWatermark(null)).toEqual(emptyWatermark());
    expect(normaliseWatermark(undefined)).toEqual(emptyWatermark());
    expect(normaliseWatermark('nope' as unknown as Partial<never>)).toEqual(emptyWatermark());
  });

  it('fills missing fields and rejects wrong-typed ones', () => {
    const out = normaliseWatermark({ messages_since_ts: '2026-01-01', escalations_since_ts: 5 as unknown as string });
    expect(out.messages_since_ts).toBe('2026-01-01');
    // EI-2042 backward-compat: a watermark with no messages_shown_ts falls back to its messages_since_ts.
    expect(out.messages_shown_ts).toBe('2026-01-01');
    expect(out.escalations_since_ts).toBe(''); // wrong type → fallback
    expect(out.plan_events_since_ts).toBe('');
  });

  it('filters non-string entries out of subscriptions_fired', () => {
    const out = normaliseWatermark({ subscriptions_fired: ['a', 1, 'b', null] as unknown as string[] });
    expect(out.subscriptions_fired).toEqual(['a', 'b']);
  });

  it('preserves a well-formed watermark', () => {
    const wm = {
      messages_since_ts: 't1',
      messages_shown_ts: 't1b',
      escalations_since_ts: 't2',
      plan_events_since_ts: 't3',
      subscriptions_fired: ['m1'],
      snapshot_rebootstrap_pending: true,
      cursors: { 'facts:workspace': '1783010341361' },
    };
    expect(normaliseWatermark(wm)).toEqual(wm);
  });
});

// D-077: `cursors` is the OPEN map that makes registering a new surface a
// key-add rather than a change to this type. The whole Watermark rides in one
// jsonb column and PgWatermarkStore.write is a read-modify-write, so anything
// this normaliser drops is destroyed durably on the next write by ANY caller.
describe('normaliseWatermark — cursors (open surface map)', () => {
  it('defaults to an empty map when absent', () => {
    expect(normaliseWatermark({ messages_since_ts: 't' }).cursors).toEqual({});
  });

  it('PRESERVES a surface key this build does not know about', () => {
    // The load-bearing case: an older host must not silently drop a newer
    // surface's cursor, or the newer peer re-reads from zero forever.
    const out = normaliseWatermark({
      cursors: { 'facts:workspace': '42', 'some:future:surface': 'abc' },
    });
    expect(out.cursors).toEqual({ 'facts:workspace': '42', 'some:future:surface': 'abc' });
  });

  it('drops non-string cursor values but keeps well-formed siblings', () => {
    const out = normaliseWatermark({
      cursors: { good: 'v1', bad: 7, alsoBad: null } as unknown as Record<string, string>,
    });
    expect(out.cursors).toEqual({ good: 'v1' });
  });

  it('degrades a malformed cursors value to an empty map', () => {
    expect(normaliseWatermark({ cursors: ['a'] as unknown as Record<string, string> }).cursors).toEqual({});
    expect(normaliseWatermark({ cursors: 'nope' as unknown as Record<string, string> }).cursors).toEqual({});
  });
});

describe('mergeWatermark', () => {
  const cur = emptyWatermark();
  it('overrides supplied fields and keeps omitted ones', () => {
    const base = { ...cur, messages_since_ts: 'old', escalations_since_ts: 'keep' };
    const out = mergeWatermark(base, { messages_since_ts: 'new' });
    expect(out.messages_since_ts).toBe('new');
    expect(out.escalations_since_ts).toBe('keep'); // omitted → preserved
  });

  it('merges messages_shown_ts (EI-2042 read-receipt cursor) like the other ts fields', () => {
    const base = { ...cur, messages_shown_ts: 'old' };
    expect(mergeWatermark(base, { messages_shown_ts: 'new' }).messages_shown_ts).toBe('new');
    expect(mergeWatermark(base, {}).messages_shown_ts).toBe('old'); // omitted → preserved
  });

  it('replaces subscriptions_fired wholesale (caller owns dedup)', () => {
    const base = { ...cur, subscriptions_fired: ['a', 'b'] };
    expect(mergeWatermark(base, { subscriptions_fired: ['c'] }).subscriptions_fired).toEqual(['c']);
  });

  it('lets a false patch override a true rebootstrap flag (?? is nullish-only)', () => {
    const base = { ...cur, snapshot_rebootstrap_pending: true };
    expect(mergeWatermark(base, { snapshot_rebootstrap_pending: false }).snapshot_rebootstrap_pending).toBe(false);
    // omitted → keeps current true
    expect(mergeWatermark(base, {}).snapshot_rebootstrap_pending).toBe(true);
  });

  // D-077: `cursors` merges PER KEY — the one field that does not follow the
  // whole-value rule above. Surfaces have independent writers.
  describe('cursors', () => {
    const base = { ...cur, cursors: { facts: 'v1', presence: 'p1' } };

    it('does NOT erase a sibling surface when one cursor advances', () => {
      // The reason per-key merge exists: whole-map replacement would make
      // advancing `facts` durably destroy `presence` via the read-modify-write.
      const out = mergeWatermark(base, { cursors: { facts: 'v2' } });
      expect(out.cursors).toEqual({ facts: 'v2', presence: 'p1' });
    });

    it('adds a brand-new surface key without touching existing ones', () => {
      const out = mergeWatermark(base, { cursors: { plans: 'x1' } });
      expect(out.cursors).toEqual({ facts: 'v1', presence: 'p1', plans: 'x1' });
    });

    it('omitted → preserved', () => {
      expect(mergeWatermark(base, {}).cursors).toEqual({ facts: 'v1', presence: 'p1' });
    });

    it('permits the deliberate BACKWARD move safe-commit recovery relies on', () => {
      // Not monotonic, by design — same contract as the ts cursors (P1-11):
      // a consumer that stops mid-(same-version)-group commits the previous
      // version so the unconsumed siblings are re-seen, never skipped.
      expect(mergeWatermark(base, { cursors: { facts: 'v0' } }).cursors.facts).toBe('v0');
    });
  });
});
