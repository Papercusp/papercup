/**
 * check-conflict-markers-guard.test.ts — the committed-conflict-marker guard's
 * detector (EI-1836).
 *
 * The guard (`scripts/check-conflict-markers.mjs`) runs green over the real tracked
 * tree in CI, proving the no-FALSE-POSITIVE direction on the live corpus. This locks
 * the two things a clean-tree run can't prove:
 *   1. it FLAGS each git conflict BRACKET at line start (<<<, >>>, ||| diff3) — the
 *      2026-06-20 globals.css break that froze the whole fleet deploy + the WI-280
 *      witness on a cryptic CssSyntaxError;
 *   2. it does NOT false-positive on the shapes that look marker-ish but are valid —
 *      a bare `=======` separator (a 7-wide markdown setext underline is exactly
 *      that, so it is DELIBERATELY excluded; the brackets already catch every
 *      conflict), a too-short bracket run, a mid-line bracket, or normal code.
 *
 * Markers are built with `.repeat(7)` so this test's own source carries no
 * line-start bracket run — keeping the guard green on the test file itself.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its detector only.
import { findConflictMarker, CONFLICT_MARKER_ERE } from '../../../../scripts/check-conflict-markers.mjs';

const B = (c: string) => c.repeat(7); // a 7-char bracket run, without a literal marker here

describe('check-conflict-markers guard detector (EI-1836)', () => {
  it('FLAGS a <<< start marker (with the right line)', () => {
    const hit = findConflictMarker('f.css', `selector {}\n${B('<')} Updated upstream\ncolor: red;`);
    expect(hit).not.toBeNull();
    expect(hit.line).toBe(2);
    expect(hit.marker).toBe(B('<'));
  });

  it('FLAGS a >>> end marker', () => {
    expect(findConflictMarker('f.ts', `${B('>')} Stashed changes`)).toMatchObject({ line: 1 });
  });

  it('FLAGS a ||| diff3 base marker', () => {
    expect(findConflictMarker('f.ts', `a\nb\n${B('|')} base`)).toMatchObject({ line: 3 });
  });

  it('FLAGS a bare bracket run with no label (EOL)', () => {
    expect(findConflictMarker('f.ts', B('<'))).toMatchObject({ line: 1 });
  });

  it('does NOT flag a lone ======= separator (DELIBERATE exclusion — FP-prone)', () => {
    // A 7-wide markdown setext underline / ASCII divider is exactly `=======`; the
    // brackets above already catch every real conflict, so flagging it adds only FPs.
    expect(findConflictMarker('f.md', `Heading\n${B('=')}\nbody`)).toBeNull();
  });

  it('does NOT flag a too-short bracket run (6 < 7)', () => {
    expect(findConflictMarker('f.ts', `${'<'.repeat(6)} HEAD`)).toBeNull();
  });

  it('does NOT flag a mid-line bracket run', () => {
    expect(findConflictMarker('f.ts', `see ${B('<')} HEAD in a comment`)).toBeNull();
  });

  it('does NOT flag normal code / markdown (--- rule, >> shift, ## heading)', () => {
    expect(findConflictMarker('f.ts', '---\nconst x = a >> b;\n## Heading\n>>> not seven')).toBeNull();
  });

  it('returns the FIRST marker when several are present', () => {
    expect(findConflictMarker('f.ts', `x\n${B('<')} HEAD\ny\n${B('>')} branch`)).toMatchObject({ line: 2 });
  });

  it('the exported ERE compiles to a JS regex that agrees with the detector (single source of truth)', () => {
    // The CLI scan feeds git grep this ERE; the detector builds its RegExp from the
    // same string. Pin that they agree so the fast pre-filter can never diverge from
    // the precise check.
    const re = new RegExp(CONFLICT_MARKER_ERE);
    expect(re.test(`${B('<')} HEAD`)).toBe(true);
    expect(re.test(`${B('>')}`)).toBe(true);
    expect(re.test(B('='))).toBe(false); // separator excluded
    expect(re.test(`${'<'.repeat(6)} HEAD`)).toBe(false);
  });
});
