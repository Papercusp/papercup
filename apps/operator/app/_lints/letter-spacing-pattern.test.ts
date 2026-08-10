/**
 * The extracted banned-letter-spacing matcher must still FIRE (EI-20023819609804890).
 *
 * WHY THIS SUITE IS NOT OPTIONAL. The matcher was lifted out of design-primitives.test.ts
 * so the edit-time hook could share one definition. But that lint is GREEN right now (the
 * third hud.css offender was fixed hours ago), so a botched extraction — a dropped flag, a
 * mangled lookahead, an import resolving to undefined — would leave it green too. "The
 * lint still passes" is therefore NOT evidence the extraction preserved behaviour; it is
 * the same zero-work false-green shape CLAUDE.md documents for `tsc -p .` and a `-t` filter
 * that matches nothing. These cases are the evidence instead.
 */
import { describe, it, expect } from 'vitest';
import {
  findNonzeroLetterSpacing,
  nonzeroLetterSpacingRe,
  stripCssComments,
} from './letter-spacing-pattern.mjs';

describe('nonzeroLetterSpacingRe', () => {
  it('catches the exact declaration that red-pinned the fleet 3x', () => {
    // Verbatim shape of the hud.css offender (.hud-goal-composer__label).
    expect(findNonzeroLetterSpacing('.x { letter-spacing: 0.04em; }')).toHaveLength(1);
  });

  it.each([
    ['em', '.x { letter-spacing: 0.09em; }'],
    ['px', '.x { letter-spacing: 2px; }'],
    ['rem', '.x { letter-spacing: 0.1rem; }'],
    ['unitless nonzero', '.x { letter-spacing: 1; }'],
    ['JSX camelCase', 'style={{ letterSpacing: "0.04em" }}'],
    ['!important', '.x { letter-spacing: 0.04em !important; }'],
  ])('catches %s', (_label, src) => {
    expect(findNonzeroLetterSpacing(src).length).toBeGreaterThan(0);
  });

  it.each([
    ['bare zero', '.x { letter-spacing: 0; }'],
    ['zero !important', '.x { letter-spacing: 0 !important; }'],
    ['zero at end of input', '.x { letter-spacing: 0'],
    ['camelCase zero', 'style={{ letterSpacing: 0 }}'],
  ])('does NOT catch the compliant form: %s', (_label, src) => {
    // The negative lookahead is the whole point — lose it and every compliant
    // declaration in the tree becomes an offender.
    expect(findNonzeroLetterSpacing(src)).toEqual([]);
  });

  it('returns a FRESH regex each call — a shared /g instance silently skips offenders', () => {
    const a = nonzeroLetterSpacingRe();
    expect(a).not.toBe(nonzeroLetterSpacingRe());
    a.exec('.x { letter-spacing: 0.04em; }'); // advances lastIndex
    expect(a.lastIndex).toBeGreaterThan(0);
    expect(nonzeroLetterSpacingRe().lastIndex).toBe(0);
  });

  it('reports truthful 1-based line numbers', () => {
    const found = findNonzeroLetterSpacing('a{}\nb{}\n.x { letter-spacing: 0.04em; }');
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(3);
  });
});

describe('stripCssComments (load-bearing, not hygiene)', () => {
  it('does NOT flag a banned value quoted inside a warning comment', () => {
    // hud.css:564 literally contains this text while being compliant. Matching raw
    // text would make the file's own warning comments its top offenders — firing
    // hardest on the best-documented file.
    const src = `/* The previous treatment used letter-spacing:0.09em and redded the lint. */
.x { letter-spacing: 0; }`;
    expect(findNonzeroLetterSpacing(src)).toEqual([]);
  });

  it('still flags a real offender sitting next to such a comment', () => {
    // The control for the case above: stripping must not swallow live code.
    const src = `/* no tracking: letter-spacing:0.09em was removed here */
.x { letter-spacing: 0.04em; }`;
    expect(findNonzeroLetterSpacing(src)).toHaveLength(1);
  });

  it('preserves newlines so line numbers survive stripping', () => {
    expect(stripCssComments('/* a\nb\nc */x')).toBe('    \n \n    x');
  });
});
