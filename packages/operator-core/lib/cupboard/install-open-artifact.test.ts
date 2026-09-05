/**
 * The encrypted-apply seam (D-045 §3b) — the call site that makes
 * `openRetrievedArtifact` production-reachable from the install door.
 *
 * The ciphertext under test is built by `publishPrivateArtifact`, not by a
 * hand-rolled fixture: the two halves of P-027 have to agree about the AAD
 * binding and the wrapped-key id derivation, and a fixture that encrypts its own
 * bytes would pass while the real publish/install pair disagreed.
 *
 * Every refusal case is paired with the passing case it differs from by one
 * field, and each asserts that `applyPlaintext` was NOT called — the check that
 * distinguishes "refused" from "wrote the ciphertext anyway".
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PINNING_POLICY,
  type ArtifactDistributionManifest,
} from '../p2p/artifact-distribution';
import {
  CONTENT_KEY_BYTES,
  publishPrivateArtifact,
  type KeyWrapAdapter,
  type WrappedKey,
  type WrappedKeyDeliveryAdapter,
} from '../p2p/artifact-encryption';
import { buildArtifactPackage } from '../p2p/artifact-package';
import type { InstalledRelease } from './entitled-delivery';
import { installDoorGateDeps } from './install-door-gate-io';
import { createOpenArtifactSeam, type PrivateArtifactAccess } from './install-open-artifact';
import type { ApplyInput } from './install-runner';
import type { CupboardReleaseManifest } from './listing-manifest';

const CHUNK = 8;
const PLAINTEXT = Buffer.from('the-unit-bytes-a-buyer-actually-installs!!', 'utf8');
const BUYER = 'buyer-a';
const RELEASE_REF = 'plugin:demo:2.0.0';

/** Reversible stand-in for a wrapping provider — never a real KMS in a unit test. */
const wrapAdapter: KeyWrapAdapter = {
  providerId: 'fake',
  wrap: async ({ contentKey }) => Buffer.from([...contentKey].reverse()),
  unwrap: async ({ wrapped }) => Buffer.from([...wrapped].reverse()),
};

const memoryDelivery = (): WrappedKeyDeliveryAdapter & { readonly store: Map<string, Buffer> } => {
  const store = new Map<string, Buffer>();
  return {
    providerId: 'memory',
    store,
    deliver: async (key: WrappedKey) => {
      store.set(`${key.recipientId}:${key.wrappedKeyId}`, key.wrapped);
    },
    fetch: async ({ wrappedKeyId, recipientId }) => store.get(`${recipientId}:${wrappedKeyId}`) ?? null,
  };
};

const release: CupboardReleaseManifest = {
  schemaVersion: 1,
  listingKind: 'plugin',
  listingRef: 'demo',
  releaseVersion: '2.0.0',
  contentHash: buildArtifactPackage(PLAINTEXT).rootHash,
  signature: 'release-sig',
  dependencies: [],
  compatibility: { runtime: 'papercusp>=1' },
  permissions: [],
  capabilities: [],
  license: 'MIT',
  publisher: { githubUserId: 42, login: 'avi' },
  reviewStatus: 'approved',
};

/** Publish once, then reuse: this is the publisher's half of the same P-027 pair. */
async function published(recipientIds: readonly string[] = [BUYER]) {
  const publication = await publishPrivateArtifact({
    plaintext: PLAINTEXT,
    release,
    contentKey: Buffer.alloc(CONTENT_KEY_BYTES, 7),
    keyVersion: 3,
    recipientIds,
    adapter: wrapAdapter,
    chunkSizeBytes: CHUNK,
  });
  const deliveryAdapter = memoryDelivery();
  for (const key of publication.wrappedKeys) await deliveryAdapter.deliver(key);
  return { publication, deliveryAdapter };
}

function applyInput(
  publication: Awaited<ReturnType<typeof publishPrivateArtifact>>,
  overrides: Partial<ArtifactDistributionManifest> = {},
): ApplyInput {
  const distribution: ArtifactDistributionManifest = {
    schemaVersion: 1,
    release,
    rootHash: publication.package.rootHash,
    totalSizeBytes: publication.package.totalSizeBytes,
    chunks: publication.package.chunks,
    visibility: 'private',
    encryption: publication.encryption,
    pinning: DEFAULT_PINNING_POLICY,
    signature: 'manifest-sig',
    ...overrides,
  };
  return {
    releaseRef: RELEASE_REF,
    intent: 'install',
    release,
    distribution,
    progress: { rootHash: distribution.rootHash, held: [], bytesHeld: 0 },
    servingYankedForExistingInstall: false,
  };
}

const installed = (contentHash: string): InstalledRelease => ({
  releaseRef: RELEASE_REF,
  installedAtMs: 1_700_000_000_000,
  contentHash,
});

function access(publication: Awaited<ReturnType<typeof publishPrivateArtifact>>, over: Partial<PrivateArtifactAccess> = {}) {
  const applyPlaintext = vi.fn(
    (_input: ApplyInput, plaintext: Buffer): InstalledRelease =>
      installed(buildArtifactPackage(plaintext).rootHash),
  );
  const full: PrivateArtifactAccess = {
    wrapAdapter,
    deliveryAdapter: null,
    readCiphertext: () => publication.ciphertext,
    applyPlaintext,
    ...over,
  };
  return { deps: full, applyPlaintext };
}

describe('createOpenArtifactSeam — the install door decrypts before it applies', () => {
  it('unwraps for the entitled recipient and applies the PLAINTEXT bytes', async () => {
    const { publication, deliveryAdapter } = await published();
    const { deps, applyPlaintext } = access(publication, { deliveryAdapter });

    const record = await createOpenArtifactSeam(deps, { subject: BUYER })(applyInput(publication));

    expect(applyPlaintext).toHaveBeenCalledTimes(1);
    const applied = applyPlaintext.mock.calls[0]![1];
    // The bytes that land are the PLAINTEXT, not the ciphertext that was
    // distributed — the whole reason this seam exists rather than `runner.apply`.
    expect(applied.equals(PLAINTEXT)).toBe(true);
    expect(applied.equals(publication.ciphertext)).toBe(false);
    // ...and they address to the content hash the release manifest declares.
    expect(record.contentHash).toBe(release.contentHash);
  });

  it('REFUSES a recipient who was never wrapped a key, and applies nothing', async () => {
    // One field different from the passing case: the subject.
    const { publication, deliveryAdapter } = await published();
    const { deps, applyPlaintext } = access(publication, { deliveryAdapter });

    await expect(
      createOpenArtifactSeam(deps, { subject: 'someone-else' })(applyInput(publication)),
    ).rejects.toThrow(/no-wrapped-key/);
    expect(applyPlaintext).not.toHaveBeenCalled();
  });

  it('REFUSES a revoked key version before any unwrap is attempted', async () => {
    const { publication, deliveryAdapter } = await published();
    const unwrap = vi.fn(wrapAdapter.unwrap);
    const { deps, applyPlaintext } = access(publication, {
      deliveryAdapter,
      wrapAdapter: { ...wrapAdapter, unwrap },
      revokedKeyVersions: () => [3],
    });

    await expect(
      createOpenArtifactSeam(deps, { subject: BUYER })(applyInput(publication)),
    ).rejects.toThrow(/key-revoked/);
    expect(unwrap).not.toHaveBeenCalled();
    expect(applyPlaintext).not.toHaveBeenCalled();
  });

  it('REFUSES when no wrapped-key delivery provider is configured', async () => {
    const { publication } = await published();
    const { deps, applyPlaintext } = access(publication); // deliveryAdapter: null

    await expect(
      createOpenArtifactSeam(deps, { subject: BUYER })(applyInput(publication)),
    ).rejects.toThrow(/no wrapped-key delivery provider is configured/);
    expect(applyPlaintext).not.toHaveBeenCalled();
  });

  it('REFUSES when no key-wrap provider is configured', async () => {
    const { publication, deliveryAdapter } = await published();
    const { deps, applyPlaintext } = access(publication, { deliveryAdapter, wrapAdapter: null });

    await expect(
      createOpenArtifactSeam(deps, { subject: BUYER })(applyInput(publication)),
    ).rejects.toThrow(/no key-wrap provider is configured/);
    expect(applyPlaintext).not.toHaveBeenCalled();
  });

  it('REFUSES an envelope that names a different ciphertext than the manifest ships', async () => {
    const { publication, deliveryAdapter } = await published();
    const { deps, applyPlaintext } = access(publication, { deliveryAdapter });
    const input = applyInput(publication, {
      encryption: { ...publication.encryption, ciphertextHash: 'sha256:deadbeef' },
    });

    await expect(createOpenArtifactSeam(deps, { subject: BUYER })(input)).rejects.toThrow(
      /encryption envelope names ciphertext/,
    );
    expect(applyPlaintext).not.toHaveBeenCalled();
  });

  it('REFUSES when the retrieved ciphertext cannot be read back', async () => {
    const { publication, deliveryAdapter } = await published();
    const { deps, applyPlaintext } = access(publication, { deliveryAdapter, readCiphertext: () => null });

    await expect(
      createOpenArtifactSeam(deps, { subject: BUYER })(applyInput(publication)),
    ).rejects.toThrow(/no assembled ciphertext could be read back/);
    expect(applyPlaintext).not.toHaveBeenCalled();
  });

  it('REFUSES tampered ciphertext — the AEAD tag is what catches it, so no second hash pass is needed', async () => {
    const { publication, deliveryAdapter } = await published();
    const tampered = Buffer.from(publication.ciphertext);
    tampered[tampered.length - 1] ^= 0xff;
    const { deps, applyPlaintext } = access(publication, { deliveryAdapter, readCiphertext: () => tampered });

    await expect(
      createOpenArtifactSeam(deps, { subject: BUYER })(applyInput(publication)),
    ).rejects.toThrow();
    expect(applyPlaintext).not.toHaveBeenCalled();
  });

  /**
   * The wiring guard. The seam being correct is worth nothing if the production
   * deps do not carry it — which was exactly P-027's `dead` disposition: the
   * gate declared an `openArtifact` seam and nothing ever supplied one.
   */
  it('is SUPPLIED by the production install-door deps, not just available to tests', async () => {
    const { publication } = await published();
    const deps = installDoorGateDeps({ subject: BUYER });
    expect(deps.openArtifact).toBeDefined();

    // And it refuses with the real missing-collaborator reason rather than the
    // gate's generic "no seam configured" throw — the observable difference this
    // wiring makes while no key provider is registered in production.
    await expect(deps.openArtifact!(applyInput(publication))).rejects.toThrow(
      /no key-wrap provider is configured/,
    );
  });

  it('REFUSES a distribution carrying no encryption envelope — that release belongs to runner.apply', async () => {
    const { publication, deliveryAdapter } = await published();
    const { deps, applyPlaintext } = access(publication, { deliveryAdapter });

    await expect(
      createOpenArtifactSeam(deps, { subject: BUYER })(
        applyInput(publication, { encryption: null, visibility: 'public' }),
      ),
    ).rejects.toThrow(/carrying no encryption envelope/);
    expect(applyPlaintext).not.toHaveBeenCalled();
  });
});
