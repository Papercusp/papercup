/**
 * Unit tests for the snapshot tarball blob transport
 * (revive-cupboard-distribution-2026-06-04, snapshot facet). The risk this
 * covers is INTEGRITY: content-addressing on upload + sha256 verification on
 * download (a tampered/truncated blob must be rejected, not restored).
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

vi.mock('../identity/gh-token', () => ({ getGhAuthToken: vi.fn() }));
vi.mock('../endpoint-route/routes/harness/cupboard-publish', () => ({
  resolveCupboardBaseUrl: () => 'https://cupboard.test',
}));

import { getGhAuthToken } from '../identity/gh-token';
import {
  uploadSnapshotTarball,
  downloadSnapshotTarball,
  fetchCupboardListing,
  snapshotBlobKey,
} from './snapshot-blob';

const BYTES = Buffer.from('snapshot tarball bytes — narrowed runtime state');
const SHA = createHash('sha256').update(BYTES).digest('hex');

const realFetch = globalThis.fetch;

describe('snapshot-blob transport', () => {
  let tmpPath: string;

  beforeEach(async () => {
    (getGhAuthToken as Mock).mockResolvedValue({ kind: 'ok', token: 'tkn' });
    tmpPath = join(tmpdir(), `sb-test-${SHA}.tar.gz`);
    await fs.writeFile(tmpPath, BYTES);
  });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    vi.clearAllMocks();
  });

  it('uploadSnapshotTarball content-addresses by sha256 and authenticates', async () => {
    let seenUrl = '';
    let seenAuth = '';
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      return new Response(JSON.stringify({ ok: true, key: snapshotBlobKey(SHA), bytes: BYTES.length, deduped: false }), { status: 200 });
    }) as typeof fetch;

    const res = await uploadSnapshotTarball(tmpPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(seenUrl).toBe(`https://cupboard.test/blobs/snapshots/${SHA}`);
    expect(seenAuth).toBe('Bearer tkn');
    expect(res.key).toBe(snapshotBlobKey(SHA));
    expect(res.sha256).toBe(SHA);
    expect(res.bytes).toBe(BYTES.length);
    expect(res.deduped).toBe(false);
  });

  it('uploadSnapshotTarball surfaces a missing gh token without uploading', async () => {
    (getGhAuthToken as Mock).mockResolvedValue({ kind: 'error', error: { kind: 'no_token' } });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const res = await uploadSnapshotTarball(tmpPath);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('gh_auth_required');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uploadSnapshotTarball maps an unreadable tarball to a 404', async () => {
    const res = await uploadSnapshotTarball(join(tmpdir(), 'does-not-exist.tar.gz'));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('tarball_unreadable');
  });

  it('downloadSnapshotTarball returns verified bytes when the sha matches', async () => {
    globalThis.fetch = vi.fn(async () => new Response(BYTES, { status: 200 })) as typeof fetch;
    const res = await downloadSnapshotTarball(SHA);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Buffer.from(res.bytes)).toEqual(BYTES);
    expect(res.sha256).toBe(SHA);
  });

  it('downloadSnapshotTarball REJECTS bytes that do not hash to the requested sha (tamper)', async () => {
    globalThis.fetch = vi.fn(async () => new Response(Buffer.from('tampered payload'), { status: 200 })) as typeof fetch;
    const res = await downloadSnapshotTarball(SHA);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('sha_mismatch');
  });

  it('downloadSnapshotTarball maps a worker 404 (unlisted/gone) to blob_download_failed', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 404 })) as typeof fetch;
    const res = await downloadSnapshotTarball(SHA);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(404);
    expect(res.error).toBe('blob_download_failed');
  });

  it('fetchCupboardListing parses a listing row and maps 404 to null', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'L1', listing_kind: 'snapshot', listing_ref: 'snap_x', tarball_content_hash: SHA }), { status: 200 }),
    ) as typeof fetch;
    const l = await fetchCupboardListing('L1');
    expect(l?.tarball_content_hash).toBe(SHA);
    expect(l?.listing_ref).toBe('snap_x');

    globalThis.fetch = vi.fn(async () => new Response('', { status: 404 })) as typeof fetch;
    expect(await fetchCupboardListing('missing')).toBe(null);
  });
});
