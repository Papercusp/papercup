import { describe, expect, it } from 'vitest';

import {
  ADMISSION_GIT_DATE,
  ADMISSION_GIT_DATE_MS,
  isAdmissionSyntheticCommitDate,
} from './admission-commit-date';
import { measureCandidateStaleness } from '../harness/routines/release-actions';

/**
 * WI-10002121. A repair-queue admission commit carries a FIXED date so its dry-run preview and its
 * confirmed write hash identically. That date is a sentinel, not a measurement — and under
 * freeze-and-converge the judged candidate IS an admission commit, so anything that reads it as a
 * real committer date computes a ~26.7-year age for a commit made minutes ago. Measured live
 * 2026-09-23: the gate's CANDIDATE-FOSSIL rule reported "judged a commit that was ALREADY
 * 234291.7h old", suppressing every repairHead verdict as unreliable.
 */
describe('admission commit date is a sentinel, never an age', () => {
  it('recognises the spelling git ACTUALLY emits, not just the constant', () => {
    // The whole bug lives in this gap. `git log -1 --format=%cI` renders the admission date as
    // `2000-01-01T00:00:00+00:00`, while the constant is spelled with `Z`. Same instant, different
    // string — so a `raw === ADMISSION_GIT_DATE` implementation passes the first case below and
    // silently fails this one, which is the only case that occurs in production.
    expect(isAdmissionSyntheticCommitDate(ADMISSION_GIT_DATE)).toBe(true);
    expect(isAdmissionSyntheticCommitDate('2000-01-01T00:00:00+00:00')).toBe(true);
    expect(isAdmissionSyntheticCommitDate('2000-01-01T00:00:00.000Z')).toBe(true);
    // CALIBRATION: a string-equality implementation would pass the `Z` case above, so assert the
    // two spellings are genuinely DIFFERENT STRINGS naming the SAME instant. Without this, a
    // later "simplification" back to `===` looks green against the first assertion alone.
    expect('2000-01-01T00:00:00+00:00').not.toBe(ADMISSION_GIT_DATE);
    expect(Date.parse('2000-01-01T00:00:00+00:00')).toBe(ADMISSION_GIT_DATE_MS);
  });

  it('accepts the epoch-ms shape the gate_health readers also accept', () => {
    expect(isAdmissionSyntheticCommitDate(ADMISSION_GIT_DATE_MS)).toBe(true);
  });

  it('does NOT fire on a real committer date, an absent value, or junk', () => {
    // The fossil rule must keep working for genuinely old candidates — this predicate is the only
    // thing standing between it and every verdict, so a true-for-everything bug would disable it.
    expect(isAdmissionSyntheticCommitDate('2026-09-23T00:08:56+00:00')).toBe(false);
    expect(isAdmissionSyntheticCommitDate('1999-12-31T23:59:59Z')).toBe(false);
    expect(isAdmissionSyntheticCommitDate(0)).toBe(false); // 1970, the OTHER false-fossil date
    expect(isAdmissionSyntheticCommitDate(null)).toBe(false);
    expect(isAdmissionSyntheticCommitDate(undefined)).toBe(false);
    expect(isAdmissionSyntheticCommitDate('')).toBe(false);
    expect(isAdmissionSyntheticCommitDate('not-a-date')).toBe(false);
  });
});

describe('measureCandidateStaleness records an admission date as UNAVAILABLE', () => {
  const runnerFor = (committedAt: string) => async (_root: string, args: readonly string[]) =>
    args[0] === 'log'
      ? { ok: true, stdout: committedAt, stderr: '', code: 0 }
      : { ok: true, stdout: '92', stderr: '', code: 0 };

  it('nulls the sentinel date a repairHead reports', async () => {
    const out = await measureCandidateStaleness(
      '/repo',
      '557ba0ff26c4',
      runnerFor('2000-01-01T00:00:00+00:00') as never,
    );
    // Null means "age unavailable", which the fossil rule already handles by standing down. The
    // regression this pins is it coming back as a real-looking date and being differenced.
    expect(out.candidateCommittedAt).toBeNull();
    // The sibling measurement must be UNAFFECTED — it is real, and it is what legitimately tells a
    // reader the judged tree is behind tip.
    expect(out.commitsBehindTip).toBe(92);
  });

  it('passes a REAL committer date through untouched', async () => {
    const out = await measureCandidateStaleness(
      '/repo',
      'f22392a985e0',
      runnerFor('2026-09-23T00:08:56+00:00') as never,
    );
    expect(out.candidateCommittedAt).toBe('2026-09-23T00:08:56+00:00');
  });
});
