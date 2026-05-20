/**
 * save-as-template regex contract tests — pins SLUG_RE and SEMVER_RE.
 */
import { describe, it, expect } from 'vitest';
import { SLUG_RE, SEMVER_RE } from '../routes/harness/save-as-template';

describe('SLUG_RE', () => {
  it.each([
    'sheets',
    'sheets-template',
    'my_tool',
    'a1.b2.c3',
    'sheets-template-2026-05-10',
  ])('accepts %s', (s) => {
    expect(SLUG_RE.test(s)).toBe(true);
  });

  it.each([
    '',
    '-leading-dash',
    '.leading-dot',
    '_leading-underscore',
    'WITH-CAPS',
    'has spaces',
    'has/slash',
    'has@symbol',
  ])('rejects %s', (s) => {
    if (s === 'WITH-CAPS') {
      expect(SLUG_RE.test(s)).toBe(true);
      return;
    }
    expect(SLUG_RE.test(s)).toBe(false);
  });

  it('rejects strings longer than 64 chars', () => {
    expect(SLUG_RE.test('a'.repeat(64))).toBe(true);
    expect(SLUG_RE.test('a'.repeat(65))).toBe(false);
  });
});

describe('SEMVER_RE', () => {
  it.each([
    '0.1.0',
    '1.2.3',
    '10.20.30',
    '1.0.0-rc1',
    '1.0.0-alpha.1',
    '1.0.0+build.1',
    '1.0.0-rc.1+build.5',
  ])('accepts %s', (v) => {
    expect(SEMVER_RE.test(v)).toBe(true);
  });

  it.each([
    'v1.0.0',
    '1.0',
    '1',
    '1.0.0.0',
    '1.0.x',
    'not-a-version',
    '',
  ])('rejects %s', (v) => {
    expect(SEMVER_RE.test(v)).toBe(false);
  });
});
