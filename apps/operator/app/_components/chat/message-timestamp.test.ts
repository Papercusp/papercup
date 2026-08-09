/**
 * session-chat-popup-timestamps-and-modes-2026-08-09 P-001 — the pure half of
 * the per-message stamp. The component half (the shared-clock subscription that
 * keeps the row memo intact) is covered by ChatConversation.test.tsx.
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
  it('renders BOTH halves, absolute first (plan D-001)', () => {
    const s = formatMessageStamp(new Date(AT).toISOString(), AT + 4 * 60_000);
    expect(s).not.toBeNull();
    expect(s!.absolute).toBe('23:14');
    expect(s!.relative).toBe('4m ago');
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

  it('drops the relative half AND forces the date when there is no clock yet', () => {
    // Without a clock we cannot know whether "today" holds, so the date is
    // always shown. A bare `23:14` that turns out to be last week's is exactly
    // the failure this stamp exists to prevent.
    const s = formatMessageStamp(new Date(AT).toISOString(), null);
    expect(s!.relative).toBeNull();
    expect(s!.absolute).toBe('Aug 9 · 23:14');
  });

  it('clamps a FUTURE timestamp to "0s ago" instead of rendering negative age', () => {
    // Routine here, not exotic: the agent's host and this browser are different
    // machines. "-3s ago" reads as a UI bug; "0s ago" reads as just-now.
    const s = formatMessageStamp(new Date(AT + 3_000).toISOString(), AT);
    expect(s!.relative).toBe('0s ago');
  });

  it('escalates the relative unit the way the rest of the HUD does', () => {
    // Shares hud-board-model's formatAge rather than re-deriving a vocabulary,
    // so an age reads the same here as on a HUD card.
    const cases: Array<[number, string]> = [
      [45 * 1000, '45s ago'],
      [90 * 1000, '1m ago'],
      [3 * 3600 * 1000, '3h ago'],
      [50 * 3600 * 1000, '2d ago'],
    ];
    for (const [elapsedMs, expected] of cases) {
      const s = formatMessageStamp(new Date(AT).toISOString(), AT + elapsedMs);
      expect(s!.relative).toBe(expected);
    }
  });
});
