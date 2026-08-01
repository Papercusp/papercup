/**
 * EI-133: the su rubric's own docstring has long claimed "the deterministic
 * asserts are the load-bearing check — D-002, the judge is secondary" — but
 * until this fix, `runScenario`/`computeRunStatus` (libs/testing-shell)
 * treated ANY error-severity judge finding as fatal regardless, so the D-002
 * comment was documentation only, not enforced behavior. This test pins the
 * rubric-side half of the fix: SU_RUBRIC actually opts into `judgeAdvisory`,
 * so a future edit can't silently drop the flag while leaving the D-002
 * comment in place. (The runner-side half — a judgeAdvisory rubric's
 * judge-only error finding not flipping status to `failed` — is covered by
 * libs/testing-shell/src/llm/__tests__/compute-run-status.test.ts.)
 */
import { describe, expect, it } from 'vitest';

import { SU_RUBRIC, SU_RUBRIC_VERSION } from '../rubrics/su';

describe('SU_RUBRIC judgeAdvisory (EI-133)', () => {
  it('opts the judge into advisory-only status (deterministic asserts stay load-bearing)', () => {
    expect(SU_RUBRIC.judgeAdvisory).toBe(true);
  });

  it('carries a version, referenced from the same module (feeds the per-run identity hash)', () => {
    expect(SU_RUBRIC.version).toBe(SU_RUBRIC_VERSION);
    expect(typeof SU_RUBRIC_VERSION).toBe('string');
  });
});
