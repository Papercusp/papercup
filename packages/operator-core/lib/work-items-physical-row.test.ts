/**
 * WI-10006010 — the pure half of physical-row pinning. The DB-backed proof that a write leaves
 * every slug twin byte-identical lives in issues-engineer.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { harnessPreference, harnessSlugMatches, pickPhysicalSlug } from './work-items-physical-row';

describe('harnessPreference', () => {
  it('treats blank, null and the * wildcard as no preference', () => {
    expect(harnessPreference(undefined)).toBeNull();
    expect(harnessPreference(null)).toBeNull();
    expect(harnessPreference('  ')).toBeNull();
    expect(harnessPreference('*')).toBeNull();
    expect(harnessPreference(' papercusp ')).toBe('papercusp');
  });
});

describe('harnessSlugMatches', () => {
  it('matches bare, prefixed and verbatim non-harness slugs', () => {
    expect(harnessSlugMatches('papercusp', 'papercusp')).toBe(true);
    expect(harnessSlugMatches('harness:papercusp', 'papercusp')).toBe(true);
    expect(harnessSlugMatches('papercusp', 'harness:papercusp')).toBe(true);
    expect(harnessSlugMatches('operator:papercusp-workspace', 'operator:papercusp-workspace')).toBe(true);
  });

  it('control: does not match a different harness or a prefix of one', () => {
    expect(harnessSlugMatches('operator:papercusp-workspace', 'papercusp')).toBe(false);
    expect(harnessSlugMatches('papercusp-public-site-pot', 'papercusp')).toBe(false);
  });
});

describe('pickPhysicalSlug', () => {
  // Ordered as resolveIssuePhysicalSlug returns them: most recently updated first.
  const twins = ['operator:papercusp-workspace', 'papercusp'];

  it('pins the named harness even when it is not the most recent row', () => {
    expect(pickPhysicalSlug(twins, 'papercusp')).toBe('papercusp');
    expect(pickPhysicalSlug(twins, 'harness:papercusp')).toBe('papercusp');
    expect(pickPhysicalSlug(twins, 'operator:papercusp-workspace')).toBe('operator:papercusp-workspace');
  });

  it('falls back to the most recent row when no harness, a wildcard, or a non-matching harness is named', () => {
    expect(pickPhysicalSlug(twins)).toBe('operator:papercusp-workspace');
    expect(pickPhysicalSlug(twins, '*')).toBe('operator:papercusp-workspace');
    // A loosely passed harness must not turn a single-row id into "not found".
    expect(pickPhysicalSlug(['papercusp'], 'some-other-pot')).toBe('papercusp');
  });

  it('returns null only when the id has no row', () => {
    expect(pickPhysicalSlug([], 'papercusp')).toBeNull();
  });
});
