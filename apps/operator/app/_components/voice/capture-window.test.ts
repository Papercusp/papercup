/**
 * Capture-window self-echo guard (WI-954890).
 *
 * The property under test is the one the old dispatch-time cooldown could not
 * express: the verdict is a function of WHEN THE AUDIO WAS RECORDED, so an
 * arbitrarily late transcript is judged exactly the same as a prompt one. Every
 * "arrives late" case below is a real escape under the previous design, where
 * the 700ms window had always expired before the transcript existed (measured
 * floor for the shipped path: 683ms of end-of-speech detection + ~827ms of
 * whisper = ~1.5s minimum).
 */

import { describe, it, expect } from 'vitest';
import { PlayoutLedger, captureWindowEndingAt, PLAYOUT_TAIL_MS } from './capture-window';

const T0 = 2_000_000;

describe('PlayoutLedger — overlap is a property of the audio, not the clock', () => {
  it('rejects audio captured DURING playout no matter how late the transcript arrives', () => {
    const led = new PlayoutLedger();
    led.open(T0);
    led.close(T0 + 3_000); // papercup spoke for 3s

    // The mic recorded the tail of that playout.
    const echo = { startedAtMs: T0 + 1_000, endedAtMs: T0 + 2_900 };

    // This is the whole fix: identical verdict at every arrival time. Under the
    // old design the guard was already expired at the FIRST of these.
    expect(led.overlaps(echo)).toBe(true);
    // …and it stays true 10s later, because `overlaps` takes no `now` at all.
    expect(led.overlaps(echo)).toBe(true);
  });

  it('rejects the FINAL segment — the one that always escaped', () => {
    // The reply's last segment ends when playout stops; its speech-end fires
    // ~683ms later and whisper adds ~827ms+, so it dispatched ~1.5s past a
    // 700ms window. Its AUDIO, however, is squarely inside playout.
    const led = new PlayoutLedger();
    led.open(T0);
    led.close(T0 + 4_000);
    expect(led.overlaps({ startedAtMs: T0 + 3_100, endedAtMs: T0 + 4_000 })).toBe(true);
  });

  it('rejects audio inside the acoustic settle tail after playout ends', () => {
    const led = new PlayoutLedger();
    led.open(T0);
    led.close(T0 + 1_000);
    expect(led.overlaps({ startedAtMs: T0 + 1_050, endedAtMs: T0 + 1_200 })).toBe(true);
    expect(
      led.overlaps({
        startedAtMs: T0 + 1_000 + PLAYOUT_TAIL_MS - 10,
        endedAtMs: T0 + 1_000 + PLAYOUT_TAIL_MS + 500,
      }),
    ).toBe(true);
  });

  it('ACCEPTS real user speech recorded outside playout — this is not a mute button', () => {
    const led = new PlayoutLedger();
    led.open(T0);
    led.close(T0 + 1_000);

    // Spoken after the room went quiet. Note it is accepted even though it is
    // DISPATCHED long after — and, unlike the old cooldown, also when dispatched
    // immediately, because only the recording's position matters.
    expect(
      led.overlaps({ startedAtMs: T0 + 1_000 + PLAYOUT_TAIL_MS + 1, endedAtMs: T0 + 3_000 }),
    ).toBe(false);
    // Spoken entirely BEFORE papercup started talking.
    expect(led.overlaps({ startedAtMs: T0 - 2_000, endedAtMs: T0 - 100 })).toBe(false);
  });

  it('rejects everything while playout is still open (no end recorded yet)', () => {
    const led = new PlayoutLedger();
    led.open(T0);
    expect(led.isPlaying).toBe(true);
    expect(led.overlaps({ startedAtMs: T0 + 10_000, endedAtMs: T0 + 12_000 })).toBe(true);
  });

  it('coalesces a multi-item synth queue into one audible interval', () => {
    const led = new PlayoutLedger();
    led.open(T0);
    led.open(T0 + 500); // next queue item — must not open a second interval
    led.close(T0 + 2_000);
    // A single close ends the run; audio after the tail is clean.
    expect(led.overlaps({ startedAtMs: T0 + 1_500, endedAtMs: T0 + 1_900 })).toBe(true);
    expect(
      led.overlaps({ startedAtMs: T0 + 2_000 + PLAYOUT_TAIL_MS + 1, endedAtMs: T0 + 4_000 }),
    ).toBe(false);
  });

  it('keeps SEVERAL recent intervals, so an older reply still shields its own echo', () => {
    const led = new PlayoutLedger();
    led.open(T0);
    led.close(T0 + 1_000);
    led.open(T0 + 5_000);
    led.close(T0 + 6_000);
    expect(led.overlaps({ startedAtMs: T0 + 200, endedAtMs: T0 + 900 })).toBe(true);
    expect(led.overlaps({ startedAtMs: T0 + 5_200, endedAtMs: T0 + 5_900 })).toBe(true);
    expect(led.overlaps({ startedAtMs: T0 + 2_000, endedAtMs: T0 + 4_000 })).toBe(false);
  });

  it('close() is idempotent and never moves an end backwards past its start', () => {
    const led = new PlayoutLedger();
    led.open(T0 + 1_000);
    led.close(T0); // a clock that went backwards must not invert the interval
    led.close(T0 + 5_000); // already closed — no effect
    expect(led.overlaps({ startedAtMs: T0 + 1_000, endedAtMs: T0 + 1_100 })).toBe(true);
    expect(led.overlaps({ startedAtMs: T0 + 4_000, endedAtMs: T0 + 4_500 })).toBe(false);
  });

  it('reset() clears the ledger', () => {
    const led = new PlayoutLedger();
    led.open(T0);
    led.close(T0 + 1_000);
    led.reset();
    expect(led.overlaps({ startedAtMs: T0 + 100, endedAtMs: T0 + 900 })).toBe(false);
  });

  it('prunes intervals older than the retention window', () => {
    const led = new PlayoutLedger();
    led.open(T0);
    led.close(T0 + 1_000);
    // A much later playout prunes the ancient one on the way through.
    led.open(T0 + 500_000);
    led.close(T0 + 501_000);
    expect(led.overlaps({ startedAtMs: T0 + 200, endedAtMs: T0 + 900 })).toBe(false);
    expect(led.overlaps({ startedAtMs: T0 + 500_200, endedAtMs: T0 + 500_900 })).toBe(true);
  });
});

describe('captureWindowEndingAt', () => {
  it('derives the start from the audio duration', () => {
    expect(captureWindowEndingAt(T0, 1_500)).toEqual({
      startedAtMs: T0 - 1_500,
      endedAtMs: T0,
    });
  });

  it('treats a negative duration as zero-length rather than inverting the window', () => {
    expect(captureWindowEndingAt(T0, -50)).toEqual({ startedAtMs: T0, endedAtMs: T0 });
  });
});
