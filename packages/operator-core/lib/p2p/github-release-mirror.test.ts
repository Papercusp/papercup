/**
 * P-045 — GitHub Releases as the public mirror provider.
 *
 * The GitHub API is faked at the `fetch` boundary and nothing else is: the
 * package build, the Merkle root, the manifest validation, the distribution
 * resolution and the retrieval assembly are all production code, so an
 * end-to-end publish → fetch → verify runs the real content-addressing.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PINNING_POLICY,
  distributionStreamId,
  isAuthoritativeSource,
  type ArtifactDistributionManifest,
  type ArtifactDistributionState,
} from './artifact-distribution';
import {
  beginRetrieval,
  buildArtifactPackage,
  completeRetrieval,
  createProviderRegistry,
  merkleRoot,
  retrieveArtifact,
  sha256Prefixed,
} from './artifact-package';
import { cupboardArtifactKey } from '../cupboard/artifact-store';
import {
  GITHUB_RELEASE_ASSET_MAX_BYTES,
  GITHUB_RELEASE_MIRROR_PROVIDER_ID,
  formatGithubReleaseLocator,
  githubReleaseAssetNameForRoot,
  githubReleaseMirrorAdapter,
  githubReleaseMirrorStore,
  githubReleaseTagForRoot,
  parseGithubReleaseLocator,
  publishGithubReleaseMirror,
} from './github-release-mirror';
import type { CupboardReleaseManifest } from '../cupboard/listing-manifest';

const CHUNK = 8;
const BYTES = Buffer.from('the-quick-brown-fox-jumps-over-a-lazy-dog!', 'utf8');
const PKG = buildArtifactPackage(BYTES, { chunkSizeBytes: CHUNK });
const REPO = { owner: 'papercusp', repo: 'cupboard-mirror' } as const;
const TAG = githubReleaseTagForRoot(PKG.rootHash);
const ASSET = githubReleaseAssetNameForRoot(PKG.rootHash);
const LOCATOR = formatGithubReleaseLocator({ owner: REPO.owner, repo: REPO.repo, tag: TAG, asset: ASSET });

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

/** A private manifest, well-formed per D-035 ruling 4 so the refusal is about VISIBILITY. */
const privateManifest = (): ArtifactDistributionManifest => {
  const ciphertext = Buffer.from('encrypted-payload-bytes-for-the-private-listing', 'utf8');
  const pkg = buildArtifactPackage(ciphertext, { chunkSizeBytes: CHUNK });
  return {
    ...manifest(),
    rootHash: pkg.rootHash,
    totalSizeBytes: pkg.totalSizeBytes,
    chunks: pkg.chunks,
    visibility: 'private',
    encryption: { scheme: 'aes-256-gcm', keyVersion: 1, ciphertextHash: pkg.rootHash, wrappedKeyIds: ['wk-1'] },
  };
};

// ---------------------------------------------------------------------------
// A fake GitHub, addressed exactly as the real one is.
// ---------------------------------------------------------------------------

interface FakeAsset {
  id: number;
  name: string;
  size: number;
  bytes: Buffer;
  browser_download_url: string;
}

function fakeGithub(options: { honorsRange?: boolean; seedAsset?: Buffer } = {}) {
  const honorsRange = options.honorsRange ?? true;
  const releases = new Map<string, { id: number; assets: FakeAsset[] }>();
  const calls: { method: string; url: string; authorization: string | null }[] = [];
  let nextId = 100;

  if (options.seedAsset) {
    releases.set(TAG, {
      id: 1,
      assets: [
        {
          id: 7,
          name: ASSET,
          size: options.seedAsset.length,
          bytes: options.seedAsset,
          browser_download_url: `https://github.com/${REPO.owner}/${REPO.repo}/releases/download/${TAG}/${ASSET}`,
        },
      ],
    });
  }

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    calls.push({ method, url, authorization: headers.get('authorization') });
    const parsed = new URL(url);
    const path = parsed.pathname;

    if (method === 'GET' && path.startsWith(`/repos/${REPO.owner}/${REPO.repo}/releases/tags/`)) {
      const tag = decodeURIComponent(path.split('/').pop()!);
      const found = releases.get(tag);
      if (!found) return json({ message: 'Not Found' }, 404);
      return json({ id: found.id, assets: found.assets.map(({ bytes: _bytes, ...rest }) => rest) });
    }

    if (method === 'POST' && path === `/repos/${REPO.owner}/${REPO.repo}/releases`) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { tag_name?: string };
      const id = (nextId += 1);
      releases.set(body.tag_name ?? '', { id, assets: [] });
      return json({ id, assets: [] }, 201);
    }

    const uploadMatch = path.match(new RegExp(`^/repos/${REPO.owner}/${REPO.repo}/releases/(\\d+)/assets$`));
    if (method === 'POST' && uploadMatch) {
      const id = Number(uploadMatch[1]);
      const entry = [...releases.values()].find((candidate) => candidate.id === id);
      if (!entry) return json({ message: 'Not Found' }, 404);
      const name = parsed.searchParams.get('name') ?? '';
      const bytes = Buffer.from(init?.body as Uint8Array);
      const asset: FakeAsset = {
        id: (nextId += 1),
        name,
        size: bytes.length,
        bytes,
        browser_download_url: `https://github.com/${REPO.owner}/${REPO.repo}/releases/download/${TAG}/${name}`,
      };
      entry.assets.push(asset);
      return json({ id: asset.id, name, size: asset.size, browser_download_url: asset.browser_download_url }, 201);
    }

    const deleteMatch = path.match(new RegExp(`^/repos/${REPO.owner}/${REPO.repo}/releases/assets/(\\d+)$`));
    if (method === 'DELETE' && deleteMatch) {
      const assetId = Number(deleteMatch[1]);
      for (const entry of releases.values()) {
        const index = entry.assets.findIndex((asset) => asset.id === assetId);
        if (index >= 0) {
          entry.assets.splice(index, 1);
          return new Response(null, { status: 204 });
        }
      }
      return json({ message: 'Not Found' }, 404);
    }

    const downloadMatch = path.match(new RegExp(`^/${REPO.owner}/${REPO.repo}/releases/download/([^/]+)/([^/]+)$`));
    if (method === 'GET' && downloadMatch) {
      const entry = releases.get(decodeURIComponent(downloadMatch[1]!));
      const asset = entry?.assets.find((candidate) => candidate.name === decodeURIComponent(downloadMatch[2]!));
      if (!asset) return json({ message: 'Not Found' }, 404);
      const range = headers.get('range');
      if (honorsRange && range) {
        const [start, end] = range.replace('bytes=', '').split('-').map(Number) as [number, number];
        return new Response(new Uint8Array(asset.bytes.subarray(start, end + 1)), { status: 206 });
      }
      // A host that ignores Range: the adapter must still be correct.
      return new Response(new Uint8Array(asset.bytes), { status: 200 });
    }

    return json({ message: `unexpected ${method} ${url}` }, 500);
  };

  return { fetchImpl, calls, releases };
}

const deps = (fetchImpl: typeof fetch, token = 'ghp-owner-installed') => ({ fetchImpl, token });

// ---------------------------------------------------------------------------

describe('the mirror locator is a provider-private address, never a URL', () => {
  it('round-trips owner/repo/tag/asset and refuses anything else', () => {
    const parsed = parseGithubReleaseLocator(LOCATOR);
    expect(parsed.ok && parsed.locator).toEqual({ owner: REPO.owner, repo: REPO.repo, tag: TAG, asset: ASSET });

    // A URL is not a locator here: the adapter owns the grammar, so a shape it
    // does not define is refused rather than guessed at (D-040 ruling 5).
    const url = parseGithubReleaseLocator('https://github.com/o/r/releases/download/t/a');
    expect(url.ok === false && url.code).toBe('malformed-locator');
    expect(parseGithubReleaseLocator('owner/repo//asset').ok).toBe(false);
    expect(parseGithubReleaseLocator('owner/repo/tag').ok).toBe(false);
  });

  it('derives the tag and asset from the Merkle root, so the address is the identity', () => {
    expect(TAG).toBe(`cupboard-sha256-${PKG.rootHash.slice('sha256:'.length)}`);
    expect(ASSET.startsWith(PKG.rootHash.slice('sha256:'.length))).toBe(true);
    // The chunking is part of the identity, so a flat digest is a DIFFERENT address.
    expect(githubReleaseTagForRoot(sha256Prefixed(BYTES))).not.toBe(TAG);
  });
});

describe('publishing to the public mirror', () => {
  it('creates the release, uploads the bytes, and advertises a NON-authoritative cache source', async () => {
    const github = fakeGithub();
    const result = await publishGithubReleaseMirror(deps(github.fetchImpl), {
      manifest: manifest(),
      bytes: BYTES,
      repo: REPO,
      nowMs: 1_000,
      chunkSizeBytes: CHUNK,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reused).toBe(false);
    expect(result.locator).toBe(LOCATOR);
    expect(result.source.providerId).toBe(GITHUB_RELEASE_MIRROR_PROVIDER_ID);
    // D-035 ruling 2: a mirror accelerates delivery and is excluded from replica
    // counting. Counting it would report a single-origin release as replicated.
    expect(result.source.class).toBe('cache');
    expect(isAuthoritativeSource(result.source)).toBe(false);
    // No github.com URL leaks into the distribution record — only the locator.
    expect(result.source.locator).not.toContain('http');

    expect(github.releases.get(TAG)?.assets.map((asset) => asset.name)).toEqual([ASSET]);
    const write = github.calls.find((call) => call.method === 'POST' && call.url.includes('/assets?'));
    expect(write?.authorization).toBe('Bearer ghp-owner-installed');
  });

  it('is idempotent: an asset already on the mirror is reused, not re-uploaded', async () => {
    const github = fakeGithub({ seedAsset: BYTES });
    const result = await publishGithubReleaseMirror(deps(github.fetchImpl), {
      manifest: manifest(),
      bytes: BYTES,
      repo: REPO,
      nowMs: 2_000,
      chunkSizeBytes: CHUNK,
    });
    expect(result.ok && result.reused).toBe(true);
    expect(github.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('replaces a partial asset rather than wedging behind a duplicate-name refusal', async () => {
    // Same asset NAME, wrong size: an abandoned upload. GitHub refuses a
    // duplicate name, so leaving it would strand this artifact's mirror behind
    // a 422 that reads like a permissions problem.
    const github = fakeGithub({ seedAsset: BYTES.subarray(0, 10) });
    const result = await publishGithubReleaseMirror(deps(github.fetchImpl), {
      manifest: manifest(),
      bytes: BYTES,
      repo: REPO,
      nowMs: 2_500,
      chunkSizeBytes: CHUNK,
    });
    expect(result.ok && result.reused).toBe(false);
    expect(github.calls.some((call) => call.method === 'DELETE')).toBe(true);
    const assets = github.releases.get(TAG)?.assets ?? [];
    expect(assets.map((asset) => asset.size)).toEqual([BYTES.length]);
  });

  it('REFUSES a private listing before the token check and before any network call', async () => {
    const github = fakeGithub();
    // Fully configured deployment, valid token: the refusal is about visibility
    // alone, because a public copy cannot be recalled once taken (D-022/D-056).
    const result = await publishGithubReleaseMirror(deps(github.fetchImpl), {
      manifest: privateManifest(),
      bytes: Buffer.from('encrypted-payload-bytes-for-the-private-listing', 'utf8'),
      repo: REPO,
      nowMs: 3_000,
      chunkSizeBytes: CHUNK,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('private-not-mirrored');
    // Nothing was attempted — not a create, not a lookup.
    expect(github.calls).toEqual([]);
  });

  it('fails CLOSED with no token, and still refuses a private listing first', async () => {
    const github = fakeGithub();
    const unconfigured = await publishGithubReleaseMirror(deps(github.fetchImpl, ''), {
      manifest: manifest(),
      bytes: BYTES,
      repo: REPO,
      nowMs: 4_000,
    });
    expect(unconfigured.ok === false && unconfigured.code).toBe('missing-token');
    expect(github.calls).toEqual([]);

    const privateUnconfigured = await publishGithubReleaseMirror(deps(github.fetchImpl, ''), {
      manifest: privateManifest(),
      bytes: Buffer.from('encrypted-payload-bytes-for-the-private-listing', 'utf8'),
      repo: REPO,
      nowMs: 4_000,
    });
    expect(privateUnconfigured.ok === false && privateUnconfigured.code).toBe('private-not-mirrored');
  });

  it('refuses bytes that do not answer to the manifest address', async () => {
    const github = fakeGithub();
    // SAME LENGTH as the real payload, three bytes different. A manifest-only
    // check passes this (the manifest is internally consistent and the size
    // agrees); only rebuilding the package from the bytes catches it.
    const wrong = await publishGithubReleaseMirror(deps(github.fetchImpl), {
      manifest: manifest(),
      bytes: Buffer.from('the-quick-brown-fox-jumps-over-a-lazy-cat!', 'utf8'),
      repo: REPO,
      nowMs: 5_000,
      chunkSizeBytes: CHUNK,
    });
    expect(wrong.ok === false && wrong.code).toBe('content-address-mismatch');
    expect(github.calls).toEqual([]);

    // A manifest addressed the FLAT way (sha256 of the bytes) is the classic
    // mistake `validatePublishableRelease` exists to catch; the mirror inherits it.
    const flat = await publishGithubReleaseMirror(deps(github.fetchImpl), {
      manifest: manifest({ rootHash: sha256Prefixed(BYTES), release: release({ contentHash: sha256Prefixed(BYTES) }) }),
      bytes: BYTES,
      repo: REPO,
      nowMs: 5_000,
      chunkSizeBytes: CHUNK,
    });
    expect(flat.ok === false && flat.code).toBe('content-address-mismatch');
  });

  it('refuses a repo shape that would break the locator grammar, and an over-size asset', async () => {
    const github = fakeGithub();
    const badRepo = await publishGithubReleaseMirror(deps(github.fetchImpl), {
      manifest: manifest(),
      bytes: BYTES,
      repo: { owner: 'papercusp/extra', repo: 'mirror' },
      nowMs: 6_000,
    });
    expect(badRepo.ok === false && badRepo.code).toBe('invalid-repo');

    const huge = { length: GITHUB_RELEASE_ASSET_MAX_BYTES + 1 } as unknown as Buffer;
    const tooLarge = await publishGithubReleaseMirror(deps(github.fetchImpl), {
      manifest: manifest(),
      bytes: huge,
      repo: REPO,
      nowMs: 6_000,
    });
    expect(tooLarge.ok === false && tooLarge.code).toBe('too-large');
    expect(github.calls).toEqual([]);
  });

  it('surfaces a GitHub failure as github-error rather than a half-published mirror', async () => {
    const failing: typeof fetch = async () => new Response('{"message":"Bad credentials"}', { status: 401 });
    const result = await publishGithubReleaseMirror(deps(failing), {
      manifest: manifest(),
      bytes: BYTES,
      repo: REPO,
      nowMs: 7_000,
      chunkSizeBytes: CHUNK,
    });
    expect(result.ok === false && result.code).toBe('github-error');
    expect(result.ok === false && result.detail).toContain('401');
  });
});

describe('retrieving from the mirror by Merkle root', () => {
  const mirrorState = (): ArtifactDistributionState => ({
    streamId: distributionStreamId(release()),
    manifest: manifest(),
    sources: [
      {
        sourceId: 'mirror-1',
        class: 'cache',
        providerId: GITHUB_RELEASE_MIRROR_PROVIDER_ID,
        locator: LOCATOR,
        advertisedAtMs: 1_000,
        expiresAtMs: null,
      },
    ],
    pins: [],
    keyVersion: 1,
    revokedKeyVersions: [],
    yankedAtMs: null,
    yankReason: null,
    lastSequence: 3,
  });

  for (const honorsRange of [true, false]) {
    it(`assembles and verifies the whole package against the root (Range ${honorsRange ? 'honoured' : 'ignored'})`, async () => {
      const github = fakeGithub({ honorsRange });
      const published = await publishGithubReleaseMirror(deps(github.fetchImpl), {
        manifest: manifest(),
        bytes: BYTES,
        repo: REPO,
        nowMs: 1_000,
        chunkSizeBytes: CHUNK,
      });
      expect(published.ok).toBe(true);

      const registry = createProviderRegistry([
        githubReleaseMirrorAdapter({ fetchImpl: github.fetchImpl }, { chunkSizeBytes: CHUNK }),
      ]);
      const outcome = await retrieveArtifact(mirrorState(), beginRetrieval(manifest()), { nowMs: 2_000, registry });

      expect(outcome.reason).toBe('ok');
      expect(outcome.ok).toBe(true);
      expect(outcome.failures).toEqual([]);
      expect(outcome.fetched.map((entry) => entry.chunkIndex)).toEqual(PKG.chunks.map((chunk) => chunk.index));
      // The Merkle root — not the transport — is what declares the artifact whole.
      expect(completeRetrieval(manifest(), outcome.progress)).toEqual({
        ok: true,
        rootHash: PKG.rootHash,
        totalSizeBytes: PKG.totalSizeBytes,
      });
      expect(merkleRoot(PKG.chunks.map((chunk) => chunk.contentHash))).toBe(PKG.rootHash);
    });
  }

  it('rejects bytes the mirror serves that do not match the chunk digest', async () => {
    const liar: typeof fetch = async () => new Response(new Uint8Array(Buffer.from('XXXXXXXX')), { status: 206 });
    const adapter = githubReleaseMirrorAdapter({ fetchImpl: liar }, { chunkSizeBytes: CHUNK });
    await expect(
      adapter.fetchChunk({
        source: mirrorState().sources[0]!,
        rootHash: PKG.rootHash,
        chunk: PKG.chunks[0]!,
      }),
    ).rejects.toThrow(/hashes to/);
  });

  it('refuses a locator it cannot parse instead of guessing a transport', async () => {
    const never: typeof fetch = async () => {
      throw new Error('must not be called');
    };
    const adapter = githubReleaseMirrorAdapter({ fetchImpl: never });
    await expect(
      adapter.fetchChunk({
        source: { ...mirrorState().sources[0]!, locator: 'https://cdn.example.com/blob' },
        rootHash: PKG.rootHash,
        chunk: PKG.chunks[0]!,
      }),
    ).rejects.toThrow(/invalid-segment/);
  });
});

describe('the mirror as an ArtifactStore (P-007 seam)', () => {
  it('heads and deletes the mirrored object under the seam content-addressed key', async () => {
    const github = fakeGithub();
    await publishGithubReleaseMirror(deps(github.fetchImpl), {
      manifest: manifest(),
      bytes: BYTES,
      repo: REPO,
      nowMs: 1_000,
      chunkSizeBytes: CHUNK,
    });

    const store = githubReleaseMirrorStore(deps(github.fetchImpl), REPO);
    expect(store.providerId).toBe(GITHUB_RELEASE_MIRROR_PROVIDER_ID);
    expect(store.capabilities.presigned).toBe(false);

    const key = cupboardArtifactKey(PKG.rootHash);
    const head = await store.head(key);
    expect(head).toEqual({ storageKey: key, sizeBytes: BYTES.length, contentType: 'application/octet-stream' });

    await store.delete(key);
    expect(await store.head(key)).toBeNull();
    // Deleting what is not there is not an error; a yank must be re-runnable.
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it('mints a proxied ticket, because an owner token cannot be handed to a client', async () => {
    const github = fakeGithub();
    const store = githubReleaseMirrorStore(deps(github.fetchImpl), REPO);
    const ticket = await store.createUploadTicket(
      { contentHash: PKG.rootHash, sizeBytes: BYTES.length, contentType: 'application/octet-stream' },
      10_000,
    );
    expect(ticket.transport).toBe('proxied-put');
    expect(ticket.url).toBeUndefined();
    expect(ticket.storageKey).toBe(cupboardArtifactKey(PKG.rootHash));
    expect(ticket.expiresAtMs).toBeGreaterThan(10_000);
  });
});
