/**
 * buildBrainMessages — the pure context-builder for the voice host's brain call
 * (universal-voice-interface-2026-06-05, P-002). The host persists the user turn
 * from EL's `user_transcript` BEFORE the agent fires `ask_operator`, so the
 * spoken question is usually already the tail; we must not double it.
 */
import { describe, expect, it } from 'vitest';
import { buildBrainMessages } from './operator-voice-session-deps';

describe('buildBrainMessages', () => {
  it('keeps only non-empty user/assistant turns, in order', () => {
    const out = buildBrainMessages(
      [
        { role: 'user', text: 'hello' },
        { role: 'system', text: 'ignore me' },
        { role: 'assistant', text: 'hi' },
        { role: 'user', text: '   ' },
      ],
      'what next',
    );
    expect(out).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'what next' },
    ]);
  });

  it('does NOT re-append the question when it is already the tail (dedup)', () => {
    const out = buildBrainMessages(
      [
        { role: 'assistant', text: 'earlier' },
        { role: 'user', text: 'what is the status' },
      ],
      'what is the status',
    );
    expect(out).toEqual([
      { role: 'assistant', content: 'earlier' },
      { role: 'user', content: 'what is the status' },
    ]);
  });

  it('appends the question when the tail is an assistant turn', () => {
    const out = buildBrainMessages([{ role: 'assistant', text: 'go on' }], 'tell me more');
    expect(out).toEqual([
      { role: 'assistant', content: 'go on' },
      { role: 'user', content: 'tell me more' },
    ]);
  });

  it('dedups even with surrounding whitespace differences', () => {
    const out = buildBrainMessages([{ role: 'user', text: '  ping  ' }], 'ping');
    expect(out).toEqual([{ role: 'user', content: '  ping  ' }]);
  });

  it('handles an empty history + empty question', () => {
    expect(buildBrainMessages([], '')).toEqual([]);
    expect(buildBrainMessages([], 'solo')).toEqual([{ role: 'user', content: 'solo' }]);
  });
});
