import { describe, it, expect } from 'vitest';
import { humanizeCapabilityId, shorten } from './format';

describe('humanizeCapabilityId — group separator split', () => {
  it("splits on ':' into 'Group: Verb'", () => {
    expect(humanizeCapabilityId('goals:list')).toBe('Goals: List');
  });

  it("splits on '.' into 'Group: Verb'", () => {
    expect(humanizeCapabilityId('panel.toggle')).toBe('Panel: Toggle');
  });

  it("prefers ':' over '.' when both are present (the group is everything before the first ':')", () => {
    // sep is ':' → group is 'nav.settings'. titleCaseWords only expands [-_], NOT '.',
    // so the dot survives; \b\w then upper-cases the letter after it ('.s' → '.S').
    expect(humanizeCapabilityId('nav.settings:open')).toBe('Nav.Settings: Open');
  });

  it('a bare verb with no separator has no namespace qualifier', () => {
    expect(humanizeCapabilityId('list_workspaces')).toBe('List Workspaces');
  });

  it("splits the group on the FIRST ':' — a later ':' stays in the verb (and is a word boundary)", () => {
    // verb is 'b:c'; ':' is a \b word boundary, so \b\w upper-cases the 'c' too.
    expect(humanizeCapabilityId('a:b:c')).toBe('A: B:C');
  });
});

describe('humanizeCapabilityId — title-casing of - / _ segments', () => {
  it('title-cases underscore-separated verb words', () => {
    expect(humanizeCapabilityId('papercusp:list_workspaces')).toBe('Papercusp: List Workspaces');
  });

  it('title-cases hyphen-separated words', () => {
    expect(humanizeCapabilityId('agent-tools:declare-intent')).toBe('Agent Tools: Declare Intent');
  });

  it('title-cases a mix of - and _ in a separator-less id', () => {
    expect(humanizeCapabilityId('do_a-thing')).toBe('Do A Thing');
  });

  it('upper-cases the first letter of each word, leaving the rest untouched', () => {
    // \b\w only touches the first char of each word; an already-capitalised tail is preserved.
    expect(humanizeCapabilityId('list_APIs')).toBe('List APIs');
  });
});

describe('humanizeCapabilityId — degenerate group/verb', () => {
  it("an empty group ('') falls back to just the verb", () => {
    // group is '' → g is falsy → returns v.
    expect(humanizeCapabilityId(':list')).toBe('List');
  });

  it('an empty verb falls back to just the group', () => {
    // verb is '' → v is falsy → returns g.
    expect(humanizeCapabilityId('goals:')).toBe('Goals');
  });

  it("a lone ':' yields an empty string (both segments empty)", () => {
    expect(humanizeCapabilityId(':')).toBe('');
  });
});

describe('shorten', () => {
  it('returns "" for undefined or empty input', () => {
    expect(shorten(undefined)).toBe('');
    expect(shorten('')).toBe('');
  });

  it('collapses internal whitespace runs (incl. newlines/tabs) to single spaces and trims', () => {
    expect(shorten('  a\t\t b \n\n c  ')).toBe('a b c');
  });

  it('returns the one-lined text unchanged when within max', () => {
    expect(shorten('short text', 90)).toBe('short text');
  });

  it('leaves text exactly AT max untouched (boundary: length === max is not > max)', () => {
    const exact = 'x'.repeat(10);
    expect(shorten(exact, 10)).toBe(exact);
    expect(shorten(exact, 10)).toHaveLength(10);
  });

  it('ellipsises text one over max — result length is exactly max, ending in the ellipsis char', () => {
    const over = 'x'.repeat(11);
    const out = shorten(over, 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith('…')).toBe(true);
    // 9 retained x's + the single ellipsis glyph.
    expect(out).toBe(`${'x'.repeat(9)}…`);
  });

  it('trims trailing whitespace at the cut boundary before appending the ellipsis', () => {
    // After collapse: "aaaaaaaaa b ccc" (15 chars). max=11 → slice(0,10)="aaaaaaaaa " → trimEnd → "aaaaaaaaa".
    const out = shorten('aaaaaaaaa b ccc', 11);
    expect(out).toBe('aaaaaaaaa…');
    expect(out).not.toContain(' …'); // no dangling space before the ellipsis
  });

  it('defaults max to 90', () => {
    const long = 'y'.repeat(200);
    const out = shorten(long);
    expect(out).toHaveLength(90);
    expect(out.endsWith('…')).toBe(true);
  });
});
