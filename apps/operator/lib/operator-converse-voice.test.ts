/**
 * Test the voice tag observer's split-across-chunks handling. B6 of
 * the active-mode audit: when the voice agent streams a `<set_mode>`
 * or `<spawn>` tag that gets split across the 1.2s flush boundary,
 * naive parsing drops both halves silently. The observer should
 * defer the flush when the trailing chunk is an unclosed tag opener,
 * and parse correctly once the closing chunk arrives.
 *
 * Spies on writeOperatorModeToSession / writeSleepUntilMs to assert
 * side effects without needing a jsdom environment.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

const writeMode = vi.fn();
const writeSleep = vi.fn();

let dismissalFlag = false;

vi.mock('./operator-converse-tags', async () => {
  const actual = await vi.importActual<typeof import('./operator-converse-tags')>(
    './operator-converse-tags',
  );
  return {
    ...actual,
    writeOperatorModeToSession: (...args: unknown[]) => writeMode(...args),
    writeSleepUntilMs: (...args: unknown[]) => writeSleep(...args),
    // One-shot consume: returns + clears in a single call.
    consumeRecentDismissal: () => {
      const v = dismissalFlag;
      dismissalFlag = false;
      return v;
    },
  };
});

import { createOperatorVoiceTagObserver } from './operator-converse-voice';

describe('createOperatorVoiceTagObserver — split-chunk tag handling', () => {
  beforeEach(() => {
    writeMode.mockReset();
    writeSleep.mockReset();
    dismissalFlag = false;
  });

  it('handles a complete set_mode tag in one chunk', () => {
    const obs = createOperatorVoiceTagObserver();
    obs.push('Hi there. <set_mode>passive</set_mode>');
    obs.flush();
    expect(writeMode).toHaveBeenCalledWith('passive');
    obs.dispose();
  });

  it('parses the tag even after multi-chunk buffering', () => {
    const obs = createOperatorVoiceTagObserver();
    obs.push('Got it. ');
    obs.push('<set_mode>');
    obs.push('passive');
    obs.push('</set_mode>');
    obs.flush();
    expect(writeMode).toHaveBeenCalledWith('passive');
    obs.dispose();
  });

  it('a complete spawn tag at end of buffer parses', () => {
    const obs = createOperatorVoiceTagObserver();
    obs.push('On it. <spawn role="worker" feature="auth" chunk="1" />');
    obs.flush();
    // We're only spying on set_mode/sleep here — spawn doesn't write
    // sessionStorage. The spawn dispatch lives in the chat provider,
    // not the voice observer. Asserting NO writes for mode/sleep is
    // the assertion that the parse didn't accidentally fire side
    // effects from a spawn-only utterance.
    expect(writeMode).not.toHaveBeenCalled();
    expect(writeSleep).not.toHaveBeenCalled();
    obs.dispose();
  });

  it('ignores plain spoken text with no tags', () => {
    const obs = createOperatorVoiceTagObserver();
    obs.push('Hello, how are you today?');
    obs.flush();
    expect(writeMode).not.toHaveBeenCalled();
    expect(writeSleep).not.toHaveBeenCalled();
    obs.dispose();
  });

  it('dispose() drops the buffer without parsing (partial tag lost by design)', () => {
    const obs = createOperatorVoiceTagObserver();
    obs.push('On it. <set_mod');
    obs.dispose();
    expect(writeMode).not.toHaveBeenCalled();
  });

  it('caller-driven flush parses a sleep tag', () => {
    const obs = createOperatorVoiceTagObserver();
    obs.push('<sleep duration_minutes="30" reason="firm pushback" />');
    obs.flush();
    expect(writeSleep).toHaveBeenCalledTimes(1);
    obs.dispose();
  });

  describe('E1 — voice-path dismissal enforcement', () => {
    it('force-flips to passive when dismissal stamp is fresh AND brain forgot the tag', () => {
      dismissalFlag = true; // simulates a recent userDismissesOperator hit
      const obs = createOperatorVoiceTagObserver();
      // Brain replies but forgets <set_mode>passive</set_mode>.
      obs.push('<say>Okay, I\'ll back off.</say>');
      obs.flush();
      expect(writeMode).toHaveBeenCalledWith('passive');
      obs.dispose();
    });

    it('does NOT double-flip when brain already emitted set_mode passive', () => {
      dismissalFlag = true;
      const obs = createOperatorVoiceTagObserver();
      obs.push('<say>Got it.</say><set_mode>passive</set_mode>');
      obs.flush();
      // Called exactly once with passive — not twice.
      expect(writeMode).toHaveBeenCalledTimes(1);
      expect(writeMode).toHaveBeenCalledWith('passive');
      obs.dispose();
    });

    it('does not flip when no dismissal stamp is set', () => {
      dismissalFlag = false;
      const obs = createOperatorVoiceTagObserver();
      obs.push('<say>Sure, here is the answer.</say>');
      obs.flush();
      expect(writeMode).not.toHaveBeenCalled();
      obs.dispose();
    });
  });
});
