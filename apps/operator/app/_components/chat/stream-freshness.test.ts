/**
 * Guards for the chat pane's staleness detector (gui-chat-pane-repaint-2026-08-12
 * P-003). The failure being prevented: a pane that has gone deaf looks exactly
 * like a live one, so the owner reads "my message never sent" off a transcript
 * that simply stopped repainting.
 *
 * The two directions are NOT symmetric, and the tests are weighted accordingly:
 *   - a MISSED stale stream costs the owner an investigation (the reported bug);
 *   - a FALSE stale alarm on a merely-idle agent is worse long-term, because
 *     most agents are idle most of the time and a banner that is usually wrong
 *     gets ignored exactly when it is finally right.
 * So "quiet agent is not a broken stream" gets its own explicit case.
 */
import { describe, expect, it } from 'vitest';
import {
  STREAM_SILENCE_STALE_MS,
  classifyStreamFreshness,
  streamFreshnessMessage,
  type TransportStatus,
} from './stream-freshness';

const NOW = new Date('2026-08-12T09:00:00Z').getTime();
const at = (msAgo: number) => NOW - msAgo;

describe('classifyStreamFreshness', () => {
  it('a stream delivering on schedule is fresh — no banner', () => {
    const f = classifyStreamFreshness({ transport: 'open', lastSignalAtMs: at(5_000), nowMs: NOW });
    expect(f).toBe('fresh');
    expect(streamFreshnessMessage(f)).toBeNull();
  });

  /**
   * THE ANTI-CRY-WOLF CASE. The server heartbeats every 15s whether or not the
   * agent is doing anything, so an idle agent still produces signals. A detector
   * keyed on transcript activity instead would fire here — and be wrong.
   */
  it('an IDLE agent is not a broken stream, as long as the transport is still beating', () => {
    // No transcript entries for an hour, but a heartbeat 3s ago.
    const f = classifyStreamFreshness({ transport: 'open', lastSignalAtMs: at(3_000), nowMs: NOW });
    expect(f).toBe('fresh');
  });

  it('silence past the threshold on an open stream is STALE — the reported symptom', () => {
    const f = classifyStreamFreshness({
      transport: 'open',
      lastSignalAtMs: at(STREAM_SILENCE_STALE_MS + 1),
      nowMs: NOW,
    });
    expect(f).toBe('stale');
    expect(streamFreshnessMessage(f)).toMatch(/may be behind/i);
  });

  it('is exactly at-or-past the threshold, not merely near it', () => {
    const open = (msAgo: number) =>
      classifyStreamFreshness({ transport: 'open', lastSignalAtMs: at(msAgo), nowMs: NOW });
    expect(open(STREAM_SILENCE_STALE_MS - 1)).toBe('fresh');
    expect(open(STREAM_SILENCE_STALE_MS)).toBe('stale');
  });

  /**
   * The transport's verdict outranks the timer: `failing` is a positive
   * observation, silence is an absence of evidence. A backing-off stream is
   * legitimately silent, so timer-first would report the vaguer of two answers.
   */
  it("a retrying transport reads as 'reconnecting' even when it has also gone silent", () => {
    const f = classifyStreamFreshness({
      transport: 'failing',
      lastSignalAtMs: at(STREAM_SILENCE_STALE_MS * 10),
      nowMs: NOW,
    });
    expect(f).toBe('reconnecting');
    expect(streamFreshnessMessage(f)).toMatch(/reconnecting/i);
  });

  it('treats an initial connect as reconnecting rather than stale', () => {
    expect(classifyStreamFreshness({ transport: 'connecting', lastSignalAtMs: null, nowMs: NOW })).toBe(
      'reconnecting',
    );
  });

  /**
   * A closed stream is not stale, it is over. The composer/`done` state already
   * says so and a second alarm would be noise.
   */
  it.each(['closed', 'idle'] as TransportStatus[])('%s is unknown, not an alarm', (transport) => {
    const f = classifyStreamFreshness({ transport, lastSignalAtMs: at(999_999), nowMs: NOW });
    expect(f).toBe('unknown');
    expect(streamFreshnessMessage(f)).toBeNull();
  });

  /**
   * Never claim a connection is dead because we never looked. This fires on
   * every pane's first frames, and a banner there would be pure noise.
   */
  it('reports unknown — never stale — when nothing has been observed yet', () => {
    expect(classifyStreamFreshness({ transport: undefined, lastSignalAtMs: null, nowMs: NOW })).toBe(
      'unknown',
    );
    expect(classifyStreamFreshness({ transport: 'open', lastSignalAtMs: null, nowMs: NOW })).toBe(
      'unknown',
    );
  });

  it('a backwards clock jump (NTP step, suspend/resume) invents neither verdict', () => {
    const f = classifyStreamFreshness({ transport: 'open', lastSignalAtMs: NOW + 30_000, nowMs: NOW });
    expect(f).toBe('unknown');
    expect(streamFreshnessMessage(f)).toBeNull();
  });

  it('works with no transport wired at all, falling back to the silence timer', () => {
    expect(classifyStreamFreshness({ lastSignalAtMs: at(1_000), nowMs: NOW })).toBe('fresh');
    expect(classifyStreamFreshness({ lastSignalAtMs: at(STREAM_SILENCE_STALE_MS), nowMs: NOW })).toBe(
      'stale',
    );
  });
});

describe('streamFreshnessMessage', () => {
  /**
   * The wording is load-bearing. "My message never sent" was the owner's
   * (incorrect) inference; a banner that implied it would automate the very
   * mistake this exists to prevent. It must speak about the VIEW being behind,
   * and must not cast doubt on delivery.
   */
  it('never suggests the message failed to send', () => {
    for (const f of ['reconnecting', 'stale'] as const) {
      const msg = streamFreshnessMessage(f);
      expect(msg).toBeTruthy();
      expect(msg).not.toMatch(/fail|not sent|never sent|undelivered|error/i);
    }
  });

  it('affirms delivery on the stale banner, which is the reassurance that was missing', () => {
    expect(streamFreshnessMessage('stale')).toMatch(/still delivered/i);
  });

  it('stays silent for the states that need no banner', () => {
    expect(streamFreshnessMessage('fresh')).toBeNull();
    expect(streamFreshnessMessage('unknown')).toBeNull();
  });
});
