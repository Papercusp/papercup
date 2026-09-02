/**
 * P-005 (plan `design-to-code-coverage-seam-2026-09-02`), governed by D-016.
 *
 * The detector is pure at its decision seam: existence, working-tree dirtiness, git
 * history and submodule layout are all injected, so BOTH directions — it fires, and it
 * stays silent — are falsifiable without a real checkout.
 *
 * The silence cases are not padding. A false accusation here lowers an honest agent's
 * grade, so every "stays silent" test below pins a specific way this check could have
 * manufactured one.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_UNTOUCHED_PROBES,
  UNTOUCHED_GRACE_SEC,
  untouchedPathsInCompletion,
} from './untouched-paths';
import { LANDING_RACE_WINDOW_SEC } from '../../../../../scripts/lib/tsc-baseline-gate.mjs';

const ROOT = '/repo';
/** The work began here. Every timestamp below is expressed relative to it. */
const SINCE_SEC = 1_780_000_000;
const SINCE_ISO = new Date(SINCE_SEC * 1000).toISOString();

/** Well before the window opens, and outside the grace — the only accusable shape. */
const OLD_SEC = SINCE_SEC - UNTOUCHED_GRACE_SEC - 3600;
/** After the work began — proof git-sync already swept the edit. */
const RECENT_SEC = SINCE_SEC + 600;

const evidence = (...filesChanged: string[]) => ({ summary: 'did the thing', filesChanged });

/** A tree where everything exists, nothing is dirty, and history is ancient. */
const baseProbe = {
  repoRoots: [ROOT],
  exists: () => true,
  isDirty: () => false,
  lastCommitAt: () => OLD_SEC,
  submodulePrefixes: () => [] as string[],
};

describe('untouchedPathsInCompletion', () => {
  it('fires on a real file that is clean and last committed before the work began', () => {
    const result = untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC, baseProbe);

    expect(result).toEqual({
      since: SINCE_ISO,
      untouched: [{ path: 'packages/real.ts', lastCommitAt: new Date(OLD_SEC * 1000).toISOString() }],
    });
  });

  it('reports only the untouched paths and leaves the genuinely changed ones alone', () => {
    const result = untouchedPathsInCompletion(
      evidence('packages/touched.ts', 'packages/untouched.ts'),
      SINCE_SEC,
      { ...baseProbe, lastCommitAt: (_root, p) => (p.endsWith('touched.ts') ? RECENT_SEC : OLD_SEC) },
    );

    expect(result?.untouched.map((u) => u.path)).toEqual(['packages/untouched.ts']);
  });

  // ── Proof-of-work route 1: the edit exists but git-sync has not swept it ──────────────
  //
  // This is the case that makes the check safe to grade on at all. This repo has ONE
  // shared tree swept on a schedule, so at close time an honest edit is usually still
  // uncommitted and its git history still predates the item.

  it('stays silent when the working tree is dirty at the path, however old its history', () => {
    const result = untouchedPathsInCompletion(evidence('packages/in-flight.ts'), SINCE_SEC, {
      ...baseProbe,
      isDirty: () => true,
      lastCommitAt: () => OLD_SEC,
    });

    expect(result).toBeUndefined();
  });

  it('stays silent when dirtiness cannot be read, rather than assuming clean', () => {
    const result = untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC, {
      ...baseProbe,
      isDirty: () => undefined,
    });

    expect(result).toBeUndefined();
  });

  // ── Proof-of-work route 2: git-sync already swept the edit ───────────────────────────

  it('stays silent when a commit touched the path inside the work window', () => {
    const result = untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC, {
      ...baseProbe,
      lastCommitAt: () => RECENT_SEC,
    });

    expect(result).toBeUndefined();
  });

  it('clears a commit that landed just BEFORE the window, inside the grace', () => {
    const result = untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC, {
      ...baseProbe,
      lastCommitAt: () => SINCE_SEC - Math.floor(UNTOUCHED_GRACE_SEC / 2),
    });

    expect(result).toBeUndefined();
  });

  it('still fires once the commit is older than the grace, so the widening is bounded', () => {
    const justOutside = SINCE_SEC - UNTOUCHED_GRACE_SEC - 1;
    const result = untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC, {
      ...baseProbe,
      lastCommitAt: () => justOutside,
    });

    expect(result?.untouched).toEqual([
      { path: 'packages/real.ts', lastCommitAt: new Date(justOutside * 1000).toISOString() },
    ]);
  });

  // ── Undecidable shapes are silence, never accusations ────────────────────────────────

  it('never judges a path inside a submodule, where superproject git log is empty for a real file', () => {
    const result = untouchedPathsInCompletion(
      evidence('libs/papercusp/libs/db/sql/727-thing.sql'),
      SINCE_SEC,
      {
        ...baseProbe,
        submodulePrefixes: () => ['libs/papercusp'],
        // The shape that would otherwise manufacture the accusation: superproject git
        // knows nothing about a file that is real inside the submodule.
        lastCommitAt: () => OLD_SEC,
      },
    );

    expect(result).toBeUndefined();
  });

  it('stays silent when git knows nothing about the path (null is not an accusation)', () => {
    const result = untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC, {
      ...baseProbe,
      lastCommitAt: () => null,
    });

    expect(result).toBeUndefined();
  });

  it('stays silent when the history read could not be made at all', () => {
    const result = untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC, {
      ...baseProbe,
      lastCommitAt: () => undefined,
    });

    expect(result).toBeUndefined();
  });

  it('leaves a path absent from disk to the fabricated-path detector, keeping the two disjoint', () => {
    const result = untouchedPathsInCompletion(evidence('packages/gone.ts'), SINCE_SEC, {
      ...baseProbe,
      exists: () => false,
    });

    expect(result).toBeUndefined();
  });

  it('stays silent for globs and absolute paths, which are not single-path claims', () => {
    expect(untouchedPathsInCompletion(evidence('packages/**/*.ts'), SINCE_SEC, baseProbe)).toBeUndefined();
    expect(untouchedPathsInCompletion(evidence('/etc/hosts'), SINCE_SEC, baseProbe)).toBeUndefined();
  });

  it('stays silent for a path escaping the repo root', () => {
    const result = untouchedPathsInCompletion(evidence('../elsewhere/file.ts'), SINCE_SEC, baseProbe);
    expect(result).toBeUndefined();
  });

  it('stays silent with no usable repo root, rather than guessing one', () => {
    expect(untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC, { ...baseProbe, repoRoots: [] })).toBeUndefined();
  });

  it('stays silent with no usable window, rather than treating "now" as the start of work', () => {
    expect(untouchedPathsInCompletion(evidence('packages/real.ts'), undefined, baseProbe)).toBeUndefined();
    expect(untouchedPathsInCompletion(evidence('packages/real.ts'), 'not-a-date', baseProbe)).toBeUndefined();
  });

  it('stays silent when no paths were declared at all', () => {
    expect(untouchedPathsInCompletion(evidence(), SINCE_SEC, baseProbe)).toBeUndefined();
    expect(untouchedPathsInCompletion(undefined, SINCE_SEC, baseProbe)).toBeUndefined();
  });

  it('treats a throwing probe as cannot-judge rather than letting it escape', () => {
    const result = untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC, {
      ...baseProbe,
      isDirty: () => {
        throw new Error('git exploded');
      },
    });

    expect(result).toBeUndefined();
  });

  // ── Bounds and multi-root semantics ──────────────────────────────────────────────────

  it('is cleared by ANY root, so a second checkout carrying the edit exonerates the path', () => {
    const result = untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC, {
      ...baseProbe,
      repoRoots: ['/repo-a', '/repo-b'],
      isDirty: (root) => root === '/repo-b',
    });

    expect(result).toBeUndefined();
  });

  it('does not judge past the probe cap', () => {
    const many = Array.from({ length: MAX_UNTOUCHED_PROBES + 5 }, (_, i) => `packages/f${i}.ts`);
    const result = untouchedPathsInCompletion(evidence(...many), SINCE_SEC, baseProbe);

    expect(result?.untouched).toHaveLength(MAX_UNTOUCHED_PROBES);
  });

  it('accepts Date, ISO and millisecond windows as the same instant', () => {
    const asIso = untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_ISO, baseProbe);
    const asMs = untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC * 1000, baseProbe);
    const asDate = untouchedPathsInCompletion(evidence('packages/real.ts'), new Date(SINCE_SEC * 1000), baseProbe);

    expect(asIso?.since).toBe(SINCE_ISO);
    expect(asMs?.since).toBe(SINCE_ISO);
    expect(asDate?.since).toBe(SINCE_ISO);
  });

  // ── Derived-truth pin ────────────────────────────────────────────────────────────────

  it('keeps its grace equal to the repo-wide landing-race window it is copied from', () => {
    // The constant is duplicated rather than imported into the resolver (that module is a
    // pure resolver; the source is an .mjs gate helper). This assertion is what stops the
    // copy drifting from the original — see the note on UNTOUCHED_GRACE_SEC.
    expect(UNTOUCHED_GRACE_SEC).toBe(LANDING_RACE_WINDOW_SEC);
  });
});
