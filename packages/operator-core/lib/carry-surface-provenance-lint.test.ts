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

  it('does NOT flag when the line already carries a recognized source tag', () => {
    expect(lintCarrySurfaceProvenance('[owner:avi 2026-07-10] the owner said to hold off until Friday').flagged).toBe(false);
    expect(lintCarrySurfaceProvenance('[self-imposed] do not resolve WI-3532 until the UI pass is done').flagged).toBe(false);
    expect(lintCarrySurfaceProvenance('[peer:su-4dc3b] the owner approved this').flagged).toBe(false);
    expect(lintCarrySurfaceProvenance('[inferred] owner wants this merged').flagged).toBe(false);
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
