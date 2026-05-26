/**
 * Coverage for the P-021 sub-harness slug guard used by register-subs.
 * Per audit follow-up to `plans-newbutton-and-subharness-scope-2026-05-25`.
 */
import { describe, expect, it } from 'vitest';
import { isSafeSubHarnessSlug } from '../projects';

describe('isSafeSubHarnessSlug', () => {
  it('accepts a typical qualified sub-harness slug', () => {
    expect(isSafeSubHarnessSlug('papercup/libs/sync')).toBe(true);
    expect(isSafeSubHarnessSlug('papercup')).toBe(true);
    expect(isSafeSubHarnessSlug('a/b/c/d')).toBe(true);
  });

  it('rejects path-traversal segments', () => {
    expect(isSafeSubHarnessSlug('papercup/..')).toBe(false);
    expect(isSafeSubHarnessSlug('papercup/../etc')).toBe(false);
    expect(isSafeSubHarnessSlug('..')).toBe(false);
    expect(isSafeSubHarnessSlug('./foo')).toBe(false);
  });

  it('rejects leading absolute-path markers', () => {
    expect(isSafeSubHarnessSlug('/abs/path')).toBe(false);
    expect(isSafeSubHarnessSlug('\\abs\\path')).toBe(false);
  });

  it('rejects empty / empty-segment slugs', () => {
    expect(isSafeSubHarnessSlug('')).toBe(false);
    expect(isSafeSubHarnessSlug('papercup//sync')).toBe(false);
    expect(isSafeSubHarnessSlug('/')).toBe(false);
    expect(isSafeSubHarnessSlug('a/')).toBe(false);
  });

  it('rejects control chars and whitespace inside segments', () => {
    expect(isSafeSubHarnessSlug('papercup/li bs')).toBe(false);
    expect(isSafeSubHarnessSlug('papercup/lib\tname')).toBe(false);
    expect(isSafeSubHarnessSlug('papercup/lib\nname')).toBe(false);
    expect(isSafeSubHarnessSlug('papercup/lib\x00name')).toBe(false);
  });

  it('rejects absurdly long slugs', () => {
    expect(isSafeSubHarnessSlug('a/'.repeat(110) + 'b')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isSafeSubHarnessSlug(null as unknown as string)).toBe(false);
    expect(isSafeSubHarnessSlug(undefined as unknown as string)).toBe(false);
    expect(isSafeSubHarnessSlug(123 as unknown as string)).toBe(false);
  });
});
