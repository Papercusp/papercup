import { describe, expect, it } from 'vitest';
import { listingManifestDigest, listingManifestSigningBytes, sameListingRelease, validateListingManifest, type CupboardReleaseManifest } from './listing-manifest';

const manifest = (overrides: Partial<CupboardReleaseManifest> = {}): CupboardReleaseManifest => ({
  schemaVersion: 1, listingKind: 'plugin', listingRef: 'demo', releaseVersion: '1.0.0',
  contentHash: `sha256:${'a'.repeat(64)}`, signature: 'sig', dependencies: ['node>=25'],
  compatibility: { runtime: 'papercusp>=1' }, permissions: ['network:read'], capabilities: ['tool:invoke'],
  license: 'MIT', publisher: { githubUserId: 42, login: 'avi' }, reviewStatus: 'approved', ...overrides,
});

describe('Cupboard listing/release manifest', () => {
  it('validates the immutable signed release shape and canonical bytes', () => {
    const m = manifest();
    expect(validateListingManifest(m)).toEqual({ ok: true, manifest: m });
    expect(listingManifestSigningBytes({ ...m, signature: undefined as never })).toBeInstanceOf(Buffer);
    expect(listingManifestDigest({ ...m, signature: undefined as never })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects malformed hashes, publisher ids, and review states', () => {
    expect(validateListingManifest(manifest({ contentHash: 'sha256:nope' })).ok).toBe(false);
    expect(validateListingManifest(manifest({ publisher: { githubUserId: 0 } })).ok).toBe(false);
    expect(validateListingManifest(manifest({ reviewStatus: 'pending' })).ok).toBe(true);
  });

  it('uses content hash plus listing identity for immutable release equality', () => {
    expect(sameListingRelease(manifest(), manifest({ signature: 'different' }))).toBe(true);
    expect(sameListingRelease(manifest(), manifest({ releaseVersion: '1.0.1' }))).toBe(false);
  });
});
