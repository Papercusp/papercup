/**
 * session-reset-continuation.test.ts — the channel set that decides whether a
 * SessionEnd is a scheduled continuation or a death (WI-6756).
 *
 * WHY THIS FILE EXISTS AT ALL: WI-6862 widened `WakeChannel` with `-unconfirmed`
 * reset/recycle variants and very nearly reverted WI-6756 by omission. Nothing
 * caught it — `CONTEXT_RESET_WAKE_CHANNELS` is a list of STRINGS consumed by a
 * SQL `= ANY()` filter, so a channel missing from it is invisible to tsc, to
 * `lint:required-field-strands`, and to every existing test. The failure mode is
 * silent and one-directional: the guard stops matching, `activity/report.ts`
 * reads the reset's SessionEnd as a death, and force-releases every work-item
 * lease the owner holds.
 */
import { describe, expect, it } from 'vitest';
import { CONTEXT_RESET_WAKE_CHANNELS, RESET_CONTINUATION_WINDOW_MS } from './session-reset-continuation';
import { WAKE_TURN_CHANNELS } from './events/await/types';

describe('CONTEXT_RESET_WAKE_CHANNELS (WI-6756 continuation guard)', () => {
  // The recurrence guard for the whole class, not just for WI-6862's two channels.
  // Any channel that drops the child's context is by definition a turn-burning
  // channel, so WAKE_TURN_CHANNELS is the enumeration to measure against: a future
  // reset/recycle variant that joins it and forgets THIS list reds here instead of
  // silently stranding the guard in production.
  it('covers EVERY reset/recycle-shaped wake channel — a new variant cannot silently strand the guard', () => {
    const resetShaped = WAKE_TURN_CHANNELS.filter((c) => /^psu-socket-(reset|recycle)/.test(c));
    expect([...resetShaped].sort()).toEqual([...CONTEXT_RESET_WAKE_CHANNELS].sort());
  });

  it('includes the WI-6862 -unconfirmed variants: a host that sends no ack still performed the reset', () => {
    // The common case, not an edge case — any host running pre-WI-5872 code never
    // acks, so its perfectly-good reset books the unconfirmed channel. Excluding
    // these is what reverts WI-6756 for the majority of cold wakes.
    expect(CONTEXT_RESET_WAKE_CHANNELS).toContain('psu-socket-reset-unconfirmed');
    expect(CONTEXT_RESET_WAKE_CHANNELS).toContain('psu-socket-recycle-unconfirmed');
  });

  // The control for the assertion above: the set must not have widened into
  // "any wake channel", which would make the first two tests pass vacuously and
  // would exempt a genuine death near a WARM inject from ever releasing.
  it('CONTROL: warm and non-turn channels are still EXCLUDED — a SessionEnd near a warm inject is a real death', () => {
    for (const warm of ['psu-socket-inject', 'pty-inject', 'resume', 'inbox', 'coalesced'] as const) {
      expect(CONTEXT_RESET_WAKE_CHANNELS).not.toContain(warm);
    }
  });

  it('the window stays well under a common 60s loop interval (an unrelated death must not inherit it)', () => {
    expect(RESET_CONTINUATION_WINDOW_MS).toBeLessThan(60_000);
    expect(RESET_CONTINUATION_WINDOW_MS).toBeGreaterThan(1_000);
  });
});
