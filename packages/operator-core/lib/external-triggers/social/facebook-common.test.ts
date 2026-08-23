/**
 * Tests for the Facebook Pages shared module — P-016 stage 2.
 *
 * These cover the four verified vendor behaviours that the adapters cannot
 * re-derive at runtime, each recorded as a plan decision: the page-credential
 * rail (D-027), throttle classification and the deliberate absence of a retry
 * delay (D-028), the only-legal-termination-test for paging (D-025), and the
 * equal-instant watermark boundary (D-023 as it survives onto a stream with no
 * query floor).
 */
import { describe, expect, it } from 'vitest';
import {
  FACEBOOK_GRAPH_VERSION,
  FACEBOOK_THROTTLE_CODE_BUC,
  FACEBOOK_THROTTLE_CODE_PLATFORM,
  FacebookGraphThrottled,
  FacebookPageCredentialError,
  assertFacebookPageCredential,
  facebookAdvanceWatermark,
  facebookGraphUrl,
  facebookInstantMs,
  facebookIsNewAgainstWatermark,
  facebookNextPageUrl,
  facebookPeakUsagePct,
  facebookThrottleFrom,
  facebookThrottleHoldMs,
  isFacebookWatermarkCursor,
  parseFacebookBucUsage,
  selectFacebookPageCredential,
} from './facebook-common';

describe('facebookGraphUrl', () => {
  it('pins the verified version into every path', () => {
    expect(facebookGraphUrl('/123/feed')).toBe('https://graph.facebook.com/' + FACEBOOK_GRAPH_VERSION + '/123/feed');
  });

  it('tolerates a missing leading slash and a trailing slash on the origin', () => {
    expect(facebookGraphUrl('123/feed', 'https://graph.facebook.com/')).toBe(
      'https://graph.facebook.com/' + FACEBOOK_GRAPH_VERSION + '/123/feed',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* D-027 — the page-credential rail                                           */
/* -------------------------------------------------------------------------- */

describe('assertFacebookPageCredential (D-027)', () => {
  const good = { pageId: 'page-1', accessToken: 'page-token', tasks: ['CREATE_CONTENT', 'MODERATE'] };

  it('accepts a page credential that carries the required task', () => {
    expect(() => assertFacebookPageCredential(good, 'page-1', 'MODERATE')).not.toThrow();
  });

  it('REFUSES a credential minted for a different Page', () => {
    expect(() => assertFacebookPageCredential(good, 'page-2', 'MODERATE')).toThrow(FacebookPageCredentialError);
  });

  it('REFUSES when the required task is absent — the case that silently returns empty data', () => {
    const noModerate = { pageId: 'page-1', accessToken: 't', tasks: ['CREATE_CONTENT'] };
    expect(() => assertFacebookPageCredential(noModerate, 'page-1', 'MODERATE')).toThrow(
      /tasks:CREATE_CONTENT/,
    );
  });

  it('REFUSES a value that is not a page credential at all (e.g. a bare user token string)', () => {
    expect(() => assertFacebookPageCredential('user-access-token', 'page-1', 'MODERATE')).toThrow(
      /not-a-page-credential/,
    );
    expect(() => assertFacebookPageCredential(null, 'page-1', 'MODERATE')).toThrow(FacebookPageCredentialError);
  });

  it('REFUSES a credential with an empty task list rather than reporting it as unknown', () => {
    const noTasks = { pageId: 'page-1', accessToken: 't', tasks: [] };
    expect(() => assertFacebookPageCredential(noTasks, 'page-1', 'MODERATE')).toThrow(/tasks:none/);
  });
});

describe('selectFacebookPageCredential', () => {
  const rows = [
    { id: 'page-1', access_token: 'tok-1', tasks: ['MODERATE'], name: 'One' },
    { id: 'page-2', access_token: 'tok-2', tasks: ['CREATE_CONTENT'], name: 'Two' },
  ];

  it('picks the row for the requested page', () => {
    expect(selectFacebookPageCredential(rows, 'page-2')).toEqual({
      pageId: 'page-2',
      accessToken: 'tok-2',
      tasks: ['CREATE_CONTENT'],
    });
  });

  it('returns null when the user does not manage that page', () => {
    expect(selectFacebookPageCredential(rows, 'page-9')).toBeNull();
  });

  it('returns null — never a task-less credential — when the row carries no token', () => {
    expect(selectFacebookPageCredential([{ id: 'page-3', tasks: ['MODERATE'] }], 'page-3')).toBeNull();
  });

  it('drops non-string task entries rather than carrying them into an includes() check', () => {
    const odd = [{ id: 'p', access_token: 't', tasks: ['MODERATE', 42, null] }];
    expect(selectFacebookPageCredential(odd, 'p')?.tasks).toEqual(['MODERATE']);
  });
});

/* -------------------------------------------------------------------------- */
/* D-025 — paging termination                                                 */
/* -------------------------------------------------------------------------- */

describe('facebookNextPageUrl (D-025)', () => {
  it('CONTINUES on an empty page that still carries next — the documented case', () => {
    const connection = { data: [], paging: { next: 'https://graph.facebook.com/next-page' } };
    expect(facebookNextPageUrl(connection)).toBe('https://graph.facebook.com/next-page');
  });

  it('CONTINUES on a short page that carries next', () => {
    expect(facebookNextPageUrl({ data: [{ id: '1' }], paging: { next: 'u' } })).toBe('u');
  });

  it('stops only when next is absent, even with a full page of data', () => {
    const full = { data: [{ id: '1' }, { id: '2' }], paging: { cursors: { after: 'abc' } } };
    expect(facebookNextPageUrl(full)).toBeNull();
  });

  it('treats a blank or non-string next as absent', () => {
    expect(facebookNextPageUrl({ paging: { next: '   ' } })).toBeNull();
    expect(facebookNextPageUrl({ paging: { next: 42 } })).toBeNull();
    expect(facebookNextPageUrl(null)).toBeNull();
  });

  it('does NOT treat the after cursor as a continuation token', () => {
    // Storing/echoing `after` across polls is what D-025 forbids; the helper must
    // never surface it as the thing to follow.
    expect(facebookNextPageUrl({ data: [], paging: { cursors: { after: 'cursor-value' } } })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* D-028 — throttling                                                         */
/* -------------------------------------------------------------------------- */

describe('parseFacebookBucUsage (D-028)', () => {
  it('flattens the business-keyed header into rows', () => {
    const header = JSON.stringify({
      'biz-1': [{ type: 'pages', call_count: 61, total_cputime: 5, total_time: 8, estimated_time_to_regain_access: 12 }],
    });
    expect(parseFacebookBucUsage(header)).toEqual([
      {
        businessId: 'biz-1',
        type: 'pages',
        callCount: 61,
        totalCputime: 5,
        totalTime: 8,
        estimatedTimeToRegainAccess: 12,
      },
    ]);
  });

  it('returns [] for a malformed header instead of throwing — telemetry must not break a good call', () => {
    expect(parseFacebookBucUsage('not json')).toEqual([]);
    expect(parseFacebookBucUsage('[1,2]')).toEqual([]);
    expect(parseFacebookBucUsage(null)).toEqual([]);
    expect(parseFacebookBucUsage('')).toEqual([]);
  });

  it('coerces numeric strings, which the header has been observed to use', () => {
    const header = JSON.stringify({ b: [{ type: 'pages', call_count: '75' }] });
    expect(parseFacebookBucUsage(header)[0]?.callCount).toBe(75);
  });
});

describe('facebookPeakUsagePct (D-028)', () => {
  it('reports the highest of the three percentages for the pages type', () => {
    const usage = parseFacebookBucUsage(
      JSON.stringify({ b: [{ type: 'pages', call_count: 10, total_cputime: 91, total_time: 3 }] }),
    );
    expect(facebookPeakUsagePct(usage)).toBe(91);
  });

  it('ignores other business-use-case types', () => {
    const usage = parseFacebookBucUsage(JSON.stringify({ b: [{ type: 'ads_management', call_count: 99 }] }));
    expect(facebookPeakUsagePct(usage, 'pages')).toBeNull();
  });

  it('returns null rather than 0 when nothing was reported — an unknown budget is not an idle one', () => {
    expect(facebookPeakUsagePct([])).toBeNull();
  });
});

describe('facebookThrottleFrom (D-028)', () => {
  const usageHeader = JSON.stringify({ b: [{ type: 'pages', estimated_time_to_regain_access: 7 }] });

  it('classifies the BUC code 80001 and takes the hold from the usage header', () => {
    const err = facebookThrottleFrom({ error: { code: FACEBOOK_THROTTLE_CODE_BUC, message: 'too many calls' } }, usageHeader);
    expect(err).toBeInstanceOf(FacebookGraphThrottled);
    expect(err?.code).toBe(80001);
    expect(err?.holdMinutes).toBe(7);
    expect(err?.message).toBe('too many calls');
  });

  it('ALSO classifies platform code 32 — the code a mis-credentialled call produces', () => {
    const err = facebookThrottleFrom({ error: { code: FACEBOOK_THROTTLE_CODE_PLATFORM } }, usageHeader);
    expect(err?.code).toBe(32);
  });

  it('is null for an ordinary error, so non-throttles are not swallowed as throttles', () => {
    expect(facebookThrottleFrom({ error: { code: 100, message: 'bad cursor' } }, usageHeader)).toBeNull();
    expect(facebookThrottleFrom({}, usageHeader)).toBeNull();
    expect(facebookThrottleFrom(null, null)).toBeNull();
  });

  it('carries a NULL hold when the provider stated none — no duration is invented', () => {
    const err = facebookThrottleFrom({ error: { code: 80001 } }, null);
    expect(err).toBeInstanceOf(FacebookGraphThrottled);
    expect(err?.holdMinutes).toBeNull();
  });
});

describe('facebookThrottleHoldMs (D-028)', () => {
  it('converts a stated hold from minutes to ms', () => {
    expect(facebookThrottleHoldMs(new FacebookGraphThrottled(80001, 7, 'x'))).toBe(420_000);
  });

  it('returns null when no duration was stated — the caller must surface, not guess and retry', () => {
    expect(facebookThrottleHoldMs(new FacebookGraphThrottled(80001, null, 'x'))).toBeNull();
  });

  it('returns null for a non-throttle error', () => {
    expect(facebookThrottleHoldMs(new Error('boom'))).toBeNull();
    expect(facebookThrottleHoldMs(null)).toBeNull();
  });

  it('rejects a negative stated duration rather than producing a negative wait', () => {
    expect(facebookThrottleHoldMs(new FacebookGraphThrottled(80001, -5, 'x'))).toBeNull();
  });

  it('exposes no retry-delay affordance at all — the class carries holdMinutes, never retryAfter', () => {
    // The naming is the guard: a generic backoff wrapper looking for a retry
    // delay finds nothing to schedule against, which is the intent of D-028.
    const err = new FacebookGraphThrottled(80001, 7, 'x');
    expect(Object.keys(err)).not.toContain('retryAfterSeconds');
    expect((err as unknown as Record<string, unknown>).retryAfter).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Watermark boundary                                                         */
/* -------------------------------------------------------------------------- */

describe('facebookInstantMs', () => {
  it('treats two spellings of one instant as equal', () => {
    expect(facebookInstantMs('2026-08-23T00:00:00Z')).toBe(facebookInstantMs('2026-08-23T00:00:00.000Z'));
  });

  it('returns null for unusable input', () => {
    expect(facebookInstantMs('not-a-date')).toBeNull();
    expect(facebookInstantMs(null)).toBeNull();
    expect(facebookInstantMs(undefined)).toBeNull();
  });
});

describe('isFacebookWatermarkCursor', () => {
  it('accepts a well-formed cursor', () => {
    expect(isFacebookWatermarkCursor({ watermark: '2026-08-23T00:00:00Z', boundaryIds: ['a'] })).toBe(true);
  });

  it('rejects an unparseable watermark, so it is treated as unreadable rather than trusted', () => {
    expect(isFacebookWatermarkCursor({ watermark: 'nonsense', boundaryIds: [] })).toBe(false);
    expect(isFacebookWatermarkCursor({ watermark: '2026-08-23T00:00:00Z' })).toBe(false);
    expect(isFacebookWatermarkCursor(null)).toBe(false);
  });
});

describe('facebookIsNewAgainstWatermark', () => {
  const stored = { watermark: '2026-08-23T12:00:00.000Z', boundaryIds: ['seen-1'] };

  it('emits everything on a cold start', () => {
    expect(facebookIsNewAgainstWatermark(null, '2020-01-01T00:00:00Z', 'x')).toBe(true);
  });

  it('drops an item strictly older than the mark', () => {
    expect(facebookIsNewAgainstWatermark(stored, '2026-08-23T11:59:59.999Z', 'x')).toBe(false);
  });

  it('emits an item strictly newer than the mark', () => {
    expect(facebookIsNewAgainstWatermark(stored, '2026-08-23T12:00:00.001Z', 'x')).toBe(true);
  });

  it('AT the mark: drops one already emitted, emits a NEW one at the same instant', () => {
    expect(facebookIsNewAgainstWatermark(stored, '2026-08-23T12:00:00.000Z', 'seen-1')).toBe(false);
    expect(facebookIsNewAgainstWatermark(stored, '2026-08-23T12:00:00.000Z', 'fresh-2')).toBe(true);
  });

  it('AT the mark, re-spelled: still recognises the already-emitted id', () => {
    expect(facebookIsNewAgainstWatermark(stored, '2026-08-23T12:00:00Z', 'seen-1')).toBe(false);
  });

  it('emits — never drops — an item whose instant cannot be parsed', () => {
    // A duplicate is absorbed by the dedupe key; a drop is unrecoverable.
    expect(facebookIsNewAgainstWatermark(stored, 'garbage', 'x')).toBe(true);
    expect(facebookIsNewAgainstWatermark(stored, null, 'x')).toBe(true);
  });
});

describe('facebookAdvanceWatermark', () => {
  it('sets the mark on first advance', () => {
    expect(facebookAdvanceWatermark(null, '2026-08-23T12:00:00Z', 'a')).toEqual({
      watermark: '2026-08-23T12:00:00Z',
      boundaryIds: ['a'],
    });
  });

  it('REPLACES the boundary set when the mark moves forward', () => {
    const stored = { watermark: '2026-08-23T12:00:00.000Z', boundaryIds: ['old'] };
    expect(facebookAdvanceWatermark(stored, '2026-08-23T13:00:00.000Z', 'new')).toEqual({
      watermark: '2026-08-23T13:00:00.000Z',
      boundaryIds: ['new'],
    });
  });

  it('APPENDS at an equal instant, so a same-millisecond sibling is not lost', () => {
    const stored = { watermark: '2026-08-23T12:00:00.000Z', boundaryIds: ['a'] };
    expect(facebookAdvanceWatermark(stored, '2026-08-23T12:00:00.000Z', 'b')).toEqual({
      watermark: '2026-08-23T12:00:00.000Z',
      boundaryIds: ['a', 'b'],
    });
  });

  it('does not duplicate an id already on the boundary', () => {
    const stored = { watermark: '2026-08-23T12:00:00.000Z', boundaryIds: ['a'] };
    expect(facebookAdvanceWatermark(stored, '2026-08-23T12:00:00.000Z', 'a')).toBe(stored);
  });

  it('never moves the mark BACKWARD for an older item', () => {
    const stored = { watermark: '2026-08-23T12:00:00.000Z', boundaryIds: ['a'] };
    expect(facebookAdvanceWatermark(stored, '2026-08-23T01:00:00.000Z', 'old')).toBe(stored);
  });

  it('leaves the cursor untouched for an unparseable instant', () => {
    const stored = { watermark: '2026-08-23T12:00:00.000Z', boundaryIds: ['a'] };
    expect(facebookAdvanceWatermark(stored, 'garbage', 'x')).toBe(stored);
  });
});

/* -------------------------------------------------------------------------- */
/* Calibration controls                                                       */
/* -------------------------------------------------------------------------- */

describe('calibration — the boundary logic is genuinely doing the work', () => {
  const stored = { watermark: '2026-08-23T12:00:00.000Z', boundaryIds: ['seen-1'] };

  it('a naive `>` comparison would DROP a new same-instant sibling that the real rule emits', () => {
    const naiveStrictlyNewer = (instant: string) =>
      (facebookInstantMs(instant) ?? 0) > (facebookInstantMs(stored.watermark) ?? 0);

    expect(naiveStrictlyNewer('2026-08-23T12:00:00.000Z')).toBe(false);
    expect(facebookIsNewAgainstWatermark(stored, '2026-08-23T12:00:00.000Z', 'fresh-2')).toBe(true);
  });

  it('a naive `>=` comparison would RE-EMIT an already-seen item that the real rule drops', () => {
    const naiveAtOrNewer = (instant: string) =>
      (facebookInstantMs(instant) ?? 0) >= (facebookInstantMs(stored.watermark) ?? 0);

    expect(naiveAtOrNewer('2026-08-23T12:00:00.000Z')).toBe(true);
    expect(facebookIsNewAgainstWatermark(stored, '2026-08-23T12:00:00.000Z', 'seen-1')).toBe(false);
  });

  it('a data-length termination test would stop early where the real rule continues', () => {
    const emptyWithNext = { data: [], paging: { next: 'https://graph.facebook.com/more' } };
    const naiveDone = (emptyWithNext.data?.length ?? 0) === 0;

    expect(naiveDone).toBe(true);
    expect(facebookNextPageUrl(emptyWithNext)).not.toBeNull();
  });
});
