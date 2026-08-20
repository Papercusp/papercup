/**
 * EI-20093150500083378 — `unresolvedPathsInCompletion`: nudge a close whose
 * `filesChanged` names paths that do not exist in the repo.
 *
 * ── WHY THIS GUARD EXISTS ──────────────────────────────────────────────────
 * Every other evidence field on `work_items:complete` is challenged — a bare-string
 * completion is downgraded to `proposed`, a unit-only close over TypeScript draws a
 * typecheck warning, a terminal close without `assumptions` is refused outright.
 * `filesChanged` alone was taken verbatim, and it is the field most likely to be
 * written from MEMORY rather than observation, because it is filled in LAST — when
 * the work is done and the details have aged out of context or out of a compaction.
 *
 * Measured 2026-08-10: an agent filed 12 paths across two completions and 8 did not
 * exist — an `agent-tools/` segment inserted because most tools in that package do
 * live under it, and a `__tests__/` directory invented because nearly every other
 * repo has one. Both completions still landed `authority:'committed'`. The direction
 * of the error is the dangerous part: the fabricated paths were MORE conventional
 * than the real ones, so they survive review by someone who knows the ecosystem but
 * not this tree. Nothing downstream could catch it — the tests were green, but tests
 * never read `filesChanged`; the typecheck was clean, but it checks the package, not
 * the prose about it.
 *
 * ── HOW THIS FILE PROVES ITSELF ────────────────────────────────────────────
 * Falsifiability is structural: the suite asserts BOTH directions, so a degenerate
 * implementation cannot pass it. One that always returned `undefined` fails every
 * "FIRES" case; one that always fired fails every "stays SILENT" case. The silent
 * half is not padding — it encodes the fail-open contract (EI-24 record-and-warn),
 * where every case this check cannot judge must produce no warning at all.
 *
 * PURE: the filesystem is injected, so this never touches a real tree.
 */
import { describe, it, expect } from 'vitest';

import { completionRepoRootsFromRegistry, unresolvedPathsInCompletion } from './complete';
import type { CompletionVerificationEvidence } from '../../coord-lifecycle/records';

const ROOT = '/repo';
const SIDESTAGE_ROOT = '/hives/sidestage';

/** The pretend tree — absolute paths, mirroring the real ones from the measured incident. */
const TREE = new Set<string>([
  '/repo/packages/operator-core/lib',
  '/repo/packages/operator-core/lib/issues-engineer.ts',
  '/repo/packages/operator-core/lib/work-items.ts',
  '/repo/packages/operator-core/lib/scheduler/claim-spec.ts',
  '/repo/packages/operator-core/lib/agent-tools/work_items',
  '/repo/packages/operator-core/lib/agent-tools/work_items/create.test.ts',
  '/repo/libs/papercusp/libs/db/sql',
  '/repo/libs/papercusp/libs/db/sql/790-expose-goal-id-on-engineer-issues-view.sql',
  `${SIDESTAGE_ROOT}/apps/api/src/auction/auction.service.ts`,
  `${SIDESTAGE_ROOT}/apps/api/src/app.module.ts`,
  '/another-repo/only-there.ts',
]);

const DIR_ENTRIES: Record<string, string[]> = {
  '/repo/libs/papercusp/libs/db/sql': ['790-expose-goal-id-on-engineer-issues-view.sql', '789-something-else.sql'],
  '/repo/packages/operator-core/lib/agent-tools/work_items': ['create.test.ts', 'complete.ts'],
  '/repo/packages/operator-core/lib': ['issues-engineer.ts', 'work-items.ts'],
};

const probe = {
  repoRoot: ROOT,
  exists: (abs: string) => TREE.has(abs),
  siblings: (abs: string) => DIR_ENTRIES[abs] ?? [],
};

const ev = (filesChanged: string[]): CompletionVerificationEvidence =>
  ({ filesChanged }) as CompletionVerificationEvidence;

describe('unresolvedPathsInCompletion — FIRES on a fabricated path', () => {
  it('catches an INSERTED path segment and names the real path (the measured `agent-tools/` case)', () => {
    const got = unresolvedPathsInCompletion(ev(['packages/operator-core/lib/agent-tools/issues-engineer.ts']), probe);
    expect(got?.missing).toHaveLength(1);
    expect(got?.missing[0]).toEqual({
      path: 'packages/operator-core/lib/agent-tools/issues-engineer.ts',
      didYouMean: 'packages/operator-core/lib/issues-engineer.ts',
    });
  });

  it('catches an INVENTED `__tests__/` directory this repo does not use', () => {
    const got = unresolvedPathsInCompletion(
      ev(['packages/operator-core/lib/agent-tools/work_items/__tests__/create.test.ts']),
      probe,
    );
    expect(got?.missing[0]?.didYouMean).toBe('packages/operator-core/lib/agent-tools/work_items/create.test.ts');
  });

  it('catches a MISREMEMBERED basename in a directory that does exist, via the leading token', () => {
    const got = unresolvedPathsInCompletion(ev(['libs/papercusp/libs/db/sql/790-engineer-issues-goal-id.sql']), probe);
    expect(got?.missing[0]?.didYouMean).toBe(
      'libs/papercusp/libs/db/sql/790-expose-goal-id-on-engineer-issues-view.sql',
    );
  });

  it('still REPORTS a missing path it cannot repair — a suggestion is a bonus, not a precondition', () => {
    const got = unresolvedPathsInCompletion(ev(['totally/made/up/nowhere.ts']), probe);
    expect(got?.missing).toHaveLength(1);
    expect(got?.missing[0]?.path).toBe('totally/made/up/nowhere.ts');
    expect(got?.missing[0]?.didYouMean).toBeUndefined();
  });

  it('reports EVERY bad path, not just the first — the incident filed 8 across two closes', () => {
    const got = unresolvedPathsInCompletion(
      ev([
        'packages/operator-core/lib/agent-tools/issues-engineer.ts', // bad
        'packages/operator-core/lib/work-items.ts', // good
        'packages/operator-core/lib/agent-tools/scheduler/claim-spec.ts', // bad
      ]),
      probe,
    );
    expect(got?.missing.map((m) => m.path)).toEqual([
      'packages/operator-core/lib/agent-tools/issues-engineer.ts',
      'packages/operator-core/lib/agent-tools/scheduler/claim-spec.ts',
    ]);
  });
});

describe('unresolvedPathsInCompletion — stays SILENT (the fail-open contract)', () => {
  it('says nothing when every declared path exists', () => {
    expect(
      unresolvedPathsInCompletion(
        ev(['packages/operator-core/lib/issues-engineer.ts', 'packages/operator-core/lib/work-items.ts']),
        probe,
      ),
    ).toBeUndefined();
  });

  it('says nothing when there is no `filesChanged` to judge', () => {
    expect(unresolvedPathsInCompletion(ev([]), probe)).toBeUndefined();
    expect(unresolvedPathsInCompletion(undefined, probe)).toBeUndefined();
    expect(unresolvedPathsInCompletion({} as CompletionVerificationEvidence, probe)).toBeUndefined();
  });

  it('says nothing when the repo root cannot be resolved — it must never guess', () => {
    expect(unresolvedPathsInCompletion(ev(['definitely/not/here.ts']), { ...probe, repoRoot: null })).toBeUndefined();
  });

  it('resolves one registered sibling Hive checkout as a unit (the measured SideStage case)', () => {
    const roots = completionRepoRootsFromRegistry(ROOT, {
      projects: [
        { slug: 'papercusp', path: ROOT, harness_kind: 'hive', self_repo: true },
        { slug: 'sidestage', path: SIDESTAGE_ROOT },
      ],
    });
    expect(
      unresolvedPathsInCompletion(ev(['apps/api/src/auction/auction.service.ts', 'apps/api/src/app.module.ts']), {
        ...probe,
        repoRoots: roots,
      }),
    ).toBeUndefined();
  });

  it('resolves an absolute filesChanged path against its owning Hive checkout', () => {
    expect(
      unresolvedPathsInCompletion(ev([`${SIDESTAGE_ROOT}/apps/api/src/auction/auction.service.ts`]), {
        ...probe,
        repoRoots: [ROOT, SIDESTAGE_ROOT],
      }),
    ).toBeUndefined();
  });

  it('admits an explicitly discovered Hive root without changing primary-root ordering', () => {
    expect(completionRepoRootsFromRegistry(ROOT, { projects: [] }, [SIDESTAGE_ROOT])).toEqual([ROOT, SIDESTAGE_ROOT]);
  });

  it('skips a GLOB — that describes many files, it does not claim one path exists', () => {
    expect(unresolvedPathsInCompletion(ev(['packages/**/*.ts', 'lib/foo?.ts']), probe)).toBeUndefined();
  });

  it('skips a path that escapes the repo root — outside the tree it has no standing to judge', () => {
    expect(unresolvedPathsInCompletion(ev(['../elsewhere/secret.ts', '/etc/passwd']), probe)).toBeUndefined();
  });

  it('survives an fs that throws — a completion must never fail because a probe did', () => {
    expect(() =>
      unresolvedPathsInCompletion(ev(['packages/operator-core/lib/issues-engineer.ts']), {
        ...probe,
        exists: () => {
          throw new Error('EIO');
        },
      }),
    ).not.toThrow();
  });

  it('bounds the work — a pathological payload cannot turn one completion into a tree walk', () => {
    const many = Array.from({ length: 500 }, (_, i) => `made/up/path-${i}.ts`);
    const got = unresolvedPathsInCompletion(ev(many), probe);
    expect(got?.missing.length).toBeLessThanOrEqual(60);
  });
});

describe('unresolvedPathsInCompletion — multiple checkout integrity', () => {
  it('does not combine partial matches from different repositories into one false green', () => {
    const got = unresolvedPathsInCompletion(ev(['packages/operator-core/lib/issues-engineer.ts', 'only-there.ts']), {
      ...probe,
      repoRoots: [ROOT, '/another-repo'],
    });
    expect(got?.missing.map((entry) => entry.path)).toEqual(['only-there.ts']);
  });
});

/**
 * Every test above INJECTS the filesystem, which proves the logic and says nothing about
 * the wiring that actually ships: the default `detectPapercupRoot` / `existsSync` /
 * `readdirSync` deps. A check whose logic is perfect and whose default root resolver
 * returns null is a check that never fires in production — and it would fail SILENTLY,
 * in the fail-open direction, which is the direction nobody notices. So these two exercise
 * the real tree with NO probe at all.
 *
 * Anchored on maximally stable paths (the repo's own `package.json`, and a path that is
 * fabricated by construction) so this cannot rot as the tree is refactored.
 */
describe('unresolvedPathsInCompletion — the DEFAULT deps really work against the real tree', () => {
  const rootResolves = unresolvedPathsInCompletion(ev(['package.json'])) === undefined;

  it.skipIf(!rootResolves)('stays silent on a path that genuinely exists in this repo', () => {
    expect(unresolvedPathsInCompletion(ev(['package.json']))).toBeUndefined();
  });

  it.skipIf(!rootResolves)('fires on a path that does not exist in this repo', () => {
    const got = unresolvedPathsInCompletion(ev(['packages/operator-core/lib/no-such-file-ei20093.ts']));
    expect(got?.missing[0]?.path).toBe('packages/operator-core/lib/no-such-file-ei20093.ts');
  });
});
