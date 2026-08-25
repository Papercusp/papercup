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
    expect(full).toContain("improvements:capture { lane:'observation', observation:{ rubricRef, ratings } }");
    expect(full).not.toContain('improvements:capture { rubricRef, ratings }');
    expect(full).toMatch(/EVIDENCE/);
    expect(full).toContain('blender:grade-idea');
  });

  it('varies the ideation lens across passes (cheap lens diversity)', () => {
    expect(full).toMatch(/[Vv]ary your\s+ideation lens/);
  });

  it('WI-5092: every mode mandates mode:set REGISTRATION on flip (an unregistered mode dies at the next compaction)', () => {
    // The audited gap: modes honored from directive text alone were never registered, so
    // peers/orient could not see them and a compaction / cold successor silently dropped
    // them. Each mode's Turning-ON paragraph now mandates the registry write.
    expect(full).toContain("mode:set { mode:'auto', reason, ownerDirected:true when the owner said it }");
    expect(full).toContain("mode:set { mode:'ideate', reason, ownerDirected }");
    expect(full).toContain("mode:set { mode:'drain', reason, ownerDirected }");
    expect(full).toMatch(/unregistered mode dies at the next compaction/);
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

  it('P-014 (su-ideate-learning-substrate): the full tier splices the su closed-loop ritual; fleet omits it', () => {
    // ground (ideation-feedback: grades + outcomes + lens win-rates + federated) → file lens-tagged
    // → route broad → close with a ledgered ideate-pass tick; grading wakes the originator.
    expect(full).toContain('blender:route-idea');
    expect(full).toContain('blender:ideate-pass-record');
    expect(full).toMatch(/WAKES its originator/);
    const fleet = renderModesPolicy('fleet');
    expect(fleet).not.toContain('blender:route-idea');
    expect(fleet).not.toContain('blender:ideate-pass-record');
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

describe('renderModesPolicy — anti-babysitting loop authority (WI-41514 / ABM-P002-PROMPT@1)', () => {
  const full = renderModesPolicy();
  const fleet = renderModesPolicy('fleet');

  it('FULL: only an explicit owner-authored ongoing objective gets the AUTO loop shortcut', () => {
    expect(full).toContain('An OWNER-AUTHORED OPEN-ENDED / ongoing directive');
    expect(full).toMatch(/Only an explicit objective authored by\s+the interactive owner qualifies/);
    expect(full).toMatch(/AUTO alone does not create a monitoring mission/);
    expect(full).toMatch(
      /self-authored or inherited\s+"monitor", "supervise", "evidence-only", or "keep watching" goal is not owner authorization/,
    );
  });

  it('FLEET: preserves assigned-work loops without licensing an invented monitoring mission', () => {
    expect(fleet).toContain('For assigned work that outlives this turn');
    expect(fleet).toMatch(/does not create permission to\s+invent a monitoring mission/);
    expect(fleet).toMatch(/Monitoring requires registered\s+work ownership \/ leadership/);
    expect(fleet).toMatch(
      /self-authored or inherited "monitor", "supervise",\s+"evidence-only", or "keep watching" goal never qualifies/,
    );
  });
});

describe('renderModesPolicy — DRAIN defect-filing exception (WI-38401)', () => {
  const full = renderModesPolicy();

  it('overrides unconditional suspected-defect filing without discarding useful evidence', () => {
    expect(full).toContain('DRAIN overrides the general file-every-suspected-bug rule');
    expect(full).toMatch(/do \*\*not\*\* mint an .*improvements:capture.*issue, work-item, or observation/s);
    expect(full).toMatch(/current drain item's checkpoint or\s+completion/);
  });

  it('permits exactly one linked record only for a direct drain blocker', () => {
    expect(full).toMatch(/directly blocks the scoped drain/);
    expect(full).toMatch(/file\s+exactly one blocker linked to the active drain item\/plan/);
    expect(full).toMatch(/does not directly\s+block the drain.*does not become a new queue row/s);
  });
});
