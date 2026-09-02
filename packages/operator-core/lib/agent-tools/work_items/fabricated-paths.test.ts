/**
 * P-001 / D-016 (plan `design-to-code-coverage-seam-2026-09-02`).
 *
 * The property under test is NOT "missing paths are caught" — it is that the THREE causes
 * of path-absence are told apart, because grading on bare absence would down-grade the
 * honest refactor closes that legitimately delete files. Each cause gets its own case, and
 * the fail-open branches get more coverage than the finding itself: a false FABRICATED
 * verdict is the expensive error here, a false clean verdict merely preserves the status quo.
 */
import { describe, expect, it } from 'vitest';

import type { CompletionVerificationEvidence } from '../../coord-lifecycle/records';
import {
  MAX_FABRICATION_PROBES,
  fabricatedPathsInCompletion,
  type FabricatedPathProbe,
} from './fabricated-paths';
import {
  authorityForCompletion,
  insufficientEvidenceReason,
  isSufficientEvidence,
} from '../../work-item-completion-authority';

const ROOT = '/repo';

const evidence = (filesChanged: string[]): CompletionVerificationEvidence =>
  ({
    verifiedHow: 'ran the suite',
    testsRun: 'vitest',
    testResult: 'pass',
    filesChanged,
  }) as CompletionVerificationEvidence;

/** Nothing on disk, nothing in git — the fabrication shape — unless overridden. */
const probe = (over: Partial<FabricatedPathProbe> = {}): FabricatedPathProbe => ({
  repoRoots: [ROOT],
  exists: () => false,
  gitKnows: () => false,
  submodulePrefixes: () => [],
  ...over,
});

describe('fabricatedPathsInCompletion — the three causes of absence', () => {
  it('FABRICATED: absent from disk and unknown to git is a finding', () => {
    const out = fabricatedPathsInCompletion(evidence(['packages/agent-tools/invented.ts']), probe());
    expect(out).toEqual({ neverExisted: ['packages/agent-tools/invented.ts'] });
  });

  it('DELETED: absent from disk but known to git is NOT a finding', () => {
    // The honest refactor close. Grading this down is the failure mode D-016 exists to stop.
    const out = fabricatedPathsInCompletion(evidence(['lib/removed.ts']), probe({ gitKnows: () => true }));
    expect(out).toBeUndefined();
  });

  it('UNJUDGEABLE: a git probe that cannot answer stays silent', () => {
    // undefined must never collapse into false — that is the whole safety property.
    const out = fabricatedPathsInCompletion(evidence(['lib/unknown.ts']), probe({ gitKnows: () => undefined }));
    expect(out).toBeUndefined();
  });

  it('present on disk is never a finding, and never costs a git probe', () => {
    let probed = 0;
    const out = fabricatedPathsInCompletion(
      evidence(['lib/real.ts']),
      probe({
        exists: () => true,
        gitKnows: () => {
          probed += 1;
          return false;
        },
      }),
    );
    expect(out).toBeUndefined();
    expect(probed).toBe(0);
  });
});

describe('fabricatedPathsInCompletion — fail-open branches', () => {
  it('no declared paths → undefined', () => {
    expect(fabricatedPathsInCompletion(evidence([]), probe())).toBeUndefined();
    expect(fabricatedPathsInCompletion(undefined, probe())).toBeUndefined();
  });

  it('an EXPLICIT empty root list means cannot-judge, not guess', () => {
    expect(fabricatedPathsInCompletion(evidence(['x.ts']), probe({ repoRoots: [] }))).toBeUndefined();
  });

  it('a submodule path is never judged, even though git legitimately has no record of it', () => {
    // The superproject tracks only the gitlink, so `git log` is empty for a REAL file here.
    // This is the one shape that would otherwise manufacture a confident false accusation.
    const out = fabricatedPathsInCompletion(
      evidence(['libs/papercusp/libs/db/sql/727-x.sql']),
      probe({ submodulePrefixes: () => ['libs/papercusp'] }),
    );
    expect(out).toBeUndefined();
  });

  it('globs and absolute paths are skipped', () => {
    expect(fabricatedPathsInCompletion(evidence(['src/**/*.ts', 'a?.ts']), probe())).toBeUndefined();
    expect(fabricatedPathsInCompletion(evidence(['/etc/passwd']), probe())).toBeUndefined();
  });

  it('a path escaping the repo root is outside our standing to judge', () => {
    expect(fabricatedPathsInCompletion(evidence(['../other/x.ts']), probe())).toBeUndefined();
  });

  it('a THROWING probe is silence, never an accusation', () => {
    const thrower = () => {
      throw new Error('git exploded');
    };
    expect(
      fabricatedPathsInCompletion(evidence(['x.ts']), probe({ gitKnows: thrower })),
    ).toBeUndefined();
    expect(fabricatedPathsInCompletion(evidence(['x.ts']), probe({ exists: thrower }))).toBeUndefined();
    expect(
      fabricatedPathsInCompletion(evidence(['x.ts']), probe({ submodulePrefixes: thrower })),
    ).toEqual({ neverExisted: ['x.ts'] }); // unreadable .gitmodules ≠ unjudgeable path
  });

  it('multi-root: existence under ANY candidate root clears the path', () => {
    const out = fabricatedPathsInCompletion(
      evidence(['pkg/x.ts']),
      probe({ repoRoots: [ROOT, '/other'], exists: (abs) => abs.startsWith('/other') }),
    );
    expect(out).toBeUndefined();
  });

  it('multi-root: git history under ANY candidate root clears the path', () => {
    const out = fabricatedPathsInCompletion(
      evidence(['pkg/x.ts']),
      probe({ repoRoots: [ROOT, '/other'], gitKnows: (root) => root === '/other' }),
    );
    expect(out).toBeUndefined();
  });

  it('probing is bounded, so a pathological list cannot fan out', () => {
    const many = Array.from({ length: MAX_FABRICATION_PROBES + 5 }, (_, i) => `f${i}.ts`);
    const out = fabricatedPathsInCompletion(evidence(many), probe());
    expect(out?.neverExisted).toHaveLength(MAX_FABRICATION_PROBES);
  });

  it('reports only the fabricated subset, not the whole list', () => {
    const out = fabricatedPathsInCompletion(
      evidence(['real.ts', 'deleted.ts', 'invented.ts']),
      probe({
        exists: (abs) => abs.endsWith('real.ts'),
        gitKnows: (_root, p) => p === 'deleted.ts',
      }),
    );
    expect(out).toEqual({ neverExisted: ['invented.ts'] });
  });
});

describe('insufficientEvidenceReason — P-001 wiring', () => {
  const full = evidence(['a.ts']);

  it('without findings the grade is exactly what it was before', () => {
    expect(insufficientEvidenceReason(full)).toBeUndefined();
    expect(authorityForCompletion(full)).toBe('committed');
  });

  it('an unrun probe (absent field) is not treated as a clean verdict', () => {
    expect(insufficientEvidenceReason(full, {})).toBeUndefined();
    expect(insufficientEvidenceReason(full, { filesChangedNeverExisted: [] })).toBeUndefined();
  });

  it('a fabricated path lowers the grade to proposed', () => {
    const findings = { filesChangedNeverExisted: ['invented.ts'] };
    expect(insufficientEvidenceReason(full, findings)).toBe('files-changed-never-existed');
    expect(isSufficientEvidence(full, findings)).toBe(false);
    expect(authorityForCompletion(full, findings)).toBe('proposed');
  });

  it('a MISSING field is reported before a wrong one — the cheaper remedy first', () => {
    // Both faults present: the caller should hear "supply verifiedHow", not "correct your
    // paths", because a caller told the wrong remedy re-submits fields it already sent.
    const noVerifiedHow = { ...full, verifiedHow: '' } as CompletionVerificationEvidence;
    expect(insufficientEvidenceReason(noVerifiedHow, { filesChangedNeverExisted: ['x.ts'] })).toBe(
      'no-verified-how',
    );
  });
});
