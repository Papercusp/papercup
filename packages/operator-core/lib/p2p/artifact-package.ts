/**
 * Content-addressed artifact packaging and retrieval (P-025).
 *
 * P-015 (`./artifact-distribution`) defined WHAT a distribution stream says:
 * the signed manifest, the append-only event log, pin health, and the
 * yank/revoke rules. It deliberately left the chunk hashes and the root hash as
 * declared values that nothing computed or checked. This module closes that
 * gap: it computes the content address from the bytes, verifies bytes against
 * it, drives a resumable multi-source retrieval, and carries signed channel
 * pointers so "the stable release of X" is a verifiable, monotonic fact rather
 * than a mutable name.
 *
 * Binding rulings it implements (D-035, which implements D-024/D-025):
 *
 *  1. A SOURCE IS AN OPAQUE DESCRIPTOR. Bytes are fetched through an adapter
 *     looked up by `providerId`; the `locator` is passed through untouched and
 *     is never parsed, ranked, or pattern-matched here. Adding IPFS/libp2p is
 *     registering another adapter — `registerProvider` — not a protocol change,
 *     which is why this module opens no socket and knows no URL scheme.
 *  2. A CACHE IS NEVER AUTHORITATIVE. Retrieval ordering is inherited whole
 *     from `resolveDistributionSources`, so cache mirrors accelerate delivery
 *     without ever counting toward durability.
 *  3. YANK AND REVOKE ARE TERMINAL. Retrieval composes the P-015 resolution
 *     rather than re-deciding deliverability, so a yanked or key-revoked
 *     release cannot be fetched through this path either — including through a
 *     channel pointer that still names it.
 *  4. PRIVATE LISTINGS DISTRIBUTE CIPHERTEXT. Packaging is byte-agnostic: it
 *     addresses whatever bytes it is given, so a private package is built from
 *     the ciphertext and its root is the ciphertext hash. No key material
 *     enters any structure here.
 *
 * D-024 defers deploying a decentralized blob provider. Nothing here deploys
 * one: the whole module is pure and adapter-injected, so it is exercised end to
 * end in-process today and gains IPFS/libp2p later by registration alone.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import {
  distributionManifestDigest,
  resolveDistributionSources,
  type ArtifactChunk,
  type ArtifactDistributionManifest,
  type ArtifactDistributionState,
  type DistributionResolutionReason,
  type DistributionSource,
  type PinHealth,
  type ResolveOptions,
} from './artifact-distribution';

const SHA256_RE = /^sha256:[0-9a-f]{64}$/i;

/** 1 MiB. Chunk boundaries are part of the content address, so this is a protocol constant. */
export const DEFAULT_CHUNK_SIZE_BYTES = 1024 * 1024;

/** Upper bound on chunks per package, so a hostile manifest cannot force an unbounded tree. */
export const MAX_PACKAGE_CHUNKS = 65_536;

/**
 * Domain separation tags. A leaf digest and an internal-node digest are drawn
 * from disjoint spaces, so a chunk hash can never be replayed as a subtree.
 */
const LEAF_TAG = Buffer.from([0x00]);
const NODE_TAG = Buffer.from([0x01]);
const ROOT_TAG = Buffer.from([0x02]);

export function sha256Prefixed(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function hashBytesOf(prefixed: string): Buffer {
  return Buffer.from(prefixed.slice('sha256:'.length), 'hex');
}

/**
 * Merkle root over chunk digests.
 *
 * Leaves and internal nodes are domain-separated, an odd node is PROMOTED
 * rather than duplicated (the classic duplicate-last-node ambiguity), and the
 * chunk COUNT is bound into the final digest — so two different chunk lists can
 * never share a root, and the root commits to the whole chunking, not just the
 * bytes.
 */
export function merkleRoot(chunkHashes: readonly string[]): string {
  if (chunkHashes.length === 0) throw new Error('merkleRoot requires at least one chunk hash');
  for (const hash of chunkHashes) {
    if (!SHA256_RE.test(hash)) throw new Error(`merkleRoot requires sha256:<64 hex> hashes, received '${hash}'`);
  }

  let level = chunkHashes.map((hash) => createHash('sha256').update(LEAF_TAG).update(hashBytesOf(hash)).digest());
  while (level.length > 1) {
    const next: typeof level = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!;
      const right = level[index + 1];
      // Odd node is promoted unchanged; duplicating it would let two distinct
      // chunk lists produce the same root.
      next.push(right ? createHash('sha256').update(NODE_TAG).update(left).update(right).digest() : left);
    }
    level = next;
  }

  const count = Buffer.alloc(4);
  count.writeUInt32BE(chunkHashes.length, 0);
  return `sha256:${createHash('sha256').update(ROOT_TAG).update(count).update(level[0]!).digest('hex')}`;
}

export interface ArtifactPackage {
  /** The content address: `merkleRoot` over the chunk digests. */
  readonly rootHash: string;
  readonly totalSizeBytes: number;
  readonly chunks: readonly ArtifactChunk[];
  readonly chunkSizeBytes: number;
}

/**
 * Split bytes into a content-addressed package.
 *
 * Byte-agnostic on purpose: a public package addresses the plaintext, a private
 * one addresses the ciphertext (D-035 ruling 4). The returned fields are
 * exactly the manifest's `rootHash` / `totalSizeBytes` / `chunks`, so a
 * manifest built from a package cannot disagree with the bytes it describes.
 */
export function buildArtifactPackage(bytes: Buffer, options: { readonly chunkSizeBytes?: number } = {}): ArtifactPackage {
  const chunkSizeBytes = options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
  if (!Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes <= 0) throw new Error('chunkSizeBytes must be a positive integer');
  if (bytes.length === 0) throw new Error('buildArtifactPackage requires at least one byte');
  const chunkCount = Math.ceil(bytes.length / chunkSizeBytes);
  if (chunkCount > MAX_PACKAGE_CHUNKS) throw new Error(`package would need ${chunkCount} chunks, above the ${MAX_PACKAGE_CHUNKS} limit`);

  const chunks: ArtifactChunk[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const slice = bytes.subarray(index * chunkSizeBytes, Math.min((index + 1) * chunkSizeBytes, bytes.length));
    chunks.push({ index, contentHash: sha256Prefixed(slice), sizeBytes: slice.length });
  }

  return { rootHash: merkleRoot(chunks.map((chunk) => chunk.contentHash)), totalSizeBytes: bytes.length, chunks, chunkSizeBytes };
}

export type PackageIntegrityCode = 'root-hash-mismatch' | 'total-size-mismatch' | 'chunk-count-mismatch' | 'chunk-hash-mismatch' | 'chunk-size-mismatch';

export type PackageIntegrity = { readonly ok: true } | { readonly ok: false; readonly code: PackageIntegrityCode; readonly detail: string };

/**
 * Does this manifest's declared root actually commit to its chunk list?
 *
 * This is what makes per-chunk verification sufficient: once the root is known
 * to commit to the chunk digests, verifying each chunk against its digest
 * verifies the whole artifact against its content address. A manifest that
 * fails here is refused BEFORE any byte is fetched.
 */
export function verifyManifestRoot(manifest: Pick<ArtifactDistributionManifest, 'rootHash' | 'chunks' | 'totalSizeBytes'>): PackageIntegrity {
  if (manifest.chunks.length === 0) return { ok: false, code: 'chunk-count-mismatch', detail: 'manifest declares no chunks' };
  const recomputed = merkleRoot(manifest.chunks.map((chunk) => chunk.contentHash));
  if (recomputed.toLowerCase() !== manifest.rootHash.toLowerCase()) {
    return { ok: false, code: 'root-hash-mismatch', detail: `chunk list commits to ${recomputed}, manifest declares ${manifest.rootHash}` };
  }
  const summed = manifest.chunks.reduce((total, chunk) => total + chunk.sizeBytes, 0);
  if (summed !== manifest.totalSizeBytes) {
    return { ok: false, code: 'total-size-mismatch', detail: `chunk sizes sum to ${summed}, manifest declares ${manifest.totalSizeBytes}` };
  }
  return { ok: true };
}

/** Does a locally built package match a manifest byte for byte? */
export function packageMatchesManifest(pkg: ArtifactPackage, manifest: Pick<ArtifactDistributionManifest, 'rootHash' | 'chunks' | 'totalSizeBytes'>): PackageIntegrity {
  if (pkg.chunks.length !== manifest.chunks.length) {
    return { ok: false, code: 'chunk-count-mismatch', detail: `package has ${pkg.chunks.length} chunks, manifest declares ${manifest.chunks.length}` };
  }
  for (const [index, chunk] of pkg.chunks.entries()) {
    const declared = manifest.chunks[index]!;
    if (chunk.contentHash.toLowerCase() !== declared.contentHash.toLowerCase()) {
      return { ok: false, code: 'chunk-hash-mismatch', detail: `chunk ${index} hashes to ${chunk.contentHash}, manifest declares ${declared.contentHash}` };
    }
    if (chunk.sizeBytes !== declared.sizeBytes) {
      return { ok: false, code: 'chunk-size-mismatch', detail: `chunk ${index} is ${chunk.sizeBytes} bytes, manifest declares ${declared.sizeBytes}` };
    }
  }
  if (pkg.totalSizeBytes !== manifest.totalSizeBytes) {
    return { ok: false, code: 'total-size-mismatch', detail: `package is ${pkg.totalSizeBytes} bytes, manifest declares ${manifest.totalSizeBytes}` };
  }
  if (pkg.rootHash.toLowerCase() !== manifest.rootHash.toLowerCase()) {
    return { ok: false, code: 'root-hash-mismatch', detail: `package root is ${pkg.rootHash}, manifest declares ${manifest.rootHash}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Resumable retrieval
// ---------------------------------------------------------------------------

/**
 * What a client already holds, VERIFIED. Progress is a durable, restartable
 * fact: a client that dies mid-install resumes from here instead of refetching
 * the artifact, which is the whole point of chunking a large package.
 */
export interface RetrievalProgress {
  readonly rootHash: string;
  /** Verified chunk indices, ascending. */
  readonly held: readonly number[];
  readonly bytesHeld: number;
}

export function beginRetrieval(manifest: Pick<ArtifactDistributionManifest, 'rootHash'>): RetrievalProgress {
  return { rootHash: manifest.rootHash, held: [], bytesHeld: 0 };
}

export type ChunkRejectionCode = 'wrong-package' | 'unknown-chunk' | 'size-mismatch' | 'chunk-hash-mismatch';

export type ChunkAcceptance =
  | { readonly ok: true; readonly progress: RetrievalProgress; readonly duplicate: boolean }
  | { readonly ok: false; readonly code: ChunkRejectionCode; readonly detail: string };

/**
 * Verify one retrieved chunk and fold it into progress.
 *
 * Every byte that enters an assembly passes through here, so a peer that serves
 * corrupt or substituted bytes is rejected at the chunk boundary rather than
 * discovered at the end — and `held` only ever names verified chunks.
 * A re-delivered chunk is idempotent (`duplicate: true`), never an error: peers
 * racing to serve the same range is normal, not a fault.
 */
export function acceptRetrievedChunk(
  manifest: Pick<ArtifactDistributionManifest, 'rootHash' | 'chunks'>,
  progress: RetrievalProgress,
  chunk: { readonly index: number; readonly bytes: Buffer },
): ChunkAcceptance {
  if (progress.rootHash.toLowerCase() !== manifest.rootHash.toLowerCase()) {
    return { ok: false, code: 'wrong-package', detail: `progress tracks ${progress.rootHash}, manifest is ${manifest.rootHash}` };
  }
  const declared = manifest.chunks[chunk.index];
  if (!declared || declared.index !== chunk.index) {
    return { ok: false, code: 'unknown-chunk', detail: `manifest declares no chunk at index ${chunk.index}` };
  }
  if (progress.held.includes(chunk.index)) return { ok: true, progress, duplicate: true };
  if (chunk.bytes.length !== declared.sizeBytes) {
    return { ok: false, code: 'size-mismatch', detail: `chunk ${chunk.index} is ${chunk.bytes.length} bytes, manifest declares ${declared.sizeBytes}` };
  }
  const actual = sha256Prefixed(chunk.bytes);
  if (actual.toLowerCase() !== declared.contentHash.toLowerCase()) {
    return { ok: false, code: 'chunk-hash-mismatch', detail: `chunk ${chunk.index} hashes to ${actual}, manifest declares ${declared.contentHash}` };
  }
  return {
    ok: true,
    duplicate: false,
    progress: { rootHash: progress.rootHash, held: [...progress.held, chunk.index].sort((a, b) => a - b), bytesHeld: progress.bytesHeld + declared.sizeBytes },
  };
}

export interface RetrievalPlan {
  /** Local progress holds every declared chunk. Independent of delivery permission. */
  readonly complete: boolean;
  /** The protocol permits fetching more bytes right now. */
  readonly canFetch: boolean;
  /** Why `canFetch` is false; `'ok'` when it is true. */
  readonly reason: DistributionResolutionReason;
  readonly missingChunks: readonly ArtifactChunk[];
  readonly bytesRemaining: number;
  /** Ordered best-first by source CLASS and freshness — never by locator shape. */
  readonly sources: readonly DistributionSource[];
  readonly pinHealth: PinHealth;
}

/**
 * What is left to fetch, and whether fetching is allowed.
 *
 * `complete` and `canFetch` are deliberately independent. A client that already
 * holds every chunk of a yanked release is complete AND barred from fetching
 * more; collapsing the two into one boolean forces a caller to guess which fact
 * it was told.
 */
export function planRetrieval(state: ArtifactDistributionState, progress: RetrievalProgress, options: ResolveOptions): RetrievalPlan {
  const resolution = resolveDistributionSources(state, options);
  const chunks = state.manifest?.chunks ?? [];
  const missingChunks = chunks.filter((chunk) => !progress.held.includes(chunk.index));
  return {
    complete: chunks.length > 0 && missingChunks.length === 0,
    canFetch: resolution.deliverable,
    reason: resolution.reason,
    missingChunks,
    bytesRemaining: missingChunks.reduce((total, chunk) => total + chunk.sizeBytes, 0),
    sources: resolution.sources,
    pinHealth: resolution.pinHealth,
  };
}

export type RetrievalCompletionCode = 'no-manifest' | 'incomplete' | PackageIntegrityCode;

export type RetrievalCompletion =
  | { readonly ok: true; readonly rootHash: string; readonly totalSizeBytes: number }
  | { readonly ok: false; readonly code: RetrievalCompletionCode; readonly detail: string };

/** Final verdict: every chunk verified AND the manifest root commits to that chunk list. */
export function completeRetrieval(manifest: Pick<ArtifactDistributionManifest, 'rootHash' | 'chunks' | 'totalSizeBytes'> | null, progress: RetrievalProgress): RetrievalCompletion {
  if (!manifest) return { ok: false, code: 'no-manifest', detail: 'no manifest to complete against' };
  const rootIntegrity = verifyManifestRoot(manifest);
  if (!rootIntegrity.ok) return rootIntegrity;
  const missing = manifest.chunks.filter((chunk) => !progress.held.includes(chunk.index));
  if (missing.length > 0) {
    return { ok: false, code: 'incomplete', detail: `missing ${missing.length} of ${manifest.chunks.length} chunks (first: ${missing[0]!.index})` };
  }
  return { ok: true, rootHash: manifest.rootHash, totalSizeBytes: manifest.totalSizeBytes };
}

// ---------------------------------------------------------------------------
// Provider adapters (D-035 ruling 1: a provider is a registration, not a branch)
// ---------------------------------------------------------------------------

export interface ChunkFetchRequest {
  readonly source: DistributionSource;
  readonly rootHash: string;
  readonly chunk: ArtifactChunk;
}

export interface ArtifactProviderAdapter {
  readonly providerId: string;
  /** Fetch one chunk's bytes. The adapter — and only the adapter — understands `source.locator`. */
  fetchChunk(request: ChunkFetchRequest): Promise<Buffer>;
}

export interface ProviderRegistry {
  register(adapter: ArtifactProviderAdapter): void;
  /** Lookup by `providerId` ONLY. An unregistered provider is `null`, never a guessed transport. */
  adapterFor(source: Pick<DistributionSource, 'providerId'>): ArtifactProviderAdapter | null;
  readonly providerIds: readonly string[];
}

export function createProviderRegistry(adapters: readonly ArtifactProviderAdapter[] = []): ProviderRegistry {
  const byId = new Map<string, ArtifactProviderAdapter>();
  const registry: ProviderRegistry = {
    register(adapter) {
      if (!adapter.providerId.trim()) throw new Error('provider adapter requires a providerId');
      if (byId.has(adapter.providerId)) throw new Error(`provider '${adapter.providerId}' is already registered`);
      byId.set(adapter.providerId, adapter);
    },
    adapterFor(source) {
      return byId.get(source.providerId) ?? null;
    },
    get providerIds() {
      return [...byId.keys()].sort();
    },
  };
  for (const adapter of adapters) registry.register(adapter);
  return registry;
}

export type RetrievalFailureCode = DistributionResolutionReason | 'no-manifest' | 'manifest-root-invalid' | 'chunk-unavailable';

export interface RetrievalAttemptFailure {
  readonly chunkIndex: number;
  readonly sourceId: string;
  readonly code: ChunkRejectionCode | 'no-adapter' | 'fetch-failed';
  readonly detail: string;
}

export interface RetrievalOutcome {
  readonly ok: boolean;
  /** `'ok'` on success; otherwise why the retrieval stopped. */
  readonly reason: 'ok' | RetrievalFailureCode;
  readonly progress: RetrievalProgress;
  readonly fetched: readonly { readonly chunkIndex: number; readonly sourceId: string }[];
  readonly failures: readonly RetrievalAttemptFailure[];
}

export interface RetrieveOptions extends ResolveOptions {
  readonly registry: ProviderRegistry;
  /** Distinct sources tried per chunk before it is declared unavailable. */
  readonly maxSourcesPerChunk?: number;
}

/**
 * Fetch every missing chunk, resuming from `progress`.
 *
 * Deliverability is NOT re-decided here: `planRetrieval` composes the P-015
 * resolution, so yank, key revocation and the offline pin rule bind this path
 * for free rather than by a second, drift-prone copy of the rules. A source
 * that serves bad bytes is skipped and the next source in class order is tried,
 * so one hostile peer degrades throughput rather than corrupting an install.
 */
export async function retrieveArtifact(state: ArtifactDistributionState, progress: RetrievalProgress, options: RetrieveOptions): Promise<RetrievalOutcome> {
  const { registry, maxSourcesPerChunk = 3, ...resolveOptions } = options;
  const manifest = state.manifest;
  const fetched: { chunkIndex: number; sourceId: string }[] = [];
  const failures: RetrievalAttemptFailure[] = [];
  let current = progress;

  if (!manifest) return { ok: false, reason: 'no-manifest', progress: current, fetched, failures };

  const rootIntegrity = verifyManifestRoot(manifest);
  if (!rootIntegrity.ok) {
    return { ok: false, reason: 'manifest-root-invalid', progress: current, fetched, failures: [{ chunkIndex: -1, sourceId: '', code: 'fetch-failed', detail: rootIntegrity.detail }] };
  }

  const plan = planRetrieval(state, current, resolveOptions);
  if (plan.complete) return { ok: true, reason: 'ok', progress: current, fetched, failures };
  if (!plan.canFetch) return { ok: false, reason: plan.reason, progress: current, fetched, failures };

  for (const chunk of plan.missingChunks) {
    let held = false;
    for (const source of plan.sources.slice(0, maxSourcesPerChunk)) {
      const adapter = registry.adapterFor(source);
      if (!adapter) {
        failures.push({ chunkIndex: chunk.index, sourceId: source.sourceId, code: 'no-adapter', detail: `no adapter registered for provider '${source.providerId}'` });
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = await adapter.fetchChunk({ source, rootHash: manifest.rootHash, chunk });
      } catch (error) {
        failures.push({ chunkIndex: chunk.index, sourceId: source.sourceId, code: 'fetch-failed', detail: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const acceptance = acceptRetrievedChunk(manifest, current, { index: chunk.index, bytes });
      if (!acceptance.ok) {
        failures.push({ chunkIndex: chunk.index, sourceId: source.sourceId, code: acceptance.code, detail: acceptance.detail });
        continue;
      }
      current = acceptance.progress;
      fetched.push({ chunkIndex: chunk.index, sourceId: source.sourceId });
      held = true;
      break;
    }
    if (!held) return { ok: false, reason: 'chunk-unavailable', progress: current, fetched, failures };
  }

  const completion = completeRetrieval(manifest, current);
  if (!completion.ok) return { ok: false, reason: 'chunk-unavailable', progress: current, fetched, failures };
  return { ok: true, reason: 'ok', progress: current, fetched, failures };
}

// ---------------------------------------------------------------------------
// Signed release / channel pointers
// ---------------------------------------------------------------------------

/**
 * A signed, monotonic pointer from a mutable channel name ("stable") to an
 * immutable release.
 *
 * Content addressing makes a release immutable; a channel is the one mutable
 * name users actually follow, so it is the natural downgrade/replay target. The
 * pointer is signed, bound to a specific manifest digest, and advances only on
 * a strictly increasing sequence.
 */
export interface ReleaseChannelPointer {
  readonly schemaVersion: 1;
  readonly listingKind: string;
  readonly listingRef: string;
  readonly channel: string;
  readonly releaseVersion: string;
  /** Content address of the bytes this channel now points at. */
  readonly rootHash: string;
  /** Digest of the unsigned distribution manifest, binding the pointer to one manifest. */
  readonly manifestDigest: string;
  /** Strictly increasing per channel. This is what refuses a replayed old pointer. */
  readonly sequence: number;
  readonly issuer: string;
  readonly publishedAtMs: number;
  readonly signature: string;
}

export function channelPointerId(pointer: Pick<ReleaseChannelPointer, 'listingKind' | 'listingRef' | 'channel'>): string {
  return `channel:${pointer.listingKind}:${pointer.listingRef}#${pointer.channel}`;
}

export function channelPointerSigningBytes(pointer: Omit<ReleaseChannelPointer, 'signature'>): Buffer {
  return Buffer.from(canonicalJson(pointer), 'utf8');
}

export function channelPointerDigest(pointer: Omit<ReleaseChannelPointer, 'signature'>): string {
  return createHash('sha256').update(channelPointerSigningBytes(pointer)).digest('hex');
}

export function unsignedChannelPointer(pointer: ReleaseChannelPointer): Omit<ReleaseChannelPointer, 'signature'> {
  const { signature: _signature, ...unsigned } = pointer;
  void _signature;
  return unsigned;
}

/** Digest of a signed manifest with its signature stripped — what a pointer binds to. */
export function manifestBindingDigest(manifest: ArtifactDistributionManifest): string {
  const { signature: _signature, ...unsigned } = manifest;
  void _signature;
  return distributionManifestDigest(unsigned);
}

export type ChannelPointerErrorCode =
  | 'invalid-shape'
  | 'unsupported-version'
  | 'invalid-identity'
  | 'invalid-hash'
  | 'invalid-sequence'
  | 'invalid-timestamp'
  | 'missing-signature';

export function validateChannelPointer(raw: unknown): { ok: true; pointer: ReleaseChannelPointer } | { ok: false; code: ChannelPointerErrorCode; detail: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'invalid-shape', detail: 'pointer must be an object' };
  const p = raw as Partial<ReleaseChannelPointer>;
  if (p.schemaVersion !== 1) return { ok: false, code: 'unsupported-version', detail: 'schemaVersion must be 1' };
  for (const key of ['listingKind', 'listingRef', 'channel', 'releaseVersion', 'issuer'] as const) {
    const value = p[key];
    if (typeof value !== 'string' || !value.trim()) return { ok: false, code: 'invalid-identity', detail: `${key} must be a non-empty string` };
  }
  if (typeof p.rootHash !== 'string' || !SHA256_RE.test(p.rootHash)) return { ok: false, code: 'invalid-hash', detail: 'rootHash must be sha256:<64 hex characters>' };
  if (typeof p.manifestDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(p.manifestDigest)) return { ok: false, code: 'invalid-hash', detail: 'manifestDigest must be 64 hex characters' };
  if (!Number.isSafeInteger(p.sequence) || (p.sequence as number) < 1) return { ok: false, code: 'invalid-sequence', detail: 'sequence must be an integer >= 1' };
  if (!Number.isSafeInteger(p.publishedAtMs) || (p.publishedAtMs as number) < 0) return { ok: false, code: 'invalid-timestamp', detail: 'publishedAtMs must be a non-negative integer' };
  if (typeof p.signature !== 'string' || !p.signature.trim()) return { ok: false, code: 'missing-signature', detail: 'signature is required' };
  return { ok: true, pointer: p as ReleaseChannelPointer };
}

export type ChannelAdvanceCode =
  | ChannelPointerErrorCode
  | 'listing-mismatch'
  | 'channel-mismatch'
  | 'issuer-mismatch'
  | 'non-monotonic-sequence'
  | 'stale-timestamp'
  | 'manifest-mismatch';

export type ChannelAdvance =
  | { readonly ok: true; readonly pointer: ReleaseChannelPointer; readonly rolledBack: boolean }
  | { readonly ok: false; readonly code: ChannelAdvanceCode; readonly detail: string };

/**
 * Advance a channel to a new pointer.
 *
 * A ROLLBACK is legitimate and is reported (`rolledBack`) rather than refused:
 * publishing an older release under a NEW sequence is how a bad release is
 * withdrawn from a channel. What is refused is a REPLAY — re-presenting the old
 * signed pointer itself — because its sequence does not advance. Distinguishing
 * these two is the whole job: a rule that refuses "the version went down" bans
 * the recovery and still admits the attack.
 */
export function advanceChannelPointer(
  current: ReleaseChannelPointer | null,
  next: unknown,
  manifest: ArtifactDistributionManifest,
): ChannelAdvance {
  const validated = validateChannelPointer(next);
  if (!validated.ok) return validated;
  const pointer = validated.pointer;

  if (pointer.listingKind !== manifest.release.listingKind || pointer.listingRef !== manifest.release.listingRef) {
    return { ok: false, code: 'listing-mismatch', detail: `pointer names ${pointer.listingKind}:${pointer.listingRef}, manifest is ${manifest.release.listingKind}:${manifest.release.listingRef}` };
  }
  if (pointer.releaseVersion !== manifest.release.releaseVersion) {
    return { ok: false, code: 'manifest-mismatch', detail: `pointer names release ${pointer.releaseVersion}, manifest is ${manifest.release.releaseVersion}` };
  }
  if (pointer.rootHash.toLowerCase() !== manifest.rootHash.toLowerCase()) {
    return { ok: false, code: 'manifest-mismatch', detail: `pointer rootHash ${pointer.rootHash} does not match manifest rootHash ${manifest.rootHash}` };
  }
  const binding = manifestBindingDigest(manifest);
  if (pointer.manifestDigest.toLowerCase() !== binding.toLowerCase()) {
    return { ok: false, code: 'manifest-mismatch', detail: `pointer binds manifest ${pointer.manifestDigest}, actual manifest digest is ${binding}` };
  }

  if (!current) return { ok: true, pointer, rolledBack: false };

  if (current.listingKind !== pointer.listingKind || current.listingRef !== pointer.listingRef) {
    return { ok: false, code: 'listing-mismatch', detail: `current pointer is for ${current.listingKind}:${current.listingRef}` };
  }
  if (current.channel !== pointer.channel) return { ok: false, code: 'channel-mismatch', detail: `current channel is '${current.channel}', pointer names '${pointer.channel}'` };
  if (current.issuer !== pointer.issuer) return { ok: false, code: 'issuer-mismatch', detail: `channel is issued by '${current.issuer}', pointer is issued by '${pointer.issuer}'` };
  if (pointer.sequence <= current.sequence) {
    return { ok: false, code: 'non-monotonic-sequence', detail: `channel is at sequence ${current.sequence}, pointer is ${pointer.sequence}` };
  }
  if (pointer.publishedAtMs < current.publishedAtMs) {
    return { ok: false, code: 'stale-timestamp', detail: `pointer is stamped ${pointer.publishedAtMs}, before the current ${current.publishedAtMs}` };
  }

  return { ok: true, pointer, rolledBack: isOlderRelease(pointer, current) };
}

function isOlderRelease(pointer: ReleaseChannelPointer, current: ReleaseChannelPointer): boolean {
  // Lexicographic on the release version is enough to REPORT a rollback; it is
  // never used to refuse one, so a non-semver version scheme degrades to a
  // wrong label, never a wrong decision.
  return pointer.releaseVersion.localeCompare(current.releaseVersion, undefined, { numeric: true }) < 0;
}

export type ChannelResolutionReason = DistributionResolutionReason | 'pointer-mismatch';

export interface ChannelResolution {
  readonly deliverable: boolean;
  readonly reason: ChannelResolutionReason;
  readonly pointer: ReleaseChannelPointer;
  readonly sources: readonly DistributionSource[];
  readonly pinHealth: PinHealth;
}

/**
 * Resolve a channel to deliverable sources.
 *
 * A channel pointer confers no delivery authority of its own: it must still
 * name the release the stream state actually describes, and the P-015
 * resolution still decides. So yanking a release stops delivery through every
 * channel that names it, without the yank having to touch any pointer.
 */
export function resolveChannel(pointer: ReleaseChannelPointer, state: ArtifactDistributionState, options: ResolveOptions): ChannelResolution {
  const resolution = resolveDistributionSources(state, options);
  const base = { pointer, sources: resolution.sources, pinHealth: resolution.pinHealth };
  const manifest = state.manifest;
  if (manifest && (pointer.rootHash.toLowerCase() !== manifest.rootHash.toLowerCase() || pointer.releaseVersion !== manifest.release.releaseVersion)) {
    return { ...base, deliverable: false, reason: 'pointer-mismatch' };
  }
  return { ...base, deliverable: resolution.deliverable, reason: resolution.reason };
}
