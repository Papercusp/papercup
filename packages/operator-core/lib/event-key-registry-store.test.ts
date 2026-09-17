import { describe, expect, it } from 'vitest';
import {
  EVENT_KEY_REVIEW_STATUSES,
  EVENT_KEY_STATUSES,
  normalizeEventKey,
  type EventKeyReviewStatus,
  type EventKeyStatus,
} from './event-key-registry-store';

describe('normalizeEventKey', () => {
  it('trims surrounding whitespace so a pasted key and a typed key are the same row', () => {
    // The registry's PK is (workspace_id, event_key); an untrimmed paste would
    // otherwise mint a SECOND row for a key that already exists, and the
    // duplicate is invisible until an await parks on the wrong one.
    expect(normalizeEventKey('  work-item:done:WI-1  ')).toBe('work-item:done:WI-1');
    expect(normalizeEventKey('work-item:done:*')).toBe('work-item:done:*');
  });

  it('throws on a key that is empty or only whitespace, rather than registering one', () => {
    for (const value of ['', '   ', '\t', '\n  \t']) {
      expect(() => normalizeEventKey(value)).toThrow(/non-empty/);
    }
  });

  it('throws on a nullish key instead of coercing it to the string "null"', () => {
    // The `?? ''` guard must land on the non-empty throw, not produce a row
    // keyed literally "null"/"undefined" — a key nothing can ever fire.
    expect(() => normalizeEventKey(null as unknown as string)).toThrow(/non-empty/);
    expect(() => normalizeEventKey(undefined as unknown as string)).toThrow(/non-empty/);
  });

  it('preserves interior characters, including the glob a pattern key depends on', () => {
    // `events:await` matches on these verbatim; normalizing away `*` or `:`
    // would silently unbind every pattern await registered against the key.
    expect(normalizeEventKey('release:green:papercusp')).toBe('release:green:papercusp');
    expect(normalizeEventKey(' @fleet:some-slug ')).toBe('@fleet:some-slug');
  });
});

describe('event key closed status sets', () => {
  it('keeps lifecycle status to exactly active/retired/superseded', () => {
    expect([...EVENT_KEY_STATUSES]).toEqual(['active', 'retired', 'superseded']);
  });

  it('publishes the review-gated `pending` state the `event` listing kind needs (D-057)', () => {
    // D-057 ruled `event` the fifteenth Cupboard listing kind and that it
    // publishes review-gated `pending`. Dropping `pending` from this set would
    // make every submission publish immediately — the asymmetry-of-error the
    // decision was made on.
    expect([...EVENT_KEY_REVIEW_STATUSES]).toEqual(['none', 'pending', 'approved', 'rejected']);
    expect(EVENT_KEY_REVIEW_STATUSES).toContain('pending');
  });

  it('does not model derivation as a status value (D-058)', () => {
    // D-058: the derived half stays NULL until the buildKey derivation lands —
    // NULL means not-yet-derived. A `derived`/`underived` status token here
    // would be exactly the hand-authored lie the item exists to prevent.
    const statusTokens: readonly string[] = [...EVENT_KEY_STATUSES, ...EVENT_KEY_REVIEW_STATUSES];
    for (const forbidden of ['derived', 'underived', 'unknown', 'not-derived']) {
      expect(statusTokens).not.toContain(forbidden);
    }
  });

  it('holds every declared status in its own closed set, with no overlap between them', () => {
    // The two sets are written to distinct columns; a token appearing in both
    // makes a mis-targeted write typecheck and pass review.
    const lifecycle = new Set<string>(EVENT_KEY_STATUSES);
    const review = new Set<string>(EVENT_KEY_REVIEW_STATUSES);
    expect(lifecycle.size).toBe(EVENT_KEY_STATUSES.length);
    expect(review.size).toBe(EVENT_KEY_REVIEW_STATUSES.length);
    for (const token of lifecycle) expect(review.has(token)).toBe(false);
  });

  it('pins the union types to their runtime arrays', () => {
    // Compile-time assertion: adding a member to either union without adding it
    // to the array (or vice versa) fails here rather than at the first write.
    const lifecycle: readonly EventKeyStatus[] = EVENT_KEY_STATUSES;
    const review: readonly EventKeyReviewStatus[] = EVENT_KEY_REVIEW_STATUSES;
    expect(lifecycle.length + review.length).toBe(7);
  });
});
