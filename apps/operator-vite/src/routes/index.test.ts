import { describe, expect, it } from 'vitest';
import { firstRunTarget } from './index';

describe('firstRunTarget (agent-first-onboarding P-003)', () => {
  it('sends unfinished first-runs to the Onboarding Console when the flag is on', () => {
    expect(firstRunTarget(true)).toBe('/onboarding');
  });
  it('falls back to the classic GUI wizard when the flag is off', () => {
    expect(firstRunTarget(false)).toBe('/setup');
  });
});
