/**
 * testing-run-source.test.ts — unit tests for the source resolver.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-014 follow-up.
 */
import { describe, it, expect } from 'vitest';
import { resolveTestRunSource } from '../testing-run-source';

const PLACEMENT_CONTROL_FILE = 'packages/operator-core/lib/goal-plan-placement-exclusion-proof.test.ts';
const PLACEMENT_CONTROLS = [
  'holder-not-independent',
  'independent-member-positive',
  'existing-one-fleet',
  'drain-and-test-excluded',
] as const;

describe('resolveTestRunSource', () => {
  it("env override 'admin-ui' wins over CI", () => {
    expect(resolveTestRunSource({ PAPERCUSP_TEST_RUN_SOURCE: 'admin-ui', CI: '1' })).toBe('admin-ui');
  });

  it("env override 'ci' is honored", () => {
    expect(resolveTestRunSource({ PAPERCUSP_TEST_RUN_SOURCE: 'ci' })).toBe('ci');
  });

  it("env override 'local' is honored", () => {
    expect(resolveTestRunSource({ PAPERCUSP_TEST_RUN_SOURCE: 'local', CI: '1' })).toBe('local');
  });

  it('invalid override falls back to CI/local detection', () => {
    expect(resolveTestRunSource({ PAPERCUSP_TEST_RUN_SOURCE: 'bogus', CI: '1' })).toBe('ci');
    expect(resolveTestRunSource({ PAPERCUSP_TEST_RUN_SOURCE: 'bogus' })).toBe('local');
  });

  it('CI=truthy with no override → ci', () => {
    expect(resolveTestRunSource({ CI: 'true' })).toBe('ci');
  });

  it('no env signals → local', () => {
    expect(resolveTestRunSource({})).toBe('local');
  });

  it('empty-string override → falls back (truthiness check)', () => {
    expect(resolveTestRunSource({ PAPERCUSP_TEST_RUN_SOURCE: '', CI: '1' })).toBe('ci');
    expect(resolveTestRunSource({ PAPERCUSP_TEST_RUN_SOURCE: '' })).toBe('local');
  });

  it('default arg reads process.env — does not throw without explicit env', () => {
    expect(() => resolveTestRunSource()).not.toThrow();
  });

  it.each(PLACEMENT_CONTROLS)('marks controlled placement fixture %s as mutation-probe', (control) => {
    expect(resolveTestRunSource({ PAPERCUSP_PLACEMENT_EXCLUSION_CONTROL: control }, PLACEMENT_CONTROL_FILE))
      .toBe('mutation-probe');
  });

  it('limits the controlled-fixture marker to known controls on the exact test file', () => {
    expect(resolveTestRunSource({}, PLACEMENT_CONTROL_FILE)).toBe('local');
    expect(resolveTestRunSource(
      { PAPERCUSP_PLACEMENT_EXCLUSION_CONTROL: 'holder-not-independent' },
      'packages/operator-core/lib/another.test.ts',
    )).toBe('local');
    expect(resolveTestRunSource(
      { PAPERCUSP_PLACEMENT_EXCLUSION_CONTROL: 'unknown-control' },
      PLACEMENT_CONTROL_FILE,
    )).toBe('local');
    expect(resolveTestRunSource({ PAPERCUSP_PLACEMENT_EXCLUSION_CONTROL: 'holder-not-independent' }))
      .toBe('local');
  });
});
