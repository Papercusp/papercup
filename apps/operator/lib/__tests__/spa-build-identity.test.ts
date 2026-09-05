/**
 * Bundle-identity guard (EI-15848).
 *
 * WHAT IS LOAD-BEARING HERE: `shouldOfferReload` exists to be FALSE in the two
 * unknown cases, and a bare `loaded !== served` would pass a naive "differs ⇒
 * prompt" test while failing exactly those. So the null cases are the real
 * subject, and they are paired with a positive control (`differs ⇒ true`) so the
 * pair cannot both pass by the predicate having been stubbed to a constant
 * false — which would silence the feature entirely while looking green.
 *
 * `readBundleIdentity` is tested against real files in a temp dir rather than a
 * mocked fs: its whole contract is "same bytes ⇒ same id, different bytes ⇒
 * different id, unreadable ⇒ null", and a mock would be asserting the mock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldOfferReload } from '../spa-build-identity';
import { readBundleIdentity } from '../spa-build-status';

describe('shouldOfferReload', () => {
  it('offers a reload when both ids are known and differ (positive control)', () => {
    expect(shouldOfferReload('aaaa', 'bbbb')).toBe(true);
  });

  it('stays silent when the ids match', () => {
    expect(shouldOfferReload('aaaa', 'aaaa')).toBe(false);
  });

  // The two cases a bare `!==` gets WRONG. Each would nag on every rebuild
  // (served null, mid-swap) or on every pre-feature page (loaded null).
  it('stays silent when the page injected no id — unknown is not stale', () => {
    expect(shouldOfferReload(null, 'bbbb')).toBe(false);
  });

  it('stays silent when the bundle is missing or mid-swap — unknown is not stale', () => {
    expect(shouldOfferReload('aaaa', null)).toBe(false);
  });

  it('treats an empty-string id as unknown, not as a real differing id', () => {
    expect(shouldOfferReload('', 'bbbb')).toBe(false);
    expect(shouldOfferReload('aaaa', '')).toBe(false);
  });
});

describe('readBundleIdentity', () => {
  let dist: string;

  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'spa-build-identity-'));
  });
  afterEach(() => {
    rmSync(dist, { recursive: true, force: true });
  });

  const writeIndex = (html: string) => writeFileSync(join(dist, 'index.html'), html, 'utf8');

  it('returns null when the bundle is missing — no opinion, never a mismatch', () => {
    expect(readBundleIdentity(dist)).toBeNull();
  });

  it('is stable for identical bytes', () => {
    writeIndex('<html><script src="/assets/index-abc123.js"></script></html>');
    const first = readBundleIdentity(dist);
    expect(first).toBeTruthy();
    expect(readBundleIdentity(dist)).toBe(first);
  });

  it('changes when the referenced content-hashed asset changes — the real signal', () => {
    writeIndex('<html><script src="/assets/index-abc123.js"></script></html>');
    const before = readBundleIdentity(dist);
    writeIndex('<html><script src="/assets/index-def456.js"></script></html>');
    expect(readBundleIdentity(dist)).not.toBe(before);
  });

  it('returns null rather than throwing when index.html is not a readable file', () => {
    // A directory at the index path reproduces the unreadable case without
    // depending on running as a non-root user (this fleet often does not).
    mkdirSync(join(dist, 'index.html'));
    expect(readBundleIdentity(dist)).toBeNull();
  });

  it('produces a short hex id, so it is cheap to inject and compare', () => {
    writeIndex('<html></html>');
    expect(readBundleIdentity(dist)).toMatch(/^[0-9a-f]{16}$/);
  });
});
