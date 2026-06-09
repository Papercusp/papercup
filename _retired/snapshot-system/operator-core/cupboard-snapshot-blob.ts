/**
 * Snapshot tarball blob transport (revive-cupboard-distribution-2026-06-04,
 * snapshot facet — owner decision 2026-06-04: snapshots fork CROSS-MACHINE now
 * via an R2 blob store behind the Cupboard, not deferred to the project remote).
 *
 * The Cupboard listing row is metadata-only, so the `.tar.gz` bytes travel
 * through the worker's R2 store (binding SNAPSHOTS, migration 005), CONTENT-
 * ADDRESSED at `snapshots/<sha256>.tar.gz`:
 *
 *   - publish (machine A) uploads the tarball here, then registers a snapshot
 *     listing carrying tarball_r2_key/_content_hash/_bytes;
 *   - fork   (machine B) reads the listing, downloads the blob here, verifies the
 *     sha256, and restores locally.
 *
 * Content-addressing is the integrity story end-to-end: the key IS the sha256,
 * the worker re-verifies on upload, and `downloadSnapshotTarball` re-verifies on
 * download — a tampered or truncated blob can't pass under a key it doesn't hash
 * to. Upload reuses the same gh-token + base-url seam as `publish-listing.ts`.
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { getGhAuthToken } from '../identity/gh-token';
import { resolveCupboardBaseUrl } from '../endpoint-route/routes/harness/cupboard-publish';

const UA = 'papercusp-operator-cupboard-proxy';

/** The content-addressed R2 object key for a snapshot tarball. */
export function snapshotBlobKey(sha256: string): string {
  return `snapshots/${sha256}.tar.gz`;
}

export type SnapshotUploadResult =
  | { ok: true; key: string; sha256: string; bytes: number; deduped: boolean }
  | { ok: false; status: number; error: string; detail?: string };

/**
 * Upload a snapshot tarball to the Cupboard R2 store, content-addressed.
 * Idempotent: the worker skips the write (and the bytes still travel, but no
 * double-store) when identical content already exists. Auth via the operator's
 * gh-token (same bar as publish). Never throws.
 */
export async function uploadSnapshotTarball(tarballPath: string): Promise<SnapshotUploadResult> {
  const tokenRes = await getGhAuthToken();
  if (tokenRes.kind !== 'ok') {
    return { ok: false, status: 401, error: 'gh_auth_required', detail: tokenRes.error.kind };
  }
  let buf: Buffer;
  try {
    buf = await fs.readFile(tarballPath);
  } catch (e) {
    return { ok: false, status: 404, error: 'tarball_unreadable', detail: (e as Error).message.slice(0, 200) };
  }
  const sha = createHash('sha256').update(buf).digest('hex');
  const key = snapshotBlobKey(sha);
  const base = resolveCupboardBaseUrl();

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/blobs/snapshots/${sha}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tokenRes.token}`,
        'Content-Type': 'application/gzip',
        'User-Agent': UA,
      },
      body: new Uint8Array(buf),
    });
  } catch (e) {
    return { ok: false, status: 502, error: 'cupboard_unreachable', detail: (e as Error).message.slice(0, 200) };
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return { ok: false, status: upstream.status, error: 'blob_upload_failed', detail: text.slice(0, 200) };
  }
  const j = (await upstream.json().catch(() => ({}))) as { bytes?: number; deduped?: boolean };
  return { ok: true, key, sha256: sha, bytes: j.bytes ?? buf.byteLength, deduped: j.deduped ?? false };
}

export type SnapshotDownloadResult =
  | { ok: true; bytes: Uint8Array; sha256: string }
  | { ok: false; status: number; error: string; detail?: string };

/**
 * Download a snapshot tarball from the Cupboard R2 store by its sha256 and
 * VERIFY the bytes hash to it (content-addressing integrity). The GET is public
 * but visibility-gated worker-side (served only while a live listing references
 * the key). Never throws.
 */
export async function downloadSnapshotTarball(sha256: string): Promise<SnapshotDownloadResult> {
  const base = resolveCupboardBaseUrl();
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/blobs/snapshots/${sha256}`, { headers: { 'User-Agent': UA } });
  } catch (e) {
    return { ok: false, status: 502, error: 'cupboard_unreachable', detail: (e as Error).message.slice(0, 200) };
  }
  if (!upstream.ok) {
    return { ok: false, status: upstream.status, error: 'blob_download_failed' };
  }
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== sha256) {
    return { ok: false, status: 422, error: 'sha_mismatch', detail: `expected ${sha256}, got ${actual}` };
  }
  return { ok: true, bytes, sha256 };
}

/** The snapshot-relevant fields of a Cupboard listing row (GET /listings/:id). */
export interface CupboardSnapshotListing {
  id: string;
  listing_kind?: string;
  listing_ref?: string | null;
  title?: string;
  tarball_r2_key?: string | null;
  tarball_content_hash?: string | null;
  tarball_bytes?: number | null;
}

/**
 * Fetch one Cupboard listing by id (GET /listings/:id, public). Returns null on
 * 404 / unreachable / bad response — the caller maps null to its own error.
 */
export async function fetchCupboardListing(listingId: string): Promise<CupboardSnapshotListing | null> {
  const base = resolveCupboardBaseUrl();
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/listings/${encodeURIComponent(listingId)}`, { headers: { 'User-Agent': UA } });
  } catch {
    return null;
  }
  if (!upstream.ok) return null;
  const row = (await upstream.json().catch(() => null)) as CupboardSnapshotListing | null;
  return row && typeof row === 'object' ? row : null;
}
