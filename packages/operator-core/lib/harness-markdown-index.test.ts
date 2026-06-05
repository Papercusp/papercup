/**
 * Coverage for harness-markdown-index.slugifyVditorAnchor — the Vditor anchor
 * slug rule (every non-alphanumeric char → a single '-'). Pure.
 */
import { describe, expect, it } from 'vitest';
import { slugifyVditorAnchor } from './harness-markdown-index';

describe('slugifyVditorAnchor', () => {
  it('replaces spaces with dashes', () => {
    expect(slugifyVditorAnchor('Hello World')).toBe('Hello-World');
  });
  it('replaces each punctuation char with its own dash', () => {
    expect(slugifyVditorAnchor('a.b/c:d')).toBe('a-b-c-d');
    expect(slugifyVditorAnchor('What? Now!')).toBe('What--Now-');
  });
  it('leaves alphanumerics untouched', () => {
    expect(slugifyVditorAnchor('Section123')).toBe('Section123');
  });
  it('returns empty for empty input', () => {
    expect(slugifyVditorAnchor('')).toBe('');
  });
});
