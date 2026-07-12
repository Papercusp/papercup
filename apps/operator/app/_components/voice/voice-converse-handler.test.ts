/**
 * voice-converse-handler — the module-level seam that routes voice-IN into the
 * in-process Papercup converse brain (plan voice-public-release-readiness P-001 /
 * D-001). Verifies the register/submit/degrade contract that replaces the retired
 * writeToSentinelPane dock path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setVoiceConverseHandler,
  hasVoiceConverseHandler,
  submitVoiceTurn,
} from './voice-converse-handler';

afterEach(() => {
  // Module-level singleton — reset so tests don't leak the handler into each other.
  setVoiceConverseHandler(null);
});

describe('voice-converse-handler', () => {
  it('no handler registered → submitVoiceTurn returns false (caller degrades) and speaks nothing', () => {
    expect(hasVoiceConverseHandler()).toBe(false);
    expect(submitVoiceTurn('hello there')).toBe(false);
  });

  it('registered handler receives the trimmed transcript with spoken:true', () => {
    const handler = vi.fn();
    setVoiceConverseHandler(handler);
    expect(hasVoiceConverseHandler()).toBe(true);

    expect(submitVoiceTurn('  what is the fleet doing  ')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('what is the fleet doing', { spoken: true });
  });

  it('blank / whitespace-only transcript is dropped (no turn submitted)', () => {
    const handler = vi.fn();
    setVoiceConverseHandler(handler);
    expect(submitVoiceTurn('   ')).toBe(false);
    expect(submitVoiceTurn('')).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('clearing the handler (unmount) makes submit degrade again', () => {
    const handler = vi.fn();
    setVoiceConverseHandler(handler);
    expect(submitVoiceTurn('one')).toBe(true);

    setVoiceConverseHandler(null);
    expect(hasVoiceConverseHandler()).toBe(false);
    expect(submitVoiceTurn('two')).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1); // only the first turn landed
  });
});
