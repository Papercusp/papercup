import { describe, expect, it } from 'vitest';

import {
  OPERATOR_RUBRIC,
  OPERATOR_RUBRIC_HIGH_CRITICALITY,
  OPERATOR_RUBRIC_HIGH_CRITICALITY_VERSION,
  OPERATOR_RUBRIC_VERSION,
} from '../rubrics/operator';

describe('operator rubric versions', () => {
  it('keeps each composed rubric aligned with its exported version', () => {
    expect(OPERATOR_RUBRIC.version).toBe(OPERATOR_RUBRIC_VERSION);
    expect(OPERATOR_RUBRIC_HIGH_CRITICALITY.version).toBe(OPERATOR_RUBRIC_HIGH_CRITICALITY_VERSION);
  });

  it('separates normal and high-criticality trend identities', () => {
    expect(OPERATOR_RUBRIC_HIGH_CRITICALITY.criticality).toBe('high');
    expect(OPERATOR_RUBRIC_HIGH_CRITICALITY_VERSION).not.toBe(OPERATOR_RUBRIC_VERSION);
  });
});
