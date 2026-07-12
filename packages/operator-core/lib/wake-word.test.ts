import { describe, expect, it } from 'vitest';
import { stripWakeWordAndPrefix, matchWakePhrase } from './wake-word';

describe('stripWakeWordAndPrefix', () => {
  it('returns matched:false when wake word absent', () => {
    const r = stripWakeWordAndPrefix('the quick brown fox', 'hey operator');
    expect(r.matched).toBe(false);
    expect(r.dispatchText).toBe('');
  });

  it('strips wake word and prefixes "operator "', () => {
    const r = stripWakeWordAndPrefix('hey operator approve sheets', 'hey operator');
    expect(r.matched).toBe(true);
    expect(r.trailing).toBe('approve sheets');
    expect(r.dispatchText).toBe('operator approve sheets');
  });

  it('handles wake word case-insensitively', () => {
    const r = stripWakeWordAndPrefix('Hey Operator approve sheets', 'hey operator');
    expect(r.matched).toBe(true);
    expect(r.dispatchText).toBe('operator approve sheets');
  });

  it('does NOT double-prefix when trailing already starts with operator', () => {
    const r = stripWakeWordAndPrefix('hey operator open', 'hey');
    expect(r.dispatchText).toBe('operator open');
  });

  it('uses lastIndexOf so a leading filler does not break dispatch', () => {
    const r = stripWakeWordAndPrefix('uh hey operator scan', 'hey operator');
    expect(r.dispatchText).toBe('operator scan');
  });

  it('returns empty dispatchText when only the wake word was spoken', () => {
    const r = stripWakeWordAndPrefix('hey operator', 'hey operator');
    expect(r.matched).toBe(true);
    expect(r.dispatchText).toBe('');
    expect(r.trailing).toBe('');
  });

  it('preserves multi-word intent payloads (approve <slug> <cap>)', () => {
    const r = stripWakeWordAndPrefix('hey operator approve sheets http fetch', 'hey operator');
    expect(r.dispatchText).toBe('operator approve sheets http fetch');
  });

  it('handles "across workspaces" multi-word intent', () => {
    const r = stripWakeWordAndPrefix('hey operator across workspaces', 'hey operator');
    expect(r.dispatchText).toBe('operator across workspaces');
  });
});

// Fuzzy wake-phrase matcher for the always-on gate
// (voice-public-release-readiness-2026-07-12 P-004). Whisper punctuates
// unpredictably, so the matcher must tolerate punctuation/spacing/case and
// both brand spellings.
describe('matchWakePhrase', () => {
  it('matches the plain phrase and returns the trailing command', () => {
    const r = matchWakePhrase('hey papercup open the dashboard');
    expect(r.matched).toBe(true);
    expect(r.trailing).toBe('open the dashboard');
  });

  it('tolerates whisper punctuation and casing', () => {
    const r = matchWakePhrase("Hey, Papercup. What's the status?");
    expect(r.matched).toBe(true);
    expect(r.trailing).toBe("What's the status?");
  });

  it('tolerates the split "paper cup" rendering', () => {
    const r = matchWakePhrase('okay paper cup stop the build');
    expect(r.matched).toBe(true);
    expect(r.trailing).toBe('stop the build');
  });

  it('accepts the papercusp brand spelling', () => {
    const r = matchWakePhrase('Hey Papercusp, list my plans');
    expect(r.matched).toBe(true);
    expect(r.trailing).toBe('list my plans');
  });

  it('accepts ok/okay lead-ins (backtracks past the ok-prefix)', () => {
    expect(matchWakePhrase('ok papercup do it').matched).toBe(true);
    expect(matchWakePhrase('okay papercup do it').matched).toBe(true);
  });

  it('a bare wake returns matched with empty trailing', () => {
    const r = matchWakePhrase('Hey Papercup!');
    expect(r.matched).toBe(true);
    expect(r.trailing).toBe('');
  });

  it('does NOT match ambient speech mentioning a paper cup', () => {
    expect(matchWakePhrase('the paper cup fell off the table').matched).toBe(false);
  });

  it('does NOT match the phrase mid-sentence (must be a prefix)', () => {
    expect(matchWakePhrase('I said hey papercup earlier today').matched).toBe(false);
  });

  it('does NOT match an unrelated transcript', () => {
    expect(matchWakePhrase('what is the weather like').matched).toBe(false);
    expect(matchWakePhrase('').matched).toBe(false);
  });
});
