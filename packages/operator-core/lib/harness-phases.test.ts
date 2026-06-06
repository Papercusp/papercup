/**
 * Coverage for harness-phases: phasePhaseLabel (query-string → Phase, defaulting
 * to staging) and phasePath (staging → project.path; testing/production → the
 * per-phase `path` override carried on the resolved project's `phases` blob from
 * the workspace-PG registry, or the `<path>--<phase>` convention). phasePath is
 * PURE (no config.json / fs read) since `deprecate-harness-config-json-2026-06-06`.
 */
import { describe, expect, it } from 'vitest';
import { phasePath, phasePhaseLabel, ALL_PHASES } from './harness-phases';

describe('phasePhaseLabel', () => {
  it('passes through the three known phases', () => {
    expect(phasePhaseLabel('staging')).toBe('staging');
    expect(phasePhaseLabel('testing')).toBe('testing');
    expect(phasePhaseLabel('production')).toBe('production');
  });
  it('defaults unknown / undefined to staging', () => {
    expect(phasePhaseLabel(undefined)).toBe('staging');
    expect(phasePhaseLabel('garbage')).toBe('staging');
  });
  it('ALL_PHASES is the canonical triple', () => {
    expect([...ALL_PHASES].sort()).toEqual(['production', 'staging', 'testing']);
  });
});

describe('phasePath', () => {
  it('staging resolves to project.path verbatim', () => {
    expect(phasePath({ path: '/proj' }, 'staging')).toBe('/proj');
  });

  it('testing uses the per-phase `path` override from the project registry entry', () => {
    expect(
      phasePath({ path: '/proj', phases: { testing: { path: '/custom/testing' } } }, 'testing'),
    ).toBe('/custom/testing');
  });

  it('falls back to <path>--<phase> when no per-phase override exists', () => {
    // an override for testing but NOT production → convention for production.
    expect(
      phasePath({ path: '/proj', phases: { testing: { path: '/custom/testing' } } }, 'production'),
    ).toBe('/proj--production');
    // no phases blob at all → convention for any non-staging phase.
    expect(phasePath({ path: '/proj' }, 'testing')).toBe('/proj--testing');
  });
});
