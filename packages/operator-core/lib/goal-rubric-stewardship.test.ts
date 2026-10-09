import { describe, expect, it } from 'vitest';
import { classifyStewardshipCycle, type StewardshipCard, type StewardshipRepair } from './goal-rubric-stewardship';

const baseline = (): StewardshipCard => ({ issueId: 'EI-1', createdAt: '2026-10-09T10:00:00Z', createdBy: 'grader',
  rubricRef: 'quality', rubricRevision: 4, criteriaHash: 'same-criteria', subject: { kind: 'pot', ref: 'target' },
  ratings: { quality: { rating: 'fail', evidence: 'Confirmed failure', remediation: 'WI-12' } },
  settled: true, current: true, requiresIndependentAcceptance: true });
const regrade = (): StewardshipCard => ({ ...baseline(), issueId: 'EI-2', supersedes: 'EI-1',
  createdAt: '2026-10-09T12:00:00Z', ratings: { quality: { rating: 'pass', evidence: 'Independent rerun passed' } } });
const repair = (): StewardshipRepair => ({ id: 'WI-12', goalId: 'g', owner: 'builder',
  closedAt: '2026-10-09T11:00:00Z', verified: true });
const grade = (after = regrade(), before = baseline(), fixes = [repair()]) =>
  classifyStewardshipCycle('g', after, [before, after], fixes);

describe('goal rubric stewardship: verified improvement', () => {
  it('credits the linked comparable audited re-grade after verified independent repair', () => {
    expect(grade()).toMatchObject({ status: 'verified', baselineRef: 'EI-1', scorecardRef: 'EI-2', repairRefs: ['WI-12'] });
  });
  it.each([
    { rubricRevision: 5 }, { criteriaHash: 'changed' }, { subject: { kind: 'pot' as const, ref: 'other' } },
    { subject: { kind: 'plan' as const, ref: 'target' } }, { rubricRef: 'other' },
  ])('requires a fresh baseline when the comparison identity changes: %j', change => {
    expect(grade({ ...regrade(), ...change }).status).toBe('incomparable');
  });
  it.each([{ settled: false }, { current: false }])('never credits incomplete or stale evidence: %j', change => {
    expect(grade({ ...regrade(), ...change }).status).toBe('unverified');
  });
  it('does not accept foreign-goal, unverified or incorrectly ordered repairs', () => {
    for (const change of [{ goalId: 'foreign' }, { verified: false }, { closedAt: null },
      { closedAt: '2026-10-09T09:00:00Z' }, { closedAt: '2026-10-09T13:00:00Z' }]) {
      expect(grade(regrade(), baseline(), [{ ...repair(), ...change }]).status).toBe('unverified');
    }
  });
  it('requires an independent final grader where the rubric asks for one', () => {
    expect(grade({ ...regrade(), createdBy: 'builder' }).status).toBe('unverified');
    expect(grade({ ...regrade(), createdBy: 'builder', requiresIndependentAcceptance: false }).status).toBe('verified');
  });
  it('keeps unresolved and unknown re-grade criteria visible', () => {
    for (const rating of ['fail', 'partial', 'unknown']) {
      expect(grade({ ...regrade(), ratings: { quality: { rating, evidence: 'Measured' } } }).status).toBe('needs-repair');
    }
  });
  it('does not confuse a passing baseline, missing baseline or unlinked repair with improvement', () => {
    expect(classifyStewardshipCycle('g', { ...regrade(), supersedes: undefined }, [], []).status).toBe('baseline');
    expect(classifyStewardshipCycle('g', regrade(), [], [repair()]).status).toBe('unverified');
    expect(grade(regrade(), { ...baseline(), ratings: { quality: { rating: 'fail', evidence: 'No repair reference' } } }).status)
      .toBe('unverified');
  });
  it('separates repairs still open from verified repairs awaiting re-grade', () => {
    expect(classifyStewardshipCycle('g', baseline(), [], []).status).toBe('needs-repair');
    expect(classifyStewardshipCycle('g', baseline(), [], [repair()]).status).toBe('needs-regrade');
  });
});
