/**
 * P-045 — the shipped Worker door that mirrors a public release to GitHub.
 *
 * GitHub is faked at `fetch`; authentication, the operator allowlist, the R2
 * origin read, manifest validation, the content-address agreement and the
 * refusal ordering are all production code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildArtifactPackage } from '@papercusp/operator-core/lib/p2p/artifact-package.ts';
import {
  DEFAULT_PINNING_POLICY,
  type ArtifactDistributionManifest,
} from '@papercusp/operator-core/lib/p2p/artifact-distribution.ts';
import { cupboardArtifactKey } from '@papercusp/operator-core/lib/cupboard/artifact-store.ts';
import {
  githubReleaseAssetNameForRoot,
  githubReleaseTagForRoot,
} from '@papercusp/operator-core/lib/p2p/github-release-mirror.ts';
import { buildApi } from '../routes/index.ts';
import { resolveReleaseMirrorConfig } from '../routes/release-mirror.ts';
import { makeEnv } from './fake-d1.ts';

const auth = vi.hoisted(() => ({ resolveGithubBearer: vi.fn() }));
vi.mock('../auth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.ts')>();
  return { ...actual, resolveGithubBearer: auth.resolveGithubBearer };
});

const BYTES = Buffer.from('a-public-cupboard-release-payload', 'utf8');
const PKG = buildArtifactPackage(BYTES);
const OWNER = 'papercusp';
const REPO = 'cupboard-mirror';
const TAG = githubReleaseTagForRoot(PKG.rootHash);
const ASSET = githubReleaseAssetNameForRoot(PKG.rootHash);

const manifest = (overrides: Partial<ArtifactDistributionManifest> = {}): ArtifactDistributionManifest => ({
  schemaVersion: 1,
  release: {
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
  },
  rootHash: PKG.rootHash,
  totalSizeBytes: PKG.totalSizeBytes,
  chunks: PKG.chunks,
  visibility: 'public',
  encryption: null,
  pinning: DEFAULT_PINNING_POLICY,
  signature: 'manifest-sig',
  ...overrides,
});

const privateManifest = (): ArtifactDistributionManifest => {
  const ciphertext = Buffer.from('ciphertext-for-the-private-listing', 'utf8');
  const pkg = buildArtifactPackage(ciphertext);
  return {
    ...manifest(),
    rootHash: pkg.rootHash,
    totalSizeBytes: pkg.totalSizeBytes,
    chunks: pkg.chunks,
    visibility: 'private',
    encryption: { scheme: 'aes-256-gcm', keyVersion: 1, ciphertextHash: pkg.rootHash, wrappedKeyIds: ['wk-1'] },
  };
};

function fakeGithub() {
  const uploads: { name: string; size: number }[] = [];
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push(`${method} ${new URL(url).pathname}`);
    if (method === 'GET') return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    if (method === 'POST' && url.includes('/assets?')) {
      const name = new URL(url).searchParams.get('name') ?? '';
      const bytes = Buffer.from(init?.body as Uint8Array);
      uploads.push({ name, size: bytes.length });
      return new Response(JSON.stringify({ id: 55, browser_download_url: `https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${name}` }), { status: 201 });
    }
    return new Response(JSON.stringify({ id: 9, assets: [] }), { status: 201 });
  };
  return { fetchImpl, uploads, calls };
}

function harness(options: { configured?: boolean; fetchImpl?: typeof fetch; seedArtifact?: boolean } = {}) {
  const { env, r2 } = makeEnv({
    CUPBOARD_OPERATOR_GITHUB_IDS: '42',
    ...(options.configured === false
      ? {}
      : { GITHUB_RELEASE_MIRROR_TOKEN: 'ghp-owner-installed', GITHUB_RELEASE_MIRROR_REPO: `${OWNER}/${REPO}` }),
  });
  if (options.seedArtifact !== false) r2.data.set(cupboardArtifactKey(PKG.rootHash), new Uint8Array(BYTES));
  return { api: buildApi({ fetchImpl: options.fetchImpl }), env, r2 };
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('resolveReleaseMirrorConfig', () => {
  it('names WHICH owner input is missing rather than a bare "not configured"', () => {
    expect(resolveReleaseMirrorConfig({}).ok).toBe(false);
    expect(resolveReleaseMirrorConfig({}) as { reason: string }).toMatchObject({ reason: 'missing_token' });
    expect(resolveReleaseMirrorConfig({ GITHUB_RELEASE_MIRROR_TOKEN: 't' })).toMatchObject({ reason: 'missing_repo' });
    expect(
      resolveReleaseMirrorConfig({ GITHUB_RELEASE_MIRROR_TOKEN: 't', GITHUB_RELEASE_MIRROR_REPO: 'not-a-slug' }),
    ).toMatchObject({ reason: 'malformed_repo' });
    expect(
      resolveReleaseMirrorConfig({ GITHUB_RELEASE_MIRROR_TOKEN: ' t ', GITHUB_RELEASE_MIRROR_REPO: 'o/r' }),
    ).toEqual({ ok: true, config: { token: 't', repo: { owner: 'o', repo: 'r' } } });
  });
});

describe('POST /admin/release-mirror', () => {
  beforeEach(() => {
    auth.resolveGithubBearer.mockReset();
    auth.resolveGithubBearer.mockResolvedValue({ id: 42, login: 'avi' });
  });

  it('publishes a public release from the R2 hot copy and returns a cache source', async () => {
    const github = fakeGithub();
    const { api, env } = harness({ fetchImpl: github.fetchImpl });

    const response = await api.request('/admin/release-mirror', post({ manifest: manifest() }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      reused: false,
      rootHash: PKG.rootHash,
      locator: `${OWNER}/${REPO}/${TAG}/${ASSET}`,
      source: { providerId: 'github-releases', class: 'cache' },
    });
    expect(github.uploads).toEqual([{ name: ASSET, size: BYTES.length }]);
  });

  it('REFUSES a private listing with 409 and never contacts GitHub', async () => {
    const github = fakeGithub();
    const { api, env } = harness({ fetchImpl: github.fetchImpl });

    const response = await api.request('/admin/release-mirror', post({ manifest: privateManifest() }), env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'private_not_mirrored' });
    expect(github.calls).toEqual([]);
  });

  it('refuses a private listing even on an UNCONFIGURED deployment, so 503 never implies "configure it and retry"', async () => {
    const github = fakeGithub();
    const { api, env } = harness({ configured: false, fetchImpl: github.fetchImpl });

    const response = await api.request('/admin/release-mirror', post({ manifest: privateManifest() }), env);
    expect(response.status).toBe(409);
    expect(github.calls).toEqual([]);
  });

  it('fails CLOSED with 503 when the owner has not installed the token', async () => {
    const github = fakeGithub();
    const { api, env } = harness({ configured: false, fetchImpl: github.fetchImpl });

    const response = await api.request('/admin/release-mirror', post({ manifest: manifest() }), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'not_configured', reason: 'missing_token' });
    expect(github.calls).toEqual([]);
  });

  it('404s when R2 — the origin — does not hold the bytes', async () => {
    const github = fakeGithub();
    const { api, env } = harness({ fetchImpl: github.fetchImpl, seedArtifact: false });

    const response = await api.request('/admin/release-mirror', post({ manifest: manifest() }), env);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'artifact_not_stored' });
    expect(github.calls).toEqual([]);
  });

  it('requires an operator, and rejects a malformed manifest before anything else', async () => {
    const github = fakeGithub();
    const { api, env } = harness({ fetchImpl: github.fetchImpl });

    auth.resolveGithubBearer.mockResolvedValueOnce({ id: 999, login: 'stranger' });
    const forbidden = await api.request('/admin/release-mirror', post({ manifest: manifest() }), env);
    expect(forbidden.status).toBe(403);

    const bad = await api.request('/admin/release-mirror', post({ manifest: { schemaVersion: 2 } }), env);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_manifest' });
    expect(github.calls).toEqual([]);
  });

  it('surfaces a GitHub failure as 502 rather than reporting a mirror that does not exist', async () => {
    const failing: typeof fetch = async () => new Response('{"message":"Bad credentials"}', { status: 401 });
    const { api, env } = harness({ fetchImpl: failing });

    const response = await api.request('/admin/release-mirror', post({ manifest: manifest() }), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'github-error' });
  });
});
