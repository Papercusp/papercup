/**
 * EI-20049757392342975 — every door that WRITES a goal row must share the
 * kill-criterion rule.
 *
 * WHY THIS IS A SOURCE SCAN AND NOT FOUR BEHAVIOURAL TESTS. The behavioural
 * tests exist too (create.test.ts, start.test.ts) and they are the ones that
 * prove the refusal actually works. This guard answers a different question
 * that no per-door test can: *has a FIFTH door appeared that nobody wired?*
 * That is the failure this bug actually was — `goals:create` and `goals:start`
 * were added later than `goals:propose`, each re-implemented the row write, and
 * neither picked up the check. A test suite that only covers the doors it knows
 * about cannot fail when a new one is added, which is precisely when it needs to.
 *
 * The rule's own module says it is shared "rather than re-implementing it",
 * and warns that a second copy "drifts silently and only ever in the permissive
 * direction". Note what actually happened here was worse than drift: the two
 * new doors had NO copy at all, while `goals:update`'s comment asserted in as
 * many words that "the create path would have rejected" a stub. The docs
 * described a system that did not exist, which is why the gap survived review.
 *
 * SCOPE. `insertGoalRow` is the one shared write primitive (agent-mcp
 * tools/goals/_core.ts), so "calls insertGoalRow" is an exact structural
 * definition of "is a goal-creation door" — it needs no maintained list, and a
 * door that bypasses that helper to hand-write its own INSERT is a different
 * (and larger) problem this guard deliberately does not pretend to cover.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The shared write primitive. A file that calls it creates goal rows. */
const WRITE_PRIMITIVE = 'insertGoalRow';
/** The shared rule every such file must consult. */
const SHARED_RULE = 'killCriterionProblem';

/** Files that legitimately mention the primitive without being a door. */
function isExempt(path: string): boolean {
  return (
    path.endsWith('.test.ts') ||
    path.endsWith('.test.tsx') ||
    // Defines/deletes the row rather than deciding what may become one.
    path.endsWith('tools/goals/_core.ts') ||
    // This guard names both strings by construction.
    path.endsWith('goals/kill-criterion-doors.test.ts')
  );
}

function repoFiles(): string[] {
  return execFileSync('git', ['ls-files', '*.ts', '*.tsx'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
    killSignal: 'SIGKILL',
  })
    .split('\n')
    .filter(Boolean)
    // WI-10004176: a plain `rm` stays in the index until git-sync commits it — drop those.
    .filter((f) => existsSync(join(ROOT, f)));
}

/**
 * Does this source CALL the write primitive (rather than merely import it)?
 *
 * Extracted so it can be control-tested against synthetic sources below. A
 * detector that silently stops matching yields zero doors, and a forall over
 * zero doors passes — so the detector needs its own falsifiability proof, not
 * just the population it produces.
 */
function isDoorSource(src: string): boolean {
  return new RegExp(`\\b${WRITE_PRIMITIVE}\\s*\\(`).test(src);
}

/** Does this source consult the shared rule? */
function consultsRule(src: string): boolean {
  return src.includes(SHARED_RULE);
}

/** Files that CALL the write primitive (not merely import or re-export it). */
function goalWriteDoors(): string[] {
  const doors: string[] = [];
  for (const rel of repoFiles()) {
    if (isExempt(rel)) continue;
    let src: string;
    try {
      src = readFileSync(join(ROOT, rel), 'utf8');
    } catch {
      continue; // raced with a peer's edit; a missing file is not a violation
    }
    if (isDoorSource(src)) doors.push(rel);
  }
  return doors;
}

describe('kill criterion — every goal-creation door shares the rule', () => {
  const doors = goalWriteDoors();

  /**
   * ⚠ THE VACUITY GUARD, and it is the most important assertion in this file.
   * Every failure mode of the scan above — a renamed primitive, a bad glob, a
   * wrong ROOT, `git ls-files` throwing — yields ZERO doors, and a forall over
   * an empty set PASSES. That green would be indistinguishable from real
   * safety, which is the exact shape of false-green this repo has been bitten
   * by repeatedly (`tsc -p .` checking zero files, `test:affected` selecting
   * zero suites, a `-t` filter matching zero tests).
   *
   * Two known doors exist today. Asserting >= 2 rather than === 2 keeps the
   * guard from failing merely because someone legitimately adds a third.
   */
  it('finds the known doors — a scan that matched nothing must FAIL, not pass', () => {
    expect(doors.length).toBeGreaterThanOrEqual(2);
    expect(doors).toEqual(
      expect.arrayContaining([
        'packages/agent-mcp/src/tools/goals/create.ts',
        'packages/operator-core/lib/agent-tools/goals/start.ts',
      ]),
    );
  });

  /**
   * CONTROLS for the detector itself. Without these, a detector that had
   * quietly stopped matching would report zero doors and every assertion above
   * would pass. These run against synthetic sources, so proving falsifiability
   * needs no mutation of the shared tree (which git-sync would commit).
   */
  describe('the detector can actually fail', () => {
    it('flags a door that does NOT consult the rule — the pre-fix state of both real doors', () => {
      const preFix = `import { insertGoalRow } from './_core';\nawait insertGoalRow(tx, { title });`;
      expect(isDoorSource(preFix)).toBe(true);
      expect(consultsRule(preFix)).toBe(false); // ⇒ the it.each below would FAIL
    });

    it('accepts a door that does consult it — so the check is not simply always-false', () => {
      const fixed = `import { killCriterionProblem } from '../../goals/kill-criterion';\nawait insertGoalRow(tx, {});`;
      expect(isDoorSource(fixed)).toBe(true);
      expect(consultsRule(fixed)).toBe(true);
    });

    it('does not mistake an IMPORT or a re-export for a door', () => {
      expect(isDoorSource(`import { goalId, insertGoalRow } from './_core';`)).toBe(false);
      expect(isDoorSource(`export { insertGoalRow };`)).toBe(false);
    });
  });

  it.each(doors)('%s consults the shared kill-criterion rule', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    expect(
      src.includes(SHARED_RULE),
      `${rel} writes goal rows via ${WRITE_PRIMITIVE}() but never calls ${SHARED_RULE}, so it can ` +
        `install a kill criterion that goals:propose and goals:update both refuse. Add the same ` +
        `\`const t = args.killCriterion?.trim(); if (t) { ... }\` guard those doors use — and keep ` +
        `the blank case passing, since a goal may have no criterion at all (WI-37604).`,
    ).toBe(true);
  });
});
