/**
 * insight-normative.test.ts — the `normative: true ⇒ governs` detector
 * (unified-agent-state-plane-2026-07-27 P-022, per D-028).
 *
 * Pure-string tests (the detector touches no fs) — the live-corpus
 * no-false-positive proof is `scripts/check-insight-normative.mjs` running
 * green in CI, mirroring how insight-citations is proven.
 */
import { describe, it, expect } from 'vitest';
import { findNormativeViolations, formatNormativeViolations } from './insight-normative';

const doc = (frontmatter: string, body = '# Hi\n') => `---\n${frontmatter}\n---\n\n${body}`;

describe('findNormativeViolations', () => {
  it('returns [] for a doc with no frontmatter at all', () => {
    expect(findNormativeViolations('# just a body\n')).toEqual([]);
  });

  it('returns [] for an UNMARKED explanatory doc — the lint never forces opt-in', () => {
    expect(findNormativeViolations(doc('title: x\ntags: [runbook, debugging]'))).toEqual([]);
  });

  it('returns [] for `normative: false`', () => {
    expect(findNormativeViolations(doc('title: x\nnormative: false'))).toEqual([]);
  });

  it('FLAGS `normative: true` with no `governs:` at all', () => {
    expect(findNormativeViolations(doc('title: x\nnormative: true'))).toEqual([
      { kind: 'missing-governs' },
    ]);
  });

  it('FLAGS `normative: true` with an EMPTY `governs:`', () => {
    expect(findNormativeViolations(doc('title: x\nnormative: true\ngoverns:'))).toEqual([
      { kind: 'missing-governs' },
    ]);
  });

  it('accepts `governs:` as an INLINE array (the `tags:` style)', () => {
    expect(
      findNormativeViolations(doc('title: x\nnormative: true\ngoverns: [editing a migration]')),
    ).toEqual([]);
  });

  it('accepts `governs:` as a BLOCK list — the corpus DOMINANT style (572/625 docs)', () => {
    const body = doc('title: x\nnormative: true\ngoverns:\n  - editing a migration\n  - adding a tool');
    expect(findNormativeViolations(body)).toEqual([]);
  });

  it('accepts `governs:` as a plain scalar', () => {
    expect(findNormativeViolations(doc('title: x\nnormative: true\ngoverns: editing a plan'))).toEqual(
      [],
    );
  });

  it('does NOT accept a block list of empty entries as a declared `governs:`', () => {
    // `governs:` followed immediately by the next key parses to '' — still absent.
    const body = doc('title: x\nnormative: true\ngoverns:\ntags: [runbook]');
    expect(findNormativeViolations(body)).toEqual([{ kind: 'missing-governs' }]);
  });

  it('is case-insensitive about the `normative:` value', () => {
    expect(findNormativeViolations(doc('title: x\nnormative: TRUE'))).toEqual([
      { kind: 'missing-governs' },
    ]);
    expect(findNormativeViolations(doc('title: x\nnormative: False'))).toEqual([]);
  });

  it('FLAGS a `normative:` value that is neither true nor false', () => {
    expect(findNormativeViolations(doc('title: x\nnormative: maybe'))).toEqual([
      { kind: 'invalid-normative', value: 'maybe' },
    ]);
  });

  it('ignores `governs:` on a doc that never claims to be normative', () => {
    expect(findNormativeViolations(doc('title: x\ngoverns: [something]'))).toEqual([]);
  });
});

describe('formatNormativeViolations', () => {
  it('returns null for an empty list', () => {
    expect(formatNormativeViolations([])).toBeNull();
  });

  it('names the missing field and what it is for', () => {
    const msg = formatNormativeViolations([{ kind: 'missing-governs' }]);
    expect(msg).toContain('governs');
    expect(msg).toMatch(/trigger\/surface/i);
  });

  it('echoes the offending value for an invalid `normative:`', () => {
    const msg = formatNormativeViolations([{ kind: 'invalid-normative', value: 'yes' }]);
    expect(msg).toContain('yes');
  });
});
