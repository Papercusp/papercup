/**
 * /blobs/snapshots — the snapshot tarball blob store (migration 005, R2 binding
 * SNAPSHOTS). Plan: revive-cupboard-distribution-2026-06-04 (snapshot facet).
 *
 * The D1 listing row is metadata-only, so cross-machine snapshot fork needs the
 * `.tar.gz` bytes to actually travel. They live here, CONTENT-ADDRESSED at
 *   snapshots/<sha256>.tar.gz
 * and the listing carries the pointer (tarball_r2_key/_content_hash/_bytes).
 *
 * This route is now a thin **adapter** over `@papercusp/artifact-registry`'s
 * content-addressed blob store (generalize-libs-to-generic D-003 #9). The generic
 * lib owns the policy — hash-verify on write, idempotent dedupe, visibility-gated
 * read, content-addressing scheme; this file binds Cloudflare R2 to the lib's
 * `BlobStore` port (`r2BlobStore`) and keeps the papercusp-specific bits: GitHub
 * auth, the D1 visibility refcount (`countActiveListingsByTarballKey`), and HTTP
 * framing. Endpoints + responses are unchanged:
 *   PUT  /blobs/snapshots/:sha  — upload (GitHub auth; body sha256 MUST equal :sha;
 *                                 idempotent — re-PUT of existing content is a no-op)
 *   HEAD /blobs/snapshots/:sha  — Hono-derived from GET (visibility-gated)
 *   GET  /blobs/snapshots/:sha  — download, STREAMED. Public, but visibility-gated:
 *                                 served only while a live (non-unlisted) listing
 *                                 references the key, so unlisting a snapshot also
 *                                 makes its bytes unreachable.
 *
 * Content-addressing is the integrity + dedupe + auth-lite story: the key IS the
 * sha256, the worker re-verifies it on upload, and the fork side re-verifies on
 * download — a tampered blob can't masquerade under a key it doesn't hash to.
 */

import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { audit, countActiveListingsByTarballKey } from '../db.ts';
import { AuthError, resolveGithubBearer } from '../auth.ts';
import {
  contentAddressing,
  getContentAddressed,
  putContentAddressed,
  HEX_SHA256_RE,
  type BlobStore,
} from '@papercusp/artifact-registry';

const BASE = '/blobs/snapshots';

/** Snapshot content-addressing scheme: `snapshots/<sha256>.tar.gz`. */
const SNAPSHOT_SCHEME = contentAddressing({ prefix: 'snapshots', ext: '.tar.gz' });

// Re-exported for the listings route + the blob tests, which import these here.
export const SHA256_RE = HEX_SHA256_RE;
/** Snapshots are narrowed runtime state, not whole repos — small. Cap well under
 *  the Workers request-body ceiling; a tarball over this is almost certainly a
 *  capture-scope bug, not a legitimate snapshot. */
export const MAX_TARBALL_BYTES = 100 * 1024 * 1024; // 100 MiB

export function snapshotBlobKey(sha256: string): string {
  return SNAPSHOT_SCHEME.key(sha256);
}

/**
 * Adapt the Cloudflare R2 bucket to the generic `BlobStore` port. The lib stays
 * Cloudflare-agnostic; this is the host seam. R2's native read object
 * (`R2ObjectBody`) flows straight back through `get` so the GET handler can
 * stream it and copy its HTTP metadata.
 */
export function r2BlobStore(bucket: R2Bucket): BlobStore<R2ObjectBody> {
  return {
    head: async (key) => {
      const o = await bucket.head(key);
      return o ? { size: o.size } : null;
    },
    put: async (key, body, opts) => {
      await bucket.put(key, body, {
        httpMetadata: opts?.contentType ? { contentType: opts.contentType } : undefined,
        // Belt-and-suspenders: R2 re-validates the content hash on write.
        sha256: opts?.sha256,
      });
    },
    get: (key) => bucket.get(key),
    delete: (key) => bucket.delete(key).then(() => undefined),
  };
}

export function blobsRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // PUT — upload a tarball, content-addressed. Auth-gated (a valid GitHub user,
  // same bar as publish) so the bucket can't be filled anonymously.
  app.put(`${BASE}/:sha`, async (c) => {
    let user;
    try {
      user = await resolveGithubBearer(c.req.raw);
    } catch (e) {
      if (e instanceof AuthError) return c.json({ error: 'auth', reason: e.reason }, 401);
      throw e;
    }
    const sha = c.req.param('sha');
    const declared = c.req.header('content-length');
    const result = await putContentAddressed(r2BlobStore(c.env.SNAPSHOTS), {
      hash: sha,
      scheme: SNAPSHOT_SCHEME,
      readBody: () => c.req.arrayBuffer(),
      declaredLength: declared != null ? Number(declared) : null,
      maxBytes: MAX_TARBALL_BYTES,
      contentType: 'application/gzip',
    });
    if (!result.ok) {
      return c.json({ error: result.error, ...(result.detail ?? {}) }, result.status);
    }
    // Audit only a real write (a deduped re-PUT skips the R2 write, as before).
    if (!result.deduped) {
      await audit(c.env.DB, Date.now(), 'snapshot_blob_put', {
        key: result.key,
        bytes: result.bytes,
        publisher_github_user_id: user.id,
      });
    }
    return c.json({ ok: true, key: result.key, bytes: result.bytes, deduped: result.deduped });
  });

  // (No explicit HEAD handler: Hono auto-derives HEAD from the GET handler, which
  // is visibility-gated, so a HEAD would 404 for an uploaded-but-unlisted blob.
  // The publisher relies on PUT idempotence instead — re-PUT of existing content
  // skips the R2 write and returns deduped:true.)

  // GET — download, streamed. Public, but only while a live listing references
  // the key (unlisting a snapshot makes its bytes unreachable too).
  app.get(`${BASE}/:sha`, async (c) => {
    const sha = c.req.param('sha');
    const result = await getContentAddressed(r2BlobStore(c.env.SNAPSHOTS), {
      hash: sha,
      scheme: SNAPSHOT_SCHEME,
      // Visibility gate: serve only while a LIVE (non-unlisted) listing points here.
      isReferenced: async (key) => (await countActiveListingsByTarballKey(c.env.DB, key)) > 0,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);

    const obj = result.object;
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set('content-type', 'application/gzip');
    headers.set('content-length', String(obj.size));
    // Content-addressed ⇒ immutable; the sha guarantees the bytes never change.
    headers.set('cache-control', 'public, max-age=31536000, immutable');
    headers.set('etag', `"${sha}"`);
    return new Response(obj.body, { status: 200, headers });
  });

  return app;
}
