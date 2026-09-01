/**
 * Regression guard for EI-19453217565223331.
 *
 * The runtime suites prove that `serving.startedSinceCodeChange` is the
 * process-level falsifier.  This file proves the build detector both catches a
 * fresh ungrounded reader and scans the real tracked tree, so a new call site
 * cannot quietly reintroduce the git/process conflation.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs guard script has no declaration file.
import { ALLOWLIST, BASELINE, findOffenders, findUngroundedReads, isExcluded, readsDeployedWithoutServingEvidence } from '../../../../scripts/check-no-deployed-liveness-read.mjs';

describe('check-no-deployed-liveness-read predicate', () => {
  it('flags a direct positions.deployed process conclusion', () => {
    const source = `
      const live = result.positions.deployed;
      if (live) return { status: 'running' };
    `;
    expect(readsDeployedWithoutServingEvidence(source, 'fixture.ts')).toBe(true);
    expect(findUngroundedReads(source, 'fixture.ts')[0]?.line).toBe(2);
  });

  it('accepts the independent serving evidence in the same decision window', () => {
    const source = `
      const live = result.positions.deployed && result.serving.startedSinceCodeChange === true;
      return live;
    `;
    expect(readsDeployedWithoutServingEvidence(source, 'fixture.ts')).toBe(false);
  });

  it('handles optional chaining and does not let comments or strings satisfy the rule', () => {
    const ungrounded = `const live = result.positions?.deployed === true;`;
    expect(readsDeployedWithoutServingEvidence(ungrounded, 'fixture.ts')).toBe(true);

    const proseOnly = `
      // result.positions.deployed means the release checkout contains the commit.
      const note = 'result.positions.deployed is not process liveness';
    `;
    expect(readsDeployedWithoutServingEvidence(proseOnly, 'fixture.ts')).toBe(false);
  });

  it('does not flag an unrelated field named deployed', () => {
    expect(readsDeployedWithoutServingEvidence('const deployed = status.deployed;', 'fixture.ts')).toBe(false);
  });

  it('keeps the allowlist explicit and shrink-only', () => {
    expect(BASELINE.size).toBe(0);
    expect(ALLOWLIST.size).toBeGreaterThan(0);
    for (const [file, reason] of ALLOWLIST) {
      expect(file).toMatch(/\.(?:ts|tsx)$/);
      expect(reason.trim().length).toBeGreaterThan(20);
    }
  });

  it('scans the real tracked tree clean', () => {
    const result = findOffenders();
    expect(result.offenders, JSON.stringify(result.offenders, null, 2)).toEqual([]);
  });

  it('excludes tests and retired/generated paths from the production scan', () => {
    expect(isExcluded('packages/operator-core/lib/foo.test.ts')).toBe(true);
    expect(isExcluded('_retired/foo.ts')).toBe(true);
    expect(isExcluded('packages/operator-core/dist/foo.ts')).toBe(true);
    expect(isExcluded('packages/operator-core/lib/foo.ts')).toBe(false);
  });
});
