import { describe, it, expect } from 'vitest';
import {
  lintCarrySurfaceProvenance,
  provenanceLintField,
  PROVENANCE_LINT_NOTE,
} from './carry-surface-provenance-lint';

describe('lintCarrySurfaceProvenance', () => {
  it('is clean on empty / null / undefined text', () => {
    expect(lintCarrySurfaceProvenance('')).toEqual({ flagged: false, matches: [] });
    expect(lintCarrySurfaceProvenance(null)).toEqual({ flagged: false, matches: [] });
    expect(lintCarrySurfaceProvenance(undefined)).toEqual({ flagged: false, matches: [] });
  });

  it('is clean on ordinary progress-note prose with no attribution phrasing', () => {
    const text = 'Finished the migration, ran the affected suite (12/12 green), left the docs update for next wake.';
    expect(lintCarrySurfaceProvenance(text)).toEqual({ flagged: false, matches: [] });
  });

  it('flags an untagged "the owner said" imperative', () => {
    const r = lintCarrySurfaceProvenance('the owner said to hold off on deploying until Friday');
    expect(r.flagged).toBe(true);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].kind).toBe('owner-attribution');
  });

  it('flags "owner wants" / "owner approved" / "owner requires" variants', () => {
    expect(lintCarrySurfaceProvenance('owner wants this shipped dark for now').flagged).toBe(true);
    expect(lintCarrySurfaceProvenance('the owner approved the force-deploy').flagged).toBe(true);
    expect(lintCarrySurfaceProvenance('owner requires a second review before merge').flagged).toBe(true);
  });

  it('flags a bare "do not X until Y" gate imperative even without the word owner', () => {
    const r = lintCarrySurfaceProvenance('do NOT resolve WI-3532 until the UI pass is done');
    expect(r.flagged).toBe(true);
    expect(r.matches[0].kind).toBe('bare-gate-imperative');
  });

  it('does NOT flag when the line carries a NON-OWNER source tag', () => {
    expect(lintCarrySurfaceProvenance('[self-imposed] do not resolve WI-3532 until the UI pass is done').flagged).toBe(false);
    expect(lintCarrySurfaceProvenance('[peer:su-4dc3b] the owner approved this').flagged).toBe(false);
    expect(lintCarrySurfaceProvenance('[inferred] owner wants this merged').flagged).toBe(false);
  });

  // P-014 (deterministic-context-carry): manual [owner:…] tags are retired as
  // evidence — a turn ref is the verifiable anchor.
  it('P-014: a manual [owner:…] tag with NO turn ref is flagged manual-owner-tag', () => {
    const r = lintCarrySurfaceProvenance('[owner:jane 2026-07-10] the owner said to hold off until Friday');
    expect(r.flagged).toBe(true);
    expect(r.matches[0].kind).toBe('manual-owner-tag');
  });

  it('P-014: a [turn:<session>@<ts>] ref clears the line — with or without an owner tag', () => {
    expect(
      lintCarrySurfaceProvenance(
        '[owner:jane 2026-07-10] [turn:bf1881bc@2026-07-14T17:42:41.307Z] hold off until Friday',
      ).flagged,
    ).toBe(false);
    expect(
      lintCarrySurfaceProvenance('the owner said to ship dark [turn:bf1881bc@2026-07-14T17:42:41.307Z]').flagged,
    ).toBe(false);
  });

  it('is LINE-scoped: a tag on one line does not mask an untagged imperative on another', () => {
    const text = ['[self-imposed] finished the audit pass.', 'the owner said to skip the retro this week.'].join('\n');
    const r = lintCarrySurfaceProvenance(text);
    expect(r.flagged).toBe(true);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].line).toContain('the owner said to skip the retro this week.');
  });

  it('caps at MAX_MATCH_LINES (5) even when many lines match', () => {
    const text = Array.from({ length: 10 }, (_, i) => `the owner said item ${i} is done`).join('\n');
    const r = lintCarrySurfaceProvenance(text);
    expect(r.matches.length).toBe(5);
  });

  it('truncates an overlong matched line to 200 chars', () => {
    const long = 'the owner said ' + 'x'.repeat(500);
    const r = lintCarrySurfaceProvenance(long);
    expect(r.matches[0].line.length).toBe(200);
  });

  // EI-10994: complying with the bare-gate nudge (writing an explicit, source-tagged
  // PROVENANCE block that restates the imperative it attributes) must CLEAR the flag —
  // before the fix it re-fired on the original line AND on the block's own restatement line.
  it('EI-10994: an explicit source-tagged PROVENANCE block clears the bare-gate-imperative it attributes', () => {
    const text = [
      'do not widen the isCapacityError match until the SDK ships the typed error',
      '',
      "PROVENANCE: the 'do not widen isCapacityError until the SDK ships' constraint above",
      '  is [self-imposed] by su-eb9b7ae3 on 2026-07-13. It is NOT an owner directive.',
    ].join('\n');
    const r = lintCarrySurfaceProvenance(text);
    expect(r.flagged).toBe(false);
    expect(r.matches).toEqual([]);
  });

  it('EI-10994: a PROVENANCE block with NO source tag does not suppress — still nudges to tag it', () => {
    const text = [
      'do not resolve WI-3532 until the UI pass is done',
      'PROVENANCE: this constraint above — I forgot to actually tag it.',
    ].join('\n');
    const r = lintCarrySurfaceProvenance(text);
    expect(r.flagged).toBe(true);
    expect(r.matches.some((m) => m.kind === 'bare-gate-imperative')).toBe(true);
  });

  it('EI-10994: a tagged PROVENANCE block does not launder an affirmative "the owner said" claim on another line', () => {
    const text = [
      "PROVENANCE: the 'do not merge until review' gate is [self-imposed] by su-abc on 2026-07-13.",
      'the owner said to ship this dark',
    ].join('\n');
    const r = lintCarrySurfaceProvenance(text);
    expect(r.flagged).toBe(true);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].kind).toBe('owner-attribution');
    expect(r.matches[0].line).toContain('the owner said to ship this dark');
  });
});

describe('provenanceLintField', () => {
  it('returns undefined on a clean write (no noise on the common case)', () => {
    expect(provenanceLintField('routine progress note, nothing attributed')).toBeUndefined();
    expect(provenanceLintField(null)).toBeUndefined();
  });

  it('returns { flagged:true, note, matches } on a flagged write', () => {
    const field = provenanceLintField('the owner said to hold off until reviewed');
    expect(field).toBeDefined();
    expect(field?.flagged).toBe(true);
    expect(field?.note).toBe(PROVENANCE_LINT_NOTE);
    expect(field?.matches.length).toBeGreaterThan(0);
  });
});
