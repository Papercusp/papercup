import { describe, it, expect } from 'vitest';
import { WAKE_TURN_CHANNELS, AWAIT_DEFAULT_TIMEOUT_SEC, AWAIT_MAX_TIMEOUT_SEC } from './types';

// WAKE_TURN_CHANNELS is the allowlist of wake channels that burn a turn (re-invoke
// the agent) — it derives a subscriber's last_woken_at for the wake floor. Adding a
// non-turn-burning channel (inbox/coalesced) here would corrupt the floor accounting.
describe('WAKE_TURN_CHANNELS — turn-burning wake channels', () => {
  it('excludes the channels that do NOT burn a turn (inbox, coalesced)', () => {
    expect(WAKE_TURN_CHANNELS).not.toContain('inbox');
    expect(WAKE_TURN_CHANNELS).not.toContain('coalesced');
  });

  it('includes every resume/inject channel that re-invokes the agent', () => {
    for (const ch of [
      'pty-inject',
      'psu-socket-inject',
      'resume',
      'resume-headless',
      'cold-fresh-successor',
      'hive-fresh-wake',
      'fresh-context-warm-inject',
      'plan-run-resume',
    ] as const) {
      expect(WAKE_TURN_CHANNELS).toContain(ch);
    }
  });

  it('has no duplicate entries', () => {
    expect(new Set(WAKE_TURN_CHANNELS).size).toBe(WAKE_TURN_CHANNELS.length);
  });
});

// The fallback timeout-wake window is the single source of truth for events:await /
// watch:create / the events sugar verbs (await-timeout-fallback-defaults-2026-07-03).
// Pin the literal so a silent revert to the old 4h (or an accidental absurd value)
// fails the build — the whole point of the change is that blocked agents get woken
// on a human-scale cadence, not 4h later.
describe('AWAIT_DEFAULT_TIMEOUT_SEC — the fallback timeout-wake window', () => {
  it('is 30 minutes (1800s) — lowered from the old 4h that stranded blocked agents', () => {
    expect(AWAIT_DEFAULT_TIMEOUT_SEC).toBe(30 * 60);
    expect(AWAIT_DEFAULT_TIMEOUT_SEC).toBe(1800);
    // Strictly below the old 4h default — the regression this guards against.
    expect(AWAIT_DEFAULT_TIMEOUT_SEC).toBeLessThan(4 * 60 * 60);
  });

  it('caps a caller-supplied deadline at 7 days', () => {
    expect(AWAIT_MAX_TIMEOUT_SEC).toBe(7 * 24 * 60 * 60);
    expect(AWAIT_DEFAULT_TIMEOUT_SEC).toBeLessThan(AWAIT_MAX_TIMEOUT_SEC);
  });
});
