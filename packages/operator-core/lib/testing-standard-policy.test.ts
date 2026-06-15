/**
 * testing-standard-policy.test.ts — renderTestingStandard injects the shared
 * "write tests the project way" clause for tests-acceptance hives, and the
 * domain-agnostic VERIFICATION_STANDARD for any non-tests acceptance kind
 * (judge / human-gate / none). This mirrors the spawned-bee base's conditional
 * so the two prompt bases can't desync (hive-blueprint-generalization P-008).
 */
import { describe, expect, it } from 'vitest';
import { TESTING_STANDARD, VERIFICATION_STANDARD } from '@papercusp/orchestrator/role-prompt';
import { renderTestingStandard } from './testing-standard-policy';

describe('renderTestingStandard', () => {
  it('defaults to the testing standard when no acceptance kind is given', () => {
    expect(renderTestingStandard()).toBe(TESTING_STANDARD);
  });

  it('returns the testing standard for a tests-acceptance hive', () => {
    expect(renderTestingStandard('tests')).toBe(TESTING_STANDARD);
  });

  it.each(['judge', 'human-gate', 'none'] as const)(
    'returns the verification standard for acceptance kind "%s"',
    (kind) => {
      expect(renderTestingStandard(kind)).toBe(VERIFICATION_STANDARD);
    },
  );

  it('the two clauses are distinct, so the branch is observable', () => {
    expect(TESTING_STANDARD).not.toBe(VERIFICATION_STANDARD);
  });
});
