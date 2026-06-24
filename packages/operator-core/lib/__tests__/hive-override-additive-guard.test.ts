/**
 * Tests for the additive-override guard (owner directive 2026-06-24): a hive prompt
 * override must ADD hive-specifics, not re-state generated-base content.
 */
import { describe, it, expect } from 'vitest';
import {
  detectGeneratedBaseOverlap,
  additiveOverrideWarning,
} from '../hive-override-additive-guard';

describe('hive-override-additive-guard', () => {
  it('a purely-additive override → no overlap, no warning', () => {
    const md = [
      '# Papercusp — instance operational guide (su)',
      '',
      '## Orientation: what Papercusp is',
      'A multi-agent coding platform run locally…',
      '',
      '## The workspace map',
      '- canonical tree at …/papercup (branch staging)',
      '',
      '## Named workflows',
      'What is the state of X → harness:list → …',
    ].join('\n');
    const overlap = detectGeneratedBaseOverlap(md);
    expect(overlap.headings).toEqual([]);
    expect(overlap.hasGeneratedMarker).toBe(false);
    expect(additiveOverrideWarning(md)).toBeNull();
  });

  it('an override that re-states a base-owned section (AUTO mode) → flagged', () => {
    const md = [
      '## Orientation: what Papercusp is',
      'hive-specific stuff…',
      '',
      '## AUTO mode — the owner\'s switch for "act, don\'t ask"',
      'When the owner says AUTO mode…',
    ].join('\n');
    const overlap = detectGeneratedBaseOverlap(md);
    expect(overlap.headings).toContain('AUTO mode');
    const warning = additiveOverrideWarning(md);
    expect(warning).toMatch(/AUTO mode/);
    expect(warning).toMatch(/ADDITIVE/);
  });

  it('an override embedding a generated splice marker → flagged', () => {
    const md = '## Orientation\nfoo\n\n<!-- PAPERCUSP-SU:AUTO-MODE -->\n';
    const overlap = detectGeneratedBaseOverlap(md);
    expect(overlap.hasGeneratedMarker).toBe(true);
    expect(additiveOverrideWarning(md)).toMatch(/generated splice marker/);
  });

  it('a wholesale base snapshot (multiple base sections) → flagged with all overlaps', () => {
    const md = [
      '## Who you are',
      'You are a senior engineer-collaborator…',
      '## Engineering discipline',
      'Plan before non-trivial work…',
      '## Wire schemas',
      'read → headerless CSV…',
    ].join('\n');
    const overlap = detectGeneratedBaseOverlap(md);
    expect(overlap.headings).toEqual(
      expect.arrayContaining(['Who you are', 'Engineering discipline', 'Wire schemas']),
    );
  });
});
