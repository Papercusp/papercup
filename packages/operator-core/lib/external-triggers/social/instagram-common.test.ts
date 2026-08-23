/**
 * Tests for the shared Instagram concerns — P-017.
 *
 * WHY THIS FILE EXISTS SEPARATELY. Every helper here was already exercised
 * THROUGH the comments adapter, and that coverage is real but it is the wrong
 * shape for these particular functions: each of them encodes a single verified
 * vendor fact, and each has a plausible WRONG implementation that the adapter's
 * happy path would not distinguish. A version check that always returned true, a
 * usage parser that did not filter by product, a timestamp parser written for
 * RFC 3339 instead of Instagram's offset format — all three pass an adapter test
 * that feeds them well-formed Instagram data and never the adversarial case.
 *
 * So the tests below are organized around the MISTAKE each helper prevents
 * rather than around its signature, and several are permanent CONTROLS: they
 * model the wrong implementation explicitly so that a future simplification
 * cannot quietly reintroduce it.
 */
import { describe, expect, it } from 'vitest';
import {
  INSTAGRAM_COMMENTS_MAX_PER_QUERY,
  INSTAGRAM_COMMENT_FIELDS,
  INSTAGRAM_GRAPH_ORIGIN,
  INSTAGRAM_GRAPH_VERSION,
  INSTAGRAM_REVERSE_CHRONO_SINCE,
  INSTAGRAM_THROTTLE_CODE_BUC,
  INSTAGRAM_USAGE_TYPE,
  InstagramCredentialError,
  InstagramGraphThrottled,
  assertInstagramCredential,
  instagramAdvanceWatermark,
  instagramGraphUrl,
  instagramInstantMs,
  instagramIsNewAgainstWatermark,
  instagramIsReverseChronological,
  instagramPeakUsagePct,
  instagramQuotaObservation,
  instagramThrottleFrom,
  instagramWindowOverflowed,
  isInstagramCredential,
  isInstagramWatermark,
  parseInstagramUsage,
  type InstagramCredential,
} from './instagram-common';

const CREDENTIAL: InstagramCredential = {
  igUserId: 'ig-1',
  pageId: 'page-1',
  accessToken: 'token',
  scopes: ['instagram_basic', 'instagram_manage_comments'],
};

/* -------------------------------------------------------------------------- */
/* API surface                                                                */
/* -------------------------------------------------------------------------- */

describe('the pinned API version is load-bearing, not cosmetic', () => {
  it('selects which END of a busy thread the 50-item cap keeps', () => {
    // The vendor states the ordering guarantee PER VERSION: 3.1 and older return
    // results in CHRONOLOGICAL order, 3.2+ in REVERSE chronological. Since the
    // edge caps at 50 with no paging, the version decides whether a capped read
    // returns the NEWEST 50 (what an incremental poll needs) or the OLDEST 50
    // (the wrong end of every active thread, while looking perfectly healthy).
    expect(instagramIsReverseChronological('v23.0')).toBe(true);
    expect(instagramIsReverseChronological('v3.2')).toBe(true);
    expect(instagramIsReverseChronological('v3.1')).toBe(false);
    expect(instagramIsReverseChronological('v2.0')).toBe(false);
  });

  it('treats an unparseable version as NOT guaranteed', () => {
    // The safe direction: an unknown version must not inherit the guarantee the
    // adapter's correctness argument rests on.
    expect(instagramIsReverseChronological('')).toBe(false);
    expect(instagramIsReverseChronological('latest')).toBe(false);
    expect(instagramIsReverseChronological('vNext')).toBe(false);
  });

  it('pins the version this adapter actually calls as one that carries the guarantee', () => {
    // The two constants must agree. If someone lowers the pinned version below
    // 3.2 the ordering silently inverts, so this asserts the RELATIONSHIP rather
    // than either value alone.
    expect(instagramIsReverseChronological(INSTAGRAM_GRAPH_VERSION)).toBe(true);
    expect(Number.parseFloat(INSTAGRAM_GRAPH_VERSION.replace(/^v/, ''))).toBeGreaterThanOrEqual(
      INSTAGRAM_REVERSE_CHRONO_SINCE,
    );
  });

  it('builds a versioned Graph URL against the Facebook Login host', () => {
    // graph.facebook.com, NOT graph.instagram.com: the other flavor is a
    // separate app identity and a separate review.
    expect(instagramGraphUrl('/ig-1/comments')).toBe(`${INSTAGRAM_GRAPH_ORIGIN}/${INSTAGRAM_GRAPH_VERSION}/ig-1/comments`);
    expect(instagramGraphUrl('ig-1/comments')).toBe(`${INSTAGRAM_GRAPH_ORIGIN}/${INSTAGRAM_GRAPH_VERSION}/ig-1/comments`);
    expect(INSTAGRAM_GRAPH_ORIGIN).toBe('https://graph.facebook.com');
  });

  it('requests the replies expansion, because the edge default is LOSSY', () => {
    // "Returns only top-level comments" — so without this expansion every nested
    // reply is silently absent, and the read looks complete.
    const fields = INSTAGRAM_COMMENT_FIELDS.join(',');
    expect(fields).toContain('replies{');
    expect(fields).toContain('parent_id');
    // `username` is what requires instagram_manage_comments as of 2024-08-27.
    expect(fields).toContain('username');
  });
});

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

describe('credentials are asserted BEFORE the call (D-027)', () => {
  it('accepts a well-formed credential', () => {
    expect(isInstagramCredential(CREDENTIAL)).toBe(true);
    expect(() => assertInstagramCredential(CREDENTIAL, 'ig-1', 'instagram_basic')).not.toThrow();
  });

  it('refuses a credential for a DIFFERENT account rather than calling with it', () => {
    // The dangerous shape: a structurally valid credential that would succeed
    // against the wrong object.
    expect(() => assertInstagramCredential(CREDENTIAL, 'ig-2', 'instagram_basic')).toThrow(
      /wrong_account/,
    );
  });

  it('refuses a missing scope, because the call would return an INCOMPLETE answer rather than an error', () => {
    // This is the whole reason the check is pre-call. An under-privileged read on
    // this family omits rather than refuses — comments from restricted users are
    // "withheld", age-gated media comments "aren't returned" — so after the call
    // there is nothing left to distinguish it from "there are no comments".
    let caught: unknown;
    try {
      assertInstagramCredential(CREDENTIAL, 'ig-1', 'instagram_content_publish');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InstagramCredentialError);
    expect((caught as InstagramCredentialError).missingScope).toBe('instagram_content_publish');
  });

  it('rejects malformed shapes instead of coercing them', () => {
    expect(isInstagramCredential(null)).toBe(false);
    expect(isInstagramCredential({})).toBe(false);
    expect(isInstagramCredential({ ...CREDENTIAL, igUserId: '' })).toBe(false);
    expect(isInstagramCredential({ ...CREDENTIAL, pageId: '' })).toBe(false);
    expect(isInstagramCredential({ ...CREDENTIAL, accessToken: '' })).toBe(false);
    expect(isInstagramCredential({ ...CREDENTIAL, scopes: 'instagram_basic' })).toBe(false);
    expect(isInstagramCredential({ ...CREDENTIAL, scopes: [1, 2] })).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Usage header                                                               */
/* -------------------------------------------------------------------------- */

describe('the usage header is filtered to Instagram\'s OWN rows', () => {
  // The header is shared across products and documents up to 32 objects typed
  // "ads_insights, ads_management, custom_audience, instagram, leadgen,
  // messenger, or pages". An account that also drives Pages carries `pages` rows
  // in the SAME header, so an unfiltered peak measures a budget this adapter
  // never spends from.
  const MIXED = JSON.stringify({
    'biz-1': [
      { type: 'pages', call_count: 95, total_cputime: 90, total_time: 90 },
      { type: 'instagram', call_count: 10, total_cputime: 5, total_time: 7 },
    ],
  });

  it('keeps instagram rows and DROPS another product\'s', () => {
    const rows = parseInstagramUsage(MIXED);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe(INSTAGRAM_USAGE_TYPE);
    expect(rows[0]!.callCount).toBe(10);
  });

  it('CONTROL: the unfiltered peak would be the Pages row, which is the bug this prevents', () => {
    // Models the wrong implementation explicitly. 95 is the Pages figure; a
    // parser that skipped the type filter would report near-exhaustion and stall
    // an Instagram adapter that has 90% of its own budget left.
    const peak = instagramPeakUsagePct(parseInstagramUsage(MIXED));
    expect(peak).toBe(10);
    expect(peak).not.toBe(95);
  });

  it('survives a header that is absent, empty, malformed, or the wrong JSON shape', () => {
    // A header that cannot be parsed must read as "said nothing", never as zero
    // usage — but it also must not throw on the hot path.
    for (const header of [null, undefined, '', '   ', 'not json', '[]', '"str"', '42']) {
      expect(parseInstagramUsage(header)).toEqual([]);
    }
    expect(instagramPeakUsagePct([])).toBeNull();
  });

  it('reads numeric strings, which the header is documented to use for whole numbers', () => {
    const rows = parseInstagramUsage(
      JSON.stringify({ 'biz-1': [{ type: 'instagram', call_count: '33', total_time: 12 }] }),
    );
    expect(rows[0]!.callCount).toBe(33);
    expect(instagramPeakUsagePct(rows)).toBe(33);
  });
});

/* -------------------------------------------------------------------------- */
/* Throttling                                                                 */
/* -------------------------------------------------------------------------- */

describe('the throttle code is Instagram\'s, not Facebook\'s', () => {
  it('classifies 80002 as an Instagram BUC throttle', () => {
    const throttle = instagramThrottleFrom(
      { error: { code: INSTAGRAM_THROTTLE_CODE_BUC, message: 'rate limited' } },
      JSON.stringify({ 'biz-1': [{ type: 'instagram', estimated_time_to_regain_access: 12 }] }),
    );
    expect(throttle).toBeInstanceOf(InstagramGraphThrottled);
    expect(throttle!.code).toBe(80002);
    expect(throttle!.holdMinutes).toBe(12);
  });

  it('CONTROL: Pages\' 80001 and 32 are NOT Instagram throttles', () => {
    // The inherited-not-verified pin. These are documented against Page calls
    // with a Page/System-User token and a User token respectively — a different
    // product's codes. Carrying them here is precisely the mistake P-017 exists
    // to avoid, and it would misclassify an unrelated Pages error as an
    // Instagram rate limit.
    expect(instagramThrottleFrom({ error: { code: 80001 } }, null)).toBeNull();
    expect(instagramThrottleFrom({ error: { code: 32 } }, null)).toBeNull();
    expect(instagramThrottleFrom({ error: { code: 4 } }, null)).toBeNull();
    expect(instagramThrottleFrom(null, null)).toBeNull();
  });

  it('carries a hold of NULL when the provider stated none, rather than inventing a default', () => {
    // Meta documents no fallback duration and warns that continuing to call
    // EXTENDS the block, so a made-up retry delay is worse than no delay: it
    // would license exactly the behaviour the vendor says lengthens the outage.
    const throttle = instagramThrottleFrom({ error: { code: 80002 } }, null);
    expect(throttle!.holdMinutes).toBeNull();

    const observation = instagramQuotaObservation(null, throttle);
    expect(observation.throttled).toBe(true);
    expect(observation.throttleHoldMs).toBeNull();
  });

  it('converts a stated hold from minutes to milliseconds for the storm-policy seam', () => {
    const throttle = instagramThrottleFrom(
      { error: { code: 80002 } },
      JSON.stringify({ 'biz-1': [{ type: 'instagram', estimated_time_to_regain_access: 3 }] }),
    );
    const observation = instagramQuotaObservation(null, throttle);
    expect(observation.throttleHoldMs).toBe(180_000);
  });

  it('reports usage without a throttle when the call simply succeeded', () => {
    const observation = instagramQuotaObservation(
      JSON.stringify({ 'biz-1': [{ type: 'instagram', call_count: 42 }] }),
    );
    expect(observation.throttled).toBe(false);
    expect(observation.peakUsagePct).toBe(42);
    expect(observation.throttleHoldMs).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Timestamps + watermark                                                     */
/* -------------------------------------------------------------------------- */

describe('the documented timestamp format parses', () => {
  it('accepts the vendor\'s basic-format offset with NO colon', () => {
    // `2017-05-19T23:27:28+0000` is the documented shape. A helper written for
    // RFC 3339 (`+00:00`) with a hand-rolled regex rejects EVERY real Instagram
    // timestamp — and the failure surfaces as "no new comments", not as a parse
    // error, which is why this is worth its own test.
    expect(instagramInstantMs('2017-05-19T23:27:28+0000')).toBe(Date.parse('2017-05-19T23:27:28Z'));
  });

  it('returns null for absent or unparseable values rather than 0 or NaN', () => {
    // A zero would read as 1970 and make every comment look NEW forever.
    for (const value of [null, undefined, '', '   ', 'yesterday']) {
      expect(instagramInstantMs(value)).toBeNull();
    }
  });
});

describe('the watermark, since no timestamp filter exists server-side', () => {
  const MARK = { watermark: '2026-08-23T10:00:00+0000', seenAtWatermark: ['c-1'] };

  it('validates its own stored shape', () => {
    expect(isInstagramWatermark(MARK)).toBe(true);
    expect(isInstagramWatermark(null)).toBe(false);
    expect(isInstagramWatermark({ watermark: '', seenAtWatermark: [] })).toBe(false);
    expect(isInstagramWatermark({ watermark: 'x' })).toBe(false);
    expect(isInstagramWatermark({ watermark: 'x', seenAtWatermark: [1] })).toBe(false);
  });

  it('treats everything as new on a cold start', () => {
    expect(instagramIsNewAgainstWatermark(null, '2020-01-01T00:00:00+0000', 'c-9')).toBe(true);
  });

  it('emits strictly newer, and skips strictly older', () => {
    expect(instagramIsNewAgainstWatermark(MARK, '2026-08-23T10:00:01+0000', 'c-2')).toBe(true);
    expect(instagramIsNewAgainstWatermark(MARK, '2026-08-23T09:59:59+0000', 'c-0')).toBe(false);
  });

  it('breaks a SAME-SECOND tie by id — the reason the id set exists at all', () => {
    // The format's resolution is one second, so two comments genuinely share a
    // timestamp. A bare `>` would drop the second one FOREVER; a bare `>=` would
    // re-emit the first on every pass. Both are silent.
    expect(instagramIsNewAgainstWatermark(MARK, MARK.watermark, 'c-1')).toBe(false);
    expect(instagramIsNewAgainstWatermark(MARK, MARK.watermark, 'c-2')).toBe(true);
  });

  it('accumulates ids at the same instant, and RESETS the set when the instant advances', () => {
    const sameSecond = instagramAdvanceWatermark(MARK, MARK.watermark, 'c-2');
    expect(sameSecond.seenAtWatermark).toEqual(['c-1', 'c-2']);

    const later = instagramAdvanceWatermark(sameSecond, '2026-08-23T10:00:05+0000', 'c-3');
    expect(later.watermark).toBe('2026-08-23T10:00:05+0000');
    // Resetting is correct AND necessary: without it the set grows without bound
    // across every poll for the life of the source.
    expect(later.seenAtWatermark).toEqual(['c-3']);
  });

  it('never moves BACKWARDS on an out-of-order item', () => {
    const older = instagramAdvanceWatermark(MARK, '2026-08-23T09:00:00+0000', 'c-old');
    expect(older).toEqual(MARK);
  });

  it('does not duplicate an id already recorded at the instant', () => {
    expect(instagramAdvanceWatermark(MARK, MARK.watermark, 'c-1').seenAtWatermark).toEqual(['c-1']);
  });

  it('leaves the mark untouched when the timestamp is unparseable', () => {
    expect(instagramAdvanceWatermark(MARK, 'nonsense', 'c-x')).toEqual(MARK);
  });
});

/* -------------------------------------------------------------------------- */
/* D-031 — the loss bound                                                     */
/* -------------------------------------------------------------------------- */

describe('the capped-window overflow predicate (D-031)', () => {
  const CAP = 4;
  function page(count: number, startSec: number): { id: string; timestamp: string }[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `c-${i}`,
      timestamp: `2026-08-23T10:00:${String(startSec + i).padStart(2, '0')}+0000`,
    }));
  }

  it('a SHORT page never overflows — the window covered everything available', () => {
    const mark = { watermark: '2026-08-23T10:00:00+0000', seenAtWatermark: [] as string[] };
    expect(instagramWindowOverflowed(page(CAP - 1, 30), mark, CAP)).toBe(false);
  });

  it('a FULL page whose oldest item REACHES the watermark did bridge the gap', () => {
    const mark = { watermark: '2026-08-23T10:00:40+0000', seenAtWatermark: [] as string[] };
    // Oldest item is at :30, older than the :40 mark — the window reached back
    // past what we last saw, so nothing fell off.
    expect(instagramWindowOverflowed(page(CAP, 30), mark, CAP)).toBe(false);
  });

  it('a FULL page whose oldest item is still NEWER than the watermark lost comments', () => {
    // The window did not reach back to the last thing we saw, and the edge
    // documents no cursor to ask again with — so at least one comment is now
    // permanently unreachable. Success and silent loss are identical from the
    // response alone; only the watermark separates them.
    const mark = { watermark: '2026-08-23T10:00:00+0000', seenAtWatermark: [] as string[] };
    expect(instagramWindowOverflowed(page(CAP, 30), mark, CAP)).toBe(true);
  });

  it('CONTROL: a COLD START is NOT exempt, and an earlier version of this said it was', () => {
    // The exemption reasoned that with no watermark there is no gap to bridge,
    // so a full first page is "simply the newest 50". That confused INTENT with
    // DATA: if the account already has 200 comments, a capped first read reaches
    // 50 and the other 150 are as unreachable as any mid-stream overflow. The
    // conformance kit falsified it in one run. This control is permanent — it is
    // the exact case the exemption would have declared healthy.
    expect(instagramWindowOverflowed(page(CAP, 0), null, CAP)).toBe(true);
    // ...and a short cold page is still fine, so the fix did not just make the
    // predicate answer true more often.
    expect(instagramWindowOverflowed(page(CAP - 1, 0), null, CAP)).toBe(false);
  });

  it('defaults to the vendor\'s documented 50, which is a ceiling and not a page size we chose', () => {
    expect(INSTAGRAM_COMMENTS_MAX_PER_QUERY).toBe(50);
    expect(instagramWindowOverflowed(page(50, 0), null)).toBe(true);
    expect(instagramWindowOverflowed(page(49, 0), null)).toBe(false);
  });

  it('does not claim loss when no item in a full page carries a usable timestamp', () => {
    // Unparseable input is a reason to say nothing, not a reason to raise an
    // alarm the data cannot support.
    const undated = Array.from({ length: CAP }, (_, i) => ({ id: `c-${i}`, timestamp: 'nonsense' }));
    const mark = { watermark: '2026-08-23T10:00:00+0000', seenAtWatermark: [] as string[] };
    expect(instagramWindowOverflowed(undated, mark, CAP)).toBe(false);
  });
});
