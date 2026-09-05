import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PINNING_POLICY,
  resolveDistributionSources,
  validateDistributionManifest,
  type ArtifactDistributionManifest,
  type ArtifactDistributionState,
  type DistributionSource,
} from './artifact-distribution';
import { acceptRetrievedChunk, beginRetrieval, buildArtifactPackage, completeRetrieval, merkleRoot, sha256Prefixed } from './artifact-package';
import {
  ARTIFACT_ENCRYPTION_SCHEME,
  AUTH_TAG_BYTES,
  CONTENT_KEY_BYTES,
  ENCRYPTED_BLOB_HEADER_BYTES,
  IV_BYTES,
  artifactEncryptionAad,
  contentKeysEqual,
  createKeyWrapRegistry,
  createWrappedKeyDeliveryRegistry,
  decryptArtifact,
  deliverWrappedKeys,
  encryptArtifact,
  generateContentKey,
  openRetrievedArtifact,
  planKeyRotation,
  plaintextContentAddress,
  publishPrivateArtifact,
  revocationOutcome,
  unwrapContentKey,
  wrapContentKeyForRecipients,
  wrappedKeyId,
  type KeyWrapAdapter,
  type WrappedKey,
  type WrappedKeyDeliveryAdapter,
} from './artifact-encryption';
import type { CupboardReleaseManifest } from '../cupboard/listing-manifest';

const PLAINTEXT = Buffer.from('the-secret-payload-that-only-entitled-holders-may-read', 'utf8');
/**
 * The release's content address is the MERKLE root, never `sha256(bytes)`
 * (EI-22433992128803548). `plaintextFlatDigest` exists only so the tests can
 * assert the two are genuinely different values rather than assuming it.
 */
const PLAINTEXT_HASH = plaintextContentAddress(PLAINTEXT);
const PLAINTEXT_FLAT_DIGEST = sha256Prefixed(PLAINTEXT);
const KEY = Buffer.alloc(CONTENT_KEY_BYTES, 7);
const OTHER_KEY = Buffer.alloc(CONTENT_KEY_BYTES, 9);
const IV = Buffer.alloc(IV_BYTES, 3);

const binding = (overrides: { releaseContentHash?: string; keyVersion?: number } = {}) => ({
  releaseContentHash: overrides.releaseContentHash ?? PLAINTEXT_HASH,
  keyVersion: overrides.keyVersion ?? 1,
});

const release = (overrides: Partial<CupboardReleaseManifest> = {}): CupboardReleaseManifest => ({
  schemaVersion: 1,
  listingKind: 'plugin',
  listingRef: 'private-demo',
  releaseVersion: '2.0.0',
  contentHash: PLAINTEXT_HASH,
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

/**
 * A deterministic wrap adapter. Deliberately NOT real asymmetric crypto: the
 * module under test must be indifferent to how a provider wraps, so the test
 * proves the SEAM rather than a particular provider's cipher.
 */
const wrapAdapter = (overrides: Partial<KeyWrapAdapter> = {}): KeyWrapAdapter => ({
  providerId: 'test-wrap',
  async wrap({ contentKey, recipientId, keyVersion }) {
    const mask = createHash('sha256').update(`${recipientId}:${keyVersion}`).digest();
    return Buffer.from(contentKey.map((byte, index) => byte ^ mask[index]!));
  },
  async unwrap({ wrapped, recipientId, keyVersion }) {
    const mask = createHash('sha256').update(`${recipientId}:${keyVersion}`).digest();
    return Buffer.from(wrapped.map((byte, index) => byte ^ mask[index]!));
  },
  ...overrides,
});

const deliveryAdapter = (): WrappedKeyDeliveryAdapter & { readonly store: Map<string, Buffer> } => {
  const store = new Map<string, Buffer>();
  return {
    providerId: 'test-delivery',
    store,
    async deliver(key: WrappedKey) {
      store.set(`${key.wrappedKeyId}:${key.recipientId}`, key.wrapped);
    },
    async fetch({ wrappedKeyId: id, recipientId }) {
      return store.get(`${id}:${recipientId}`) ?? null;
    },
  };
};

const state = (overrides: Partial<ArtifactDistributionState> = {}): ArtifactDistributionState => ({
  streamId: 'stream-1',
  manifest: null,
  sources: [],
  pins: [],
  keyVersion: 1,
  revokedKeyVersions: [],
  yankedAtMs: null,
  yankReason: null,
  lastSequence: 0,
  ...overrides,
});

describe('artifact encryption (P-027)', () => {
  describe('AES-256-GCM round trip', () => {
    it('CALIBRATION: encrypt then decrypt reproduces the plaintext exactly', () => {
      const encrypted = encryptArtifact(PLAINTEXT, KEY, binding(), { iv: IV });
      const opened = decryptArtifact(encrypted.bytes, KEY, binding());
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(opened.plaintext.equals(PLAINTEXT)).toBe(true);
    });

    it('frames the blob as version || iv || authTag || ciphertext', () => {
      const encrypted = encryptArtifact(PLAINTEXT, KEY, binding(), { iv: IV });
      expect(encrypted.bytes.length).toBe(ENCRYPTED_BLOB_HEADER_BYTES + PLAINTEXT.length);
      expect(encrypted.bytes.readUInt8(0)).toBe(1);
      expect(encrypted.bytes.subarray(1, 1 + IV_BYTES).equals(IV)).toBe(true);
      expect(ENCRYPTED_BLOB_HEADER_BYTES).toBe(1 + IV_BYTES + AUTH_TAG_BYTES);
      expect(encrypted.scheme).toBe(ARTIFACT_ENCRYPTION_SCHEME);
    });

    it('is randomised: two encryptions of the same plaintext differ', () => {
      const a = encryptArtifact(PLAINTEXT, KEY, binding());
      const b = encryptArtifact(PLAINTEXT, KEY, binding());
      expect(a.bytes.equals(b.bytes)).toBe(false);
    });

    it('refuses an empty plaintext and a wrong-length key', () => {
      expect(() => encryptArtifact(Buffer.alloc(0), KEY, binding())).toThrow(/at least one plaintext byte/);
      expect(() => encryptArtifact(PLAINTEXT, Buffer.alloc(16), binding())).toThrow(/exactly 32 bytes/);
      expect(() => encryptArtifact(PLAINTEXT, KEY, binding({ keyVersion: 0 }))).toThrow(/keyVersion/);
    });
  });

  describe('there is exactly ONE content address, and it is the Merkle root', () => {
    // Regression guard for EI-22433992128803548: computing the obvious
    // sha256(bytes) here would make every plaintext check reject a correctly
    // published release, and the failure would surface far away at retrieval.
    it('is the P-025 package root, NOT a flat sha256 of the bytes', () => {
      expect(PLAINTEXT_HASH).toBe(buildArtifactPackage(PLAINTEXT).rootHash);
      expect(PLAINTEXT_HASH).not.toBe(PLAINTEXT_FLAT_DIGEST);
    });

    it('differs from the flat digest even for a single chunk', () => {
      const tiny = Buffer.from('x', 'utf8');
      expect(plaintextContentAddress(tiny)).toBe(merkleRoot([sha256Prefixed(tiny)]));
      expect(plaintextContentAddress(tiny)).not.toBe(sha256Prefixed(tiny));
    });

    it('depends on the chunk size, so a non-default packaging must say so', () => {
      expect(plaintextContentAddress(PLAINTEXT, 8)).not.toBe(plaintextContentAddress(PLAINTEXT));
    });
  });

  describe('AAD binding — one control per property', () => {
    // Each case changes EXACTLY ONE field of the binding, so a passing
    // assertion pins that field specifically rather than "something differed".
    it('refuses a ciphertext replayed under a DIFFERENT release (only the release changes)', () => {
      const encrypted = encryptArtifact(PLAINTEXT, KEY, binding(), { iv: IV });
      const otherRelease = sha256Prefixed(Buffer.from('a-different-release', 'utf8'));
      const opened = decryptArtifact(encrypted.bytes, KEY, binding({ releaseContentHash: otherRelease }));
      expect(opened).toMatchObject({ ok: false, code: 'auth-failed' });
    });

    it('refuses a ciphertext replayed under a DIFFERENT key version (only the version changes)', () => {
      const encrypted = encryptArtifact(PLAINTEXT, KEY, binding({ keyVersion: 1 }), { iv: IV });
      const opened = decryptArtifact(encrypted.bytes, KEY, binding({ keyVersion: 2 }));
      expect(opened).toMatchObject({ ok: false, code: 'auth-failed' });
    });

    it('binds the AAD to exactly the release hash and key version', () => {
      const aad = JSON.parse(artifactEncryptionAad(binding({ keyVersion: 4 })).toString('utf8')) as Record<string, unknown>;
      expect(aad.releaseContentHash).toBe(PLAINTEXT_HASH.toLowerCase());
      expect(aad.keyVersion).toBe(4);
      // Case-insensitive on the hash, so an upper-case manifest still opens.
      const encrypted = encryptArtifact(PLAINTEXT, KEY, binding(), { iv: IV });
      const upper = decryptArtifact(encrypted.bytes, KEY, binding({ releaseContentHash: PLAINTEXT_HASH.toUpperCase() }));
      expect(upper.ok).toBe(true);
    });
  });

  describe('tamper and malformation refusals', () => {
    it('refuses a flipped ciphertext byte', () => {
      const encrypted = encryptArtifact(PLAINTEXT, KEY, binding(), { iv: IV });
      const tampered = Buffer.from(encrypted.bytes);
      tampered[ENCRYPTED_BLOB_HEADER_BYTES] ^= 0x01;
      expect(decryptArtifact(tampered, KEY, binding())).toMatchObject({ ok: false, code: 'auth-failed' });
    });

    it('refuses a flipped authentication tag', () => {
      const encrypted = encryptArtifact(PLAINTEXT, KEY, binding(), { iv: IV });
      const tampered = Buffer.from(encrypted.bytes);
      tampered[1 + IV_BYTES] ^= 0x01;
      expect(decryptArtifact(tampered, KEY, binding())).toMatchObject({ ok: false, code: 'auth-failed' });
    });

    it('refuses the wrong content key', () => {
      const encrypted = encryptArtifact(PLAINTEXT, KEY, binding(), { iv: IV });
      expect(decryptArtifact(encrypted.bytes, OTHER_KEY, binding())).toMatchObject({ ok: false, code: 'auth-failed' });
    });

    it('refuses a truncated blob and an unknown framing version', () => {
      const encrypted = encryptArtifact(PLAINTEXT, KEY, binding(), { iv: IV });
      expect(decryptArtifact(encrypted.bytes.subarray(0, ENCRYPTED_BLOB_HEADER_BYTES), KEY, binding())).toMatchObject({
        ok: false,
        code: 'malformed-blob',
      });
      const wrongVersion = Buffer.from(encrypted.bytes);
      wrongVersion.writeUInt8(9, 0);
      expect(decryptArtifact(wrongVersion, KEY, binding())).toMatchObject({ ok: false, code: 'unsupported-version' });
    });

    it('refuses bytes that authenticate but do not hash to the declared release', () => {
      // A publisher encrypting content other than the release it signed: the
      // AAD matches (they chose it), so only the plaintext-hash check catches it.
      const wrongContent = Buffer.from('not-the-release-content', 'utf8');
      const encrypted = encryptArtifact(wrongContent, KEY, binding(), { iv: IV });
      expect(decryptArtifact(encrypted.bytes, KEY, binding())).toMatchObject({ ok: false, code: 'plaintext-hash-mismatch' });
    });

    it('refuses decryption at a revoked key version before touching the cipher', () => {
      const encrypted = encryptArtifact(PLAINTEXT, KEY, binding(), { iv: IV });
      expect(decryptArtifact(encrypted.bytes, KEY, binding(), { revokedKeyVersions: [1] })).toMatchObject({
        ok: false,
        code: 'key-revoked',
      });
    });
  });

  describe('wrapped key identifiers are blinded', () => {
    const base = { releaseContentHash: PLAINTEXT_HASH, keyVersion: 1, recipientId: 'alice' };

    it('is deterministic for the same triple', () => {
      expect(wrappedKeyId(base)).toBe(wrappedKeyId({ ...base }));
    });

    it('changes when ONLY the recipient changes', () => {
      expect(wrappedKeyId({ ...base, recipientId: 'bob' })).not.toBe(wrappedKeyId(base));
    });

    it('changes when ONLY the key version changes — so ids are unlinkable across rotations', () => {
      expect(wrappedKeyId({ ...base, keyVersion: 2 })).not.toBe(wrappedKeyId(base));
    });

    it('changes when ONLY the release changes — so ids are unlinkable across releases', () => {
      const other = sha256Prefixed(Buffer.from('another-release', 'utf8'));
      expect(wrappedKeyId({ ...base, releaseContentHash: other })).not.toBe(wrappedKeyId(base));
    });

    it('does not disclose the recipient it belongs to', () => {
      const id = wrappedKeyId({ ...base, recipientId: 'alice@example.com' });
      expect(id).not.toContain('alice');
      expect(id).toMatch(/^wk_[0-9a-f]{64}$/);
    });
  });

  describe('per-entitlement key wrapping', () => {
    it('wraps for each recipient and yields ids that match the published envelope', async () => {
      const adapter = wrapAdapter();
      const wrapped = await wrapContentKeyForRecipients({
        contentKey: KEY,
        recipientIds: ['alice', 'bob'],
        releaseContentHash: PLAINTEXT_HASH,
        keyVersion: 1,
        adapter,
      });
      expect(wrapped.map((key) => key.recipientId)).toEqual(['alice', 'bob']);
      expect(wrapped[0]!.wrappedKeyId).toBe(wrappedKeyId({ releaseContentHash: PLAINTEXT_HASH, keyVersion: 1, recipientId: 'alice' }));
      // The wrapped material is not the bare key.
      expect(wrapped[0]!.wrapped.equals(KEY)).toBe(false);
    });

    it('refuses a duplicate recipient', async () => {
      await expect(
        wrapContentKeyForRecipients({
          contentKey: KEY,
          recipientIds: ['alice', 'alice'],
          releaseContentHash: PLAINTEXT_HASH,
          keyVersion: 1,
          adapter: wrapAdapter(),
        }),
      ).rejects.toThrow(/duplicate recipientId/);
    });

    it('round-trips the content key through wrap and unwrap', async () => {
      const adapter = wrapAdapter();
      const [wrapped] = await wrapContentKeyForRecipients({
        contentKey: KEY,
        recipientIds: ['alice'],
        releaseContentHash: PLAINTEXT_HASH,
        keyVersion: 1,
        adapter,
      });
      const result = await unwrapContentKey({
        wrapped: wrapped!.wrapped,
        recipientId: 'alice',
        keyVersion: 1,
        releaseContentHash: PLAINTEXT_HASH,
        envelope: { wrappedKeyIds: [wrapped!.wrappedKeyId] },
        adapter,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(contentKeysEqual(result.contentKey, KEY)).toBe(true);
    });

    it('refuses a recipient the envelope does not list', async () => {
      const adapter = wrapAdapter();
      const result = await unwrapContentKey({
        wrapped: Buffer.alloc(CONTENT_KEY_BYTES, 1),
        recipientId: 'mallory',
        keyVersion: 1,
        releaseContentHash: PLAINTEXT_HASH,
        envelope: { wrappedKeyIds: [wrappedKeyId({ releaseContentHash: PLAINTEXT_HASH, keyVersion: 1, recipientId: 'alice' })] },
        adapter,
      });
      expect(result).toMatchObject({ ok: false, code: 'not-entitled' });
    });

    it('refuses a revoked key version, an adapter that throws, and a wrong-length key', async () => {
      const id = wrappedKeyId({ releaseContentHash: PLAINTEXT_HASH, keyVersion: 1, recipientId: 'alice' });
      const common = {
        wrapped: Buffer.alloc(CONTENT_KEY_BYTES, 1),
        recipientId: 'alice',
        keyVersion: 1,
        releaseContentHash: PLAINTEXT_HASH,
        envelope: { wrappedKeyIds: [id] },
      };
      expect(await unwrapContentKey({ ...common, adapter: wrapAdapter(), revokedKeyVersions: [1] })).toMatchObject({
        ok: false,
        code: 'key-revoked',
      });
      expect(
        await unwrapContentKey({
          ...common,
          adapter: wrapAdapter({ unwrap: async () => { throw new Error('hsm offline'); } }),
        }),
      ).toMatchObject({ ok: false, code: 'unwrap-failed', detail: 'hsm offline' });
      expect(
        await unwrapContentKey({ ...common, adapter: wrapAdapter({ unwrap: async () => Buffer.alloc(8) }) }),
      ).toMatchObject({ ok: false, code: 'wrong-key-length' });
    });
  });

  describe('adapter registries are provider-neutral registrations', () => {
    it('looks an adapter up by providerId and refuses duplicates', () => {
      const registry = createKeyWrapRegistry([wrapAdapter(), wrapAdapter({ providerId: 'hsm' })]);
      expect(registry.providerIds).toEqual(['hsm', 'test-wrap']);
      expect(registry.get('hsm')?.providerId).toBe('hsm');
      expect(registry.get('nope')).toBeNull();
      expect(() => createKeyWrapRegistry([wrapAdapter(), wrapAdapter()])).toThrow(/duplicate/);
      expect(() => createWrappedKeyDeliveryRegistry([{ ...deliveryAdapter(), providerId: ' ' }])).toThrow(/non-empty/);
    });
  });

  describe('forward-only rotation', () => {
    it('defaults to the next version', () => {
      expect(planKeyRotation(state({ keyVersion: 3 }))).toEqual({ ok: true, nextKeyVersion: 4, supersedes: 3 });
    });

    it('refuses to reuse the current version', () => {
      expect(planKeyRotation(state({ keyVersion: 3 }), { requestedKeyVersion: 3 })).toMatchObject({ ok: false, code: 'not-forward' });
    });

    it('refuses to rewind to an earlier version', () => {
      expect(planKeyRotation(state({ keyVersion: 3 }), { requestedKeyVersion: 2 })).toMatchObject({ ok: false, code: 'not-forward' });
    });

    it('refuses to land on a revoked version', () => {
      expect(planKeyRotation(state({ keyVersion: 3, revokedKeyVersions: [4] }))).toMatchObject({ ok: false, code: 'revoked-target' });
    });

    it('allows skipping ahead past a revoked version', () => {
      expect(planKeyRotation(state({ keyVersion: 3, revokedKeyVersions: [4] }), { requestedKeyVersion: 5 })).toEqual({
        ok: true,
        nextKeyVersion: 5,
        supersedes: 3,
      });
    });
  });

  describe('revocation is honest about what it cannot take back', () => {
    it('reports nothing revoked when nothing is', () => {
      expect(revocationOutcome(state({ keyVersion: 2 }))).toMatchObject({
        revoked: false,
        futureUnwrapStopped: false,
        requiresRotation: false,
        rotateToKeyVersion: null,
        priorPlaintextUnrecallable: false,
      });
    });

    it('does not require rotation when only a superseded version is revoked', () => {
      expect(revocationOutcome(state({ keyVersion: 3, revokedKeyVersions: [1] }))).toMatchObject({
        revoked: true,
        futureUnwrapStopped: true,
        requiresRotation: false,
        rotateToKeyVersion: null,
      });
    });

    it('requires rotation and names the next version when the CURRENT version is revoked', () => {
      expect(revocationOutcome(state({ keyVersion: 3, revokedKeyVersions: [3] }))).toMatchObject({
        revoked: true,
        requiresRotation: true,
        rotateToKeyVersion: 4,
      });
    });

    it('reports no rotation target when the next version is itself revoked', () => {
      expect(revocationOutcome(state({ keyVersion: 3, revokedKeyVersions: [3, 4] }))).toMatchObject({
        requiresRotation: true,
        rotateToKeyVersion: null,
      });
    });

    it('NEVER claims already-decrypted plaintext can be recalled', () => {
      // The parallel of yankOutcome.publicCopiesUnrecallable (D-035 ruling 3).
      const outcome = revocationOutcome(state({ keyVersion: 1, revokedKeyVersions: [1] }));
      expect(outcome.priorPlaintextUnrecallable).toBe(true);
    });

    it('sorts the revoked set so the report is order-independent', () => {
      expect(revocationOutcome(state({ keyVersion: 5, revokedKeyVersions: [3, 1, 2] })).revokedKeyVersions).toEqual([1, 2, 3]);
    });
  });

  describe('publishing a private artifact', () => {
    it('makes rootHash === ciphertextHash BY CONSTRUCTION', async () => {
      const published = await publishPrivateArtifact({
        plaintext: PLAINTEXT,
        release: release(),
        contentKey: KEY,
        keyVersion: 1,
        recipientIds: ['alice'],
        adapter: wrapAdapter(),
        chunkSizeBytes: 8,
      });
      expect(published.package.rootHash).toBe(published.encryption.ciphertextHash);
      expect(published.package.rootHash).not.toBe(release().contentHash);
      expect(published.encryption.wrappedKeyIds).toEqual([published.wrappedKeys[0]!.wrappedKeyId]);
    });

    it('produces a manifest that validateDistributionManifest ACCEPTS as private', async () => {
      const published = await publishPrivateArtifact({
        plaintext: PLAINTEXT,
        release: release(),
        contentKey: KEY,
        keyVersion: 1,
        recipientIds: ['alice'],
        adapter: wrapAdapter(),
        chunkSizeBytes: 8,
      });
      const manifest: ArtifactDistributionManifest = {
        schemaVersion: 1,
        release: release(),
        rootHash: published.package.rootHash,
        totalSizeBytes: published.package.totalSizeBytes,
        chunks: published.package.chunks,
        visibility: 'private',
        encryption: published.encryption,
        pinning: DEFAULT_PINNING_POLICY,
        signature: 'manifest-sig',
      };
      const validated = validateDistributionManifest(manifest);
      expect(validated.ok).toBe(true);
    });

    it('refuses to publish content the release manifest does not describe', async () => {
      await expect(
        publishPrivateArtifact({
          plaintext: Buffer.from('different-bytes', 'utf8'),
          release: release(),
          contentKey: KEY,
          keyVersion: 1,
          recipientIds: ['alice'],
          adapter: wrapAdapter(),
        }),
      ).rejects.toThrow(/release manifest declared/);
    });

    it('never puts key material in the envelope that reaches the log', async () => {
      const published = await publishPrivateArtifact({
        plaintext: PLAINTEXT,
        release: release(),
        contentKey: KEY,
        keyVersion: 1,
        recipientIds: ['alice', 'bob'],
        adapter: wrapAdapter(),
      });
      const serialized = JSON.stringify(published.encryption);
      expect(serialized).not.toContain(KEY.toString('hex'));
      expect(serialized).not.toContain(KEY.toString('base64'));
      for (const key of published.wrappedKeys) {
        expect(serialized).not.toContain(key.wrapped.toString('hex'));
      }
    });
  });

  describe('end to end over the P-025 chunked retrieval path', () => {
    it('encrypts, chunks, retrieves chunk-by-chunk, and opens the plaintext', async () => {
      const wrap = wrapAdapter();
      const delivery = deliveryAdapter();
      const published = await publishPrivateArtifact({
        plaintext: PLAINTEXT,
        release: release(),
        contentKey: KEY,
        keyVersion: 1,
        recipientIds: ['alice'],
        adapter: wrap,
        chunkSizeBytes: 8,
      });
      await deliverWrappedKeys({ wrappedKeys: published.wrappedKeys, adapter: delivery });
      expect(published.package.chunks.length).toBeGreaterThan(1);

      // P-025 verifies the CIPHERTEXT chunks with no change whatsoever.
      const manifestLike = {
        rootHash: published.package.rootHash,
        chunks: published.package.chunks,
        totalSizeBytes: published.package.totalSizeBytes,
      };
      let progress = beginRetrieval(manifestLike);
      let offset = 0;
      for (const chunk of published.package.chunks) {
        const bytes = published.ciphertext.subarray(offset, offset + chunk.sizeBytes);
        offset += chunk.sizeBytes;
        const accepted = acceptRetrievedChunk(manifestLike, progress, { index: chunk.index, bytes });
        expect(accepted.ok).toBe(true);
        if (accepted.ok) progress = accepted.progress;
      }
      const completed = completeRetrieval(manifestLike, progress);
      expect(completed.ok).toBe(true);

      const opened = await openRetrievedArtifact({
        ciphertext: published.ciphertext,
        recipientId: 'alice',
        keyVersion: 1,
        release: release(),
        envelope: published.encryption,
        wrapAdapter: wrap,
        deliveryAdapter: delivery,
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(opened.plaintext.equals(PLAINTEXT)).toBe(true);
    });

    it('refuses a recipient who was never delivered a wrapped key', async () => {
      const wrap = wrapAdapter();
      const delivery = deliveryAdapter();
      const published = await publishPrivateArtifact({
        plaintext: PLAINTEXT,
        release: release(),
        contentKey: KEY,
        keyVersion: 1,
        recipientIds: ['alice'],
        adapter: wrap,
      });
      await deliverWrappedKeys({ wrappedKeys: published.wrappedKeys, adapter: delivery });
      const opened = await openRetrievedArtifact({
        ciphertext: published.ciphertext,
        recipientId: 'mallory',
        keyVersion: 1,
        release: release(),
        envelope: published.encryption,
        wrapAdapter: wrap,
        deliveryAdapter: delivery,
      });
      expect(opened).toMatchObject({ ok: false, code: 'no-wrapped-key' });
    });

    it('refuses to open at a revoked key version even with the wrapped key in hand', async () => {
      const wrap = wrapAdapter();
      const delivery = deliveryAdapter();
      const published = await publishPrivateArtifact({
        plaintext: PLAINTEXT,
        release: release(),
        contentKey: KEY,
        keyVersion: 1,
        recipientIds: ['alice'],
        adapter: wrap,
      });
      await deliverWrappedKeys({ wrappedKeys: published.wrappedKeys, adapter: delivery });
      const opened = await openRetrievedArtifact({
        ciphertext: published.ciphertext,
        recipientId: 'alice',
        keyVersion: 1,
        release: release(),
        envelope: published.encryption,
        wrapAdapter: wrap,
        deliveryAdapter: delivery,
        revokedKeyVersions: [1],
      });
      expect(opened).toMatchObject({ ok: false, code: 'key-revoked' });
    });
  });

  describe('rotation actually denies a revoked holder the NEXT release', () => {
    it('re-encrypting under a rotated key locks out the old wrapped key', async () => {
      const wrap = wrapAdapter();
      const v1 = await publishPrivateArtifact({
        plaintext: PLAINTEXT,
        release: release(),
        contentKey: KEY,
        keyVersion: 1,
        recipientIds: ['alice', 'bob'],
        adapter: wrap,
      });

      // Alice is revoked; the current version is revoked, so a rotation is owed.
      const afterRevoke = state({ keyVersion: 1, revokedKeyVersions: [1] });
      const outcome = revocationOutcome(afterRevoke);
      expect(outcome.requiresRotation).toBe(true);
      const rotation = planKeyRotation(afterRevoke);
      expect(rotation.ok).toBe(true);
      if (!rotation.ok) return;

      // Republish under the rotated version for the remaining holder only.
      const v2 = await publishPrivateArtifact({
        plaintext: PLAINTEXT,
        release: release(),
        contentKey: OTHER_KEY,
        keyVersion: rotation.nextKeyVersion,
        recipientIds: ['bob'],
        adapter: wrap,
      });

      // Alice's v1 identifier does not appear in the v2 envelope...
      expect(v2.encryption.wrappedKeyIds).not.toContain(v1.wrappedKeys[0]!.wrappedKeyId);
      // ...and her old content key cannot open the new ciphertext.
      const forced = decryptArtifact(v2.ciphertext, KEY, binding({ keyVersion: rotation.nextKeyVersion }));
      expect(forced).toMatchObject({ ok: false, code: 'auth-failed' });
      // Bob, still entitled, can.
      const bob = decryptArtifact(v2.ciphertext, OTHER_KEY, binding({ keyVersion: rotation.nextKeyVersion }));
      expect(bob.ok).toBe(true);
    });
  });

  describe('the delivery decision stays with resolveDistributionSources', () => {
    it('a revoked holder is refused delivery there, independently of this module', async () => {
      const published = await publishPrivateArtifact({
        plaintext: PLAINTEXT,
        release: release(),
        contentKey: KEY,
        keyVersion: 1,
        recipientIds: ['alice'],
        adapter: wrapAdapter(),
      });
      const source: DistributionSource = {
        sourceId: 'pin-1',
        class: 'pinner',
        locator: 'test://pin-1',
        advertisedAtMs: 1_000,
      } as DistributionSource;
      const manifest: ArtifactDistributionManifest = {
        schemaVersion: 1,
        release: release(),
        rootHash: published.package.rootHash,
        totalSizeBytes: published.package.totalSizeBytes,
        chunks: published.package.chunks,
        visibility: 'private',
        encryption: published.encryption,
        pinning: DEFAULT_PINNING_POLICY,
        signature: 'manifest-sig',
      };
      const live = state({ manifest, sources: [source], pins: ['pin-1'], keyVersion: 1, revokedKeyVersions: [1] });
      const resolved = resolveDistributionSources(live, { nowMs: 2_000, keyVersion: 1 });
      expect(resolved).toMatchObject({ deliverable: false, reason: 'key-revoked' });
    });
  });

  describe('generateContentKey', () => {
    it('returns 32 distinct random bytes each call', () => {
      const a = generateContentKey();
      const b = generateContentKey();
      expect(a.length).toBe(CONTENT_KEY_BYTES);
      expect(contentKeysEqual(a, b)).toBe(false);
    });
  });
});
