import { describe, it, expect } from 'vitest';
import { WAKE_TURN_CHANNELS } from './types';

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
      'hive-fresh-wake',
      'plan-run-resume',
    ] as const) {
      expect(WAKE_TURN_CHANNELS).toContain(ch);
    }
  });

  it('has no duplicate entries', () => {
    expect(new Set(WAKE_TURN_CHANNELS).size).toBe(WAKE_TURN_CHANNELS.length);
  });
});
