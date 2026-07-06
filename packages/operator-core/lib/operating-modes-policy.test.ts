/**
 * Guards on the rendered operating-modes clause (renderModesPolicy).
 *
 * su-loop-capability-parity-2026-07-03:
 *   - P-004: the IDEATE pre-pass grounds in the shared substrate (curation:state-of-pot,
 *     rubrics/scorecards, own graded proposals), files rubric-graded observations, grades
 *     Scout-routed ideas, and varies the ideation lens — WITHOUT gating filing.
 *   - D-005: the "no quality gate and no quota — file freely" owner directive survives
 *     verbatim; rubrics ENRICH, never filter.
 */
import { describe, it, expect } from 'vitest';
import { renderModesPolicy } from './operating-modes-policy';

describe('renderModesPolicy — IDEATE grounding pre-pass (P-004)', () => {
  const full = renderModesPolicy();

  it('grounds each pass in the shared substrate (the reads Scout/Queen already use)', () => {
    expect(full).toContain('curation:state-of-pot');
    expect(full).toContain('rubrics:list');
    expect(full).toContain('rubrics:search');
    expect(full).toContain('scorecards:freshness');
  });

  it('files rubric-graded observations with evidence + grades Scout-routed ideas', () => {
    expect(full).toContain('rubricRef');
    expect(full).toMatch(/EVIDENCE/);
    expect(full).toContain('blender:grade-idea');
  });

  it('varies the ideation lens across passes (cheap lens diversity)', () => {
    expect(full).toMatch(/[Vv]ary your\s+ideation lens/);
  });

  it('D-005: preserves "no quality gate and no quota — file freely" VERBATIM', () => {
    expect(full).toContain('there is no quality gate and no quota');
    expect(full).toContain('File\n  freely; the owner reviews the history.');
  });

  it('D-005: rubrics ENRICH ideation, never gate/filter it', () => {
    expect(full).toMatch(/ENRICHES ideation/);
    expect(full).toMatch(/never.*(gate|suppress).*filing|filing stays free/s);
  });

  it('the fleet tier stays IDEATE-free (grounding is a leader/interactive posture)', () => {
    const fleet = renderModesPolicy('fleet');
    expect(fleet).not.toContain('IDEATE');
    expect(fleet).not.toContain('curation:state-of-pot');
    expect(fleet).not.toContain('blender:grade-idea');
  });
});

describe('renderModesPolicy — SU zero-pauses AUTO clause (P-014)', () => {
  const full = renderModesPolicy();
  const fleet = renderModesPolicy('fleet');

  it('FULL: the only stop is the anti-footgun peer-data rail, framed as data-integrity not permission', () => {
    // No "STOP and ask" for irreversible/outward actions — those PROCEED + DISCLOSE now.
    expect(full).toMatch(/PROCEED and DISCLOSE it/);
    expect(full).toMatch(/anti-footgun rail/);
    expect(full).toMatch(/ANOTHER agent's UNCOMMITTED work/);
    expect(full).toMatch(/NOT an owner-permission pause/);
    // The old "irreversible + high-stakes OUTSIDE the work → stop" brake is gone.
    expect(full).not.toMatch(/prefer a reversible path; stop only if\s+there is truly none/);
  });

  it('FULL: even irreversible / outward / privilege actions are proceed-and-disclose, not gated', () => {
    expect(full).toMatch(/privilege-escalation action/);
    expect(full).toMatch(/irreversible\s*\/\s*outward-facing\s*\/\s*destructive/);
    expect(full).toMatch(/Your OWN\s+irreversible\/outward\/privilege actions are yours to take \+ disclose/);
  });

  it('FLEET: same — anti-footgun rail is the only brake; everything else proceeds + discloses', () => {
    expect(fleet).toMatch(/anti-footgun rail/);
    expect(fleet).toMatch(/NEVER pause to ask the owner/);
    expect(fleet).toMatch(/zero owner-confirm pauses/);
    // The old numbered "(1) irreversible + high-stakes OUTSIDE your assigned work" brake is gone.
    expect(fleet).not.toMatch(/IRREVERSIBLE \+ HIGH-STAKES action OUTSIDE your assigned/);
  });

  it('preserves the anti-footgun git rail specifics in both tiers (the ONE thing kept)', () => {
    for (const clause of [full, fleet]) {
      expect(clause).toMatch(/reset --hard/);
      expect(clause).toMatch(/clean -fd/);
    }
  });
});
