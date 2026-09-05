import { describe, expect, it } from 'vitest';
import { admittedToLineageFor, evaluateChangeInCandidate, type GateCandidates } from './git-pipeline-position';
import { renderAdmitCommand } from './release/repair-manifest';

// P-022 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, D-007 #3):
// `admittedToLineage` beside `judgingContainsPath` — the mechanical answer to "is my fix
// in the candidate" that reads the ADMISSION LEDGER rather than comparing blobs.

const queue = {
  admissions: [
    { paths: ['a/fix.ts'], unchanged: ['lib/same.ts'] },
    { paths: ['b/other.ts'], unchanged: [] },
  ],
};

describe('admittedToLineageFor', () => {
  it('is null with no frozen queue or no path — the question does not arise', () => {
    expect(admittedToLineageFor(null, 'a/fix.ts')).toBeNull();
    expect(admittedToLineageFor(undefined, 'a/fix.ts')).toBeNull();
    expect(admittedToLineageFor(queue, null)).toBeNull();
    expect(admittedToLineageFor(queue, './')).toBeNull();
  });

  it('is true for a path an admission changed OR carried unchanged, false for one no admission names', () => {
    expect(admittedToLineageFor(queue, 'a/fix.ts')).toBe(true);
    expect(admittedToLineageFor(queue, 'lib/same.ts')).toBe(true);
    expect(admittedToLineageFor(queue, 'b/other.ts')).toBe(true);
    expect(admittedToLineageFor(queue, 'c/never.ts')).toBe(false);
  });

  it('normalizes leading ./ and / on either side', () => {
    expect(admittedToLineageFor(queue, './a/fix.ts')).toBe(true);
    expect(admittedToLineageFor({ admissions: [{ paths: ['./lib/same.ts'] }] }, '/lib/same.ts')).toBe(true);
  });

  it('a frozen queue with an EMPTY ledger answers false, never null', () => {
    expect(admittedToLineageFor({ admissions: [] }, 'a/fix.ts')).toBe(false);
    expect(admittedToLineageFor({ admissions: null }, 'a/fix.ts')).toBe(false);
  });
});

describe('evaluateChangeInCandidate — admittedToLineage rides beside the blob verdict', () => {
  const candidates: GateCandidates = {
    judgingSha: 'j'.repeat(40),
    judgingShaSource: 'retriage-marker',
    nextCandidateSha: 'n'.repeat(40),
  } as GateCandidates;
  const containment = (inCandidate: boolean) => ({
    path: 'a/fix.ts',
    inCandidate,
    reason: inCandidate ? null : ('newer-commit' as const),
  });

  it('is absent (not null) when no ledger verdict was supplied — pre-P-022 readers see the old shape', () => {
    const r = evaluateChangeInCandidate({ relPath: 'a/fix.ts', candidates, judging: containment(true) as never, next: null });
    expect('admittedToLineage' in r).toBe(false);
  });

  it('false + blob-uncontained names the admit lever', () => {
    const r = evaluateChangeInCandidate({
      relPath: 'a/fix.ts',
      candidates,
      judging: containment(false) as never,
      next: null,
      admittedToLineage: false,
    });
    expect(r.admittedToLineage).toBe(false);
    expect(r.detail).toContain(renderAdmitCommand(['a/fix.ts']));
  });

  it('true + blob-uncontained diagnoses a LATER edit rather than a missing admission', () => {
    const r = evaluateChangeInCandidate({
      relPath: 'a/fix.ts',
      candidates,
      judging: containment(false) as never,
      next: null,
      admittedToLineage: true,
    });
    expect(r.admittedToLineage).toBe(true);
    expect(r.detail).toMatch(/LATER edit/);
  });

  it('false + blob-contained is the coincidence case: says the ledger does not carry it', () => {
    const r = evaluateChangeInCandidate({
      relPath: 'a/fix.ts',
      candidates,
      judging: containment(true) as never,
      next: null,
      admittedToLineage: false,
    });
    expect(r.judgingContainsPath).toBe(true);
    expect(r.admittedToLineage).toBe(false);
    expect(r.detail).toMatch(/NO admission names this path/);
  });
});
