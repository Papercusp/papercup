/**
 * Cupboard snapshot tarball blob store tests (migration 005, R2 binding SNAPSHOTS).
 * Plan: revive-cupboard-distribution-2026-06-04 (snapshot facet, cross-machine fork).
 *
 * Covers the /blobs/snapshots PUT/HEAD/GET routes (content-addressing, auth,
 * idempotence, visibility gate) and the snapshot-listing tarball_* passthrough +
 * blob GC on unlist in /listings.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildApi } from '../routes/index.ts';
import { makeEnv, stubGithub } from './fake-d1.ts';
import { snapshotBlobKey } from '../routes/blobs.ts';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function putBlob(
  api: ReturnType<typeof buildApi>,
  env: ReturnType<typeof makeEnv>['env'],
  sha: string,
  bytes: Uint8Array,
  opts: { auth?: boolean } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.auth !== false) headers.Authorization = 'Bearer t';
  return api.request(`/blobs/snapshots/${sha}`, { method: 'PUT', headers, body: bytes }, env);
}

function publishSnapshot(
  api: ReturnType<typeof buildApi>,
  env: ReturnType<typeof makeEnv>['env'],
  over: Record<string, unknown> = {},
) {
  return api.request(
    '/listings',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        github_owner: 'papercupai',
        github_name: 'demo-project',
        github_url: 'https://github.com/papercupai/demo-project',
        project_ref: 'papercupai/demo-project',
        github_repository_id: 7,
        listing_kind: 'snapshot',
        listing_ref: 'snap_abc',
        title: 'Demo snapshot',
        ...over,
      }),
    },
    env,
  );
}

const TARBALL = new TextEncoder().encode('fake .tar.gz bytes — snapshot state');

describe('Cupboard snapshot blob store — /blobs/snapshots', () => {
  let api: ReturnType<typeof buildApi>;
  beforeEach(() => {
    api = buildApi();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 7, private: false } });
  });

  it('PUT stores a content-addressed tarball and is idempotent', async () => {
    const { env, r2 } = makeEnv();
    const sha = await sha256Hex(TARBALL);
    const res = await putBlob(api, env, sha, TARBALL);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; key: string; bytes: number; deduped: boolean };
    expect(j.ok).toBe(true);
    expect(j.key).toBe(snapshotBlobKey(sha));
    expect(j.bytes).toBe(TARBALL.byteLength);
    expect(j.deduped).toBe(false);
    expect(r2.data.has(snapshotBlobKey(sha))).toBe(true);

    // Re-PUT identical content ⇒ deduped, no re-write.
    const again = await putBlob(api, env, sha, TARBALL);
    expect(again.status).toBe(200);
    expect((await again.json() as { deduped: boolean }).deduped).toBe(true);
  });

  it('PUT rejects a body whose sha256 does not match the key', async () => {
    const { env } = makeEnv();
    const wrongSha = 'a'.repeat(64);
    const res = await putBlob(api, env, wrongSha, TARBALL);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('sha_mismatch');
  });

  it('PUT rejects a non-hex sha and an unauthenticated caller', async () => {
    const { env } = makeEnv();
    const sha = await sha256Hex(TARBALL);
    expect((await putBlob(api, env, 'not-a-sha', TARBALL)).status).toBe(400);

    stubGithub({}); // no user ⇒ bearer resolves 401
    expect((await putBlob(api, env, sha, TARBALL)).status).toBe(401);
  });

  it('GET is gated: 404 until a live listing references the key, then streams the bytes', async () => {
    const { env } = makeEnv();
    const sha = await sha256Hex(TARBALL);
    await putBlob(api, env, sha, TARBALL);

    // Uploaded but not yet listed ⇒ not downloadable.
    expect((await api.request(`/blobs/snapshots/${sha}`, {}, env)).status).toBe(404);

    // Publish the snapshot listing pointing at the blob.
    const pub = await publishSnapshot(api, env, {
      tarball_r2_key: snapshotBlobKey(sha),
      tarball_content_hash: sha,
      tarball_bytes: TARBALL.byteLength,
    });
    expect(pub.status).toBe(200);

    const get = await api.request(`/blobs/snapshots/${sha}`, {}, env);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('application/gzip');
    const got = new Uint8Array(await get.arrayBuffer());
    expect(got).toEqual(TARBALL);
  });

  it('unlisting the snapshot GCs the blob (no other listing references it)', async () => {
    const { env, store, r2 } = makeEnv();
    const sha = await sha256Hex(TARBALL);
    await putBlob(api, env, sha, TARBALL);
    const pub = await publishSnapshot(api, env, {
      tarball_r2_key: snapshotBlobKey(sha),
      tarball_content_hash: sha,
      tarball_bytes: TARBALL.byteLength,
    });
    const id = (await pub.json() as { id: string }).id;
    expect(r2.data.has(snapshotBlobKey(sha))).toBe(true);

    const del = await api.request(`/listings/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer t' } }, env);
    expect(del.status).toBe(200);
    expect(store.tables.harnesses[0].unlisted_at).not.toBe(null);
    // Blob deleted + no longer downloadable.
    expect(r2.data.has(snapshotBlobKey(sha))).toBe(false);
    expect((await api.request(`/blobs/snapshots/${sha}`, {}, env)).status).toBe(404);
  });
});

describe('Cupboard /listings — snapshot tarball passthrough validation', () => {
  let api: ReturnType<typeof buildApi>;
  beforeEach(() => {
    api = buildApi();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 7, private: false } });
  });

  it('a snapshot listing carries tarball_* through to the row', async () => {
    const { env, store } = makeEnv();
    const sha = await sha256Hex(TARBALL);
    await putBlob(api, env, sha, TARBALL);
    const res = await publishSnapshot(api, env, {
      tarball_r2_key: snapshotBlobKey(sha),
      tarball_content_hash: sha,
      tarball_bytes: TARBALL.byteLength,
    });
    expect(res.status).toBe(200);
    const row = store.tables.harnesses[0];
    expect(row.listing_kind).toBe('snapshot');
    expect(row.tarball_r2_key).toBe(snapshotBlobKey(sha));
    expect(row.tarball_content_hash).toBe(sha);
    expect(row.tarball_bytes).toBe(TARBALL.byteLength);
  });

  it('rejects a snapshot listing whose blob was never uploaded', async () => {
    const { env } = makeEnv();
    const sha = await sha256Hex(TARBALL);
    const res = await publishSnapshot(api, env, {
      tarball_r2_key: snapshotBlobKey(sha),
      tarball_content_hash: sha,
      tarball_bytes: TARBALL.byteLength,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('tarball_blob_missing');
  });

  it('rejects a tarball_r2_key that is not content-addressed to the hash', async () => {
    const { env } = makeEnv();
    const sha = await sha256Hex(TARBALL);
    await putBlob(api, env, sha, TARBALL);
    const res = await publishSnapshot(api, env, {
      tarball_r2_key: 'snapshots/deadbeef.tar.gz',
      tarball_content_hash: sha,
      tarball_bytes: TARBALL.byteLength,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { reason: string }).reason).toBe('must_be_content_addressed');
  });

  it('rejects tarball_* on a non-snapshot kind', async () => {
    const { env } = makeEnv();
    const sha = await sha256Hex(TARBALL);
    await putBlob(api, env, sha, TARBALL);
    const res = await api.request(
      '/listings',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          github_owner: 'papercupai', github_name: 'demo', github_url: 'https://github.com/papercupai/demo',
          github_repository_id: 7, listing_kind: 'blueprint', listing_ref: 'bp',
          tarball_r2_key: snapshotBlobKey(sha), tarball_content_hash: sha, tarball_bytes: TARBALL.byteLength,
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { reason: string }).reason).toBe('snapshot_kind_only');
  });

  it('rejects a partial tarball_* (all-or-none)', async () => {
    const { env } = makeEnv();
    const sha = await sha256Hex(TARBALL);
    await putBlob(api, env, sha, TARBALL);
    const res = await publishSnapshot(api, env, { tarball_content_hash: sha }); // missing key + bytes
    expect(res.status).toBe(400);
    expect((await res.json() as { reason: string }).reason).toBe('all_or_none');
  });
});
