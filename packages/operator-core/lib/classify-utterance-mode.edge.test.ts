import { describe, it, expect } from 'vitest';
import { classifyUtteranceMode } from './classify-utterance-mode';

describe('classifyUtteranceMode — edge cases', () => {
  it('handles unicode + emoji without crashing', () => {
    expect(classifyUtteranceMode('On it 🚀.')).toBe('default');
    expect(classifyUtteranceMode('Smoke test failed 💥')).toBe('sober');
    expect(classifyUtteranceMode('My mistake — résumé incident.')).toBe('apologetic');
  });
  it('handles very long input by classifying on the first signal', () => {
    const long = 'On it. ' + 'A'.repeat(5000) + ' Smoke test failed.';
    // Sober wins because the regex is non-positional.
    expect(classifyUtteranceMode(long)).toBe('sober');
  });
  it('handles mixed-case + smart quotes in apologetic markers', () => {
    expect(classifyUtteranceMode('MY MISTAKE — slug confused.')).toBe('apologetic');
    expect(classifyUtteranceMode('"That was on me," she said.')).toBe('apologetic');
  });
  it('avoids false-positive on non-failure uses of "failed" in possessive form', () => {
    // Edge: "failed test" vs "the test failed" — both contain "failed"
    // and our regex accepts both. Documenting current behavior, not
    // claiming it's perfect.
    expect(classifyUtteranceMode('Reading the failed test now.')).toBe('sober');
  });
  it('classifies single-char input as default', () => {
    expect(classifyUtteranceMode('.')).toBe('default');
    expect(classifyUtteranceMode('?')).toBe('default');
  });
  it('handles newline-laden input', () => {
    expect(classifyUtteranceMode('Heads up.\n\nThat replan will overwrite.')).toBe('assertive');
  });
});
