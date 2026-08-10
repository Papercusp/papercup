/**
 * WI-37717 / WI-4978 — the papercupai-vs-Papercusp identity guard.
 *
 * `papercupai` is a GitHub USER; `Papercusp` is the org. The guard fails any doc
 * that calls papercupai an org. See scripts/check-github-identity-terms.mjs for
 * the full ground truth.
 *
 * What this file pins is the ESCAPE HATCH, added 2026-08-10. This guard quotes the
 * banned phrasing in its own header — which is exactly why its own source sits on
 * the guard's exclusion list — so a doc that must SAY the wrong phrase in order to
 * correct it is the guard's own phantom-offender class. Before the hatch, the only
 * way to write such a doc was to hard-code its path into the lint script: prose
 * could only justify itself by editing code. Measured at the time: all 3 near-miss
 * lines in the corpus sat in the single hard-coded exclusion.
 *
 * FALSIFIES = wrong answer without the hatch. ANCHOR = passes before AND after,
 * pinning that the hatch did not defeat the guard.
 */
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its pure detector. Kept on ONE line: @ts-ignore suppresses only the line that follows it, so a multi-line import leaves the module specifier unguarded and TS7016 reds the build.
import { MARKER_LOOKBACK, findOffenders } from '../../../../scripts/check-github-identity-terms.mjs';

const count = (text: string) => findOffenders(text).length;

describe('findOffenders — the rule still bites', () => {
  it('ANCHOR: the plain offending phrasing fails', () => {
    expect(count('The papercupai org owns the repos.')).toBe(1);
  });

  it('ANCHOR: the inverse word order fails', () => {
    expect(count('Members of the organization papercupai can publish.')).toBe(1);
  });

  it('ANCHOR: an innocent mention of the user is clean', () => {
    expect(count('The `papercupai` user is the maintainer login.')).toBe(0);
  });

  it('reports the 1-indexed line number of the offender', () => {
    expect(findOffenders('clean line\nThe papercupai org owns the repos.')).toEqual([
      { line: 2, text: 'The papercupai org owns the repos.' },
    ]);
  });
});

describe('findOffenders — the justification hatch', () => {
  it('FALSIFIES: a doc correcting the record can justify itself in place', () => {
    const text = [
      'github-identity-justified: correcting the record — quoting the wrong phrasing',
      'Any doc calling it the papercupai org is describing something that cannot exist.',
    ].join('\n');
    expect(count(text)).toBe(0);
  });

  it('FALSIFIES: the marker also counts on the SAME line', () => {
    expect(count('Do not say "the papercupai org". github-identity-justified: shows the banned phrasing')).toBe(0);
  });

  it('ANCHOR: a BARE marker with no reason does not silence it — an empty marker is just a mute button', () => {
    expect(count('github-identity-justified:\nThe papercupai org owns the repos.')).toBe(1);
  });

  it(`ANCHOR: a marker further than ${MARKER_LOOKBACK} lines above does not reach`, () => {
    const text = ['github-identity-justified: too far above', '', '', '', 'The papercupai org owns the repos.'].join('\n');
    expect(count(text)).toBe(1);
  });

  it('the marker reaches exactly MARKER_LOOKBACK lines above, and no further', () => {
    const marker = 'github-identity-justified: a reason';
    const offending = 'The papercupai org owns the repos.';
    const atLimit = [marker, ...Array(MARKER_LOOKBACK - 1).fill(''), offending].join('\n');
    const oneTooFar = [marker, ...Array(MARKER_LOOKBACK).fill(''), offending].join('\n');
    expect(count(atLimit)).toBe(0);
    expect(count(oneTooFar)).toBe(1);
  });
});

describe('import safety', () => {
  it('importing the guard does not run the scan (RUN_AS_MAIN entrypoint guard)', () => {
    // Reaching this assertion IS the test: without the guard, the import would
    // shell out to `git ls-files` and call process.exit(), killing the worker.
    expect(typeof findOffenders).toBe('function');
  });
});
