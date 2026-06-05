/**
 * Coverage for shortcut-match: the combo parser + matcher core. Pure logic —
 * KeyboardEvents are plain objects with the read fields. Runs in the bare node
 * env, so navigator is absent → isMac=false → `mod` resolves to Ctrl.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { parseCombo, stepMatches, tryMatch, _resetSequenceState } from './shortcut-match';

const ev = (key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }) as KeyboardEvent;

beforeEach(() => _resetSequenceState());

describe('parseCombo', () => {
  it('parses modifiers + a normalized key', () => {
    expect(parseCombo('mod+shift+p')).toEqual({
      alternates: [{ steps: [{ key: 'p', mod: true, shift: true }] }],
    });
  });
  it('splits comma alternates and > sequences', () => {
    expect(parseCombo('a, b').alternates).toHaveLength(2);
    expect(parseCombo('g>d').alternates[0].steps).toHaveLength(2);
  });
  it('normalizes special key names', () => {
    expect(parseCombo('slash').alternates[0].steps[0].key).toBe('/');
    expect(parseCombo('Enter').alternates[0].steps[0].key).toBe('Enter');
    expect(parseCombo('f5').alternates[0].steps[0].key).toBe('F5');
    expect(parseCombo('space').alternates[0].steps[0].key).toBe(' ');
  });
});

describe('stepMatches', () => {
  const step = (raw: string) => parseCombo(raw).alternates[0].steps[0];

  it('matches mod+key against Ctrl on non-Mac', () => {
    expect(stepMatches(step('mod+k'), ev('k', { ctrlKey: true }))).toBe(true);
    expect(stepMatches(step('mod+k'), ev('k'))).toBe(false); // no ctrl
  });

  it('rejects an unmodified binding when Ctrl/Meta is held', () => {
    expect(stepMatches(step('j'), ev('j'))).toBe(true);
    expect(stepMatches(step('j'), ev('j', { ctrlKey: true }))).toBe(false);
  });

  it('matches a shifted-variant key (shift+slash → "?")', () => {
    expect(stepMatches(step('shift+slash'), ev('?', { shiftKey: true }))).toBe(true);
  });

  it('rejects an unmodified letter when Shift is held (Shift+J ≠ j)', () => {
    expect(stepMatches(step('j'), ev('J', { shiftKey: true }))).toBe(false);
  });

  it('is case-insensitive for single chars', () => {
    expect(stepMatches(step('k'), ev('K'))).toBe(true);
  });
});

describe('tryMatch — single + sequence', () => {
  it('fires a single-step combo immediately', () => {
    expect(tryMatch('c1', parseCombo('mod+k'), ev('k', { ctrlKey: true }))).toBe(true);
  });

  it('fires a g>d sequence only after both steps', () => {
    const combo = parseCombo('g>d');
    expect(tryMatch('seq', combo, ev('g'))).toBe(false); // first step advances, not complete
    expect(tryMatch('seq', combo, ev('d'))).toBe(true); // completes
  });

  it('a wrong second key aborts the sequence', () => {
    const combo = parseCombo('g>d');
    expect(tryMatch('seq2', combo, ev('g'))).toBe(false);
    expect(tryMatch('seq2', combo, ev('x'))).toBe(false); // not 'd' → reset, no fire
    expect(tryMatch('seq2', combo, ev('d'))).toBe(false); // depth was reset, 'd' isn't step 0
  });

  it('matches any of comma-separated alternates', () => {
    const combo = parseCombo('mod+p, mod+k');
    expect(tryMatch('alt', combo, ev('k', { ctrlKey: true }))).toBe(true);
    expect(tryMatch('alt', combo, ev('p', { ctrlKey: true }))).toBe(true);
  });
});
