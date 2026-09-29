import { describe, expect, it } from 'vitest';
import { IDENTITY_OMISSION_REASONS, OMITTED_DECISION_PATTERN } from './omission-reasons';

describe('identity omission reasons', () => {
  it('parses back every reason the binder can write as `omitted:<reason>`', () => {
    // source.ts writes `status: 'omitted:' + reason`; role-launch-spec.ts parses it
    // back with this pattern. A reason the writer accepts but the reader drops is
    // the drift this shared list exists to prevent.
    for (const reason of IDENTITY_OMISSION_REASONS) {
      expect(OMITTED_DECISION_PATTERN.test(`omitted:${reason}`)).toBe(true);
    }
  });

  it('includes the R-4 / D-032 experiment-arm reason', () => {
    expect(IDENTITY_OMISSION_REASONS).toContain('experiment-arm');
    expect(OMITTED_DECISION_PATTERN.test('omitted:experiment-arm')).toBe(true);
  });

  it('rejects unknown reasons and partial matches', () => {
    for (const decision of ['omitted:', 'omitted:bogus', 'omitted:experiment-arm-x', 'xomitted:ineligible', 'bound']) {
      expect(OMITTED_DECISION_PATTERN.test(decision)).toBe(false);
    }
  });
});
