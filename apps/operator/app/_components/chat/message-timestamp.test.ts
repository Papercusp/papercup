/**
 * session-chat-popup-timestamps-and-modes-2026-08-09 P-001 — the pure half of
 * the per-message stamp. The component half (the shared-clock subscription that
 * keeps the row memo intact) is covered by PapercupChat's shared-view tests.
 *
 * Every case here builds its instants from a LOCAL-time constructor
 * (`new Date(y, m, d, hh, mm)`) rather than an ISO literal. The formatter reads
 * local hours/minutes deliberately — the stamp shows the reader's own clock —
 * so an ISO-literal fixture would pass in UTC and fail on the owner's box, which
 * is the worst possible place for a timezone assumption to surface.
 */
import { describe, expect, it } from 'vitest';
import { formatMessageStamp } from './message-timestamp';

/** 2026-08-09 23:14:07 local. */
const AT = new Date(2026, 7, 9, 23, 14, 7).getTime();

describe('formatMessageStamp', () => {
  it('renders only the compact clock for a message from today (plan D-011)', () => {
    const s = formatMessageStamp(new Date(AT).toISOString(), AT + 4 * 60_000);
    expect(s).not.toBeNull();
    expect(s!.absolute).toBe('23:14');
    expect(s).not.toHaveProperty('relative');
  });

  it('omits the date while the message is from TODAY and adds it once it is not', () => {
    const sameDay = formatMessageStamp(new Date(AT).toISOString(), new Date(2026, 7, 9, 23, 59).getTime());
    expect(sameDay!.absolute).toBe('23:14');

    // One minute later by the clock, but the NEXT DAY — the bare `23:14` would
    // now be actively misleading, which is the whole reason for the date.
    const nextDay = formatMessageStamp(new Date(AT).toISOString(), new Date(2026, 7, 10, 0, 1).getTime());
    expect(nextDay!.absolute).toBe('Aug 9 · 23:14');
  });

  it('pads the clock so a column of stamps stays aligned', () => {
    const s = formatMessageStamp(new Date(2026, 7, 9, 9, 5).toISOString(), AT);
    expect(s!.absolute).toBe('09:05');
  });

  it('carries the full instant for the hover title / dateTime attribute', () => {
    const iso = new Date(AT).toISOString();
    expect(formatMessageStamp(iso, AT)!.iso).toBe(iso);
  });

  it('returns null — no stamp at all — for absent, empty or unparseable input', () => {
    for (const bad of [undefined, null, '', 'not-a-date']) {
      expect(formatMessageStamp(bad, AT)).toBeNull();
    }
  });

  it('forces the shorthand date when there is no clock yet', () => {
    // Without a clock we cannot know whether "today" holds, so the date is
    // always shown. A bare `23:14` that turns out to be last week's is exactly
    // the failure this stamp exists to prevent.
    const s = formatMessageStamp(new Date(AT).toISOString(), null);
    expect(s!.absolute).toBe('Aug 9 · 23:14');
  });
});
