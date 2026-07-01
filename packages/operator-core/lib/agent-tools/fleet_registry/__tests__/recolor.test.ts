/**
 * Unit smoke for fleet:recolor (fleet-recolor-and-color-hardening P-001). The
 * handler persists (setFleetScheme) + fans recolorViaPty across the live roster —
 * all PG / pty IO, so (like launch-on-plan.test.ts) there is no pure unit surface
 * for the happy path. What we CAN assert without IO: the module imports + self-
 * registers cleanly (its whole import chain compiles + loads — the defineTool runs
 * on import), and the curated-catalog reference it validates against is non-empty.
 */
import { describe, it, expect } from 'vitest';
import tool from '../recolor';
import { COLOR_SCHEMES } from '../../../console-color-schemes';

describe('fleet:recolor', () => {
  it('loads + self-registers the tool module without error', () => {
    expect(tool).toBeTruthy();
  });

  it('validates against a non-empty curated catalog (the valid-names list it returns)', () => {
    expect(COLOR_SCHEMES.length).toBeGreaterThan(0);
    expect(COLOR_SCHEMES.every((s) => /^#[0-9a-f]{6}$/.test(s.bg))).toBe(true);
  });
});
