import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PINNING_POLICY,
  distributionStreamId,
  validateDistributionManifest,
  type ArtifactDistributionManifest,
  type ArtifactDistributionState,
  type DistributionSource,
} from './artifact-distribution';
import {
  acceptRetrievedChunk,
  advanceChannelPointer,
  beginRetrieval,
  buildArtifactPackage,
  channelPointerDigest,
  channelPointerId,
  completeRetrieval,
  createProviderRegistry,
  manifestBindingDigest,
  merkleRoot,
  packageMatchesManifest,
  planRetrieval,
  resolveChannel,
  retrieveArtifact,
  sha256Prefixed,
  unsignedChannelPointer,
  validateChannelPointer,
  validatePublishableRelease,
  verifyManifestRoot,
  type ArtifactProviderAdapter,
  type ReleaseChannelPointer,
} from './artifact-package';
import type { CupboardReleaseManifest } from '../cupboard/listing-manifest';

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

const manifest = (overrides: Partial<ArtifactDistributionManifest> = {}): ArtifactDistributionManifest => ({
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

const source = (overrides: Partial<DistributionSource> = {}): DistributionSource => ({
  sourceId: 'src-peer',
  class: 'peer',
  providerId: 'libp2p',
  locator: 'opaque-locator',
  advertisedAtMs: 1_000,
  expiresAtMs: null,
  ...overrides,
});

const state = (overrides: Partial<ArtifactDistributionState> = {}): ArtifactDistributionState => ({
  streamId: distributionStreamId(release()),
  manifest: manifest(),
  sources: [source()],
  pins: ['src-peer'],
  keyVersion: 1,
  revokedKeyVersions: [],
  yankedAtMs: null,
  yankReason: null,
  lastSequence: 3,
  ...overrides,
});

const chunkBytes = (index: number): Buffer => BYTES.subarray(index * CHUNK, Math.min((index + 1) * CHUNK, BYTES.length));

/** An adapter that serves the real bytes; `locator` is passed through untouched. */
const honestAdapter = (providerId: string, seen: string[] = []): ArtifactProviderAdapter => ({
  providerId,
  async fetchChunk({ source: from, chunk }) {
    seen.push(`${from.sourceId}#${chunk.index}`);
    return chunkBytes(chunk.index);
  },
});

const pointer = (overrides: Partial<ReleaseChannelPointer> = {}): ReleaseChannelPointer => ({
  schemaVersion: 1,
  listingKind: 'plugin',
  listingRef: 'demo',
  channel: 'stable',
  releaseVersion: '2.0.0',
  rootHash: PKG.rootHash,
  manifestDigest: manifestBindingDigest(manifest()),
  sequence: 5,
  issuer: 'publisher-key-1',
  publishedAtMs: 10_000,
  signature: 'pointer-sig',
  ...overrides,
});

describe('content-addressed packaging', () => {
  it('chunks bytes deterministically and sums to the total size', () => {
    expect(PKG.chunks).toHaveLength(Math.ceil(BYTES.length / CHUNK));
    expect(PKG.chunks.reduce((total, chunk) => total + chunk.sizeBytes, 0)).toBe(BYTES.length);
    expect(PKG.chunks.map((chunk) => chunk.index)).toEqual(PKG.chunks.map((_chunk, index) => index));
    expect(buildArtifactPackage(BYTES, { chunkSizeBytes: CHUNK })).toEqual(PKG);
    for (const chunk of PKG.chunks) expect(sha256Prefixed(chunkBytes(chunk.index))).toBe(chunk.contentHash);
  });

  it('makes the CHUNKING part of the address: the same bytes chunked differently are a different artifact', () => {
    const coarse = buildArtifactPackage(BYTES, { chunkSizeBytes: BYTES.length });
    expect(coarse.chunks).toHaveLength(1);
    expect(coarse.rootHash).not.toBe(PKG.rootHash);
  });

  it('is domain-separated and count-bound, pinned one property at a time', () => {
    // A PARAMETERIZED CONTROL TREE. It stays here permanently so each property
    // of the real root is pinned SEPARATELY. An earlier version of this test
    // compared against a single "naive" tree that dropped the tags AND the
    // count together; a mutation probe stripping only the count mix SURVIVED it
    // (2026-09-05) because the surviving tags kept the two values unequal. One
    // control per property is what makes each mutation fail something.
    const controlRoot = (hashes: readonly string[], opts: { leafTag?: number; nodeTag?: number; bindCount: boolean }): string => {
      let level = hashes.map((hash) => {
        const digest = createHash('sha256');
        if (opts.leafTag !== undefined) digest.update(Buffer.from([opts.leafTag]));
        return digest.update(Buffer.from(hash.slice('sha256:'.length), 'hex')).digest();
      });
      while (level.length > 1) {
        const next: typeof level = [];
        for (let index = 0; index < level.length; index += 2) {
          const right = level[index + 1];
          if (!right) {
            next.push(level[index]!);
            continue;
          }
          const digest = createHash('sha256');
          if (opts.nodeTag !== undefined) digest.update(Buffer.from([opts.nodeTag]));
          next.push(digest.update(level[index]!).update(right).digest());
        }
        level = next;
      }
      if (!opts.bindCount) return `sha256:${level[0]!.toString('hex')}`;
      const count = Buffer.alloc(4);
      count.writeUInt32BE(hashes.length, 0);
      return `sha256:${createHash('sha256').update(Buffer.from([0x02])).update(count).update(level[0]!).digest('hex')}`;
    };

    const hashes = PKG.chunks.map((chunk) => chunk.contentHash);
    expect(hashes.length).toBeGreaterThan(3); // a multi-level tree, so node tags are actually exercised

    // CALIBRATION: the fully-specified control reproduces the module exactly.
    // Without this the inequalities below could all hold for a control that is
    // simply broken, which is a passing test that measures nothing.
    expect(controlRoot(hashes, { leafTag: 0x00, nodeTag: 0x01, bindCount: true })).toBe(merkleRoot(hashes));

    // Each mutation below removes exactly one property and must break equality.
    expect(controlRoot(hashes, { leafTag: 0x00, nodeTag: 0x01, bindCount: false })).not.toBe(merkleRoot(hashes)); // count mix removed
    expect(controlRoot(hashes, { nodeTag: 0x01, bindCount: true })).not.toBe(merkleRoot(hashes)); // leaf tag removed
    expect(controlRoot(hashes, { leafTag: 0x00, bindCount: true })).not.toBe(merkleRoot(hashes)); // node tag removed
    expect(controlRoot(hashes, { leafTag: 0x00, nodeTag: 0x00, bindCount: true })).not.toBe(merkleRoot(hashes)); // leaf and node tags collapsed onto one value

    // A single-chunk root is not the chunk's own digest, so a public chunk hash
    // can never be replayed as a root.
    expect(merkleRoot([hashes[0]!])).not.toBe(hashes[0]);
  });

  it('gives distinct chunk lists distinct roots, including the odd-node case', () => {
    const hashes = PKG.chunks.map((chunk) => chunk.contentHash);
    const roots = new Set<string>();
    for (let count = 1; count <= hashes.length; count += 1) roots.add(merkleRoot(hashes.slice(0, count)));
    expect(roots.size).toBe(hashes.length);
    // The classic duplicate-last-node collision: [a,b,c] must not equal [a,b,c,c].
    expect(merkleRoot([hashes[0]!, hashes[1]!, hashes[2]!])).not.toBe(merkleRoot([hashes[0]!, hashes[1]!, hashes[2]!, hashes[2]!]));
  });

  it('refuses to address nothing', () => {
    expect(() => buildArtifactPackage(Buffer.alloc(0))).toThrow(/at least one byte/);
    expect(() => merkleRoot([])).toThrow(/at least one chunk/);
    expect(() => buildArtifactPackage(BYTES, { chunkSizeBytes: 0 })).toThrow(/positive integer/);
  });

  it('produces a package a P-015 manifest validator accepts', () => {
    const validated = validateDistributionManifest(manifest());
    expect(validated.ok).toBe(true);
  });
});

describe('manifest root integrity', () => {
  it('accepts a manifest whose root commits to its chunk list', () => {
    expect(verifyManifestRoot(manifest())).toEqual({ ok: true });
    expect(packageMatchesManifest(PKG, manifest())).toEqual({ ok: true });
  });

  it('refuses a manifest whose declared root does NOT commit to its chunks', () => {
    // The substitution attack per-chunk verification alone cannot catch: swap a
    // chunk digest and keep the signed root. Every fetched chunk would verify
    // against the tampered list, so the root check is what refuses it.
    const tampered = manifest({ chunks: [{ ...PKG.chunks[0]!, contentHash: sha256Prefixed(Buffer.from('evil')) }, ...PKG.chunks.slice(1)] });
    const verdict = verifyManifestRoot(tampered);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.code).toBe('root-hash-mismatch');
  });

  it('reports a size lie separately from a hash lie', () => {
    const resized = manifest({ totalSizeBytes: PKG.totalSizeBytes + 1 });
    // rootHash still commits to the chunk list, so this is a size fault, not a root fault.
    const verdict = verifyManifestRoot(resized);
    expect(verdict.ok === false && verdict.code).toBe('total-size-mismatch');
    const mismatched = packageMatchesManifest(buildArtifactPackage(Buffer.from('other bytes entirely'), { chunkSizeBytes: CHUNK }), manifest());
    expect(mismatched.ok === false && mismatched.code).toBe('chunk-count-mismatch');
  });
});

describe('publish-time admission (EI-22433992128803548)', () => {
  // The obvious-but-wrong content address: sha256 over the whole blob, which is
  // what `contentHash` means everywhere else in this repo and what
  // artifact-store.ts uses for its hosted object key.
  const FLAT = sha256Prefixed(BYTES);

  it('accepts a correctly published release', () => {
    const verdict = validatePublishableRelease(manifest());
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.manifest.rootHash).toBe(PKG.rootHash);
  });

  it('the flat digest is genuinely a DIFFERENT address, at every size', () => {
    expect(FLAT).not.toBe(PKG.rootHash);
    // Not even one chunk collapses the two: merkleRoot([h]) !== h by construction.
    const single = buildArtifactPackage(BYTES, { chunkSizeBytes: BYTES.length });
    expect(single.chunks).toHaveLength(1);
    expect(single.rootHash).not.toBe(FLAT);
    expect(single.rootHash).not.toBe(single.chunks[0]!.contentHash);
  });

  it('refuses a PUBLIC release whose contentHash is sha256(bytes) instead of the Merkle root', () => {
    const wrong = manifest({ rootHash: FLAT, release: release({ contentHash: FLAT }) });

    // THE CONTROL, and the whole reason this door exists: the pre-existing
    // validator accepts it. Both fields are well-formed and equal to each
    // other, so nothing in a shape check can tell they were derived the wrong
    // way. If this assertion ever flips to false the door has become redundant
    // and should be deleted rather than kept as ceremony.
    expect(validateDistributionManifest(wrong).ok).toBe(true);

    const verdict = validatePublishableRelease(wrong);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.code).toBe('root-hash-mismatch');
    // The message must name the hash that is actually wrong. The retrieval-time
    // message this replaces said "chunk list commits to X" — which sends the
    // reader to investigate the bytes, where there is nothing to find.
    const detail = verdict.ok === false ? verdict.detail : '';
    expect(detail).toContain('release contentHash');
    expect(detail).toContain('merkleRoot(chunk digests)');
    expect(detail).toContain(PKG.rootHash);
    expect(detail).not.toContain('chunk list commits to');
  });

  it('refuses a PRIVATE release whose ciphertextHash is flat, and blames that field instead', () => {
    const wrong = manifest({
      visibility: 'private',
      rootHash: FLAT,
      encryption: { scheme: 'aes-256-gcm', keyVersion: 1, ciphertextHash: FLAT, wrappedKeyIds: ['wk-1'] },
    });
    expect(validateDistributionManifest(wrong).ok).toBe(true);

    const verdict = validatePublishableRelease(wrong);
    expect(verdict.ok === false && verdict.code).toBe('root-hash-mismatch');
    const detail = verdict.ok === false ? verdict.detail : '';
    expect(detail).toContain('encryption.ciphertextHash');
    expect(detail).not.toContain('release contentHash');
  });

  it('passes a shape failure through untouched rather than re-labelling it', () => {
    const verdict = validatePublishableRelease(manifest({ signature: '' }));
    expect(verdict.ok === false && verdict.code).toBe('missing-signature');
  });

  it('still refuses a swapped chunk digest, which is a real bytes fault', () => {
    // Here the chunk list genuinely IS the problem, so the re-attributed
    // message would be wrong. The root check fires before the door can
    // re-attribute anything, because rootHash no longer matches the list.
    const tampered = manifest({
      chunks: [{ ...PKG.chunks[0]!, contentHash: sha256Prefixed(Buffer.from('evil')) }, ...PKG.chunks.slice(1)],
    });
    const verdict = validatePublishableRelease(tampered);
    expect(verdict.ok === false && verdict.code).toBe('root-hash-mismatch');
  });
});

describe('resumable retrieval', () => {
  it('accepts verified chunks and is idempotent on a re-delivery', () => {
    const m = manifest();
    const first = acceptRetrievedChunk(m, beginRetrieval(m), { index: 0, bytes: chunkBytes(0) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.duplicate).toBe(false);
    expect(first.progress.held).toEqual([0]);

    const again = acceptRetrievedChunk(m, first.progress, { index: 0, bytes: chunkBytes(0) });
    expect(again.ok && again.duplicate).toBe(true);
    expect(again.ok && again.progress.held).toEqual([0]);
  });

  it('rejects corrupt, mis-sized, unknown and cross-package chunks at the boundary', () => {
    const m = manifest();
    const progress = beginRetrieval(m);
    const corrupt = acceptRetrievedChunk(m, progress, { index: 0, bytes: Buffer.from('XXXXXXXX') });
    expect(corrupt.ok === false && corrupt.code).toBe('chunk-hash-mismatch');
    const short = acceptRetrievedChunk(m, progress, { index: 0, bytes: Buffer.from('XX') });
    expect(short.ok === false && short.code).toBe('size-mismatch');
    const unknown = acceptRetrievedChunk(m, progress, { index: 99, bytes: chunkBytes(0) });
    expect(unknown.ok === false && unknown.code).toBe('unknown-chunk');
    const foreign = acceptRetrievedChunk(m, { ...progress, rootHash: sha256Prefixed(Buffer.from('elsewhere')) }, { index: 0, bytes: chunkBytes(0) });
    expect(foreign.ok === false && foreign.code).toBe('wrong-package');
  });

  it('plans only the missing chunks, so a resumed install refetches nothing', () => {
    const m = manifest();
    let progress = beginRetrieval(m);
    for (const index of [0, 1]) {
      const accepted = acceptRetrievedChunk(m, progress, { index, bytes: chunkBytes(index) });
      if (accepted.ok) progress = accepted.progress;
    }
    const plan = planRetrieval(state(), progress, { nowMs: 2_000 });
    expect(plan.missingChunks.map((chunk) => chunk.index)).toEqual(PKG.chunks.slice(2).map((chunk) => chunk.index));
    expect(plan.bytesRemaining).toBe(BYTES.length - progress.bytesHeld);
    expect(plan.complete).toBe(false);
    expect(plan.canFetch).toBe(true);
  });

  it('reports completeness and fetch permission as INDEPENDENT facts', () => {
    const m = manifest();
    let progress = beginRetrieval(m);
    for (const chunk of m.chunks) {
      const accepted = acceptRetrievedChunk(m, progress, { index: chunk.index, bytes: chunkBytes(chunk.index) });
      if (accepted.ok) progress = accepted.progress;
    }
    // Yanked AND fully held: the client is complete and barred from fetching more.
    const plan = planRetrieval(state({ yankedAtMs: 5_000, yankReason: 'security' }), progress, { nowMs: 6_000 });
    expect(plan.complete).toBe(true);
    expect(plan.canFetch).toBe(false);
    expect(plan.reason).toBe('yanked');
    expect(completeRetrieval(m, progress)).toEqual({ ok: true, rootHash: PKG.rootHash, totalSizeBytes: PKG.totalSizeBytes });
  });

  it('refuses to declare an incomplete assembly complete', () => {
    const m = manifest();
    const verdict = completeRetrieval(m, beginRetrieval(m));
    expect(verdict.ok === false && verdict.code).toBe('incomplete');
    expect(completeRetrieval(null, beginRetrieval(m)).ok).toBe(false);
  });
});

describe('provider adapters are a registration, never a branch', () => {
  it('looks an adapter up by providerId and never guesses from the locator', () => {
    const registry = createProviderRegistry([honestAdapter('libp2p')]);
    expect(registry.providerIds).toEqual(['libp2p']);
    expect(registry.adapterFor(source())?.providerId).toBe('libp2p');
    // A locator that LOOKS like an ordinary URL confers nothing: an unregistered
    // provider is null, not an implicit HTTP fetch.
    expect(registry.adapterFor(source({ providerId: 'r2', locator: 'https://cdn.example.com/blob' }))).toBeNull();
  });

  it('refuses to register the same providerId twice', () => {
    const registry = createProviderRegistry([honestAdapter('libp2p')]);
    expect(() => registry.register(honestAdapter('libp2p'))).toThrow(/already registered/);
  });

  it('fetches every chunk through registered adapters and completes', async () => {
    const seen: string[] = [];
    const outcome = await retrieveArtifact(state(), beginRetrieval(manifest()), {
      nowMs: 2_000,
      registry: createProviderRegistry([honestAdapter('libp2p', seen)]),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe('ok');
    expect(outcome.progress.held).toEqual(PKG.chunks.map((chunk) => chunk.index));
    expect(outcome.progress.bytesHeld).toBe(BYTES.length);
    expect(seen).toHaveLength(PKG.chunks.length);
    expect(completeRetrieval(manifest(), outcome.progress).ok).toBe(true);
  });

  it('resumes: an already-held chunk is never refetched', async () => {
    const m = manifest();
    const first = acceptRetrievedChunk(m, beginRetrieval(m), { index: 0, bytes: chunkBytes(0) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const seen: string[] = [];
    const outcome = await retrieveArtifact(state(), first.progress, { nowMs: 2_000, registry: createProviderRegistry([honestAdapter('libp2p', seen)]) });
    expect(outcome.ok).toBe(true);
    expect(seen.some((entry) => entry.endsWith('#0'))).toBe(false);
    expect(outcome.fetched.map((entry) => entry.chunkIndex)).toEqual(PKG.chunks.slice(1).map((chunk) => chunk.index));
  });

  it('skips a source that serves bad bytes and completes from the next one', async () => {
    const liar: ArtifactProviderAdapter = { providerId: 'liar', async fetchChunk({ chunk }) { return Buffer.alloc(chunk.sizeBytes, 0x00); } };
    const outcome = await retrieveArtifact(
      state({
        // A pinner is tried first by class order — and it lies.
        sources: [source({ sourceId: 'src-liar', class: 'pinner', providerId: 'liar' }), source({ sourceId: 'src-honest', class: 'peer', providerId: 'libp2p' })],
        pins: ['src-liar', 'src-honest'],
      }),
      beginRetrieval(manifest()),
      { nowMs: 2_000, registry: createProviderRegistry([liar, honestAdapter('libp2p')]) },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.fetched.every((entry) => entry.sourceId === 'src-honest')).toBe(true);
    expect(outcome.failures.every((failure) => failure.sourceId === 'src-liar' && failure.code === 'chunk-hash-mismatch')).toBe(true);
    expect(outcome.failures).toHaveLength(PKG.chunks.length);
  });

  it('inherits the P-015 refusals instead of re-deciding delivery', async () => {
    const registry = createProviderRegistry([honestAdapter('libp2p')]);
    const yanked = await retrieveArtifact(state({ yankedAtMs: 5_000, yankReason: 'security' }), beginRetrieval(manifest()), { nowMs: 6_000, registry });
    expect(yanked.ok).toBe(false);
    expect(yanked.reason).toBe('yanked');
    expect(yanked.fetched).toEqual([]);

    const offline = await retrieveArtifact(state({ pins: [] }), beginRetrieval(manifest()), { nowMs: 2_000, offline: true, registry });
    expect(offline.reason).toBe('offline-no-pin');
  });

  it('reports an unavailable chunk rather than a silent partial install', async () => {
    const outcome = await retrieveArtifact(state(), beginRetrieval(manifest()), { nowMs: 2_000, registry: createProviderRegistry([]) });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('chunk-unavailable');
    expect(outcome.failures[0]?.code).toBe('no-adapter');
  });

  it('refuses a manifest whose root does not commit to its chunks BEFORE fetching a byte', async () => {
    const seen: string[] = [];
    const tampered = manifest({ chunks: [{ ...PKG.chunks[0]!, contentHash: sha256Prefixed(Buffer.from('evil')) }, ...PKG.chunks.slice(1)] });
    const outcome = await retrieveArtifact(state({ manifest: tampered }), beginRetrieval(tampered), {
      nowMs: 2_000,
      registry: createProviderRegistry([honestAdapter('libp2p', seen)]),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('manifest-root-invalid');
    expect(seen).toEqual([]);
  });
});

describe('signed channel pointers', () => {
  it('digests canonically and identifies a channel deterministically', () => {
    expect(channelPointerId(pointer())).toBe('channel:plugin:demo#stable');
    expect(channelPointerDigest(unsignedChannelPointer(pointer()))).toBe(channelPointerDigest(unsignedChannelPointer(pointer())));
    expect(channelPointerDigest(unsignedChannelPointer(pointer()))).not.toBe(channelPointerDigest(unsignedChannelPointer(pointer({ sequence: 6 }))));
    expect(validateChannelPointer(pointer()).ok).toBe(true);
    expect(validateChannelPointer({ ...pointer(), sequence: 0 }).ok).toBe(false);
    expect(validateChannelPointer({ ...pointer(), manifestDigest: 'not-a-digest' }).ok).toBe(false);
  });

  it('binds a pointer to one manifest: root, version and digest must all agree', () => {
    const m = manifest();
    expect(advanceChannelPointer(null, pointer(), m).ok).toBe(true);

    const wrongRoot = advanceChannelPointer(null, pointer({ rootHash: sha256Prefixed(Buffer.from('other')) }), m);
    expect(wrongRoot.ok === false && wrongRoot.code).toBe('manifest-mismatch');

    const wrongVersion = advanceChannelPointer(null, pointer({ releaseVersion: '9.9.9' }), m);
    expect(wrongVersion.ok === false && wrongVersion.code).toBe('manifest-mismatch');

    const wrongDigest = advanceChannelPointer(null, pointer({ manifestDigest: 'f'.repeat(64) }), m);
    expect(wrongDigest.ok === false && wrongDigest.code).toBe('manifest-mismatch');

    const wrongListing = advanceChannelPointer(null, pointer({ listingRef: 'other' }), m);
    expect(wrongListing.ok === false && wrongListing.code).toBe('listing-mismatch');
  });

  it('refuses a REPLAYED pointer while allowing a deliberate rollback', () => {
    const current = pointer({ sequence: 5, releaseVersion: '2.0.0' });
    const m = manifest();

    // Replay of the standing pointer, or anything at or below its sequence.
    const replay = advanceChannelPointer(current, pointer({ sequence: 5 }), m);
    expect(replay.ok === false && replay.code).toBe('non-monotonic-sequence');
    const older = advanceChannelPointer(current, pointer({ sequence: 4 }), m);
    expect(older.ok === false && older.code).toBe('non-monotonic-sequence');

    // Withdrawing a bad 2.0.0 by republishing 1.9.0 under a NEW sequence is
    // legitimate, and is reported as a rollback rather than refused.
    const rollbackManifest = manifest({ release: release({ releaseVersion: '1.9.0' }) });
    const rollback = advanceChannelPointer(
      current,
      pointer({ sequence: 6, releaseVersion: '1.9.0', publishedAtMs: 20_000, manifestDigest: manifestBindingDigest(rollbackManifest) }),
      rollbackManifest,
    );
    expect(rollback.ok).toBe(true);
    expect(rollback.ok && rollback.rolledBack).toBe(true);

    const forward = advanceChannelPointer(current, pointer({ sequence: 6, publishedAtMs: 20_000 }), m);
    expect(forward.ok && forward.rolledBack).toBe(false);
  });

  it('refuses a pointer from another issuer, another channel, or an earlier timestamp', () => {
    const current = pointer();
    const m = manifest();
    const foreignIssuer = advanceChannelPointer(current, pointer({ sequence: 6, issuer: 'attacker-key' }), m);
    expect(foreignIssuer.ok === false && foreignIssuer.code).toBe('issuer-mismatch');
    const wrongChannel = advanceChannelPointer(current, pointer({ sequence: 6, channel: 'beta' }), m);
    expect(wrongChannel.ok === false && wrongChannel.code).toBe('channel-mismatch');
    const backdated = advanceChannelPointer(current, pointer({ sequence: 6, publishedAtMs: 9_000 }), m);
    expect(backdated.ok === false && backdated.code).toBe('stale-timestamp');
  });

  it('confers no delivery authority of its own', () => {
    const ok = resolveChannel(pointer(), state(), { nowMs: 2_000 });
    expect(ok.deliverable).toBe(true);
    expect(ok.sources.map((entry) => entry.sourceId)).toEqual(['src-peer']);

    // Yanking the release stops delivery through every channel naming it,
    // without the yank touching a single pointer.
    const yanked = resolveChannel(pointer(), state({ yankedAtMs: 5_000, yankReason: 'security' }), { nowMs: 6_000 });
    expect(yanked.deliverable).toBe(false);
    expect(yanked.reason).toBe('yanked');

    // A pointer naming a release the stream does not describe is refused rather
    // than silently serving whatever the stream happens to hold.
    const stale = resolveChannel(pointer({ releaseVersion: '1.0.0' }), state(), { nowMs: 2_000 });
    expect(stale.deliverable).toBe(false);
    expect(stale.reason).toBe('pointer-mismatch');
  });
});
