/**
 * The publish-time release gate (D-045 §3b) — the call site that makes
 * `validatePublishableRelease` and `publishPrivateArtifact` production-reachable.
 *
 * The controls matter more than usual here. This gate exists because the two
 * doors had zero non-test callers, so a test that only asserts the happy path
 * would reproduce exactly the condition it was written to end: green, and
 * proving nothing about whether a bad release is actually stopped. Each refusal
 * case below is paired with the passing case it differs from by one field.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PINNING_POLICY, type ArtifactDistributionManifest } from '../p2p/artifact-distribution';
import { buildArtifactPackage, sha256Prefixed } from '../p2p/artifact-package';
import {
  CONTENT_KEY_BYTES,
  type KeyWrapAdapter,
  type WrappedKeyDeliveryAdapter,
} from '../p2p/artifact-encryption';
import { isPrivateVisibility, prepareReleaseForPublish } from './publish-release-gate';
import type { CupboardReleaseManifest } from './listing-manifest';

const CHUNK = 8;
const BYTES = Buffer.from('the-quick-brown-fox-jumps-over-a-lazy-dog!', 'utf8');
const PKG = buildArtifactPackage(BYTES, { chunkSizeBytes: CHUNK });

const release = (overrides: Partial<CupboardReleaseManifest> = {}): CupboardReleaseManifest => ({
  schemaVersion: 1,
  listingKind: 'plugin',
  listingRef: 'demo',
  releaseVersion: '2.0.0',
  contentHash: PKG.rootHash,
  signature: 'release-sig',
  dependencies: [],
  compatibility: { runtime: 'papercusp>=1' },
  permissions: [],
  capabilities: [],
  license: 'MIT',
  publisher: { githubUserId: 42, login: 'avi' },
  reviewStatus: 'approved',
  ...overrides,
});

const publicManifest = (overrides: Partial<ArtifactDistributionManifest> = {}): ArtifactDistributionManifest => ({
  schemaVersion: 1,
  release: release(),
  rootHash: PKG.rootHash,
  totalSizeBytes: PKG.totalSizeBytes,
  chunks: PKG.chunks,
  visibility: 'public',
  encryption: null,
  pinning: DEFAULT_PINNING_POLICY,
  signature: 'manifest-sig',
  ...overrides,
});

/** Reversible stand-in for a real wrapping provider — never a real KMS in a unit test. */
const fakeAdapter: KeyWrapAdapter = {
  providerId: 'fake',
  wrap: async ({ contentKey }) => Buffer.from([...contentKey].reverse()),
  unwrap: async ({ wrapped }) => Buffer.from([...wrapped].reverse()),
};

const contentKey = Buffer.alloc(CONTENT_KEY_BYTES, 7);

/**
 * A delivery provider that actually STORES what it is handed, so the gate's
 * read-back is a real round trip. `delivered` is exposed because the whole point
 * of the check is that a no-op adapter must not pass — see the drop control.
 */
const memoryDelivery = (): WrappedKeyDeliveryAdapter & { readonly delivered: Map<string, Buffer> } => {
  const delivered = new Map<string, Buffer>();
  return {
    providerId: 'memory',
    delivered,
    deliver: async (key) => {
      delivered.set(`${key.recipientId}:${key.wrappedKeyId}`, key.wrapped);
    },
    fetch: async ({ wrappedKeyId, recipientId }) => delivered.get(`${recipientId}:${wrappedKeyId}`) ?? null,
  };
};

describe('prepareReleaseForPublish — public path', () => {
  it('passes a manifest whose root agrees with its chunk list', async () => {
    const r = await prepareReleaseForPublish({ visibility: 'public', manifest: publicManifest(), bytes: BYTES });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.rootHash).toBe(PKG.rootHash);
    // A public release ships its bytes in the clear: nothing to encrypt, no keys.
    expect(r.ciphertext).toBeNull();
    expect(r.wrappedKeys).toEqual([]);
  });

  it('REFUSES the flat-digest address, and proves the diagnosis from the bytes', async () => {
    // The exact mistake the door exists to catch: `sha256(bytes)` is what
    // "contentHash" means everywhere else in this repo, but a distribution
    // address is merkleRoot(chunk digests). The two coincide at no size.
    const flat = sha256Prefixed(BYTES);
    expect(flat).not.toBe(PKG.rootHash);

    const r = await prepareReleaseForPublish({
      visibility: 'public',
      manifest: publicManifest({ rootHash: flat, release: release({ contentHash: flat }) }),
      bytes: BYTES,
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('release-not-publishable');
    // With the bytes supplied the flat derivation is PROVEN, not guessed.
    expect(r.detail).toContain('exactly sha256(bytes)');
  });

  it('still refuses without the bytes, but names both causes instead of one', async () => {
    const flat = sha256Prefixed(BYTES);
    const r = await prepareReleaseForPublish({
      visibility: 'public',
      manifest: publicManifest({ rootHash: flat, release: release({ contentHash: flat }) }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.detail).toContain('cannot tell the two apart');
  });

  it('refuses a manifest that is not a release at all', async () => {
    const r = await prepareReleaseForPublish({ visibility: 'public', manifest: { nope: true } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('release-not-publishable');
  });

  it("treats 'unlisted' as the unencrypted path — it is a catalog axis, not a bytes axis", async () => {
    const r = await prepareReleaseForPublish({ visibility: 'unlisted', manifest: publicManifest(), bytes: BYTES });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.visibility).toBe('public');
    expect(r.ciphertext).toBeNull();
  });
});

describe('prepareReleaseForPublish — private path', () => {
  const privateInput = () =>
    ({
      visibility: 'private',
      release: release({ contentHash: buildArtifactPackage(BYTES, { chunkSizeBytes: CHUNK }).rootHash }),
      plaintext: BYTES,
      contentKey,
      keyVersion: 1,
      recipientIds: ['user-a', 'user-b'],
      adapter: fakeAdapter,
      deliveryAdapter: memoryDelivery(),
      sign: () => 'signed-by-publisher',
      plaintextChunkSizeBytes: CHUNK,
      chunkSizeBytes: CHUNK,
    }) as const;

  it('builds a manifest whose root is the CIPHERTEXT hash, by construction', async () => {
    const r = await prepareReleaseForPublish(privateInput());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.manifest.visibility).toBe('private');
    // The invariant that makes a private manifest coherent: what is distributed
    // is the ciphertext, so the root addresses the ciphertext, not the plaintext.
    expect(r.manifest.encryption).not.toBeNull();
    expect(r.manifest.rootHash).toBe(r.manifest.encryption!.ciphertextHash);
    expect(r.manifest.rootHash).not.toBe(r.manifest.release.contentHash);
    expect(r.ciphertext).not.toBeNull();
    expect(r.manifest.rootHash).toBe(buildArtifactPackage(r.ciphertext!, { chunkSizeBytes: CHUNK }).rootHash);
  });

  it('wraps the content key once per recipient and keeps the material out of the manifest', async () => {
    const r = await prepareReleaseForPublish(privateInput());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.wrappedKeys).toHaveLength(2);
    expect(r.wrappedKeys.map((k) => k.recipientId)).toEqual(['user-a', 'user-b']);
    // The manifest carries only the IDENTIFIERS; the wrapped bytes travel out of band.
    expect(r.manifest.encryption!.wrappedKeyIds).toEqual(r.wrappedKeys.map((k) => k.wrappedKeyId));
    expect(JSON.stringify(r.manifest)).not.toContain(contentKey.toString('base64'));
  });

  it('signs the canonical unsigned manifest and carries the signature through', async () => {
    // Declare the parameter: an untyped `vi.fn(() => ...)` types mock.calls as
    // an EMPTY tuple, so reading calls[0][0] is a type error even though the
    // call happens at runtime — vitest would stay green while tsc failed.
    const sign = vi.fn((_signingBytes: Buffer) => 'sig-xyz');
    const r = await prepareReleaseForPublish({ ...privateInput(), sign });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(sign).toHaveBeenCalledTimes(1);
    const signed = sign.mock.calls[0]![0];
    expect(Buffer.isBuffer(signed)).toBe(true);

    // The manifest being signed must not already carry its OWN signature —
    // asserted on the parsed top-level key, not as a substring: the EMBEDDED
    // release manifest legitimately has a `signature` of its own, so a
    // substring check here passes or fails for the wrong reason.
    const signedManifest = JSON.parse(signed.toString('utf8')) as Record<string, unknown>;
    expect('signature' in signedManifest).toBe(false);
    expect((signedManifest.release as { signature: string }).signature).toBe('release-sig');
    expect(r.manifest.signature).toBe('sig-xyz');
  });

  it('REFUSES when the plaintext does not address to the declared contentHash', async () => {
    // One field different from the passing case above.
    const r = await prepareReleaseForPublish({
      ...privateInput(),
      release: release({ contentHash: sha256Prefixed(Buffer.from('some-other-artifact')) }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('private-publication-failed');
    expect(r.detail).toContain('addresses to');
  });

  it('returns a refusal rather than throwing when signing fails', async () => {
    const r = await prepareReleaseForPublish({
      ...privateInput(),
      sign: () => {
        throw new Error('hsm offline');
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('private-publication-failed');
    expect(r.detail).toContain('hsm offline');
  });

  it('DELIVERS one wrapped key per recipient out of band and reports the ids', async () => {
    const deliveryAdapter = memoryDelivery();
    const r = await prepareReleaseForPublish({ ...privateInput(), deliveryAdapter });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // The evidence that the ciphertext is openable: every id the manifest
    // committed to was delivered, and each is fetchable back by its recipient —
    // which is exactly the lookup `openRetrievedArtifact` performs at install.
    expect([...r.deliveredKeyIds].sort()).toEqual([...r.manifest.encryption!.wrappedKeyIds].sort());
    expect(deliveryAdapter.delivered.size).toBe(2);
    for (const key of r.wrappedKeys) {
      await expect(
        deliveryAdapter.fetch({ wrappedKeyId: key.wrappedKeyId, recipientId: key.recipientId }),
      ).resolves.not.toBeNull();
    }
  });

  it('REFUSES a private publish whose keys are accepted but never stored (the no-op provider)', async () => {
    // The control that makes the read-back meaningful: `deliver` resolves, so
    // `deliverWrappedKeys` reports every id as delivered — and the release is
    // still refused, because nothing can be fetched back. Without the read-back
    // this case publishes ciphertext no buyer can ever open.
    const r = await prepareReleaseForPublish({
      ...privateInput(),
      deliveryAdapter: {
        providerId: 'no-op',
        deliver: async () => undefined,
        fetch: async () => null,
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('key-delivery-failed');
    expect(r.detail).toContain('cannot be fetched back');
  });

  it('returns a refusal rather than throwing when wrapped-key delivery fails', async () => {
    const r = await prepareReleaseForPublish({
      ...privateInput(),
      deliveryAdapter: {
        providerId: 'broken',
        deliver: async () => {
          throw new Error('key bus offline');
        },
        fetch: async () => null,
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('key-delivery-failed');
    expect(r.detail).toContain('key bus offline');
  });

  it('returns a refusal rather than throwing when the wrap adapter fails', async () => {
    const r = await prepareReleaseForPublish({
      ...privateInput(),
      adapter: {
        providerId: 'broken',
        wrap: async () => {
          throw new Error('wrap denied');
        },
        unwrap: async () => Buffer.alloc(0),
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('private-publication-failed');
  });
});

describe('isPrivateVisibility', () => {
  it('is true only for private — unlisted is a catalog axis, not an encryption one', () => {
    expect(isPrivateVisibility('private')).toBe(true);
    expect(isPrivateVisibility('unlisted')).toBe(false);
    expect(isPrivateVisibility('public')).toBe(false);
    expect(isPrivateVisibility(null)).toBe(false);
    expect(isPrivateVisibility(undefined)).toBe(false);
  });
});
