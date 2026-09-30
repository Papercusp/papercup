/**
 * D-041 (goal-agent-behavior-feedback-2026-09-06, R-18): filing is not disposing.
 *
 * Measured 6/6 in the S35 scenario: the su model filed an out-of-scope defect with no
 * `assign_to`, cited the new id only in `summary` or `deferred`, and closed with
 * `coverage.residue: []`. These tests pin the pure half (which cited refs count, and when)
 * and the grade (an unowned follow-up lowers `committed` to `proposed`, last in order).
 */
import { describe, expect, it } from 'vitest';

import {
  residueCitations,
  unownedResidueRefs,
  type ResidueCitations,
  type ResidueRefOwnership,
} from './coord-lifecycle/records';
import { authorityForCompletion, insufficientEvidenceReason } from './work-item-completion-authority';

const CLOSER = 'su-closer';
const TAKEN_AT = Date.parse('2026-09-30T01:00:00Z');
const open = (id: string, over: Partial<ResidueRefOwnership> = {}): ResidueRefOwnership => ({
  id, settled: false, assignee: null, createdBy: CLOSER, createdAtMs: TAKEN_AT + 60_000, ...over,
});
const judge = (cited: ResidueCitations, ownership: ResidueRefOwnership[]) =>
  unownedResidueRefs(cited, ownership, { ownerId: CLOSER, sinceMs: TAKEN_AT });

describe('residueCitations — every field that names a follow-up', () => {
  it('reads residue, deferred and requirementDisposition[].followUp, and keeps summary-only ids apart', () => {
    const cited = residueCitations(
      {
        residue: ['WI-1 widget-export'],
        deferred: ['filed as EI-2'],
        requirementDisposition: [{ followUp: 'WI-3' }, {}],
        summary: 'Closed WI-9. Filed WI-1 and WI-4.',
      },
      ['WI-9'],
    );
    expect(cited).toEqual({ followUps: ['WI-1', 'EI-2', 'WI-3'], summaryRefs: ['WI-4'] });
  });

  it('a close citing nothing yields nothing', () => {
    expect(residueCitations({ residue: [], summary: 'fixed it' })).toEqual({ followUps: [], summaryRefs: [] });
  });
});

describe('unownedResidueRefs', () => {
  it('flags an OPEN, UNASSIGNED follow-up cited in deferred (the measured 2/6 shape)', () => {
    expect(judge({ followUps: ['WI-1'], summaryRefs: [] }, [open('WI-1')])).toEqual(['WI-1']);
  });

  it('flags a summary-only id the closer filed during this work (the measured 4/6 shape)', () => {
    expect(judge({ followUps: [], summaryRefs: ['WI-4'] }, [open('WI-4')])).toEqual(['WI-4']);
  });

  it('calibration: assigned and settled follow-ups are silent', () => {
    const ownership = [open('WI-1', { assignee: 'su-owner' }), open('WI-2', { settled: true })];
    expect(judge({ followUps: ['WI-1', 'WI-2'], summaryRefs: [] }, ownership)).toEqual([]);
  });

  it('a summary id filed by someone else, or before the closer took the item, is history, not residue', () => {
    const ownership = [open('WI-5', { createdBy: 'su-other' }), open('WI-6', { createdAtMs: TAKEN_AT - 1 })];
    expect(judge({ followUps: [], summaryRefs: ['WI-5', 'WI-6'] }, ownership)).toEqual([]);
  });

  it('an id the store did not return is not judged', () => {
    expect(judge({ followUps: ['WI-7'], summaryRefs: [] }, [])).toEqual([]);
  });

  it('control: a guard reading only coverage.residue misses the measured close entirely', () => {
    // The deliberately-wrong implementation D-041 rules out, kept here so the reason the real
    // helper reads `deferred` and the summary stays falsifiable.
    const residueOnly = (input: Parameters<typeof residueCitations>[0]) =>
      residueCitations({ residue: input.residue });
    const measured = { residue: [], deferred: ['widget-export filed as WI-1'], summary: 'Filed WI-1.' };
    expect(judge(residueOnly(measured), [open('WI-1')])).toEqual([]);
    expect(judge(residueCitations(measured), [open('WI-1')])).toEqual(['WI-1']);
  });
});

describe('the grade', () => {
  const evidence = { verifiedHow: 'unit' as const, testsRun: 'widget-sync.test.ts', testResult: '8 passed' };

  it('an unowned follow-up lowers committed to proposed, with its own reason', () => {
    expect(authorityForCompletion(evidence)).toBe('committed');
    expect(authorityForCompletion(evidence, { residueUnowned: ['WI-1'] })).toBe('proposed');
    expect(insufficientEvidenceReason(evidence, { residueUnowned: ['WI-1'] })).toBe('residue-unowned');
  });

  it('is heard LAST: a finding about the work itself is named first', () => {
    expect(
      insufficientEvidenceReason(evidence, { residueUnowned: ['WI-1'], filesChangedNeverExisted: ['x.ts'] }),
    ).toBe('files-changed-never-existed');
  });

  it('an empty finding is no finding', () => {
    expect(authorityForCompletion(evidence, { residueUnowned: [] })).toBe('committed');
  });
});
