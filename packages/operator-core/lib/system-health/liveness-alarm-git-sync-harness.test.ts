import { describe, expect, it } from 'vitest';
import { collapseStarvedInstallsByHarness, worstGitSyncInstallForSubject } from './liveness-alarm';

// WI-6554700010048238: one git-sync starvation incident per HARNESS, not one per submodule install.
describe('collapseStarvedInstallsByHarness', () => {
  it('folds a superproject and its submodule installs into one subject at the worst reading', () => {
    expect(collapseStarvedInstallsByHarness([
      { installSlug: 'papercusp', missedIntervals: 4 },
      { installSlug: 'papercusp/libs/papercusp-db', missedIntervals: 9 },
      { installSlug: 'papercusp/libs/generic/search', missedIntervals: 3 },
      { installSlug: 'scout-runtime', missedIntervals: 5 },
    ])).toEqual([
      { installSlug: 'papercusp', missedIntervals: 9 },
      { installSlug: 'scout-runtime', missedIntervals: 5 },
    ]);
  });

  it('keeps the legacy null subject (a snapshot with no per-install list) as its own entry', () => {
    expect(collapseStarvedInstallsByHarness([{ installSlug: null, missedIntervals: 6 }]))
      .toEqual([{ installSlug: null, missedIntervals: 6 }]);
  });
});

describe('worstGitSyncInstallForSubject', () => {
  const entries = [
    { installSlug: 'papercusp/libs/papercusp-db', missedIntervals: 9 },
    { installSlug: 'papercusp', missedIntervals: 4 },
    { installSlug: 'papercusp-pr-drill-20261014', missedIntervals: 7 },
  ];

  it('matches every install of a harness subject and returns the worst one', () => {
    expect(worstGitSyncInstallForSubject(entries, 'papercusp')?.missedIntervals).toBe(9);
  });

  it('still matches a pre-collapse per-install subject exactly', () => {
    expect(worstGitSyncInstallForSubject(entries, 'papercusp/libs/papercusp-db')?.missedIntervals).toBe(9);
  });

  it('does not treat a harness whose slug merely shares a prefix as a member', () => {
    expect(worstGitSyncInstallForSubject(entries, 'papercusp-pr-drill-20261014')?.missedIntervals).toBe(7);
    expect(worstGitSyncInstallForSubject([{ installSlug: 'papercusp-pr-drill-20261014', missedIntervals: 7 }], 'papercusp'))
      .toBeUndefined();
  });
});
