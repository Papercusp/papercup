/**
 * testing-run-source.test.ts — unit tests for the source resolver.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-014 follow-up.
 */
import { describe, it, expect } from 'vitest';
import { resolveTestRunSource } from '../testing-run-source';

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
});
