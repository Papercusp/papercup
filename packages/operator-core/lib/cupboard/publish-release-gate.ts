/**
 * publish-release-gate.ts — the pre-publish checkpoint every listing that ships
 * DISTRIBUTABLE BYTES passes through (shared-pot-dao-cupboard-v1-2026-09-04
 * D-045 §3b, P-006/P-025/P-027).
 *
 * WHY THIS EXISTS AS A DOOR RATHER THAN A CONVENTION
 *
 * `validatePublishableRelease` and `publishPrivateArtifact` were landed as the
 * sanctioned publish doors for the public and private paths respectively, and
 * then had ZERO non-test callers: the release chain was definition-only while
 * both plan items read `done` (WI-2146243). Nothing in the product could reach
 * them, so the D-041 content-address agreement was enforced only in tests —
 * exactly the shape of the `provides_events` bug documented in
 * `publish-listing.ts`, where a landed column that nothing ever SENT made a
 * whole rung inert.
 *
 * This module is the missing call site. It is deliberately the ONLY one: every
 * publish in the product funnels through `publishListingToCupboard` (13 call
 * sites — the seven `agent-tools/cupboard/publish-*.ts` doors via their
 * per-kind cores, plus blueprint, knowledge-pack, hive and pot-contribute
 * publishes), so gating there reaches all of them at once instead of copying
 * the check seven ways.
 *
 * THE TWO MODES ARE NOT SYMMETRIC
 *
 *   public/unlisted — the publisher already built the manifest, so the gate can
 *     only CHECK it. That check is the whole point: `validatePublishableRelease`
 *     composes the shape check with a Merkle-root recomputation, because each is
 *     insufficient alone and the unstated `merkleRoot(chunk digests)` convention
 *     otherwise holds by luck.
 *
 *   private — the gate BUILDS the manifest from `publishPrivateArtifact`'s
 *     output, so `rootHash === encryption.ciphertextHash` holds by construction
 *     rather than by the publisher getting it right. It is still validated
 *     afterwards: construction-time correctness and a validated artifact are
 *     different claims, and only the second survives a later refactor.
 *
 * `unlisted` maps to a `public` DISTRIBUTION manifest on purpose. The two words
 * live on different axes: `unlisted` is a CATALOG property (reachable by direct
 * ref, absent from browse), while the manifest's `visibility` selects which
 * bytes are addressed — plaintext or ciphertext. An unlisted listing ships
 * unencrypted bytes, so its manifest is `public`. Only `private` encrypts.
 */
import {
  DEFAULT_PINNING_POLICY,
  distributionManifestSigningBytes,
  type ArtifactDistributionManifest,
  type PinningPolicy,
} from '../p2p/artifact-distribution';
import { validatePublishableRelease } from '../p2p/artifact-package';
import { publishPrivateArtifact, type KeyWrapAdapter, type WrappedKey } from '../p2p/artifact-encryption';
import type { CupboardReleaseManifest } from './listing-manifest';
import type { ListingVisibility } from './types';

/**
 * Sign the canonical bytes of an unsigned distribution manifest. Supplied by the
 * caller because the signing key is the publisher's, never this module's.
 */
export type ManifestSigner = (signingBytes: Buffer) => string | Promise<string>;

/** A listing whose bytes are distributed in the clear (`public` or `unlisted`). */
export interface PublicReleaseInput {
  readonly visibility: 'public' | 'unlisted';
  /** The manifest the publisher assembled. Validated, never trusted. */
  readonly manifest: unknown;
  /**
   * The release bytes, when the publisher has them — a publisher always does.
   * Passing them upgrades a root mismatch from an ambiguous two-cause refusal to
   * a PROVEN flat-digest diagnosis.
   */
  readonly bytes?: Buffer;
}

/** A listing whose bytes are encrypted to a recipient set before distribution. */
export interface PrivateReleaseInput {
  readonly visibility: 'private';
  /** The embedded P-006 release manifest; its `contentHash` addresses the PLAINTEXT. */
  readonly release: CupboardReleaseManifest;
  readonly plaintext: Buffer;
  readonly contentKey: Buffer;
  readonly keyVersion: number;
  readonly recipientIds: readonly string[];
  readonly adapter: KeyWrapAdapter;
  readonly sign: ManifestSigner;
  readonly pinning?: PinningPolicy;
  readonly chunkSizeBytes?: number;
  readonly plaintextChunkSizeBytes?: number;
}

export type ReleaseGateInput = PublicReleaseInput | PrivateReleaseInput;

export type ReleaseGateCode =
  /** The manifest is not a publishable release (shape, or the D-041 root check). */
  | 'release-not-publishable'
  /** Encrypt/package/wrap failed — e.g. the plaintext does not address to the declared contentHash. */
  | 'private-publication-failed';

export interface PreparedRelease {
  readonly ok: true;
  /** Validated, and for the private path signed and built from the ciphertext package. */
  readonly manifest: ArtifactDistributionManifest;
  /** The bytes to actually distribute for a private release; null on the public path. */
  readonly ciphertext: Buffer | null;
  /** Out-of-band key material. Never part of the manifest, never sent to the Cupboard. */
  readonly wrappedKeys: readonly WrappedKey[];
}

export type ReleaseGateResult =
  | PreparedRelease
  | { readonly ok: false; readonly code: ReleaseGateCode; readonly detail: string };

/** Is this listing-catalog visibility the encrypted one? */
export function isPrivateVisibility(visibility: ListingVisibility | null | undefined): boolean {
  return visibility === 'private';
}

/**
 * Run the publish-time release check, returning the manifest to publish or a
 * structured refusal. Never throws: a publish path turns a refusal into its own
 * error response rather than a stack trace.
 */
export async function prepareReleaseForPublish(input: ReleaseGateInput): Promise<ReleaseGateResult> {
  if (input.visibility === 'private') return preparePrivateRelease(input);
  return preparePublicRelease(input);
}

function preparePublicRelease(input: PublicReleaseInput): ReleaseGateResult {
  const validated = validatePublishableRelease(input.manifest, input.bytes ? { bytes: input.bytes } : {});
  if (!validated.ok) {
    return { ok: false, code: 'release-not-publishable', detail: `${validated.code}: ${validated.detail}` };
  }
  return { ok: true, manifest: validated.manifest, ciphertext: null, wrappedKeys: [] };
}

async function preparePrivateRelease(input: PrivateReleaseInput): Promise<ReleaseGateResult> {
  let publication: Awaited<ReturnType<typeof publishPrivateArtifact>>;
  try {
    publication = await publishPrivateArtifact({
      plaintext: input.plaintext,
      release: input.release,
      contentKey: input.contentKey,
      keyVersion: input.keyVersion,
      recipientIds: input.recipientIds,
      adapter: input.adapter,
      ...(input.chunkSizeBytes !== undefined ? { chunkSizeBytes: input.chunkSizeBytes } : {}),
      ...(input.plaintextChunkSizeBytes !== undefined
        ? { plaintextChunkSizeBytes: input.plaintextChunkSizeBytes }
        : {}),
    });
  } catch (e) {
    return { ok: false, code: 'private-publication-failed', detail: (e as Error).message.slice(0, 400) };
  }

  // Built from the package rather than restated, so the private-manifest
  // invariants (`rootHash === encryption.ciphertextHash`) hold by construction.
  const unsigned: Omit<ArtifactDistributionManifest, 'signature'> = {
    schemaVersion: 1,
    release: input.release,
    rootHash: publication.package.rootHash,
    totalSizeBytes: publication.package.totalSizeBytes,
    chunks: publication.package.chunks,
    visibility: 'private',
    encryption: publication.encryption,
    pinning: input.pinning ?? DEFAULT_PINNING_POLICY,
  };

  let signature: string;
  try {
    signature = await input.sign(distributionManifestSigningBytes(unsigned));
  } catch (e) {
    return { ok: false, code: 'private-publication-failed', detail: `signing failed: ${(e as Error).message.slice(0, 300)}` };
  }

  // Validate what we just built. Construction-time correctness and a validated
  // artifact are different claims; only the second survives a later refactor.
  // The ciphertext is what the chunk list addresses, so it is the right `bytes`.
  const validated = validatePublishableRelease({ ...unsigned, signature }, { bytes: publication.ciphertext });
  if (!validated.ok) {
    return { ok: false, code: 'release-not-publishable', detail: `${validated.code}: ${validated.detail}` };
  }

  return {
    ok: true,
    manifest: validated.manifest,
    ciphertext: publication.ciphertext,
    wrappedKeys: publication.wrappedKeys,
  };
}
