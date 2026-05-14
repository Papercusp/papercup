import { describe, expect, it } from 'vitest';

import { isDeclinePhrase, listDeclinePhrases, normalize } from './decline-phrases';

describe('decline-phrases', () => {
  it('normalize lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalize('  Cancel.  ')).toBe('cancel');
    expect(normalize("Never, mind!")).toBe('never mind');
    expect(normalize('No thanks!')).toBe('no thanks');
  });

  it('isDeclinePhrase matches exactly on normalized input', () => {
    for (const p of listDeclinePhrases()) {
      expect(isDeclinePhrase(p)).toBe(true);
    }
  });

  it('isDeclinePhrase rejects partial / wrong matches', () => {
    expect(isDeclinePhrase('skip this step')).toBe(false);
    expect(isDeclinePhrase('cancel the order')).toBe(false);
    expect(isDeclinePhrase('')).toBe(false);
    expect(isDeclinePhrase('yes')).toBe(false);
  });

  it('"never mind" and "nevermind" are both accepted', () => {
    expect(isDeclinePhrase('never mind')).toBe(true);
    expect(isDeclinePhrase('nevermind')).toBe(true);
  });

  it('punctuation in raw input becomes a clean decline match', () => {
    expect(isDeclinePhrase(normalize("Forget it!"))).toBe(true);
  });

  it('caller is responsible for normalize() — raw "Skip" does not match', () => {
    expect(isDeclinePhrase('Skip')).toBe(false);
    expect(isDeclinePhrase(normalize('Skip'))).toBe(true);
  });
});
